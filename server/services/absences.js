// Ausência combinada (equipe interna): falta com reposição (dia inteiro, reposto até o fim do mês seguinte à falta)
// ou falta descontada. A pessoa pede e o gestor aprova; o gestor também pode lançar (já aprovada).
// Depois do dia da reposição, o gestor confirma: cumprida (não desconta) ou não cumprida (vira falta descontada na Folha).
import { all, one, run, tx } from '../db.js';
import { badRequest, forbidden, notFound, str, date, intOrNull, oneOf } from '../lib/http.js';
import { isAdmin, hasSection, teamIds } from '../lib/permissions.js';
import { audit } from './audit.js';
import { today } from './metrics.js';
import { canApprove, conflictsOf, readProposals, applyProposals } from './vacations.js';
import { insertTask } from './tasks.js';
import { taskHistory } from './audit.js';

const fmtD = d => (d ? d.split('-').reverse().join('/') : '—');
const lastDayNextMonth = d => { const [y, m] = d.split('-').map(Number); return new Date(Date.UTC(y, m + 1, 0)).toISOString().slice(0, 10); };
const nowSql = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
const LIVE = `status IN ('solicitada','aprovada')`;

const SQL = `SELECT a.*, (SELECT code FROM tasks WHERE id = a.task_id) AS task_code, u.name AS user_name, u.job_title, rb.name AS requested_by_name, db.name AS decided_by_name, cb.name AS checked_by_name
  FROM absences a JOIN users u ON u.id = a.user_id LEFT JOIN users rb ON rb.id = a.requested_by LEFT JOIN users db ON db.id = a.decided_by
  LEFT JOIN users cb ON cb.id = a.makeup_checked_by`;

function targetOf(id) {
  const t = one('SELECT * FROM users WHERE id = ? AND active = 1', id);
  if (!t) throw notFound('Pessoa não encontrada.');
  if (t.is_external) throw badRequest('A ausência combinada vale só para a equipe interna.');
  return t;
}

