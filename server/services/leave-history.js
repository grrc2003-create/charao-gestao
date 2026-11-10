// Histórico de ausências combinadas e férias/recesso: as solicitações da própria pessoa, as que ela aprovou
// e (administrador) todas as aprovadas, que ele pode excluir.
import { all } from '../db.js';
import { isAdmin } from '../lib/permissions.js';
import { modeOf, LABEL } from './vacations.js';

const ABS = `SELECT a.*, u.name AS user_name, u.job_title, rb.name AS requested_by_name, db.name AS decided_by_name, cb.name AS checked_by_name
  FROM absences a JOIN users u ON u.id = a.user_id LEFT JOIN users rb ON rb.id = a.requested_by LEFT JOIN users db ON db.id = a.decided_by LEFT JOIN users cb ON cb.id = a.makeup_checked_by`;
const VAC = `SELECT v.*, u.name AS user_name, u.job_title, u.employment, rb.name AS requested_by_name, db.name AS decided_by_name
  FROM vacations v JOIN users u ON u.id = v.user_id LEFT JOIN users rb ON rb.id = v.requested_by LEFT JOIN users db ON db.id = v.decided_by`;

const common = r => ({ id: r.id, user_id: r.user_id, user_name: r.user_name, job_title: r.job_title, status: r.status, note: r.note, decision_note: r.decision_note,
  requested_by_name: r.requested_by_name, decided_by_name: r.decided_by_name, decided_at: r.decided_at, created_at: r.created_at });
const absRow = a => ({ ...common(a), key: `a${a.id}`, type: 'ausencia', kind: a.kind, start_date: a.off_date, end_date: a.off_date, makeup_date: a.makeup_date, makeup_status: a.makeup_status,
  checked_by_name: a.checked_by_name, task_id: a.task_id });
const vacRow = v => ({ ...common(v), key: `v${v.id}`, type: 'ferias', label: LABEL[modeOf(v)], start_date: v.start_date, end_date: v.end_date, days: v.days });
const byDate = (a, b) => b.start_date.localeCompare(a.start_date) || b.key.localeCompare(a.key);

const rows = (where, ...args) => [...all(`${ABS} WHERE ${where.replace(/\bT\./g, 'a.')}`, ...args).map(absRow), ...all(`${VAC} WHERE ${where.replace(/\bT\./g, 'v.')}`, ...args).map(vacRow)].sort(byDate);

export function leaveHistory(ctx) {
  const admin = isAdmin(ctx.user);
  return {
    mine: rows('T.user_id = ?', ctx.user.id),
    approved: rows(`T.status = 'aprovada' AND T.decided_by = ?`, ctx.user.id),
    all: admin ? rows(`T.status = 'aprovada'`) : null,
    can_delete: admin,
  };
}
