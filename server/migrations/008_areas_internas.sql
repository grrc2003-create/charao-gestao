-- Tipo do projeto: 'obra' (padrão, todos os existentes) ou 'interno' (área interna da empresa, código INT-000).
-- Migração apenas aditiva. A área padrão "Charão — Interno" é criada pelo servidor (ensureInternalArea).
ALTER TABLE projects ADD COLUMN kind TEXT NOT NULL DEFAULT 'obra' CHECK (kind IN ('obra', 'interno'));
CREATE INDEX idx_projects_kind ON projects(kind);
