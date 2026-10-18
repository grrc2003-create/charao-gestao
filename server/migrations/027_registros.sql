-- Registros do projeto: observações, definições, atas de reunião, pendências e outros tipos cadastráveis.
-- Cada tipo tem um comportamento: nota | decisao | reuniao | pendencia. Migração apenas aditiva.
CREATE TABLE record_types (
  id                INTEGER PRIMARY KEY,
  name              TEXT NOT NULL UNIQUE COLLATE NOCASE,
  behavior          TEXT NOT NULL CHECK (behavior IN ('nota', 'decisao', 'reuniao', 'pendencia')),
  color             TEXT NOT NULL DEFAULT '#2A3D50',
  prefix            TEXT,                         -- numeração própria (ex.: ATA → ATA-PRJ-001-001); NULL = sem numeração
  requires_approval INTEGER NOT NULL DEFAULT 0,   -- fica "Aguardando aprovação" até gestor/administrador aprovar
  internal          INTEGER NOT NULL DEFAULT 0,   -- terceirizados não veem
  allow_colab       INTEGER NOT NULL DEFAULT 0,   -- colaboradores também criam
  in_report         INTEGER NOT NULL DEFAULT 1,   -- entra no relatório História do projeto
  active            INTEGER NOT NULL DEFAULT 1,
  sort_order        INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO record_types (name, behavior, color, prefix, requires_approval, internal, allow_colab, sort_order) VALUES
  ('Observação', 'nota', '#5B6B7A', NULL, 0, 0, 1, 1),
  ('Definição', 'decisao', '#1F6FB2', 'DEF', 0, 0, 0, 2),
  ('Ata de reunião', 'reuniao', '#2A3D50', 'ATA', 0, 0, 0, 3),
  ('Solicitação do cliente', 'pendencia', '#C9520F', 'SOL', 0, 0, 1, 4),
  ('Alteração de escopo / aditivo', 'decisao', '#8E44AD', 'ALT', 1, 1, 0, 5),
  ('Ocorrência / incidente', 'nota', '#C0392B', 'OCO', 0, 0, 1, 6),
  ('Visita técnica / vistoria', 'nota', '#16A085', 'VIS', 0, 0, 1, 7),
  ('Comunicado / notificação', 'nota', '#B7950B', 'COM', 0, 0, 0, 8),
  ('Pendência de projeto (RFI)', 'pendencia', '#D35400', 'RFI', 0, 0, 1, 9),
  ('Lição aprendida', 'nota', '#27AE60', NULL, 0, 1, 1, 10);

CREATE TABLE project_records (
  id            INTEGER PRIMARY KEY,
  project_id    INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  type_id       INTEGER NOT NULL REFERENCES record_types(id),
  seq           INTEGER,                          -- sequência do tipo no projeto (quando o tipo tem numeração)
  code          TEXT,
  title         TEXT NOT NULL,
  body          TEXT,
  record_date   TEXT NOT NULL,                    -- quando aconteceu (aparece no Gantt e na história)
  status        TEXT NOT NULL CHECK (status IN ('ativo', 'rascunho', 'emitida', 'aguardando_aprovacao', 'vigente', 'substituida',
                                                'reprovada', 'aberta', 'cancelada')),
  pinned        INTEGER NOT NULL DEFAULT 0,
  origin        TEXT,                             -- origem (reunião, e-mail, obra, cliente…)
  decided_by    TEXT,                             -- quem definiu / solicitou
  replaces_id   INTEGER REFERENCES project_records(id),
  replaced_by_id INTEGER REFERENCES project_records(id),
  source_record_id INTEGER REFERENCES project_records(id),  -- definição gerada por uma ata
  assignee_id   INTEGER REFERENCES users(id),
  due_date      TEXT,
  task_id       INTEGER REFERENCES tasks(id) ON DELETE SET NULL,  -- tarefa gerada (pendência)
  meeting_time  TEXT,
  location      TEXT,
  participants  TEXT,                             -- JSON: [{name, company}] (lista de nomes)
  agenda        TEXT,
  approved_by   INTEGER REFERENCES users(id),
  approved_at   TEXT,
  approval_note TEXT,
  emitted_by    INTEGER REFERENCES users(id),
  emitted_at    TEXT,
  cancelled_by  INTEGER REFERENCES users(id),
  cancelled_at  TEXT,
  cancel_reason TEXT,
  created_by    INTEGER NOT NULL REFERENCES users(id),
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_records_project ON project_records(project_id, record_date);
CREATE INDEX idx_records_type ON project_records(type_id);

-- Itens da ata: informação, definição (gera um registro de Definição) ou demanda (gera uma tarefa)
CREATE TABLE record_items (
  id           INTEGER PRIMARY KEY,
  record_id    INTEGER NOT NULL REFERENCES project_records(id) ON DELETE CASCADE,
  seq          INTEGER NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('info', 'definicao', 'demanda')),
  text         TEXT NOT NULL,
  assignee_id  INTEGER REFERENCES users(id),
  due_date     TEXT,
  task_id      INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
  decision_id  INTEGER REFERENCES project_records(id) ON DELETE SET NULL,
  addendum     INTEGER NOT NULL DEFAULT 0,        -- incluído depois da emissão (adendo)
  created_by   INTEGER REFERENCES users(id),
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_record_items_record ON record_items(record_id);

CREATE TABLE record_files (
  id            INTEGER PRIMARY KEY,
  record_id     INTEGER NOT NULL REFERENCES project_records(id) ON DELETE CASCADE,
  stored_name   TEXT NOT NULL UNIQUE,
  mime          TEXT NOT NULL,
  size          INTEGER NOT NULL,
  caption       TEXT,
  original_name TEXT,
  uploaded_by   INTEGER NOT NULL REFERENCES users(id),
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_record_files_record ON record_files(record_id);

-- Tarefa gerada por um registro (pendência ou demanda de ata): origem visível na tarefa
ALTER TABLE tasks ADD COLUMN origin_record_id INTEGER REFERENCES project_records(id);
