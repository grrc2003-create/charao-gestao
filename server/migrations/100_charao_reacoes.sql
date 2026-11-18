-- Charão: cada pessoa liga/desliga as reações do mascote às telas e filtros (Minha conta). 1 = ligado (padrão).
-- Os avisos de tarefas continuam aparecendo de qualquer forma. Migração apenas aditiva.
ALTER TABLE users ADD COLUMN charao_reactions INTEGER NOT NULL DEFAULT 1;
