-- Acesso total: define se a pessoa também acessa os projetos internos da empresa (áreas restritas seguem as próprias liberações).
-- Migração apenas aditiva: quem já tem acesso total continua vendo os internos.
ALTER TABLE users ADD COLUMN total_internal INTEGER NOT NULL DEFAULT 1;
