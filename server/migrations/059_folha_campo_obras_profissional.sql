-- Folha de Campo: obras em que o profissional aparece (para incluir nas folhas e nas empreitadas da obra).
-- Profissional sem obra escolhida continua aparecendo em todas as obras.
-- Migração apenas aditiva: quem já trabalhou numa obra (folhas ou empreitadas) fica ligado a ela.
CREATE TABLE field_worker_projects (
  worker_id  INTEGER NOT NULL REFERENCES field_workers(id) ON DELETE CASCADE,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  PRIMARY KEY (worker_id, project_id)
);
CREATE INDEX idx_field_worker_projects_project ON field_worker_projects(project_id);

INSERT OR IGNORE INTO field_worker_projects (worker_id, project_id)
  SELECT DISTINCT e.worker_id, f.project_id FROM field_sheet_people e JOIN field_sheets f ON f.id = e.sheet_id;
INSERT OR IGNORE INTO field_worker_projects (worker_id, project_id)
  SELECT DISTINCT worker_id, project_id FROM field_contracts;