// ---------- Tarefa de confirmação de presença no dia da reposição (pergunta Sim/Não, sem padrão) ----------
const readCreateTask = (b, a) => {
  if (a.kind !== 'reposicao') return false;
  if (b?.create_task !== true && b?.create_task !== false) throw badRequest(`Responda se cria a tarefa de confirmação de presença no dia da reposição (${fmtD(a.makeup_date)}): Sim ou Não.`);
  return b.create_task;
};
function internalArea() {
  const id = Number(one(`SELECT value FROM app_settings WHERE key = 'internal_area_created'`)?.value) || one(`SELECT id FROM projects WHERE kind = 'interno' AND COALESCE(restricted, 0) = 0 ORDER BY id LIMIT 1`)?.id;
  return id ? one('SELECT * FROM projects WHERE id = ?', id) : null;
}
function createMakeupTask(ctx, a, t) {
  if (a.makeup_date < today()) return null; // reposição já passou: o líder confere pelo painel
  const area = internalArea();
  if (!area) throw badRequest('Área interna de tarefas não encontrada para criar a tarefa de confirmação de presença.');
  const stage = one('SELECT id FROM project_stages WHERE project_id = ? AND name = ? COLLATE NOCASE', area.id, 'Pessoas (RH)')?.id;
  const taskId = insertTask({
    project: area,
    data: { task_type: 'tarefa', title: `Confirmar presença — reposição da falta de ${fmtD(a.off_date).slice(0, 5)}`,
      description: [`Hoje (${fmtD(a.makeup_date)}) é o dia combinado para repor a falta de ${fmtD(a.off_date)}.`, a.note ? `Combinado: ${a.note}` : '',
        'Ao cumprir a reposição, envie esta tarefa para conferência: quando o líder aprovar, a reposição fica registrada como cumprida.'].filter(Boolean).join('\n'),
      field_summary: null, notes: null, due_date: a.makeup_date, start_date: a.makeup_date, priority: 'media', proof_type: 'nenhuma', assignee_id: t.id },
    stageInput: stage || null,
    creatorId: ctx.user.id,
  });
  run('UPDATE absences SET task_id = ?, task_asked = 1 WHERE id = ?', taskId, a.id);
  return taskId;
}
// Encerra a tarefa de confirmação quando a reposição é conferida ou a ausência cancelada
function closeMakeupTask(a, userId, how) {
  if (!a.task_id) return;
  const t = one('SELECT id, status, cancelled_at FROM tasks WHERE id = ?', a.task_id);
  if (!t || t.cancelled_at || t.status === 'concluida') return;
  const now = new Date().toISOString();
  if (how === 'done') {
    run(`UPDATE tasks SET status = 'concluida', started_at = COALESCE(started_at, ?), delivered_at = COALESCE(delivered_at, ?), completed_at = ?, review_status = 'aprovada', reviewed_by = ?, reviewed_at = ?, progress_pct = 100, updated_at = ? WHERE id = ?`, now, now, now, userId, now, now, t.id);
    taskHistory(t.id, userId, 'Tarefa concluída', 'Reposição confirmada como cumprida pelo líder');
  } else {
    const reason = how === 'missed' ? 'Reposição não cumprida (vira falta descontada)' : 'Ausência combinada cancelada';
    run('UPDATE tasks SET cancelled_at = ?, cancelled_by = ?, cancel_reason = ?, updated_at = ? WHERE id = ?', now, userId, reason, now, t.id);
    taskHistory(t.id, userId, 'Tarefa cancelada', reason);
  }
}
// Tarefa de confirmação conferida (aprovada/concluída) ou reaberta pela tela de tarefas: a reposição acompanha
export function syncAbsenceTask(taskId, action, userId) {
  let a;
  try { a = one('SELECT * FROM absences WHERE task_id = ?', taskId); } catch { return; }
  if (!a || a.status !== 'aprovada') return;
  if ((action === 'approve' || action === 'conclude') && a.makeup_status === 'pendente') {
    run(`UPDATE absences SET makeup_status = 'cumprida', makeup_checked_by = ?, makeup_checked_at = ?, updated_at = datetime('now') WHERE id = ?`, userId, nowSql(), a.id);
    audit(userId, 'absence', a.id, 'Reposição cumprida (tarefa de confirmação aprovada)', { dia: fmtD(a.makeup_date) });
  } else if (action === 'reopen' && a.makeup_status === 'cumprida') {
    run(`UPDATE absences SET makeup_status = 'pendente', makeup_checked_by = NULL, makeup_checked_at = NULL, updated_at = datetime('now') WHERE id = ?`, a.id);
  }
}

const APPLY = { reasonName: 'Ausência do responsável', what: 'Ausência', table: 'absence_reschedules', key: 'absence_id' };
// Tarefas da pessoa com entrega no dia da ausência (precisam de novo prazo ou explicação)
export function previewAbsence(ctx, body) {
  const t = targetOf(intOrNull(body?.user_id) || ctx.user.id);
  if (t.id !== ctx.user.id && !canApprove(ctx, t)) throw forbidden('Você não pode lançar ausências desta pessoa.');
  const off = date(body?.off_date, 'Dia da ausência');
  return { conflicts: off ? conflictsOf(t.id, off, off) : [] };
}
function withReschedules(rows) {
  for (const a of rows) {
    a.reschedules = all(`SELECT r.task_id, r.old_due, r.new_due, r.explanation, r.applied, t.code, t.title FROM absence_reschedules r JOIN tasks t ON t.id = r.task_id WHERE r.absence_id = ? ORDER BY r.old_due`, a.id);
    if (a.status === 'solicitada') {
      const have = new Set(a.reschedules.map(x => x.task_id));
      a.new_conflicts = conflictsOf(a.user_id, a.off_date, a.off_date).filter(c => !have.has(c.id));
    }
  }
  return rows;
}

// Quem o usuário pode lançar (a própria pessoa não entra: ela solicita)
export function absencePeople(ctx) {
  const all_ = all('SELECT id, name, job_title FROM users WHERE active = 1 AND is_external = 0 ORDER BY name');
  if (isAdmin(ctx.user) || hasSection(ctx.user, 'equipe')) return all_.filter(u => u.id !== ctx.user.id || isAdmin(ctx.user));
  const team = teamIds(ctx.user.id);
  return all_.filter(u => team.has(u.id));
}

