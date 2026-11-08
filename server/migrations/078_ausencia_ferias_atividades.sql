-- Férias e ausências que caem em data com atividade: cada tarefa com entrega no período precisa de um novo prazo
-- ou de uma explicação (prazo mantido), acordados com o líder (valem quando ele aprova). Migração apenas aditiva.
ALTER TABLE vacation_reschedules ADD COLUMN explanation TEXT;

CREATE TABLE absence_reschedules (
  id          INTEGER PRIMARY KEY,
  absence_id  INTEGER NOT NULL REFERENCES absences(id) ON DELETE CASCADE,
  task_id     INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  old_due     TEXT,
  new_due     TEXT NOT NULL,          -- igual ao prazo antigo quando o prazo é mantido (com explicação)
  explanation TEXT,
  applied     INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (absence_id, task_id)
);
CREATE INDEX idx_absence_reschedules_task ON absence_reschedules(task_id);

INSERT OR IGNORE INTO reschedule_reasons (name, sort_order)
  SELECT 'Ausência do responsável', COALESCE(MAX(sort_order), 0) + 1 FROM reschedule_reasons
  WHERE NOT EXISTS (SELECT 1 FROM reschedule_reasons WHERE name = 'Ausência do responsável' COLLATE NOCASE);
