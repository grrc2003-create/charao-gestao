// Prazo do projeto pelas tarefas: início = tarefa/subtarefa que começa mais cedo; fim = maior prazo.
// Impacto dos reagendamentos: reconstrói a linha do tempo do fim do projeto a partir do prazo original de cada tarefa
// (antes do 1º reagendamento) e aplica, em ordem, cada reagendamento e cada deslocamento por dependência. Só conta o que
// mudou o fim do projeto: quantas tarefas reagendadas impactaram e quantos dias atrasaram ou anteciparam.
// Tarefas principais com subtarefas ficam fora da conta (as datas delas acompanham as subtarefas).
import { all } from '../db.js';
import { daysBetween } from './metrics.js';

export function projectSchedule(projectId) {
  const tasks = all(`SELECT t.id, t.code, t.title, t.parent_id, t.start_date, t.due_date,
      EXISTS(SELECT 1 FROM tasks s WHERE s.parent_id = t.id AND s.cancelled_at IS NULL) AS has_subs
    FROM tasks t WHERE t.project_id = ? AND t.cancelled_at IS NULL`, projectId);
  if (!tasks.length) return null;
  const starts = tasks.map(t => t.start_date || t.due_date).filter(Boolean).sort();
  const dues = tasks.map(t => t.due_date).filter(Boolean).sort();
  const leaves = tasks.filter(t => !t.has_subs);
  const byId = new Map(leaves.map(t => [t.id, t]));
  const events = [
    ...all(`SELECT r.id, r.task_id, r.old_due, r.new_due, r.created_at AS at, r.task_id AS cause, 'r' AS src
      FROM task_reschedules r JOIN tasks t ON t.id = r.task_id WHERE t.project_id = ?`, projectId),
    ...all(`SELECT s.id, s.target_task_id AS task_id, s.old_due, s.new_due, e.created_at AS at, e.cause_task_id AS cause, 'd' AS src
      FROM dependency_shifts s JOIN dependency_events e ON e.id = s.event_id WHERE e.project_id = ? AND s.target_task_id IS NOT NULL`, projectId),
  ].filter(e => byId.has(e.task_id) && e.old_due && e.new_due)
    .sort((a, b) => a.at.localeCompare(b.at) || (a.src === b.src ? a.id - b.id : a.src === 'r' ? -1 : 1));
  // Prazo original de cada tarefa = antes do primeiro evento
  const due = new Map(leaves.map(t => [t.id, t.due_date]));
  const seen = new Set();
  for (const e of events) if (!seen.has(e.task_id)) { seen.add(e.task_id); due.set(e.task_id, e.old_due); }
  const maxDue = () => { let m = null; for (const v of due.values()) if (v && (!m || v > m)) m = v; return m; };
  const endOriginal = maxDue();
  let end = endOriginal, delayed = 0, advanced = 0;
  const impact = new Map();
  for (const e of events) {
    due.set(e.task_id, e.new_due);
    const ne = maxDue();
    if (end && ne && ne !== end) {
      const d = daysBetween(end, ne);
      if (d > 0) delayed += d; else advanced -= d;
      impact.set(e.cause, (impact.get(e.cause) || 0) + d);
    }
    end = ne;
  }
  const info = new Map(tasks.map(t => [t.id, t]));
  const impacting = [...impact.entries()].filter(([, d]) => d).map(([id, d]) => ({ id, code: info.get(id)?.code, title: info.get(id)?.title, days: d }))
    .filter(x => x.code).sort((a, b) => Math.abs(b.days) - Math.abs(a.days));
  return {
    start: starts[0] || null, end: dues.at(-1) || null, end_original: endOriginal,
    delayed_days: delayed, advanced_days: advanced, net_days: delayed - advanced,
    impacting_count: impacting.length, impacting: impacting.slice(0, 20),
    rescheduled_tasks: new Set(all(`SELECT DISTINCT r.task_id FROM task_reschedules r JOIN tasks t ON t.id = r.task_id WHERE t.project_id = ? AND t.cancelled_at IS NULL`, projectId).map(r => r.task_id)).size,
  };
}
