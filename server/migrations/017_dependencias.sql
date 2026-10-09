-- Dependências (predecessora → sucessora) entre tarefas, subtarefas e itens de check-list do mesmo projeto.
-- Tipo Término → Início: a sucessora só começa depois que a predecessora termina (+ folga em dias).
-- Cada ponta é uma tarefa (task_id) OU um item de check-list (item_id). Migração apenas aditiva.
CREATE TABLE dependencies (
  id            INTEGER PRIMARY KEY,
  project_id    INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  pred_task_id  INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
  pred_item_id  INTEGER REFERENCES checklist_items(id) ON DELETE CASCADE,
  succ_task_id  INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
  succ_item_id  INTEGER REFERENCES checklist_items(id) ON DELETE CASCADE,
  lag_days      INTEGER NOT NULL DEFAULT 0,
  created_by    INTEGER REFERENCES users(id),
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK ((pred_task_id IS NULL) <> (pred_item_id IS NULL)),
  CHECK ((succ_task_id IS NULL) <> (succ_item_id IS NULL))
);
CREATE UNIQUE INDEX ux_dependencies ON dependencies(COALESCE(pred_task_id, 0), COALESCE(pred_item_id, 0), COALESCE(succ_task_id, 0), COALESCE(succ_item_id, 0));
CREATE INDEX idx_dep_pred_task ON dependencies(pred_task_id);
CREATE INDEX idx_dep_pred_item ON dependencies(pred_item_id);
CREATE INDEX idx_dep_succ_task ON dependencies(succ_task_id);
CREATE INDEX idx_dep_succ_item ON dependencies(succ_item_id);
CREATE INDEX idx_dep_project ON dependencies(project_id);
