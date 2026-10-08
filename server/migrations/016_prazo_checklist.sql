-- Check-list: o prazo da tarefa acompanha o maior prazo dos itens. Ajuste único dos check-lists em aberto
-- (concluídos e cancelados ficam como estão). O ajuste fica registrado no histórico de cada check-list.
INSERT INTO task_history (task_id, user_id, action, details, created_at)
SELECT t.id, NULL, 'Prazo do check-list ajustado',
  COALESCE(substr(t.due_date, 9, 2) || '/' || substr(t.due_date, 6, 2) || '/' || substr(t.due_date, 1, 4), 'sem prazo') || ' → ' ||
  substr(m.d, 9, 2) || '/' || substr(m.d, 6, 2) || '/' || substr(m.d, 1, 4) || ' · acompanha o maior prazo dos itens',
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM tasks t JOIN (SELECT task_id, MAX(due_date) AS d FROM checklist_items WHERE due_date IS NOT NULL GROUP BY task_id) m ON m.task_id = t.id
WHERE t.task_type = 'checklist' AND t.status <> 'concluida' AND t.cancelled_at IS NULL AND t.due_date IS NOT m.d;

UPDATE tasks SET due_date = (SELECT MAX(due_date) FROM checklist_items ci WHERE ci.task_id = tasks.id), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE task_type = 'checklist' AND status <> 'concluida' AND cancelled_at IS NULL
  AND (SELECT MAX(due_date) FROM checklist_items ci WHERE ci.task_id = tasks.id) IS NOT NULL
  AND due_date IS NOT (SELECT MAX(due_date) FROM checklist_items ci WHERE ci.task_id = tasks.id);