export function requestAbsence(ctx, body, ip) {
  const b = body || {};
  const t = targetOf(intOrNull(b.user_id) || ctx.user.id);
  const self = t.id === ctx.user.id;
  const approver = canApprove(ctx, t);
  if (!self && !approver) throw forbidden('Você não pode lançar ausências desta pessoa.');
  const kind = oneOf(b.kind, ['reposicao', 'descontada'], 'Tipo da ausência');
  const off = date(b.off_date, 'Dia da ausência');
  if (!off) throw badRequest('Informe o dia da ausência.');
  if (!approver && off < today()) throw badRequest('O dia da ausência não pode ser no passado (peça ao gestor para lançar).');
  let makeup = null;
  if (kind === 'reposicao') {
    makeup = date(b.makeup_date, 'Dia da reposição');
    if (!makeup) throw badRequest('Informe o dia da reposição.');
    if (makeup === off) throw badRequest('O dia da reposição precisa ser diferente do dia da ausência.');
    const limit = lastDayNextMonth(off);
    if (makeup > limit) throw badRequest(`A reposição precisa acontecer até o fim do mês seguinte à ausência (${fmtD(limit)}).`);
    if (!approver && makeup < today()) throw badRequest('O dia da reposição não pode ser no passado.');
  }
  if (one(`SELECT 1 FROM absences WHERE user_id = ? AND ${LIVE} AND off_date = ?`, t.id, off)) throw badRequest(`Já existe uma ausência de ${t.name.split(' ')[0]} em ${fmtD(off)}.`);
  if (one(`SELECT 1 FROM vacations WHERE user_id = ? AND status IN ('solicitada','aprovada') AND start_date <= ? AND end_date >= ?`, t.id, off, off)) throw badRequest(`${fmtD(off)} já está dentro de férias/recesso de ${t.name.split(' ')[0]}.`);
  const note = str(b.note, { max: 1000, label: 'Combinado / motivo' });
  const status = approver && (!self || isAdmin(ctx.user)) ? 'aprovada' : 'solicitada';
  const proposals = readProposals(conflictsOf(t.id, off, off), b.reschedules, off, off, 'a ausência');
  const createTask = status === 'aprovada' ? readCreateTask(b, { kind, makeup_date: makeup }) : false;
  const id = tx(() => {
    const nid = Number(run(`INSERT INTO absences (user_id, kind, off_date, makeup_date, status, makeup_status, note, requested_by, decided_by, decided_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`, t.id, kind, off, makeup, status, kind === 'reposicao' ? 'pendente' : null, note, ctx.user.id,
      status === 'aprovada' ? ctx.user.id : null, status === 'aprovada' ? nowSql() : null).lastInsertRowid);
    for (const x of proposals) run('INSERT INTO absence_reschedules (absence_id, task_id, old_due, new_due, explanation) VALUES (?,?,?,?,?)', nid, x.task_id, x.old_due, x.new_due, x.explanation || null);
    if (status === 'aprovada') {
      applyProposals(ctx, { id: nid, start_date: off, end_date: off, requested_by: ctx.user.id }, t, proposals, APPLY);
      if (kind === 'reposicao') { if (createTask) createMakeupTask(ctx, { id: nid, off_date: off, makeup_date: makeup, note }, t); else run('UPDATE absences SET task_asked = 1 WHERE id = ?', nid); }
    }
    return nid;
  });
  audit(ctx.user.id, 'absence', id, status === 'aprovada' ? 'Ausência combinada lançada' : 'Ausência combinada solicitada',
    { pessoa: t.name, tipo: kind === 'reposicao' ? 'falta com reposição' : 'falta descontada', dia: fmtD(off), reposicao: makeup ? fmtD(makeup) : undefined, tarefas: proposals.length || undefined }, ip);
  return { id, status, reschedules: proposals.length };
}

