-- Tarefas recorrentes: a série guarda o "molde" da tarefa e a regra de repetição.
-- Cada ocorrência é uma tarefa normal (tasks.recurrence_id). Migração apenas aditiva.
CREATE TABLE recurrences (
  id             INTEGER PRIMARY KEY,
  project_id     INTEGER NOT NULL REFERENCES projects(id),
  title          TEXT NOT NULL,
  description    TEXT NOT NULL DEFAULT '',
  field_summary  TEXT,
  notes          TEXT,
  assignee_id    INTEGER REFERENCES users(id),
  stage_id       INTEGER REFERENCES project_stages(id),
  priority       TEXT NOT NULL DEFAULT 'media',
  proof_type     TEXT NOT NULL DEFAULT 'nenhuma',
  duration_days  INTEGER NOT NULL DEFAULT 1,           -- início previsto = prazo - (duração - 1)
  freq           TEXT NOT NULL CHECK (freq IN ('diaria','semanal','mensal')),
  interval_n     INTEGER NOT NULL DEFAULT 1,
  weekdays       TEXT,                                 -- '1,3' (0 = domingo)
  month_day      INTEGER,
  workdays_only  INTEGER NOT NULL DEFAULT 0,
  start_date     TEXT NOT NULL,                        -- prazo da 1ª ocorrência
  end_type       TEXT NOT NULL CHECK (end_type IN ('data','ocorrencias','nunca')),
  end_date       TEXT,
  end_count      INTEGER,
  lead_days      INTEGER NOT NULL DEFAULT 7,           -- cria cada ocorrência N dias antes do prazo
  generated_count INTEGER NOT NULL DEFAULT 0,
  last_generated_date TEXT,
  active         INTEGER NOT NULL DEFAULT 1,
  ended_at       TEXT,
  ended_by       INTEGER REFERENCES users(id),
  end_reason     TEXT,
  created_by     INTEGER NOT NULL REFERENCES users(id),
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_recurrences_project ON recurrences(project_id);

-- Imagens de referência do molde (copiadas para cada ocorrência)
CREATE TABLE recurrence_files (
  id            INTEGER PRIMARY KEY,
  recurrence_id INTEGER NOT NULL REFERENCES recurrences(id) ON DELETE CASCADE,
  stored_name   TEXT NOT NULL UNIQUE,
  mime          TEXT NOT NULL,
  size          INTEGER NOT NULL,
  caption       TEXT,
  uploaded_by   INTEGER NOT NULL REFERENCES users(id),
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

ALTER TABLE tasks ADD COLUMN recurrence_id INTEGER REFERENCES recurrences(id);
ALTER TABLE tasks ADD COLUMN recurrence_seq INTEGER;
CREATE INDEX idx_tasks_recurrence ON tasks(recurrence_id);
