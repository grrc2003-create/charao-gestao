-- Configurações gerais em chave/valor (permite novas opções sem alterar o esquema).
-- Migração apenas aditiva.
CREATE TABLE app_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- Tarefa "crônica": reagendada este número de vezes ou mais
INSERT INTO app_settings (key, value) VALUES ('chronic_reschedule_threshold', '3');