export function absenceAction(ctx, id, action, body = {}, ip) {
  const a = one('SELECT * FROM absences WHERE id = ?', id);
  if (!a) throw notFound('Ausência não encontrada.');
  const t = one('SELECT * FROM users WHERE id = ?', a.user_id);
  const approver = canApprove(ctx, t);
  const self = t.id === ctx.user.id;
  const note = str(body.note, { max: 1000, required: action === 'reject', label: 'Motivo' });
  const now = nowSql();
  let label;
  if (action === 'approve' || action === 'reject') {
    if (!approver) throw forbidden('Você não pode decidir as ausências desta pessoa.');
    if (a.status !== 'solicitada') throw badRequest('Esta ausência não está aguardando aprovação.');
    const createTask = action === 'approve' ? readCreateTask(body, a) : false;
    if (action === 'approve') {
      // Propostas da pessoa (o líder pode ajustar ou completar, ex.: tarefa criada depois do pedido)
      const saved = all('SELECT task_id, new_due, explanation FROM absence_reschedules WHERE absence_id = ?', a.id);
      const given = new Map((Array.isArray(body.reschedules) ? body.reschedules : []).map(x => [intOrNull(x?.task_id), x]));
      const merged = saved.map(x => (given.get(x.task_id) ? { task_id: x.task_id, ...given.get(x.task_id) } : x));
      for (const [tid, g] of given) if (tid && !merged.some(x => x.task_id === tid)) merged.push({ ...g, task_id: tid });
      const proposals = readProposals(conflictsOf(t.id, a.off_date, a.off_date), merged, a.off_date, a.off_date, 'a ausência');
      tx(() => {
        for (const x of proposals) run(`INSERT INTO absence_reschedules (absence_id, task_id, old_due, new_due, explanation) VALUES (?,?,?,?,?)
          ON CONFLICT (absence_id, task_id) DO UPDATE SET new_due = excluded.new_due, explanation = excluded.explanation`, a.id, x.task_id, x.old_due, x.new_due, x.explanation || null);
        applyProposals(ctx, { id: a.id, start_date: a.off_date, end_date: a.off_date, requested_by: a.requested_by }, t, proposals, APPLY);
        if (a.kind === 'reposicao') { if (createTask) createMakeupTask(ctx, a, t); else run('UPDATE absences SET task_asked = 1 WHERE id = ?', a.id); }
      });
    }
    run(`UPDATE absences SET status = ?, decided_by = ?, decided_at = ?, decision_note = ?, updated_at = datetime('now') WHERE id = ?`, action === 'approve' ? 'aprovada' : 'recusada', ctx.user.id, now, note, id);
    label = action === 'approve' ? 'Ausência combinada aprovada' : 'Ausência combinada recusada';
  } else if (action === 'cancel') {
    const can = (self && a.status === 'solicitada') || (approver && ['solicitada', 'aprovada'].includes(a.status));
    if (!can) throw forbidden('Você não pode cancelar esta ausência.');
    if (a.makeup_status === 'nao_cumprida' || a.makeup_status === 'cumprida') throw badRequest('A reposição já foi conferida: desfaça a conferência antes.');
    run(`UPDATE absences SET status = 'cancelada', decided_by = ?, decided_at = ?, decision_note = ?, updated_at = datetime('now') WHERE id = ?`, ctx.user.id, now, note, id);
    closeMakeupTask(a, ctx.user.id, 'cancel');
    label = 'Ausência combinada cancelada';
  } else if (action === 'delete') {
    // Exclusão definitiva de ausência aprovada (só administrador); os dados ficam no registro da Auditoria
    if (!isAdmin(ctx.user)) throw forbidden('Somente o administrador exclui solicitações aprovadas.');
    if (a.status !== 'aprovada') throw badRequest('Somente solicitações aprovadas podem ser excluídas.');
    const why = str(body.note, { max: 1000, required: true, label: 'Motivo da exclusão' });
    const by = a.decided_by ? one('SELECT name FROM users WHERE id = ?', a.decided_by)?.name : null;
    tx(() => {
      closeMakeupTask(a, ctx.user.id, 'cancel');
      run('DELETE FROM absences WHERE id = ?', id);
      audit(ctx.user.id, 'absence', id, 'Ausência aprovada excluída', { pessoa: t.name, tipo: a.kind === 'reposicao' ? 'falta com reposição' : 'falta descontada', dia: fmtD(a.off_date), reposicao: a.makeup_date ? fmtD(a.makeup_date) : undefined,
        situacao_reposicao: a.makeup_status || undefined, combinado: a.note || undefined, aprovada_por: by || undefined, motivo_exclusao: why }, ip);
    });
    return { ok: true };
  } else if (action === 'makeup_done' || action === 'makeup_missed') {
    if (!approver) throw forbidden('Só o gestor confere a reposição.');
    if (a.status !== 'aprovada' || a.kind !== 'reposicao') throw badRequest('Esta ausência não tem reposição a conferir.');
    if (a.makeup_date > today()) throw badRequest(`A reposição é em ${fmtD(a.makeup_date)}: confira a partir desse dia.`);
    run(`UPDATE absences SET makeup_status = ?, makeup_checked_by = ?, makeup_checked_at = ?, decision_note = COALESCE(?, decision_note), updated_at = datetime('now') WHERE id = ?`,
      action === 'makeup_done' ? 'cumprida' : 'nao_cumprida', ctx.user.id, now, note, id);
    closeMakeupTask(a, ctx.user.id, action === 'makeup_done' ? 'done' : 'missed');
    label = action === 'makeup_done' ? 'Reposição cumprida' : 'Reposição não cumprida (vira falta descontada)';
  } else if (action === 'makeup_reopen') {
    if (!approver) throw forbidden('Só o gestor confere a reposição.');
    run(`UPDATE absences SET makeup_status = 'pendente', makeup_checked_by = NULL, makeup_checked_at = NULL, updated_at = datetime('now') WHERE id = ? AND kind = 'reposicao'`, id);
    label = 'Conferência da reposição desfeita';
  } else throw badRequest('Ação inválida.');
  audit(ctx.user.id, 'absence', id, label, { pessoa: t.name, dia: fmtD(a.off_date), reposicao: a.makeup_date ? fmtD(a.makeup_date) : undefined, motivo: note || undefined }, ip);
  return { ok: true };
}

