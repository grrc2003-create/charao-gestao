-- Mais Controle: despesa com categoria corrigida no sistema (vai para a tarefa escolhida) ou em stand by (fora do
-- realizado até vir corrigida do Mais Controle). Migração apenas aditiva.
ALTER TABLE ext_reviews ADD COLUMN fix_category TEXT;
