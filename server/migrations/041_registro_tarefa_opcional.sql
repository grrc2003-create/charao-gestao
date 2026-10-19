-- Registros do projeto: a tarefa da pendência / demanda de ata passa a ser opcional (escolhida na criação).
-- Registros já existentes mantêm o comportamento anterior (gerar = 1). Migração apenas aditiva.
ALTER TABLE project_records ADD COLUMN create_task INTEGER NOT NULL DEFAULT 1;
ALTER TABLE record_items ADD COLUMN create_task INTEGER NOT NULL DEFAULT 1;
ALTER TABLE project_records ADD COLUMN resolved_at TEXT;   -- pendência sem tarefa marcada como resolvida
ALTER TABLE project_records ADD COLUMN resolved_by INTEGER REFERENCES users(id);
