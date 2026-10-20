-- Tarefas financeiras › Planejamento anual: previsto ajustado para um mês específico de uma tarefa financeira
-- (os demais meses seguem projetados pela recorrência). Ao gerar a parcela do mês, ela nasce com este valor.
-- Migração apenas aditiva.
CREATE TABLE finance_plan (
  obligation_id INTEGER NOT NULL REFERENCES finance_obligations(id) ON DELETE CASCADE,
  ref_month     TEXT NOT NULL,                       -- AAAA-MM
  amount        REAL NOT NULL,
  updated_by    INTEGER REFERENCES users(id),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (obligation_id, ref_month)
);
