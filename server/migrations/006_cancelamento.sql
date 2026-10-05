-- Cancelamento de tarefas (reversível). O status original é preservado; "Cancelada" é derivado de cancelled_at.
-- Migração apenas aditiva.
ALTER TABLE tasks ADD COLUMN cancelled_at TEXT;
ALTER TABLE tasks ADD COLUMN cancelled_by INTEGER REFERENCES users(id);
ALTER TABLE tasks ADD COLUMN cancel_reason TEXT;
CREATE INDEX idx_tasks_cancelled ON tasks(cancelled_at);
