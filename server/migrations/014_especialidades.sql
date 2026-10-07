-- Especialidades do check-list (Pintura, Revestimento, Elétrica…): modelos cadastrados em Configurações e
-- escolhidos por obra. O item guarda o nome da especialidade (como o grupo), para não depender do modelo.
-- Migração apenas aditiva: obras ficam sem modelo e itens sem especialidade até serem definidos.
CREATE TABLE specialty_templates (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE COLLATE NOCASE,
  items       TEXT NOT NULL DEFAULT '[]', -- lista JSON de nomes, na ordem de exibição
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO specialty_templates (name, items, sort_order) VALUES
  ('Acabamentos — padrão', '["Pintura","Revestimento","Bancadas","Louças e Metais","Forro","Hidráulica","Elétrica"]', 1);

ALTER TABLE projects ADD COLUMN specialty_template_id INTEGER REFERENCES specialty_templates(id);
ALTER TABLE checklist_items ADD COLUMN specialty TEXT;
