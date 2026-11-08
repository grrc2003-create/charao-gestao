// Ausência combinada (equipe interna): falta com reposição (dia inteiro, reposto até o fim do mês seguinte à falta)
// ou falta descontada. A pessoa pede e o gestor aprova; o gestor também pode lançar (já aprovada).
// Depois do dia da reposição, o gestor confirma: cumprida (não desconta) ou não cumprida (vira falta descontada na Folha).
import { all, one, run, tx } from '../db.js';
import { badRequest, forbidden, notFound, str, date, intOrNull, oneOf } from '../lib/http.js';
import { isAdmin, hasSection, teamIds } from '../lib/permissions.js';
import { audit } from './audit.js';
import { today } from './metrics.js';
import { canApprove } from './vacations.js';

const fmtD = d => (d ? d.split('-').reverse().join('/') : '—');
const lastDayNextMonth = d => { const [y, m] = d.split('-').map(Number); return new Date(Date.UTC(y, m + 1, 0)).toISOString().slice(0, 10); };
const nowSql = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
const LIVE = `status IN ('solicitada','aprovada')`;

const SQL = `SELECT a.*, u.name AS user_name, u.job_title, rb.name AS requested_by_name, db.name AS decided_by_name, cb.name AS checked_by_name
  FROM absences a JOIN users u ON u.id = a.user_id LEFT JOIN users rb ON rb.id = a.requested_by LEFT JOIN users db ON db.id = a.decided_by
  LEFT JOIN users cb ON cb.id = a.makeup_checked_by`;

function targetOf(id) {
  const t = one('SELECT * FROM users WHERE id = ? AND active = 1', id);
  if (!t) throw notFound('Pessoa não encontrada.');
  if (t.is_external) throw badRequest('A ausência combinada vale só para a equipe interna.');
  return t;
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
  const id = Number(run(`INSERT INTO absences (user_id, kind, off_date, makeup_date, status, makeup_status, note, requested_by, decided_by, decided_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`, t.id, kind, off, makeup, status, kind === 'reposicao' ? 'pendente' : null, note, ctx.user.id,
    status === 'aprovada' ? ctx.user.id : null, status === 'aprovada' ? nowSql() : null).lastInsertRowid);
  audit(ctx.user.id, 'absence', id, status === 'aprovada' ? 'Ausência combinada lançada' : 'Ausência combinada solicitada',
    { pessoa: t.name, tipo: kind === 'reposicao' ? 'falta com reposição' : 'falta descontada', dia: fmtD(off), reposicao: makeup ? fmtD(makeup) : undefined }, ip);
  return { id, status };
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
    run(`UPDATE absences SET status = ?, decided_by = ?, decided_at = ?, decision_note = ?, updated_at = datetime('now') WHERE id = ?`, action === 'approve' ? 'aprovada' : 'recusada', ctx.user.id, now, note, id);
    label = action === 'approve' ? 'Ausência combinada aprovada' : 'Ausência combinada recusada';
  } else if (action === 'cancel') {
    const can = (self && a.status === 'solicitada') || (approver && ['solicitada', 'aprovada'].includes(a.status));
    if (!can) throw forbidden('Você não pode cancelar esta ausência.');
    if (a.makeup_status === 'nao_cumprida' || a.makeup_status === 'cumprida') throw badRequest('A reposição já foi conferida: desfaça a conferência antes.');
    run(`UPDATE absences SET status = 'cancelada', decided_by = ?, decided_at = ?, decision_note = ?, updated_at = datetime('now') WHERE id = ?`, ctx.user.id, now, note, id);
    label = 'Ausência combinada cancelada';
  } else if (action === 'makeup_done' || action === 'makeup_missed') {
    if (!approver) throw forbidden('Só o gestor confere a reposição.');
    if (a.status !== 'aprovada' || a.kind !== 'reposicao') throw badRequest('Esta ausência não tem reposição a conferir.');
    if (a.makeup_date > today()) throw badRequest(`A reposição é em ${fmtD(a.makeup_date)}: confira a partir desse dia.`);
    run(`UPDATE absences SET makeup_status = ?, makeup_checked_by = ?, makeup_checked_at = ?, decision_note = COALESCE(?, decision_note), updated_at = datetime('now') WHERE id = ?`,
      action === 'makeup_done' ? 'cumprida' : 'nao_cumprida', ctx.user.id, now, note, id);
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
  const mine = all(`${SQL} WHERE a.user_id = ? ORDER BY a.off_date DESC LIMIT 30`, ctx.user.id);
  const canFor = new Map();
  const ok = a => { if (!canFor.has(a.user_id)) canFor.set(a.user_id, a.user_id !== ctx.user.id && canApprove(ctx, one('SELECT * FROM users WHERE id = ?', a.user_id))); return canFor.get(a.user_id); };
  const approvals = all(`${SQL} WHERE a.status = 'solicitada' ORDER BY a.off_date`).filter(ok);
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
