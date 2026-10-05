// Tarefas recorrentes: séries (molde + regra) e geração automática das ocorrências.
// Cada ocorrência é uma tarefa normal, criada `lead_days` dias antes do seu prazo.
import { all, one, run, tx } from '../db.js';
import { badRequest, forbidden, notFound, str, oneOf, date, intOrNull } from '../lib/http.js';
import { isAdmin, canAccessProject, canCreateTaskIn, userHasProjectAccess } from '../lib/permissions.js';
import { today, addDays } from './metrics.js';
import { FREQS, END_TYPES, occurrenceDates, describeRule } from './recurrence-rules.js';
import { insertTask, validateAssignee, listVisible, listCancelled, PRIORITIES, PROOF_TYPES } from './tasks.js';
import { resolveStage } from './stages.js';
import { saveImageFromDataUrl } from './files.js';
import { taskHistory, audit } from './audit.js';

const nowIso = () => new Date().toISOString();
const BASE = `SELECT r.*, p.code AS project_code, p.name AS project_name, p.status AS project_status,
    a.name AS assignee_name, c.name AS creator_name, e.name AS ended_by_name, s.name AS stage_name,
    (SELECT COUNT(*) FROM tasks t WHERE t.recurrence_id = r.id) AS task_count,
    (SELECT COUNT(*) FROM tasks t WHERE t.recurrence_id = r.id AND t.status = 'concluida' AND t.cancelled_at IS NULL) AS done_count
  FROM recurrences r JOIN projects p ON p.id = r.project_id
  LEFT JOIN users a ON a.id = r.assignee_id LEFT JOIN users c ON c.id = r.created_by
  LEFT JOIN users e ON e.id = r.ended_by LEFT JOIN project_stages s ON s.id = r.stage_id`;

// ---------- Regra ----------
export const ruleOf = r => ({
  freq: r.freq, interval: r.interval_n, weekdays: r.weekdays ? r.weekdays.split(',').map(Number) : [],
  month_day: r.month_day, workdays_only: !!r.workdays_only, start_date: r.start_date,
  end_type: r.end_type, end_date: r.end_date, end_count: r.end_count,
});

function readRule(body, { creating, current } = {}) {
  const freq = oneOf(body.freq, FREQS, 'Frequência');
  const interval = Number(body.interval || 1);
  if (!Number.isInteger(interval) || interval < 1 || interval > 99) throw badRequest('Intervalo da repetição inválido (1 a 99).');
  const weekdays = freq === 'semanal'
    ? [...new Set((Array.isArray(body.weekdays) ? body.weekdays : String(body.weekdays || '').split(',')).filter(x => x !== '').map(Number))]
    : [];
  if (weekdays.some(d => !Number.isInteger(d) || d < 0 || d > 6)) throw badRequest('Dias da semana inválidos.');
  const start = date(body.start_date ?? body.due_date, 'Prazo da 1ª ocorrência');
  if (!start) throw badRequest('Informe o prazo da 1ª ocorrência.');
  if (creating && start < today()) throw badRequest('A 1ª ocorrência deve ser hoje ou uma data futura.');
  const monthDay = freq === 'mensal' ? Number(body.month_day || start.slice(8, 10)) : null;
  if (freq === 'mensal' && (!Number.isInteger(monthDay) || monthDay < 1 || monthDay > 31)) throw badRequest('Dia do mês inválido.');
  const endType = oneOf(body.end_type, END_TYPES, 'Término da recorrência');
  const endDate = endType === 'data' ? date(body.end_date, 'Data de término') : null;
  if (endType === 'data' && (!endDate || endDate < start)) throw badRequest('A data de término deve ser igual ou posterior à 1ª ocorrência.');
  const endCount = endType === 'ocorrencias' ? Number(body.end_count) : null;
  if (endType === 'ocorrencias' && (!Number.isInteger(endCount) || endCount < 1 || endCount > 500)) throw badRequest('Número de ocorrências inválido (1 a 500).');
  if (current && endType === 'ocorrencias' && endCount < current.generated_count) throw badRequest(`Já foram criadas ${current.generated_count} ocorrência(s); o total não pode ser menor.`);
  if (current && endType === 'data' && current.last_generated_date && endDate < current.last_generated_date) throw badRequest(`Já existe ocorrência com prazo em ${current.last_generated_date.split('-').reverse().join('/')}; escolha uma data igual ou posterior.`);
  return { freq, interval, weekdays, month_day: monthDay, workdays_only: freq === 'diaria' && !!body.workdays_only, start_date: start, end_type: endType, end_date: endDate, end_count: endCount };
}

