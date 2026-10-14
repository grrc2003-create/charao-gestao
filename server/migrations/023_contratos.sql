-- Controle de contratos: contratos fechados pela Charão, planilha contratual (itens e aditivos), medições
-- (boletins) com o ciclo Rascunho → Emitida → Faturada → Recebida e o faturamento global.
-- Acesso por liberação (users.can_contracts). As tarefas da área interna restrita "Contratos" só aparecem para os liberados.
-- Migração apenas aditiva: administradores atuais já começam liberados (podem retirar a própria liberação).
ALTER TABLE users ADD COLUMN can_contracts INTEGER NOT NULL DEFAULT 0;
UPDATE users SET can_contracts = 1 WHERE role = 'admin';

ALTER TABLE projects ADD COLUMN restricted INTEGER NOT NULL DEFAULT 0;

CREATE TABLE contracts (
  id              INTEGER PRIMARY KEY,
  code            TEXT NOT NULL UNIQUE,                 -- CT-001…
  client          TEXT NOT NULL,
  client_doc      TEXT,                                 -- CNPJ/CPF do cliente
  number          TEXT,                                 -- nº do contrato no cliente
  title           TEXT NOT NULL,                        -- objeto
  scope           TEXT,                                 -- escopo (vai no boletim)
  project_id      INTEGER REFERENCES projects(id) ON DELETE SET NULL,
  start_date      TEXT,
  end_date        TEXT,
  bulletin_prefix TEXT NOT NULL,                        -- ex.: ORBE → ORBE0036.26
  payment_info    TEXT,                                 -- dados para pagamento (rodapé do boletim)
  notes           TEXT,
  status          TEXT NOT NULL DEFAULT 'vigente' CHECK (status IN ('vigente', 'suspenso', 'encerrado')),
  created_by      INTEGER REFERENCES users(id),
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE contract_items (
  id          INTEGER PRIMARY KEY,
  contract_id INTEGER NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
  seq         INTEGER NOT NULL,
  description TEXT NOT NULL,
  unit        TEXT NOT NULL DEFAULT 'vb',
  unit_price  REAL NOT NULL DEFAULT 0,
  quantity    REAL NOT NULL DEFAULT 0,
  additive    INTEGER NOT NULL DEFAULT 0,               -- item incluído por aditivo
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_contract_items ON contract_items(contract_id, seq);

CREATE TABLE measurements (
  id           INTEGER PRIMARY KEY,
  contract_id  INTEGER NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
  seq          INTEGER NOT NULL,
  code         TEXT NOT NULL,
  ref_month    TEXT NOT NULL,                            -- AAAA-MM
  period_start TEXT,
  period_end   TEXT,
  status       TEXT NOT NULL DEFAULT 'rascunho' CHECK (status IN ('rascunho', 'emitida', 'faturada', 'recebida')),
  notes        TEXT,
  nf_number    TEXT,
  nf_date      TEXT,
  paid_date    TEXT,
  paid_amount  REAL,
  issued_at    TEXT,
  issued_by    INTEGER REFERENCES users(id),
  created_by   INTEGER REFERENCES users(id),
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (contract_id, seq)
);

CREATE TABLE measurement_lines (
  measurement_id INTEGER NOT NULL REFERENCES measurements(id) ON DELETE CASCADE,
  item_id        INTEGER NOT NULL REFERENCES contract_items(id),
  quantity       REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (measurement_id, item_id)
);

CREATE TABLE measurement_adjustments (
  id             INTEGER PRIMARY KEY,
  measurement_id INTEGER NOT NULL REFERENCES measurements(id) ON DELETE CASCADE,
  seq            INTEGER NOT NULL,
  description    TEXT NOT NULL,
  unit           TEXT NOT NULL DEFAULT 'vb',
  amount         REAL NOT NULL DEFAULT 0                -- negativo = desconto, positivo = acréscimo
);
