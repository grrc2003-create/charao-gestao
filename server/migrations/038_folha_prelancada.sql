-- Folha pré-lançada em Tarefas financeiras: valor estimado (opcionalmente o valor do mês anterior),
-- corrigido pela Folha (Administrativa) no fechamento. Migração apenas aditiva.
ALTER TABLE finance_obligations ADD COLUMN repeat_last INTEGER NOT NULL DEFAULT 0;  -- nova parcela usa o valor do mês anterior
ALTER TABLE finance_items ADD COLUMN estimated INTEGER NOT NULL DEFAULT 0;           -- valor estimado (aguarda correção)
ALTER TABLE payroll_months ADD COLUMN finance_item_id INTEGER REFERENCES finance_items(id) ON DELETE SET NULL; -- folha pré-lançada
ALTER TABLE payroll_months ADD COLUMN finance_estimate REAL;                          -- valor estimado antes do fechamento
