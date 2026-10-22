-- Mais Controle: custos que não devem entrar (um pagamento, um fornecedor ou uma categoria inteira) e regra do previsto
-- da tarefa (plan_zero: 0 = realizado do ano anterior; 2 = zero no primeiro ano da categoria, depois a regra; 1 = sempre
-- zero). Migração apenas aditiva.
CREATE TABLE ext_exclusions (
  source     TEXT NOT NULL DEFAULT 'maiscontrole',
  kind       TEXT NOT NULL,                        -- pagamento | fornecedor | categoria
  ext_key    TEXT NOT NULL,                        -- chave do pagamento, do fornecedor ou da categoria
  label      TEXT NOT NULL,
  detail     TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (source, kind, ext_key)
);
ALTER TABLE finance_obligations ADD COLUMN plan_zero INTEGER NOT NULL DEFAULT 0;
