-- Dependências, etapa 2: quando uma tarefa/item é reagendado ou termina atrasado, as sucessoras são empurradas.
-- Cada ocorrência (evento) guarda a causa e o efeito no fim do projeto; cada empurrão guarda a tarefa/item ajustado.
-- Os empurrões NÃO são reagendamentos das sucessoras (não entram em task_reschedules): só a causa é penalizada.
CREATE TABLE dependency_events (
  id               INTEGER PRIMARY KEY,
  project_id       INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  cause_task_id    INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  cause_item_id    INTEGER REFERENCES checklist_items(id) ON DELETE SET NULL,
  kind             TEXT NOT NULL,          -- reagendamento | conclusao_atrasada | prazo_item
  cause_old_due    TEXT,
  cause_new_due    TEXT,
  project_end_old  TEXT,
  project_end_new  TEXT,
  created_by       INTEGER REFERENCES users(id),
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_dep_events_cause ON dependency_events(cause_task_id);
CREATE INDEX idx_dep_events_project ON dependency_events(project_id);

CREATE TABLE dependency_shifts (
  id              INTEGER PRIMARY KEY,
  event_id        INTEGER NOT NULL REFERENCES dependency_events(id) ON DELETE CASCADE,
  target_task_id  INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
  target_item_id  INTEGER REFERENCES checklist_items(id) ON DELETE CASCADE,
  old_start       TEXT,
  old_due         TEXT,
  new_start       TEXT,
  new_due         TEXT,
  days            INTEGER NOT NULL
);
CREATE INDEX idx_dep_shifts_event ON dependency_shifts(event_id);
CREATE INDEX idx_dep_shifts_task ON dependency_shifts(target_task_id);
CREATE INDEX idx_dep_shifts_item ON dependency_shifts(target_item_id);
