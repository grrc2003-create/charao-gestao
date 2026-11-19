-- Folha de Campo: contrato de mão de obra da obra (encontro de contas com o fornecedor).
-- A obra define se tem contrato de mão de obra (fornecedor + valor). A cada folha, o que foi pago na folha é comparado
-- com a medição do fornecedor do mesmo período (lançada na própria folha, usando a medição do terceiro já existente):
-- medido − pago = saldo do fornecedor (positivo: a empresa deve a ele; negativo: ele recebeu a mais).
-- Obra já em andamento: informa o que já foi medido e o saldo do fornecedor até ali, e a folha a partir da qual a conta segue.
-- Lançamentos opcionais: aditivo (aumenta o valor do contrato) e retrabalho/gasto extra por falha do fornecedor pago pelo
-- cliente (desconta do saldo do fornecedor só quando marcado como válido para desconto).
-- Migração apenas aditiva.
CREATE TABLE field_labor_contracts (
  id              INTEGER PRIMARY KEY,
  project_id      INTEGER NOT NULL UNIQUE REFERENCES projects(id) ON DELETE CASCADE,
  supplier        TEXT NOT NULL,                                       -- fornecedor da mão de obra
  supplier_doc    TEXT,                                                -- CPF/CNPJ
  total           REAL NOT NULL,                                       -- valor do contrato
  start_sheet_id  INTEGER REFERENCES field_sheets(id) ON DELETE SET NULL, -- a conta segue a partir desta folha (vazio = todas)
  prior_measured  REAL NOT NULL DEFAULT 0,                             -- já medido antes (obra já em andamento)
  prior_balance   REAL NOT NULL DEFAULT 0,                             -- saldo do fornecedor antes (+ a favor dele, − contra)
  notes           TEXT,
  created_by      INTEGER REFERENCES users(id),
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE field_labor_entries (
  id           INTEGER PRIMARY KEY,
  contract_id  INTEGER NOT NULL REFERENCES field_labor_contracts(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL CHECK (kind IN ('aditivo', 'retrabalho')),
  ref_date     TEXT NOT NULL,
  amount       REAL NOT NULL,
  description  TEXT NOT NULL,
  deduct       INTEGER NOT NULL DEFAULT 0,                             -- retrabalho: 1 = desconta do saldo do fornecedor
  created_by   INTEGER REFERENCES users(id),
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_field_labor_entries ON field_labor_entries(contract_id);

-- Comprovantes / fotos do lançamento (PDF ou imagem)
CREATE TABLE field_labor_entry_files (
  id             INTEGER PRIMARY KEY,
  entry_id       INTEGER NOT NULL REFERENCES field_labor_entries(id) ON DELETE CASCADE,
  stored_name    TEXT NOT NULL UNIQUE,
  mime           TEXT NOT NULL,
  size           INTEGER NOT NULL,
  original_name  TEXT,
  uploaded_by    INTEGER REFERENCES users(id),
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_field_labor_entry_files ON field_labor_entry_files(entry_id);
