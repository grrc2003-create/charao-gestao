-- Cotações: frete da proposta. Cada proposta/revisão guarda o seu frete (vale o da revisão mais recente).
-- O frete é somado ao total e distribuído entre os itens proporcionalmente ao valor de cada um (preço × quantidade),
-- para a comparação entre fornecedores. O preço digitado continua guardado sem frete. Migração apenas aditiva.
CREATE TABLE quote_freights (
  id          INTEGER PRIMARY KEY,
  request_id  INTEGER NOT NULL REFERENCES quote_requests(id) ON DELETE CASCADE,
  revision    INTEGER NOT NULL DEFAULT 0,
  amount      REAL NOT NULL DEFAULT 0,
  created_by  INTEGER REFERENCES users(id),
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_quote_freights ON quote_freights(request_id, revision);
