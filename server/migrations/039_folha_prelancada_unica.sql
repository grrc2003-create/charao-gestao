-- Uma folha pré-lançada (parcela de Tarefas financeiras) só pode ser usada por uma Folha do mês.
CREATE UNIQUE INDEX IF NOT EXISTS idx_payroll_months_finance_item ON payroll_months(finance_item_id) WHERE finance_item_id IS NOT NULL;
