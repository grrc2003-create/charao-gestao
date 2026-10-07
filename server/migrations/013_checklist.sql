-- Tarefa do tipo Check-list: itens com responsável próprio (opcional), resposta Conforme / Não conforme / N/A,
-- observação e fotos. A regra de fotos (obrigatória em todos os itens ou livre escolha) é definida na criação.
-- Migração apenas aditiva: tarefas existentes ficam com task_type = 'tarefa'.
ALTER TABLE tasks ADD COLUMN task_type TEXT NOT NULL DEFAULT 'tarefa';
ALTER TABLE tasks ADD COLUMN photo_rule TEXT;

CREATE TABLE checklist_items (
  id          INTEGER PRIMARY KEY,
  task_id     INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  seq         INTEGER NOT NULL,
  group_name  TEXT,
  text        TEXT NOT NULL,
  assignee_id INTEGER REFERENCES users(id),
  result      TEXT CHECK (result IN ('conforme','nao_conforme','na')),
  note        TEXT,
  answered_by INTEGER REFERENCES users(id),
  answered_at TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_checklist_items_task ON checklist_items(task_id, seq);
CREATE INDEX idx_checklist_items_assignee ON checklist_items(assignee_id);

CREATE TABLE checklist_files (
  id          INTEGER PRIMARY KEY,
  item_id     INTEGER NOT NULL REFERENCES checklist_items(id) ON DELETE CASCADE,
  stored_name TEXT NOT NULL UNIQUE,
  mime        TEXT NOT NULL,
  size        INTEGER NOT NULL,
  uploaded_by INTEGER NOT NULL REFERENCES users(id),
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_checklist_files_item ON checklist_files(item_id);
