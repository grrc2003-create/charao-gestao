// Reembolsos: a pessoa lança no Meu painel (data, valor, descrição e comprovante); quem cuida da Folha
// (seção folha) puxa o reembolso para o lançamento da pessoa na folha do mês, ou recusa com o motivo.
import { all, one, run, tx } from '../db.js';
import { badRequest, forbidden, notFound, str, date, intOrNull } from '../lib/http.js';
import { hasSection, requireSection } from '../lib/permissions.js';
import { audit } from './audit.js';
import { saveImageFromDataUrl, cleanFileName } from './files.js';
import { today } from './metrics.js';

const r2 = v => Math.round((Number(v) || 0) * 100) / 100;
const isPayroll = user => hasSection(user, 'folha');

const BASE = `SELECT r.*, u.name AS user_name, pm.ref AS month_ref, pm.status AS month_status, pm.id AS month_id, d.name AS decided_by_name
  FROM reimbursements r JOIN users u ON u.id = r.user_id
  LEFT JOIN payroll_entries e ON e.id = r.entry_id LEFT JOIN payroll_months pm ON pm.id = e.month_id
  LEFT JOIN users d ON d.id = r.decided_by`;

function shape(r) {
  const files = all('SELECT id, mime, size, original_name FROM reimbursement_files WHERE reimbursement_id = ? ORDER BY id', r.id);
  const paid = r.status === 'incluido' && r.month_status === 'fechada';
  return { ...r, files, situation: paid ? 'pago' : r.status };
}

function load(id) {
  const r = one(`${BASE} WHERE r.id = ?`, id);
  if (!r) throw notFound('Reembolso não encontrado.');
  return r;
}

// ---------- Pessoa (Meu painel) ----------
export function myReimbursements(ctx) {
  const list = all(`${BASE} WHERE r.user_id = ? ORDER BY r.created_at DESC LIMIT 60`, ctx.user.id).map(shape);
  return {
    items: list,
    pending_total: r2(list.filter(r => r.status === 'enviado').reduce((s, r) => s + r.amount, 0)),
  };
}

export function createReimbursement(ctx, body, ip) {
  const b = body || {};
  const d = {
    expense_date: date(b.expense_date, 'Data da despesa'),
    amount: r2(String(b.amount ?? '').replace(',', '.')),
    description: str(b.description, { max: 300, required: true, label: 'Descrição' }),
  };
  if (!d.expense_date) throw badRequest('Informe a data da despesa.');
  if (d.expense_date > today()) throw badRequest('A data da despesa não pode ser futura.');
  if (!(d.amount > 0)) throw badRequest('Informe o valor do reembolso.');
  if (d.amount > 100000) throw badRequest('Valor acima do limite.');
  const files = Array.isArray(b.files) ? b.files.slice(0, 10) : [];
  if (!files.length) throw badRequest('Anexe o comprovante (foto ou PDF).');
  const id = tx(() => {
    const nid = Number(run('INSERT INTO reimbursements (user_id, expense_date, amount, description) VALUES (?,?,?,?)', ctx.user.id, d.expense_date, d.amount, d.description).lastInsertRowid);
    for (const f of files) {
      const saved = saveImageFromDataUrl(f.data);
      run('INSERT INTO reimbursement_files (reimbursement_id, stored_name, mime, size, original_name, uploaded_by) VALUES (?,?,?,?,?,?)', nid, saved.stored_name, saved.mime, saved.size, cleanFileName(f.name), ctx.user.id);
    }
    return nid;
  });
  audit(ctx.user.id, 'reimbursement', id, 'Reembolso lançado', { valor: d.amount }, ip);
  return shape(load(id));
}

export function cancelReimbursement(ctx, id, ip) {
  const r = load(id);
  if (r.user_id !== ctx.user.id) throw forbidden('Somente quem lançou pode cancelar.');
  if (r.status !== 'enviado') throw badRequest('Só é possível cancelar enquanto o reembolso aguarda a folha.');
  run(`UPDATE reimbursements SET status = 'cancelado', updated_at = datetime('now') WHERE id = ?`, id);
  audit(ctx.user.id, 'reimbursement', id, 'Reembolso cancelado', null, ip);
  return myReimbursements(ctx);
}

