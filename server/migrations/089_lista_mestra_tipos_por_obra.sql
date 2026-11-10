-- @foreign_keys_off
-- Lista Mestra: cada obra passa a ter a própria cópia dos tipos de projeto e etapas, editável na obra.
-- Os tipos sem obra (project_id nulo) são o formato padrão (Configurações), copiado ao ligar a Lista Mestra na obra.
-- A tabela é reconstruída só para o nome deixar de ser único no sistema todo (passa a ser único por obra).
CREATE TABLE ml_types_new (
  id          INTEGER PRIMARY KEY,
  project_id  INTEGER REFERENCES projects(id) ON DELETE CASCADE,   -- NULL = formato padrão
  src_id      INTEGER,                                             -- tipo do padrão de onde veio a cópia
  name        TEXT NOT NULL,
  active      INTEGER NOT NULL DEFAULT 1,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO ml_types_new (id, name, active, sort_order, created_at, updated_at) SELECT id, name, active, sort_order, created_at, updated_at FROM ml_types;
DROP TABLE ml_types;
ALTER TABLE ml_types_new RENAME TO ml_types;
CREATE UNIQUE INDEX idx_ml_types_name ON ml_types(IFNULL(project_id, 0), name COLLATE NOCASE);
CREATE INDEX idx_ml_types_project ON ml_types(project_id, sort_order);
ALTER TABLE ml_type_stages ADD COLUMN src_id INTEGER;

-- Obras que já usam a Lista Mestra: cópia do padrão atual e os projetos dela passam para a cópia (datas e histórico mantidos)
INSERT INTO ml_types (project_id, src_id, name, active, sort_order)
  SELECT p.id, t.id, t.name, t.active, t.sort_order FROM projects p JOIN ml_types t ON t.project_id IS NULL
  WHERE p.has_master_list = 1 OR EXISTS (SELECT 1 FROM ml_items i WHERE i.project_id = p.id);
INSERT INTO ml_type_stages (type_id, src_id, name, active, sort_order)
  SELECT nt.id, s.id, s.name, s.active, s.sort_order FROM ml_types nt JOIN ml_type_stages s ON s.type_id = nt.src_id WHERE nt.project_id IS NOT NULL;
UPDATE ml_item_stages SET stage_id = (SELECT ns.id FROM ml_type_stages ns JOIN ml_types nt ON nt.id = ns.type_id JOIN ml_items i ON i.id = ml_item_stages.item_id
    WHERE nt.project_id = i.project_id AND ns.src_id = ml_item_stages.stage_id)
  WHERE EXISTS (SELECT 1 FROM ml_type_stages ns JOIN ml_types nt ON nt.id = ns.type_id JOIN ml_items i ON i.id = ml_item_stages.item_id
    WHERE nt.project_id = i.project_id AND ns.src_id = ml_item_stages.stage_id);
UPDATE ml_changes SET stage_id = (SELECT ns.id FROM ml_type_stages ns JOIN ml_types nt ON nt.id = ns.type_id JOIN ml_items i ON i.id = ml_changes.item_id
    WHERE nt.project_id = i.project_id AND ns.src_id = ml_changes.stage_id)
  WHERE stage_id IS NOT NULL AND EXISTS (SELECT 1 FROM ml_type_stages ns JOIN ml_types nt ON nt.id = ns.type_id JOIN ml_items i ON i.id = ml_changes.item_id
    WHERE nt.project_id = i.project_id AND ns.src_id = ml_changes.stage_id);
UPDATE ml_items SET type_id = (SELECT nt.id FROM ml_types nt WHERE nt.project_id = ml_items.project_id AND nt.src_id = ml_items.type_id)
  WHERE EXISTS (SELECT 1 FROM ml_types nt WHERE nt.project_id = ml_items.project_id AND nt.src_id = ml_items.type_id);
