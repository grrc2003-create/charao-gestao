-- Empresas que cada pessoa pode ver (Cadastro → Acesso e permissões; só administradores alteram).
-- NULL = padrão (como antes: quem é do grupo vê todas as empresas; quem é de fora vê só as pessoas da própria).
-- JSON com ids = vê a própria empresa + as listadas: pessoas, projetos e tarefas das demais ficam escondidos.
-- '[]' = só a própria empresa. Migração apenas aditiva.
ALTER TABLE users ADD COLUMN visible_company_ids TEXT;
