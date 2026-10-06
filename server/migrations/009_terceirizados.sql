-- Perfil Terceirizado: pessoa sem login, responsável por tarefas, com líder interno obrigatório (users.manager_id).
-- Migração apenas aditiva.
ALTER TABLE users ADD COLUMN is_external INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN company TEXT;
