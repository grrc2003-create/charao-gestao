-- Tarefas financeiras › Mais Controle (API para Relatórios, rotina "pagamentos"): toda semana os pagamentos do ERP
-- viram o real das tarefas financeiras (centro de custo Empresa; a tarefa é a categoria, pelo nome) e os custos dos demais centros de custo ficam em
-- "Custos destinados a Projetos". Só entram pagamentos de contas bancárias cadastradas. Migração apenas aditiva.

-- Cada busca (pela API ou por arquivo exportado): linhas guardadas para a prévia, sem nova consulta à API
CREATE TABLE ext_fetches (
  id          INTEGER PRIMARY KEY,
  source      TEXT NOT NULL DEFAULT 'maiscontrole',
  origin      TEXT NOT NULL,                       -- api | arquivo | auto
  file_name   TEXT,
  rows_json   TEXT NOT NULL,
  row_count   INTEGER NOT NULL DEFAULT 0,
  data_until  TEXT,                                -- até que dia os dados valem (para conferir o "Paguei")
  fetched_by  INTEGER REFERENCES users(id),
  fetched_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Contas bancárias do Mais Controle cujos custos entram no sistema
CREATE TABLE ext_accounts (
  source     TEXT NOT NULL DEFAULT 'maiscontrole',
  ext_key    TEXT NOT NULL,
  label      TEXT NOT NULL,
  active     INTEGER NOT NULL DEFAULT 1,
  updated_by INTEGER REFERENCES users(id),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (source, ext_key)
);

-- Foto atual dos pagamentos do Mais Controle (a cada busca completa é substituída): o realizado de cada tarefa/mês é
-- recalculado a partir daqui, então correções feitas no Mais Controle se refletem sozinhas
CREATE TABLE ext_payments (
  source       TEXT NOT NULL DEFAULT 'maiscontrole',
  ext_key      TEXT NOT NULL,                      -- vencimento, pagamento, valor, fornecedor, descrição (sem a categoria)
  due_date     TEXT,
  paid_date    TEXT,
  ref_month    TEXT NOT NULL,                      -- mês do vencimento
  amount       REAL NOT NULL,
  category     TEXT,
  supplier     TEXT,
  supplier_key TEXT,
  description  TEXT,
  account      TEXT,
  account_key  TEXT,
  cost_center  TEXT,
  fetch_id     INTEGER REFERENCES ext_fetches(id),
  PRIMARY KEY (source, ext_key)
);
CREATE INDEX ext_payments_month ON ext_payments(ref_month);
CREATE INDEX ext_payments_supplier ON ext_payments(supplier_key);

-- Conferência de alocação: pagamento numa categoria diferente da habitual do fornecedor
CREATE TABLE ext_reviews (
  source       TEXT NOT NULL DEFAULT 'maiscontrole',
  ext_key      TEXT NOT NULL,
  supplier_key TEXT,
  decision     TEXT NOT NULL,                      -- ok | errado
  category     TEXT,                               -- categoria do pagamento quando foi decidido
  usual        TEXT,                               -- categoria habitual do fornecedor
  decided_by   INTEGER REFERENCES users(id),
  decided_at   TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (source, ext_key)
);

-- Tarefa: mês mais antigo com pagamento no Mais Controle (o histórico aparece na grade sem gerar tarefas antigas)
ALTER TABLE finance_obligations ADD COLUMN mc_start TEXT;
-- Parcela paga pela sincronização (o Mais Controle pode atualizar ou desfazer; pagamento lançado à mão não é mexido)
ALTER TABLE finance_items ADD COLUMN source TEXT;
-- Previsto calculado (realizado do ano anterior): auto = 1 é refeito a cada sincronização; ajuste manual (auto = 0) vale por cima
ALTER TABLE finance_plan ADD COLUMN auto INTEGER NOT NULL DEFAULT 0;

-- Parcela: "Paguei" (aguardando confirmação do Mais Controle) e justificativa de despesa prevista sem pagamento
ALTER TABLE finance_items ADD COLUMN marked_paid_at TEXT;
ALTER TABLE finance_items ADD COLUMN marked_paid_by INTEGER REFERENCES users(id);
ALTER TABLE finance_items ADD COLUMN marked_amount REAL;
ALTER TABLE finance_items ADD COLUMN justify_kind TEXT;             -- vai_ocorrer | nao_ocorre
ALTER TABLE finance_items ADD COLUMN justify_reason TEXT;
ALTER TABLE finance_items ADD COLUMN justified_at TEXT;
ALTER TABLE finance_items ADD COLUMN justified_by INTEGER REFERENCES users(id);
