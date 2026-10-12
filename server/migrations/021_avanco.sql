-- Avanço parcial (opcional), em %, de tarefas, subtarefas e itens de check-list. NULL = não informado.
-- Migração apenas aditiva: nada existente é alterado.
ALTER TABLE tasks ADD COLUMN progress_pct INTEGER CHECK (progress_pct IS NULL OR (progress_pct BETWEEN 0 AND 100));
ALTER TABLE checklist_items ADD COLUMN progress_pct INTEGER CHECK (progress_pct IS NULL OR (progress_pct BETWEEN 0 AND 100));
