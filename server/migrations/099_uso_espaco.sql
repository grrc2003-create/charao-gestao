-- Espaço e uso (Configurações): uma foto por dia do disco de dados, para acompanhar o crescimento. Migração apenas aditiva.
CREATE TABLE storage_snapshots (
  day         TEXT PRIMARY KEY,
  disk_total  INTEGER,
  disk_used   INTEGER,
  db_bytes    INTEGER NOT NULL,
  files_bytes INTEGER NOT NULL,
  files_count INTEGER NOT NULL,
  created_at  TEXT NOT NULL
);
