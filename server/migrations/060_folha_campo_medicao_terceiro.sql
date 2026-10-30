-- Folha de Campo: medição do terceiro (BM) que deveria cobrir as folhas da obra.
-- Valor medido, BM anexado e as folhas cobertas; a tela compara o medido com o total das folhas (pago a mais / a menos).
-- Somente a seção folha_campo vê e lança. Migração apenas aditiva.
CREATE TABLE field_measurements (
  id          INTEGER PRIMARY KEY,
  project_id  INTEGER NOT NULL REFERENCES projects(id),
  supplier    TEXT,                                             -- terceiro que mediu
  ref_date    TEXT NOT NULL,                                    -- data da medição
  amount      REAL NOT NULL DEFAULT 0,                          -- valor da medição
  notes       TEXT,
  created_by  INTEGER REFERENCES users(id),
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_field_measurements_project ON field_measurements(project_id);

-- Folhas cobertas pela medição (cada folha entra em uma medição só)
CREATE TABLE field_measurement_sheets (
  measurement_id INTEGER NOT NULL REFERENCES field_measurements(id) ON DELETE CASCADE,
  sheet_id       INTEGER NOT NULL UNIQUE REFERENCES field_sheets(id) ON DELETE CASCADE,
  PRIMARY KEY (measurement_id, sheet_id)
);

-- BM anexado (PDF ou imagem)
CREATE TABLE field_measurement_files (
  id             INTEGER PRIMARY KEY,
  measurement_id INTEGER NOT NULL REFERENCES field_measurements(id) ON DELETE CASCADE,
  stored_name    TEXT NOT NULL UNIQUE,
  mime           TEXT NOT NULL,
  size           INTEGER NOT NULL,
  original_name  TEXT,
  uploaded_by    INTEGER REFERENCES users(id),
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_field_measurement_files ON field_measurement_files(measurement_id);
