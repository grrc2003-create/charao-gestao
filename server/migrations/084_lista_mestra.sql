-- Lista Mestra de projetos: os projetos de cada obra (arquitetura, estrutural, complementares…), a etapa em que cada um
-- está, as datas previstas das próximas etapas e o histórico de alterações com o motivo.
-- Etapas cadastradas por tipo de projeto (Configurações) e editáveis depois. Data base = primeira data prevista (congelada);
-- toda mudança de data prevista exige motivo e fica registrada.
CREATE TABLE ml_types (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE COLLATE NOCASE,
  active      INTEGER NOT NULL DEFAULT 1,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE ml_type_stages (
  id          INTEGER PRIMARY KEY,
  type_id     INTEGER NOT NULL REFERENCES ml_types(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  active      INTEGER NOT NULL DEFAULT 1,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_ml_type_stages ON ml_type_stages(type_id, sort_order);

-- Um projeto (disciplina) de uma obra
CREATE TABLE ml_items (
  id          INTEGER PRIMARY KEY,
  project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  type_id     INTEGER NOT NULL REFERENCES ml_types(id),
  name        TEXT,                 -- complemento (ex.: Bloco A, Fachada)
  designer    TEXT,                 -- projetista / escritório
  revision    TEXT,                 -- revisão atual (R00, R01…)
  notes       TEXT,
  created_by  INTEGER REFERENCES users(id),
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_ml_items_project ON ml_items(project_id);

-- Datas de cada etapa do projeto: base (congelada), prevista (atual) e realizada
CREATE TABLE ml_item_stages (
  item_id      INTEGER NOT NULL REFERENCES ml_items(id) ON DELETE CASCADE,
  stage_id     INTEGER NOT NULL REFERENCES ml_type_stages(id),
  base_date    TEXT,
  planned_date TEXT,
  done_date    TEXT,
  updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (item_id, stage_id)
);

-- Histórico: cada data alterada (prevista, realizada ou nova linha de base), com motivo e explicação
CREATE TABLE ml_changes (
  id          INTEGER PRIMARY KEY,
  item_id     INTEGER NOT NULL REFERENCES ml_items(id) ON DELETE CASCADE,
  stage_id    INTEGER REFERENCES ml_type_stages(id),
  kind        TEXT NOT NULL CHECK (kind IN ('previsto', 'realizado', 'base', 'cadastro')),
  old_date    TEXT,
  new_date    TEXT,
  reason      TEXT,
  explanation TEXT,
  cascade     INTEGER NOT NULL DEFAULT 0,   -- deslocada junto com a etapa anterior
  created_by  INTEGER REFERENCES users(id),
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_ml_changes_item ON ml_changes(item_id, created_at);

-- Tipos e etapas iniciais (podem ser alterados em Configurações)
INSERT INTO ml_types (name, sort_order) VALUES
  ('Arquitetura', 1), ('Estrutural', 2), ('Fundações', 3), ('Elétrico', 4), ('Hidrossanitário', 5),
  ('Climatização (HVAC)', 6), ('Prevenção e combate a incêndio', 7), ('SPDA', 8), ('Cabeamento estruturado', 9);
INSERT INTO ml_type_stages (type_id, name, sort_order)
  SELECT t.id, s.name, s.ord FROM ml_types t JOIN (
    SELECT 'Arquitetura' AS tp, 'Levantamento de dados' AS name, 1 AS ord UNION ALL
    SELECT 'Arquitetura', 'Estudo preliminar', 2 UNION ALL
    SELECT 'Arquitetura', 'Anteprojeto', 3 UNION ALL
    SELECT 'Arquitetura', 'Projeto legal (aprovação)', 4 UNION ALL
    SELECT 'Arquitetura', 'Projeto executivo', 5 UNION ALL
    SELECT 'Arquitetura', 'Compatibilização', 6 UNION ALL
    SELECT 'Arquitetura', 'Liberado para obra', 7 UNION ALL
    SELECT 'Prevenção e combate a incêndio', 'Estudo preliminar', 1 UNION ALL
    SELECT 'Prevenção e combate a incêndio', 'Projeto executivo', 2 UNION ALL
    SELECT 'Prevenção e combate a incêndio', 'Aprovação no Corpo de Bombeiros', 3 UNION ALL
    SELECT 'Prevenção e combate a incêndio', 'Compatibilização', 4 UNION ALL
    SELECT 'Prevenção e combate a incêndio', 'Liberado para obra', 5
  ) s ON s.tp = t.name;
INSERT INTO ml_type_stages (type_id, name, sort_order)
  SELECT t.id, s.name, s.ord FROM ml_types t JOIN (
    SELECT 'Estudo preliminar' AS name, 1 AS ord UNION ALL
    SELECT 'Anteprojeto', 2 UNION ALL
    SELECT 'Projeto executivo', 3 UNION ALL
    SELECT 'Compatibilização', 4 UNION ALL
    SELECT 'Liberado para obra', 5
  ) s WHERE t.name NOT IN ('Arquitetura', 'Prevenção e combate a incêndio');