function readOptions(body) {
  const lead = Number(body.lead_days ?? 7);
  if (!Number.isInteger(lead) || lead < 0 || lead > 90) throw badRequest('Antecedência de criação inválida (0 a 90 dias).');
  const duration = Number(body.duration_days ?? 1);
  if (!Number.isInteger(duration) || duration < 1 || duration > 60) throw badRequest('Duração inválida (1 a 60 dias).');
  return { lead_days: lead, duration_days: duration };
}

function readTemplate(body, projectId) {
  return {
    title: str(body.title, { max: 160, required: true, label: 'Título' }),
    description: str(body.description, { max: 5000, required: true, label: 'Descrição' }),
    field_summary: str(body.field_summary, { max: 180, label: 'Resumo para campo' }),
    notes: str(body.notes, { max: 2000, label: 'Observações' }),
    priority: oneOf(body.priority, PRIORITIES, 'Prioridade', 'media'),
    proof_type: oneOf(body.proof_type, PROOF_TYPES, 'Tipo de comprovação', 'nenhuma'),
    assignee_id: validateAssignee(intOrNull(body.assignee_id), projectId),
    stage_id: resolveStage(projectId, body.stage_id),
  };
}

// Prévia (formulário): descrição e próximas datas, sem gravar nada
export function previewRule(body) {
  const rule = readRule(body, { creating: false });
  const next = [...occurrenceDates(rule, { limit: 8 })];
  const total = rule.end_type === 'nunca' ? null : [...occurrenceDates(rule, { limit: 501 })].length;
  return { description: describeRule(rule), next, total };
}

// ---------- Permissões ----------
function canSee(ctx, r) {
  const { user } = ctx;
  if (isAdmin(user)) return true;
  if (r.created_by === user.id || r.assignee_id === user.id) return true;
  return canAccessProject(user, r.project_id, ctx.projects) && user.access_scope !== 'proprias';
}
function canManage(ctx, r) {
  const { user } = ctx;
  if (isAdmin(user) || r.created_by === user.id) return true;
  return user.role === 'gestor' && canAccessProject(user, r.project_id, ctx.projects) && user.access_scope !== 'proprias';
}
function load(ctx, id) {
  const r = one(`${BASE} WHERE r.id = ?`, id);
  if (!r || !canSee(ctx, r)) throw notFound('Recorrência não encontrada.');
  return r;
}

// ---------- Geração das ocorrências ----------
// Cria as ocorrências com prazo até hoje + antecedência. Idempotente: usa generated_count para não repetir datas.
export function generateFor(recId, ref = today()) {
  const r = one(`${BASE} WHERE r.id = ?`, recId);
  if (!r || !r.active) return [];
  const project = one('SELECT * FROM projects WHERE id = ?', r.project_id);
  if (['concluido', 'cancelado'].includes(project.status)) {
    endInternal(r, null, `Projeto ${project.status === 'concluido' ? 'concluído' : 'cancelado'}`);
    return [];
  }
  const rule = ruleOf(r);
  const horizon = addDays(ref, r.lead_days);
  const dates = [...occurrenceDates(rule, { until: horizon, limit: r.generated_count + 200 })].slice(r.generated_count);
  const files = all('SELECT stored_name, mime, caption FROM recurrence_files WHERE recurrence_id = ?', r.id);
  const created = [];
  tx(() => {
    let seq = r.generated_count;
    for (const due of dates) {
      seq++;
      // Responsável que perdeu acesso ao projeto: ocorrência criada sem responsável (fica registrado)
      const assigneeOk = !r.assignee_id || userHasProjectAccess(r.assignee_id, r.project_id);
      const data = {
        title: r.title, description: r.description, field_summary: r.field_summary, notes: r.notes,
        priority: r.priority, proof_type: r.proof_type, assignee_id: assigneeOk ? r.assignee_id : null,
        due_date: due, start_date: r.duration_days > 1 ? addDays(due, -(r.duration_days - 1)) : null,
      };
      // Classificação removida do projeto: ocorrência vai para "Geral"
      const stageOk = r.stage_id && one('SELECT id FROM project_stages WHERE id = ? AND project_id = ?', r.stage_id, r.project_id);
      const id = insertTask({ project, data, stageInput: stageOk ? r.stage_id : null, creatorId: r.created_by, copyFiles: files,
        recurrence: { id: r.id, seq, label: describeRule(rule) } });
      if (!assigneeOk) taskHistory(id, r.created_by, 'Sem responsável', 'O responsável definido na recorrência não tem mais acesso ao projeto.');
      created.push(id);
    }
    const last = dates.at(-1) || r.last_generated_date;
    run('UPDATE recurrences SET generated_count = ?, last_generated_date = ?, updated_at = ? WHERE id = ?', seq, last, nowIso(), r.id);
    // Fim natural: não há mais datas na regra
    const remaining = [...occurrenceDates(rule, { limit: seq + 1 })].length > seq;
    if (!remaining) endInternal({ ...r, generated_count: seq }, null, 'Término da recorrência atingido');
  });
  return created;
}

