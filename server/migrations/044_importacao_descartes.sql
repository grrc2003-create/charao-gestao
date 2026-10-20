-- Importar BMs: pagamentos da planilha descartados na prévia (não entram no valor do contrato nem nos BMs).
-- Fica guardado para que reenviar a planilha não traga o pagamento de volta; pode ser reativado na prévia.
-- Migração apenas aditiva.
CREATE TABLE contract_import_discards (
  import_key  TEXT PRIMARY KEY,
  obra        TEXT,
  payer       TEXT,
  due_date    TEXT,
  amount      REAL,
  created_by  INTEGER REFERENCES users(id),
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
