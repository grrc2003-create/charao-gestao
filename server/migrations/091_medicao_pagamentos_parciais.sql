-- Contratos: recebimento da medição em partes. Cada pagamento fica registrado (data, valor, observação);
-- o saldo continua em aberto até quitar. "closes" = este pagamento quitou a medição (inclusive com diferença aceita,
-- ex.: retenção). Medições já recebidas ganham o seu pagamento único no histórico. Migração apenas aditiva.
CREATE TABLE measurement_payments (
  id             INTEGER PRIMARY KEY,
  measurement_id INTEGER NOT NULL REFERENCES measurements(id) ON DELETE CASCADE,
  paid_date      TEXT NOT NULL,
  amount         REAL NOT NULL,
  notes          TEXT,
  closes         INTEGER NOT NULL DEFAULT 0,
  mc_task_id     INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
  created_by     INTEGER REFERENCES users(id),
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_measurement_payments ON measurement_payments(measurement_id, paid_date);
INSERT INTO measurement_payments (measurement_id, paid_date, amount, closes, mc_task_id, created_by, created_at)
  SELECT id, paid_date, paid_amount, 1, mc_task_id, issued_by, updated_at FROM measurements
  WHERE status = 'recebida' AND paid_date IS NOT NULL AND paid_amount IS NOT NULL;
