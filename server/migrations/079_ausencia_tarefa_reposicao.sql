-- Falta com reposição: tarefa no dia da reposição para a pessoa confirmar a presença (criada só com "Sim" na pergunta).
-- Quando o líder confere e aprova a tarefa, a reposição fica cumprida. Migração apenas aditiva.
ALTER TABLE absences ADD COLUMN task_id INTEGER REFERENCES tasks(id) ON DELETE SET NULL;
ALTER TABLE absences ADD COLUMN task_asked INTEGER NOT NULL DEFAULT 0;   -- já respondeu a pergunta (Sim ou Não)
