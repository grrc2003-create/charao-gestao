-- Férias × prazos: ao solicitar férias num período com entregas, a pessoa propõe o novo prazo de cada tarefa;
-- o reagendamento só é aplicado quando o gestor/líder aprova as férias. Migração apenas aditiva.
CREATE TABLE vacation_reschedules (
  id          INTEGER PRIMARY KEY,
  vacation_id INTEGER NOT NULL REFERENCES vacations(id) ON DELETE CASCADE,
  task_id     INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  old_due     TEXT,
  new_due     TEXT NOT NULL,
  applied     INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (vacation_id, task_id)
);
CREATE INDEX idx_vacation_reschedules_task ON vacation_reschedules(task_id);

-- Justificativa usada nos reagendamentos por férias
INSERT OR IGNORE INTO reschedule_reasons (name, sort_order)
  SELECT 'Férias do responsável', COALESCE(MAX(sort_order), 0) + 1 FROM reschedule_reasons
  WHERE NOT EXISTS (SELECT 1 FROM reschedule_reasons WHERE name = 'Férias do responsável' COLLATE NOCASE);
