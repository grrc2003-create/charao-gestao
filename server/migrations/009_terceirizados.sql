-- Perfil Terceirizado: responsável por tarefas, com líder interno obrigatório (users.manager_id).
-- login_enabled = 0: sem acesso ao sistema (o líder registra e confere a execução em nome dele).
-- login_enabled = 1: acesso ao sistema, com as mesmas regras de um Colaborador.
-- O terceirizado só pode ser responsável nos projetos liberados a ele (user_project_access). Migração apenas aditiva.
ALTER TABLE users ADD COLUMN is_external INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN company TEXT;
ALTER TABLE users ADD COLUMN login_enabled INTEGER NOT NULL DEFAULT 1;
