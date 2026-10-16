-- Seções liberadas por usuário (lista JSON). NULL = padrão pelo perfil (comportamento atual: nada muda até ser editado).
-- Contratos e Tarefas financeiras continuam espelhados em can_contracts / can_finance (áreas restritas de tarefas).
ALTER TABLE users ADD COLUMN sections TEXT;
