-- Vínculo entre registros do projeto e tarefas existentes (muitos para muitos). Migração apenas aditiva.
CREATE TABLE record_task_links (
  record_id  INTEGER NOT NULL REFERENCES project_records(id) ON DELETE CASCADE,
  task_id    INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (record_id, task_id)
);
CREATE INDEX idx_record_task_links_task ON record_task_links(task_id);
