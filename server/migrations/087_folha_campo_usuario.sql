-- Folha de Campo: profissional ligado ao usuário do sistema, para ver os próprios comprovantes no Meu painel.
-- O vínculo é feito no cadastro do profissional (não é automático: dá acesso a dados de pagamento).
ALTER TABLE field_workers ADD COLUMN user_id INTEGER REFERENCES users(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX idx_field_workers_user ON field_workers(user_id) WHERE user_id IS NOT NULL;