// Meu painel: minhas ausências, as que aguardam minha aprovação e as reposições a conferir
export function myAbsences(ctx) {
  const mine = withReschedules(all(`${SQL} WHERE a.user_id = ? ORDER BY a.off_date DESC LIMIT 30`, ctx.user.id));
  const canFor = new Map();
  const ok = a => { if (!canFor.has(a.user_id)) canFor.set(a.user_id, a.user_id !== ctx.user.id && canApprove(ctx, one('SELECT * FROM users WHERE id = ?', a.user_id))); return canFor.get(a.user_id); };
  const approvals = withReschedules(all(`${SQL} WHERE a.status = 'solicitada' ORDER BY a.off_date`).filter(ok));
  const checks = all(`${SQL} WHERE a.status = 'aprovada' AND a.kind = 'reposicao' AND a.makeup_status = 'pendente' AND a.makeup_date <= ? ORDER BY a.makeup_date`, today()).filter(ok);
  const upcoming = all(`${SQL} WHERE a.status = 'aprovada' AND (a.off_date >= ? OR (a.kind = 'reposicao' AND a.makeup_status = 'pendente')) ORDER BY a.off_date`, today()).filter(ok);
  return { mine, approvals, checks, upcoming, people: absencePeople(ctx) };
}

// Faltas descontadas na Folha no intervalo: falta descontada (pelo dia da falta) e reposição não cumprida (pelo dia combinado da reposição)
export function discountedAbsences(userId, from, to) {
  try {
    return all(`SELECT * FROM absences WHERE user_id = ? AND status = 'aprovada' AND ((kind = 'descontada' AND off_date BETWEEN ? AND ?)
      OR (kind = 'reposicao' AND makeup_status = 'nao_cumprida' AND makeup_date BETWEEN ? AND ?)) ORDER BY off_date`, userId, from, to, from, to);
  } catch { return []; }
}
