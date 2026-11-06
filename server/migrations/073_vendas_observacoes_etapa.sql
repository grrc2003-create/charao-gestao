-- Vendas e Prospecção: observações por etapa (coluna) da oportunidade. Cada observação guarda a coluna em que foi feita
-- (e o nome dela, caso a coluna seja renomeada ou excluída depois), quem escreveu e quem editou. Migração apenas aditiva.
CREATE TABLE sales_notes (
  id             INTEGER PRIMARY KEY,
  opportunity_id INTEGER NOT NULL REFERENCES sales_opportunities(id) ON DELETE CASCADE,
  stage_id       INTEGER REFERENCES sales_stages(id) ON DELETE SET NULL,
  stage_name     TEXT NOT NULL,
  body           TEXT NOT NULL,
  created_by     INTEGER REFERENCES users(id),
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_by     INTEGER REFERENCES users(id),
  updated_at     TEXT
);
CREATE INDEX idx_sales_notes_opp ON sales_notes(opportunity_id, stage_id);