export function reimbursementFileForUser(ctx, fileId) {
  const f = one('SELECT f.*, r.user_id FROM reimbursement_files f JOIN reimbursements r ON r.id = f.reimbursement_id WHERE f.id = ?', fileId);
  if (!f || (f.user_id !== ctx.user.id && !isPayroll(ctx.user))) throw notFound('Arquivo não encontrado.');
  return f;
}

// ---------- Folha ----------
// Reembolsos que aguardam a folha (todos, ou só das pessoas informadas)
export function pendingReimbursements(userIds = null) {
  const rows = all(`${BASE} WHERE r.status = 'enviado' ORDER BY r.expense_date, r.id`).map(shape);
  return userIds ? rows.filter(r => userIds.includes(r.user_id)) : rows;
}
// Reembolsos já puxados para um lançamento da folha
export const entryReimbursements = entryId => all(`${BASE} WHERE r.entry_id = ? AND r.status = 'incluido' ORDER BY r.expense_date, r.id`, entryId).map(shape);

export function listForPayroll(ctx) {
  requireSection(ctx.user, 'folha');
  const inPayroll = new Set(all('SELECT user_id FROM payroll_people WHERE active = 1').map(r => r.user_id));
  return pendingReimbursements().map(r => ({ ...r, in_payroll: inPayroll.has(r.user_id) }));
}

function entryOpen(entryId) {
  const e = one('SELECT e.*, m.status AS month_status, m.ref, p.user_id FROM payroll_entries e JOIN payroll_months m ON m.id = e.month_id JOIN payroll_people p ON p.id = e.person_id WHERE e.id = ?', entryId);
  if (!e) throw notFound('Lançamento da folha não encontrado.');
  if (e.month_status !== 'aberta') throw badRequest('A folha está fechada. Reabra para alterar.');
  return e;
}

// Puxar para a folha (lançamento da própria pessoa)
export function includeReimbursement(ctx, id, entryId, ip) {
  requireSection(ctx.user, 'folha');
  const r = load(id);
  if (r.status !== 'enviado') throw badRequest('Este reembolso não está aguardando a folha.');
  const e = entryOpen(intOrNull(entryId));
  if (e.user_id !== r.user_id) throw badRequest('O reembolso precisa ir para o lançamento da mesma pessoa.');
  run(`UPDATE reimbursements SET status = 'incluido', entry_id = ?, decided_by = ?, decided_at = ?, updated_at = datetime('now') WHERE id = ?`, e.id, ctx.user.id, new Date().toISOString(), id);
  audit(ctx.user.id, 'reimbursement', id, 'Reembolso incluído na folha', { folha: e.ref, valor: r.amount }, ip);
  return e.month_id;
}

// Tirar da folha (volta a aguardar)
export function releaseReimbursement(ctx, id, ip) {
  requireSection(ctx.user, 'folha');
  const r = load(id);
  if (r.status !== 'incluido' || !r.entry_id) throw badRequest('Este reembolso não está em uma folha.');
  const e = entryOpen(r.entry_id);
  run(`UPDATE reimbursements SET status = 'enviado', entry_id = NULL, decided_by = NULL, decided_at = NULL, updated_at = datetime('now') WHERE id = ?`, id);
  audit(ctx.user.id, 'reimbursement', id, 'Reembolso retirado da folha', { folha: e.ref }, ip);
  return e.month_id;
}

export function rejectReimbursement(ctx, id, body, ip) {
  requireSection(ctx.user, 'folha');
  const r = load(id);
  if (r.status !== 'enviado') throw badRequest('Só é possível recusar reembolsos que aguardam a folha.');
  const note = str(body?.note, { max: 500, required: true, label: 'Motivo da recusa' });
  run(`UPDATE reimbursements SET status = 'recusado', decision_note = ?, decided_by = ?, decided_at = ?, updated_at = datetime('now') WHERE id = ?`, note, ctx.user.id, new Date().toISOString(), id);
  audit(ctx.user.id, 'reimbursement', id, 'Reembolso recusado', { motivo: note }, ip);
  return { ok: true };
}

// Lançamento/folha removidos: reembolsos voltam a aguardar
export function releaseByEntries(entryIds) {
  for (const id of entryIds) run(`UPDATE reimbursements SET status = 'enviado', entry_id = NULL, decided_by = NULL, decided_at = NULL, updated_at = datetime('now') WHERE entry_id = ? AND status = 'incluido'`, id);
}
