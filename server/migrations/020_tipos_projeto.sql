-- Tipos de projeto (Orçamento, Consultoria, Obra, Reforma…): cadastrados em Configurações e escolhidos em cada projeto.
-- Migração apenas aditiva: os projetos existentes ficam "Sem tipo" até serem classificados.
CREATE TABLE project_types (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE COLLATE NOCASE,
  active      INTEGER NOT NULL DEFAULT 1,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO project_types (name, sort_order) VALUES ('Orçamento', 1), ('Consultoria', 2), ('Obra', 3), ('Reforma', 4);

ALTER TABLE projects ADD COLUMN type_id INTEGER REFERENCES project_types(id);
CREATE INDEX idx_projects_type ON projects(type_id);
