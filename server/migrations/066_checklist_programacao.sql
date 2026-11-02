-- Check-list: programação do profissional. Guarda a ordem em que os itens foram vinculados a ele (a equipe do item e as
-- dependências continuam nas tabelas próprias). Migração apenas aditiva.
CREATE TABLE checklist_plan (
  worker_id  INTEGER NOT NULL REFERENCES field_workers(id) ON DELETE CASCADE,
  item_id    INTEGER NOT NULL REFERENCES checklist_items(id) ON DELETE CASCADE,
  seq        INTEGER NOT NULL,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (worker_id, item_id)
);
CREATE INDEX idx_checklist_plan_item ON checklist_plan(item_id);
