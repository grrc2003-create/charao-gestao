-- Reagendamento de prazos com justificativa obrigatória.
-- Justificativas são cadastradas de forma geral (Configurações) e servem a todos os projetos.
-- Migração apenas aditiva: nenhuma tabela existente é alterada.
CREATE TABLE reschedule_reasons (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  active     INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX ux_reschedule_reasons_name ON reschedule_reasons(name COLLATE NOCASE);

-- Cada reagendamento fica registrado (o nome da justificativa é guardado no momento do registro,
-- para que renomear uma justificativa não altere o histórico)
CREATE TABLE task_reschedules (
  id          INTEGER PRIMARY KEY,
  task_id     INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  old_due     TEXT,
  new_due     TEXT,
  reason_id   INTEGER REFERENCES reschedule_reasons(id),
  reason_name TEXT NOT NULL,
  note        TEXT,
  user_id     INTEGER REFERENCES users(id),
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_task_reschedules_task ON task_reschedules(task_id);

-- Lista inicial sugerida (pode ser editada em Configurações)
INSERT INTO reschedule_reasons (name, sort_order) VALUES
  ('Condições climáticas (chuva, vento)', 1),
  ('Atraso na entrega de material', 2),
  ('Falta de mão de obra / equipe', 3),
  ('Alteração de projeto ou escopo', 4),
  ('Aguardando liberação ou decisão do cliente', 5),
  ('Dependência de outra tarefa ou etapa', 6),
  ('Problema com equipamento', 7),
  ('Repriorização da obra', 8),
  ('Outro motivo (detalhar na observação)', 9);
