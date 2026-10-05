-- Classificação das tarefas (Grupo/Local/Etapa), cadastrada por projeto.
-- Cada projeto tem a classificação padrão "Geral", que recebe as tarefas não classificadas.
-- Migração apenas aditiva: nenhum dado existente é removido.
CREATE TABLE project_stages (
  id         INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_default INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX ux_project_stages_name ON project_stages(project_id, name COLLATE NOCASE);
CREATE UNIQUE INDEX ux_project_stages_default ON project_stages(project_id) WHERE is_default = 1;

INSERT INTO project_stages (project_id, name, sort_order, is_default)
SELECT id, 'Geral', 0, 1 FROM projects;

ALTER TABLE tasks ADD COLUMN stage_id INTEGER REFERENCES project_stages(id);
-- Início previsto (opcional) — usado no cronograma Gantt
ALTER TABLE tasks ADD COLUMN start_date TEXT;

UPDATE tasks SET stage_id = (SELECT s.id FROM project_stages s WHERE s.project_id = tasks.project_id AND s.is_default = 1);
CREATE INDEX idx_tasks_stage ON tasks(stage_id);
