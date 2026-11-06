-- Jornada de trabalho da pessoa (Cadastro da Equipe): dias da semana em que trabalha (JSON com 0=domingo … 6=sábado;
-- vazio = segue o calendário da empresa) e turno. Migração apenas aditiva.
ALTER TABLE users ADD COLUMN work_days TEXT;
ALTER TABLE users ADD COLUMN work_shift TEXT;
