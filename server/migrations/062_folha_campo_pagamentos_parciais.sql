-- Folha de Campo: pagamentos registrados (valor, data, observação e comprovante), inclusive parciais.
-- Cada "Marcar pago" cria um lançamento de pagamento (lote) com um ou mais valores por pessoa/empreiteiro da folha.
-- A pessoa só fica "paga" (paid_at) quando a soma dos pagamentos cobre o valor devido; antes disso o restante segue a pagar.
-- Pagamentos já marcados antes desta migração continuam valendo como pagos integralmente. Migração apenas aditiva.
CREATE TABLE field_pay_batches (
  id          INTEGER PRIMARY KEY,
  paid_date   TEXT NOT NULL,
  total       REAL NOT NULL DEFAULT 0,
  notes       TEXT,
  created_by  INTEGER REFERENCES users(id),
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Valor pago a cada lançamento da folha (p<id> = pessoa, c<id> = empreitada)
CREATE TABLE field_payments (
  id          INTEGER PRIMARY KEY,
  batch_id    INTEGER NOT NULL REFERENCES field_pay_batches(id) ON DELETE CASCADE,
  sheet_id    INTEGER NOT NULL REFERENCES field_sheets(id) ON DELETE CASCADE,
  line        TEXT NOT NULL,
  amount      REAL NOT NULL,
  paid_date   TEXT NOT NULL,
  created_by  INTEGER REFERENCES users(id),
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_field_payments_sheet ON field_payments(sheet_id, line);

-- Comprovantes do pagamento (foto ou PDF)
CREATE TABLE field_pay_files (
  id            INTEGER PRIMARY KEY,
  batch_id      INTEGER NOT NULL REFERENCES field_pay_batches(id) ON DELETE CASCADE,
  stored_name   TEXT NOT NULL UNIQUE,
  mime          TEXT NOT NULL,
  size          INTEGER NOT NULL,
  original_name TEXT,
  uploaded_by   INTEGER REFERENCES users(id),
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_field_pay_files ON field_pay_files(batch_id);
