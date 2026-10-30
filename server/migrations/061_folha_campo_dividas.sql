-- Folha de Campo: dívidas anteriores da obra (de antes do sistema ou fora das folhas), com o motivo.
--  · empresa_deve: a empresa deve ao profissional (ex.: diárias antigas não pagas)
--  · profissional_deve: o profissional deve à empresa (ex.: adiantamento/vale antigo)
--  · pago_mais: a obra já tinha pago a mais do que o terceiro mediu (entra no saldo perante a medição)
-- Baixa só marcando "quitada" (não mexe nas folhas). Somente a seção folha_campo. Migração apenas aditiva.
CREATE TABLE field_debts (
  id            INTEGER PRIMARY KEY,
  project_id    INTEGER NOT NULL REFERENCES projects(id),
  kind          TEXT NOT NULL CHECK (kind IN ('empresa_deve', 'profissional_deve', 'pago_mais')),
  worker_id     INTEGER REFERENCES field_workers(id),
  origin_date   TEXT NOT NULL,
  amount        REAL NOT NULL,
  reason        TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'aberta' CHECK (status IN ('aberta', 'quitada')),
  settled_date  TEXT,
  settled_note  TEXT,
  settled_by    INTEGER REFERENCES users(id),
  created_by    INTEGER REFERENCES users(id),
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_field_debts_project ON field_debts(project_id);
CREATE INDEX idx_field_debts_worker ON field_debts(worker_id);

-- Comprovante (PDF) da dívida
CREATE TABLE field_debt_files (
  id            INTEGER PRIMARY KEY,
  debt_id       INTEGER NOT NULL REFERENCES field_debts(id) ON DELETE CASCADE,
  stored_name   TEXT NOT NULL UNIQUE,
  mime          TEXT NOT NULL,
  size          INTEGER NOT NULL,
  original_name TEXT,
  uploaded_by   INTEGER REFERENCES users(id),
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_field_debt_files ON field_debt_files(debt_id);
