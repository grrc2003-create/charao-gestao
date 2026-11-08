-- Financeiro: lista do mês (checks) no lugar de uma tarefa por despesa.
-- Cada despesa do mês é um check: a confirmar → vai ter (valor do mês) / não vai ter → pago.
-- Uma tarefa "Contas do mês" por mês e responsável acompanha o avanço e só conclui com todos os checks resolvidos.
-- Migração apenas aditiva: as tarefas antigas por despesa ficam no histórico (legacy_task_id).
ALTER TABLE finance_items ADD COLUMN confirmed_at TEXT;
ALTER TABLE finance_items ADD COLUMN confirmed_by INTEGER REFERENCES users(id);
ALTER TABLE finance_items ADD COLUMN legacy_task_id INTEGER REFERENCES tasks(id) ON DELETE SET NULL;

CREATE TABLE finance_month_tasks (
  id            INTEGER PRIMARY KEY,
  ref_month     TEXT NOT NULL,
  assignee_key  INTEGER NOT NULL DEFAULT 0,          -- responsável das despesas (0 = sem responsável)
  task_id       INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
  skipped       INTEGER NOT NULL DEFAULT 0,          -- respondeu "Não" à pergunta de criar a tarefa
  created_by    INTEGER REFERENCES users(id),
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (ref_month, assignee_key)
);
CREATE INDEX idx_finance_month_tasks_task ON finance_month_tasks(task_id);

-- Comprovantes de despesas sem tarefa própria (lista do mês)
CREATE TABLE finance_item_files (
  id            INTEGER PRIMARY KEY,
  item_id       INTEGER NOT NULL REFERENCES finance_items(id) ON DELETE CASCADE,
  stored_name   TEXT NOT NULL UNIQUE,
  mime          TEXT NOT NULL,
  size          INTEGER NOT NULL,
  original_name TEXT,
  uploaded_by   INTEGER REFERENCES users(id),
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_finance_item_files ON finance_item_files(item_id);
