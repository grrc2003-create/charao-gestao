-- Mais Controle: solicitação de alteração de um lançamento (vira tarefa no INT-001, classificação "Mais Controle",
-- para um responsável alterar no Mais Controle). Migração apenas aditiva.
CREATE TABLE ext_change_requests (
  id         INTEGER PRIMARY KEY,
  source     TEXT NOT NULL DEFAULT 'maiscontrole',
  ext_key    TEXT NOT NULL,
  what       TEXT NOT NULL,                      -- conta | centro_custo | categoria | valor_data | fornecedor | outro
  details    TEXT NOT NULL,
  task_id    INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX ix_ext_change_requests_key ON ext_change_requests(source, ext_key);
