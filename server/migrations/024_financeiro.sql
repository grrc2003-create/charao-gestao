-- Tarefas financeiras: obrigações mensais/periódicas (impostos, folha, aluguel, fornecedores…) que geram parcelas
-- Pendente → Paga (data, valor e comprovante). Cada parcela é também uma tarefa na área interna restrita "Financeiro".
-- Liberação própria (users.can_finance). projects.restricted: 1 = Contratos, 2 = Financeiro.
-- Migração apenas aditiva: administradores atuais já começam liberados (podem retirar a própria liberação).
ALTER TABLE users ADD COLUMN can_finance INTEGER NOT NULL DEFAULT 0;
UPDATE users SET can_finance = 1 WHERE role = 'admin';

CREATE TABLE finance_obligations (
  id           INTEGER PRIMARY KEY,
  title        TEXT NOT NULL,
  category     TEXT NOT NULL DEFAULT 'Outros',
  payee        TEXT,                                   -- favorecido / fornecedor / órgão
  amount       REAL NOT NULL DEFAULT 0,                -- valor previsto de cada parcela
  variable     INTEGER NOT NULL DEFAULT 0,             -- valor muda a cada mês (ajustado na parcela)
  frequency    TEXT NOT NULL DEFAULT 'mensal' CHECK (frequency IN ('mensal', 'bimestral', 'trimestral', 'semestral', 'anual', 'unica')),
  due_day      INTEGER NOT NULL DEFAULT 10 CHECK (due_day BETWEEN 1 AND 31),
  start_month  TEXT NOT NULL,                          -- AAAA-MM
  end_month    TEXT,                                   -- AAAA-MM (opcional)
  assignee_id  INTEGER REFERENCES users(id),
  notes        TEXT,
  active       INTEGER NOT NULL DEFAULT 1,
  created_by   INTEGER REFERENCES users(id),
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE finance_items (
  id              INTEGER PRIMARY KEY,
  obligation_id   INTEGER NOT NULL REFERENCES finance_obligations(id) ON DELETE CASCADE,
  ref_month       TEXT NOT NULL,                       -- AAAA-MM
  due_date        TEXT NOT NULL,
  amount_expected REAL NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'pendente' CHECK (status IN ('pendente', 'paga')),
  paid_date       TEXT,
  paid_amount     REAL,
  notes           TEXT,
  task_id         INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
  paid_by         INTEGER REFERENCES users(id),
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (obligation_id, ref_month)
);
CREATE INDEX idx_finance_items_due ON finance_items(due_date);
CREATE INDEX idx_finance_items_task ON finance_items(task_id);
