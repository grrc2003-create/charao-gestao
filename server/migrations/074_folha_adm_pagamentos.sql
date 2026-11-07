-- Folha (Administrativa): pagamentos registrados por pessoa (valor, data, observação e comprovante), inclusive parciais,
-- como na Folha de Campo. Só com a folha fechada. A pessoa fica "paga" (paid_at) quando a soma cobre o total dela;
-- o pagamento correspondente no Financeiro é baixado automaticamente. Migração apenas aditiva.
ALTER TABLE payroll_entries ADD COLUMN paid_at TEXT;
ALTER TABLE payroll_entries ADD COLUMN paid_by INTEGER REFERENCES users(id);

CREATE TABLE payroll_pay_batches (
  id          INTEGER PRIMARY KEY,
  month_id    INTEGER NOT NULL REFERENCES payroll_months(id) ON DELETE CASCADE,
  paid_date   TEXT NOT NULL,
  total       REAL NOT NULL DEFAULT 0,
  notes       TEXT,
  created_by  INTEGER REFERENCES users(id),
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE payroll_payments (
  id          INTEGER PRIMARY KEY,
  batch_id    INTEGER NOT NULL REFERENCES payroll_pay_batches(id) ON DELETE CASCADE,
  entry_id    INTEGER NOT NULL REFERENCES payroll_entries(id) ON DELETE CASCADE,
  amount      REAL NOT NULL,
  paid_date   TEXT NOT NULL,
  created_by  INTEGER REFERENCES users(id),
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_payroll_payments_entry ON payroll_payments(entry_id);

CREATE TABLE payroll_pay_files (
  id            INTEGER PRIMARY KEY,
  batch_id      INTEGER NOT NULL REFERENCES payroll_pay_batches(id) ON DELETE CASCADE,
  stored_name   TEXT NOT NULL UNIQUE,
  mime          TEXT NOT NULL,
  size          INTEGER NOT NULL,
  original_name TEXT,
  uploaded_by   INTEGER REFERENCES users(id),
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_payroll_pay_files ON payroll_pay_files(batch_id);
