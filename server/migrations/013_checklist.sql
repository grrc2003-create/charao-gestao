-- Tarefa do tipo Check-list: itens com responsável próprio (opcional), resposta Conforme / Não conforme / N/A
-- (Não conforme fica pendente até ser corrigido; o histórico guarda cada resposta com suas fotos: antes × depois),
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
  description TEXT,
  assignee_id INTEGER REFERENCES users(id),
  start_date  TEXT,
  duration_days INTEGER,
  due_date    TEXT,
  result      TEXT CHECK (result IN ('conforme','nao_conforme','na')),
  note        TEXT,
  answered_by INTEGER REFERENCES users(id),
  answered_at TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_checklist_items_task ON checklist_items(task_id, seq);
CREATE INDEX idx_checklist_items_assignee ON checklist_items(assignee_id);

-- Histórico de respostas do item (cada mudança de resposta é um registro; as fotos ficam ligadas à resposta)
CREATE TABLE checklist_answers (
  id          INTEGER PRIMARY KEY,
  item_id     INTEGER NOT NULL REFERENCES checklist_items(id) ON DELETE CASCADE,
  result      TEXT NOT NULL CHECK (result IN ('conforme','nao_conforme','na')),
  note        TEXT,
  reason      TEXT,
  user_id     INTEGER NOT NULL REFERENCES users(id),
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_checklist_answers_item ON checklist_answers(item_id, id);

CREATE TABLE checklist_files (
  id          INTEGER PRIMARY KEY,
  item_id     INTEGER NOT NULL REFERENCES checklist_items(id) ON DELETE CASCADE,
  answer_id   INTEGER REFERENCES checklist_answers(id) ON DELETE SET NULL,
  -- referencia = foto de entrada do item (o "antes" inicial); resposta = foto registrada ao responder
  kind        TEXT NOT NULL DEFAULT 'resposta' CHECK (kind IN ('referencia','resposta')),
  stored_name TEXT NOT NULL UNIQUE,
  mime        TEXT NOT NULL,
  size        INTEGER NOT NULL,
  uploaded_by INTEGER NOT NULL REFERENCES users(id),
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_checklist_files_item ON checklist_files(item_id);
