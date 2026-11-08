-- Alertas por indicador em cada projeto: limite de atenção e limite crítico (em branco = sem alerta).
CREATE TABLE project_alerts (
  project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  indicator   TEXT NOT NULL,
  warn        REAL,
  crit        REAL,
  updated_by  INTEGER REFERENCES users(id),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (project_id, indicator)
);
