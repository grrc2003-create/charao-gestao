-- Mais Controle: regra por categoria inteira — enviar todos os pagamentos para outra tarefa financeira, ou deixar a
-- categoria fora do realizado até ser ajustada no Mais Controle. Migração apenas aditiva.
CREATE TABLE ext_category_rules (
  source        TEXT NOT NULL DEFAULT 'maiscontrole',
  cat_key       TEXT NOT NULL,
  label         TEXT NOT NULL,
  action        TEXT NOT NULL,                     -- mapear | ajustar
  obligation_id INTEGER REFERENCES finance_obligations(id) ON DELETE CASCADE,
  created_by    INTEGER REFERENCES users(id),
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (source, cat_key)
);
