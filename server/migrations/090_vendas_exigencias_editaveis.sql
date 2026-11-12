-- Vendas: exigências editáveis por coluna.
-- entry_fields: o que é exigido para entrar na coluna (NULL = padrão do tipo de etapa, como antes).
-- exit_fields: o que é exigido para sair da coluna e seguir para as próximas (NULL = nada além do cadastro).
-- Listas em JSON com os nomes dos campos da oportunidade. Migração apenas aditiva (o comportamento atual se mantém).
ALTER TABLE sales_stages ADD COLUMN entry_fields TEXT;
ALTER TABLE sales_stages ADD COLUMN exit_fields TEXT;
