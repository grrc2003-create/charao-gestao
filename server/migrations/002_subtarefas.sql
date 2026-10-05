-- @foreign_keys_off
-- Subtarefas: tarefa com parent_id. A sequência passa a ser única por projeto (tarefas principais)
-- e por tarefa-mãe (subtarefas). Reconstrução da tabela conforme o procedimento oficial do SQLite;
-- todos os dados, arquivos e históricos existentes são preservados.
CREATE TABLE tasks_new (
  id            INTEGER PRIMARY KEY,
  code          TEXT NOT NULL UNIQUE,
  project_id    INTEGER NOT NULL REFERENCES projects(id),
  parent_id     INTEGER REFERENCES tasks(id),
  seq           INTEGER NOT NULL,
  sub_seq       INTEGER NOT NULL DEFAULT 0,
  title         TEXT NOT NULL,
  description   TEXT NOT NULL DEFAULT '',
  field_summary TEXT,
  notes         TEXT,
  assignee_id   INTEGER REFERENCES users(id),
  assigned_by_id INTEGER REFERENCES users(id),
  creator_id    INTEGER NOT NULL REFERENCES users(id),
  due_date      TEXT,
  priority      TEXT NOT NULL DEFAULT 'media' CHECK (priority IN ('baixa','media','alta','urgente')),
  status        TEXT NOT NULL DEFAULT 'aberta'
                CHECK (status IN ('aberta','em_andamento','aguardando_conferencia','concluida')),
  proof_type    TEXT NOT NULL DEFAULT 'nenhuma' CHECK (proof_type IN ('nenhuma','foto','descricao','foto_descricao')),
  exec_description TEXT,
  exec_notes    TEXT,
  delivered_at  TEXT,
  review_status TEXT CHECK (review_status IN ('pendente','aprovada','devolvida')),
  review_comment TEXT,
  reviewed_by   INTEGER REFERENCES users(id),
  reviewed_at   TEXT,
  completed_at  TEXT,
  started_at    TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO tasks_new (id, code, project_id, parent_id, seq, sub_seq, title, description, field_summary, notes, assignee_id,
  assigned_by_id, creator_id, due_date, priority, status, proof_type, exec_description, exec_notes, delivered_at, review_status,
  review_comment, reviewed_by, reviewed_at, completed_at, started_at, created_at, updated_at)
SELECT id, code, project_id, NULL, seq, 0, title, description, field_summary, notes, assignee_id,
  assigned_by_id, creator_id, due_date, priority, status, proof_type, exec_description, exec_notes, delivered_at, review_status,
  review_comment, reviewed_by, reviewed_at, completed_at, started_at, created_at, updated_at
FROM tasks;

DROP TABLE tasks;
ALTER TABLE tasks_new RENAME TO tasks;

CREATE UNIQUE INDEX ux_tasks_project_seq ON tasks(project_id, seq) WHERE parent_id IS NULL;
CREATE UNIQUE INDEX ux_tasks_parent_seq ON tasks(parent_id, seq) WHERE parent_id IS NOT NULL;
CREATE INDEX idx_tasks_project ON tasks(project_id);
CREATE INDEX idx_tasks_assignee ON tasks(assignee_id);
CREATE INDEX idx_tasks_status ON tasks(status);
CREATE INDEX idx_tasks_parent ON tasks(parent_id);
