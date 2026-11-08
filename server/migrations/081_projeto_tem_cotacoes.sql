-- Cotações só existem no projeto marcado no cadastro ("Este projeto terá cotações").
-- Projetos que já têm itens de cotação ficam marcados (nada some).
ALTER TABLE projects ADD COLUMN has_quotes INTEGER NOT NULL DEFAULT 0;
UPDATE projects SET has_quotes = 1 WHERE id IN (SELECT DISTINCT project_id FROM quote_items);
