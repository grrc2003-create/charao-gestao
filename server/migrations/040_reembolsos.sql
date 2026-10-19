-- Reembolsos lançados pela própria pessoa (Meu painel), com comprovante; incluídos na Folha (Administrativa) para pagamento.
-- Situação: enviado (aguarda a folha) · incluido (puxado para uma folha) · recusado · cancelado. Migração apenas aditiva.
CREATE TABLE reimbursements (
  id            INTEGER PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES users(id),
  expense_date  TEXT NOT NULL,                                  -- data da despesa
  amount        REAL NOT NULL CHECK (amount > 0),
  description   TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'enviado' CHECK (status IN ('enviado', 'incluido', 'recusado', 'cancelado')),
  entry_id      INTEGER REFERENCES payroll_entries(id) ON DELETE SET NULL,  -- lançamento da folha que paga
  decision_note TEXT,                                           -- motivo da recusa
  decided_by    INTEGER REFERENCES users(id),
  decided_at    TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_reimbursements_user ON reimbursements(user_id, status);
CREATE INDEX idx_reimbursements_entry ON reimbursements(entry_id);

CREATE TABLE reimbursement_files (
  id               INTEGER PRIMARY KEY,
  reimbursement_id INTEGER NOT NULL REFERENCES reimbursements(id) ON DELETE CASCADE,
  stored_name      TEXT NOT NULL UNIQUE,
  mime             TEXT NOT NULL,
  size             INTEGER NOT NULL,
  original_name    TEXT,
  uploaded_by      INTEGER NOT NULL REFERENCES users(id),
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_reimbursement_files ON reimbursement_files(reimbursement_id);
