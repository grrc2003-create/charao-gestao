-- Financeiro: as parcelas deixam de criar a tarefa sozinhas; o sistema pergunta se a tarefa deve ser criada.
-- task_skip = 1: a pessoa respondeu "não criar" ou excluiu a tarefa (não pergunta de novo nem recria).
-- Parcelas que hoje já estão sem tarefa (excluída ou histórico do Mais Controle) não são perguntadas. Migração apenas aditiva.
ALTER TABLE finance_items ADD COLUMN task_skip INTEGER NOT NULL DEFAULT 0;
UPDATE finance_items SET task_skip = 1 WHERE task_id IS NULL;
