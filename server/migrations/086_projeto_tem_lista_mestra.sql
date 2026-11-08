-- Lista Mestra só existe no projeto marcado no cadastro ("Este projeto terá Lista Mestra"), como as cotações.
-- Projetos que já têm itens na Lista Mestra ficam marcados (nada some).
ALTER TABLE projects ADD COLUMN has_master_list INTEGER NOT NULL DEFAULT 0;
UPDATE projects SET has_master_list = 1 WHERE id IN (SELECT DISTINCT project_id FROM ml_items);
