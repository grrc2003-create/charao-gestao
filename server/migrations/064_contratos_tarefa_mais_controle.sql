-- Contratos: ao registrar o recebimento de uma medição, o sistema cria no Financeiro a tarefa
-- "Atualizar no Mais Controle" para lançar esse recebimento; aqui fica a ligação medição → tarefa
-- (para mostrar na medição e cancelar a tarefa aberta se o recebimento for desfeito). Migração apenas aditiva.
ALTER TABLE measurements ADD COLUMN mc_task_id INTEGER REFERENCES tasks(id);
