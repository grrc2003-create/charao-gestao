// Rastreabilidade: histórico por tarefa e auditoria administrativa.
import { run, all } from '../db.js';

export function taskHistory(taskId, userId, action, details = null) {
  run('INSERT INTO task_history (task_id, user_id, action, details, created_at) VALUES (?,?,?,?,?)',
    taskId, userId, action, details, new Date().toISOString());
}

export function audit(actorId, entity, entityId, action, details = null, ip = null) {
  run('INSERT INTO audit_log (actor_id, entity, entity_id, action, details, ip, created_at) VALUES (?,?,?,?,?,?,?)',
    actorId, entity, entityId, action, details ? JSON.stringify(details) : null, ip, new Date().toISOString());
}

export function listAudit(limit = 200) {
  return all(`SELECT a.*, u.name AS actor_name FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id
    ORDER BY a.id DESC LIMIT ?`, limit);
}