export function generateAll(ref = today()) {
  let total = 0;
  for (const { id } of all('SELECT id FROM recurrences WHERE active = 1')) {
    try { total += generateFor(id, ref).length; } catch (e) { console.error(`[recorrência ${id}]`, e.message); }
  }
  return total;
}

function endInternal(r, userId, reason) {
  run('UPDATE recurrences SET active = 0, ended_at = ?, ended_by = ?, end_reason = ?, updated_at = ? WHERE id = ?',
    nowIso(), userId, reason, nowIso(), r.id);
}

// ---------- Operações ----------
export function createRecurrence(ctx, body, ip) {
  const projectId = intOrNull(body.project_id);
  const project = projectId && one('SELECT * FROM projects WHERE id = ?', projectId);
  if (!project) throw badRequest('Projeto é obrigatório.');
  if (!canCreateTaskIn(ctx, projectId)) throw forbidden('Você não tem acesso a este projeto.');
  if (['concluido', 'cancelado'].includes(project.status)) throw badRequest('Projeto encerrado não recebe novas tarefas.');
  const t = readTemplate(body, projectId);
  const rule = readRule(body, { creating: true });
  const opt = readOptions(body);
  const images = Array.isArray(body.images) ? body.images.slice(0, 10) : [];
  const id = tx(() => {
    const r = run(`INSERT INTO recurrences (project_id, title, description, field_summary, notes, assignee_id, stage_id, priority, proof_type,
        duration_days, freq, interval_n, weekdays, month_day, workdays_only, start_date, end_type, end_date, end_count, lead_days, created_by, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      projectId, t.title, t.description, t.field_summary, t.notes, t.assignee_id, t.stage_id, t.priority, t.proof_type,
      opt.duration_days, rule.freq, rule.interval, rule.weekdays.join(',') || null, rule.month_day, rule.workdays_only ? 1 : 0,
      rule.start_date, rule.end_type, rule.end_date, rule.end_count, opt.lead_days, ctx.user.id, nowIso(), nowIso());
    const rid = Number(r.lastInsertRowid);
    for (const img of images) {
      const f = saveImageFromDataUrl(img.data);
      run('INSERT INTO recurrence_files (recurrence_id, stored_name, mime, size, caption, uploaded_by) VALUES (?,?,?,?,?,?)',
        rid, f.stored_name, f.mime, f.size, str(img.caption, { max: 200, label: 'Legenda' }), ctx.user.id);
    }
    audit(ctx.user.id, 'recurrence', rid, 'Recorrência criada', { projeto: project.code, titulo: t.title, regra: describeRule(rule) }, ip);
    return rid;
  });
  const generated = generateFor(id);
  return { id, generated: generated.length, first_task_id: generated[0] || null };
}

export function listRecurrences(ctx, { project } = {}) {
  const pid = intOrNull(project);
  return all(`${BASE} ${pid ? 'WHERE r.project_id = ?' : ''} ORDER BY r.active DESC, r.id DESC`, ...(pid ? [pid] : []))
    .filter(r => canSee(ctx, r))
    .map(r => decorate(ctx, r));
}

function decorate(ctx, r) {
  const rule = ruleOf(r);
  const next = r.active ? [...occurrenceDates(rule, { limit: r.generated_count + 3 })].slice(r.generated_count) : [];
  return { ...r, rule, description: describeRule(rule), next_dates: next, can_manage: canManage(ctx, r) };
}

export function getRecurrence(ctx, id) {
  const r = load(ctx, id);
  const d = decorate(ctx, r);
  const rule = ruleOf(r);
  d.next_dates = r.active ? [...occurrenceDates(rule, { limit: r.generated_count + 6 })].slice(r.generated_count) : [];
  d.total_planned = r.end_type === 'nunca' ? null : [...occurrenceDates(rule, { limit: 501 })].length;
  d.files = all('SELECT id, mime, caption FROM recurrence_files WHERE recurrence_id = ? ORDER BY id', id);
  d.tasks = [...listVisible(ctx, 'WHERE t.recurrence_id = ?', id), ...listCancelled(ctx, 'WHERE t.recurrence_id = ?', id)]
    .sort((a, b) => (a.recurrence_seq || 0) - (b.recurrence_seq || 0));
  return d;
}

export function updateRecurrence(ctx, id, body, ip) {
  const r = load(ctx, id);
  if (!canManage(ctx, r)) throw forbidden('Você não pode editar esta recorrência.');
  if (!r.active) throw badRequest('Recorrência encerrada não pode ser editada.');
  const t = readTemplate({ ...r, ...body }, r.project_id);
  // Frequência e 1ª ocorrência são fixas; término, antecedência e duração podem mudar
  const rule = readRule({ ...ruleOf(r), interval: r.interval_n, weekdays: ruleOf(r).weekdays, ...pick(body, ['end_type', 'end_date', 'end_count']) }, { current: r });
  const opt = readOptions({ lead_days: body.lead_days ?? r.lead_days, duration_days: body.duration_days ?? r.duration_days });
  tx(() => {
    run(`UPDATE recurrences SET title=?, description=?, field_summary=?, notes=?, assignee_id=?, stage_id=?, priority=?, proof_type=?,
        duration_days=?, lead_days=?, end_type=?, end_date=?, end_count=?, updated_at=? WHERE id=?`,
      t.title, t.description, t.field_summary, t.notes, t.assignee_id, t.stage_id, t.priority, t.proof_type,
      opt.duration_days, opt.lead_days, rule.end_type, rule.end_date, rule.end_count, nowIso(), id);
    audit(ctx.user.id, 'recurrence', id, 'Recorrência alterada (vale para as próximas ocorrências)', { titulo: t.title, regra: describeRule(rule), antecedencia: opt.lead_days }, ip);
  });
  generateFor(id);
}

const pick = (o, keys) => Object.fromEntries(keys.filter(k => k in o).map(k => [k, o[k]]));

export function endRecurrence(ctx, id, body, ip) {
  const r = load(ctx, id);
  if (!canManage(ctx, r)) throw forbidden('Você não pode encerrar esta recorrência.');
  if (!r.active) throw badRequest('A recorrência já está encerrada.');
  const reason = str(body.reason, { max: 1000, required: true, label: 'Motivo do encerramento' });
  let cancelled = 0;
  tx(() => {
    endInternal(r, ctx.user.id, reason);
    if (body.cancel_future) {
      // Cancela ocorrências futuras ainda não iniciadas
      const now = nowIso();
      for (const t of all(`SELECT id FROM tasks WHERE recurrence_id = ? AND status = 'aberta' AND cancelled_at IS NULL AND due_date >= ?`, id, today())) {
        run('UPDATE tasks SET cancelled_at = ?, cancelled_by = ?, cancel_reason = ?, updated_at = ? WHERE id = ?', now, ctx.user.id, `Recorrência encerrada: ${reason}`, now, t.id);
        taskHistory(t.id, ctx.user.id, 'Tarefa cancelada', `Recorrência encerrada: ${reason}`);
        cancelled++;
      }
    }
    audit(ctx.user.id, 'recurrence', id, 'Recorrência encerrada', { titulo: r.title, motivo: reason, ocorrencias_canceladas: cancelled }, ip);
  });
  return { cancelled };
}

export function recurrenceFileForUser(ctx, fileId) {
  const f = one('SELECT * FROM recurrence_files WHERE id = ?', fileId);
  if (!f) throw notFound();
  load(ctx, f.recurrence_id);
  return f;
}

