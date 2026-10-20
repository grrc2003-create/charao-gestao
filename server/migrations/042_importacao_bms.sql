-- Importação de BMs das planilhas de recebimentos: guarda cada linha já considerada, para que reenviar a planilha
-- não some de novo o valor no contrato e para criar o BM quando uma parcela em aberto passar a recebida.
-- status: aberto (valor já no contrato, ainda sem BM) · medido (entrou num BM) · ignorado (mês já tinha BM lançado à mão)
-- Migração apenas aditiva.
CREATE TABLE contract_import_rows (
  import_key     TEXT PRIMARY KEY,
  contract_id    INTEGER NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
  kind           TEXT NOT NULL CHECK (kind IN ('parcela', 'rt')),
  nature         TEXT,
  amount         REAL NOT NULL DEFAULT 0,
  status         TEXT NOT NULL CHECK (status IN ('aberto', 'medido', 'ignorado')),
  measurement_id INTEGER REFERENCES measurements(id) ON DELETE SET NULL,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_contract_import_rows_contract ON contract_import_rows(contract_id);
