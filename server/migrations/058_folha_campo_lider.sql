-- Folha de Campo: líder do profissional (pessoa da equipe interna). No organograma, o líder mostra
-- um cartão com a equipe de campo ligada a ele, contada por função.
-- Migração apenas aditiva.
ALTER TABLE field_workers ADD COLUMN leader_id INTEGER REFERENCES users(id);
CREATE INDEX idx_field_workers_leader ON field_workers(leader_id);
