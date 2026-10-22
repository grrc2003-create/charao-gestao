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

-- Pagamentos já lançados (não duplica ao sincronizar de novo). kind: empresa (tarefa) | projeto (centro de custo)
CREATE TABLE ext_payments (
  source        TEXT NOT NULL DEFAULT 'maiscontrole',
  ext_key       TEXT NOT NULL,
  kind          TEXT NOT NULL DEFAULT 'empresa',
  obligation_id INTEGER,
  item_id       INTEGER,
  cost_center   TEXT,
  account       TEXT,
  ref_month     TEXT NOT NULL,
  paid_date     TEXT,
  amount        REAL NOT NULL,
  category      TEXT,
  fetch_id      INTEGER REFERENCES ext_fetches(id),
  batch_id      INTEGER,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (source, ext_key)
);
CREATE INDEX ext_payments_item ON ext_payments(item_id);
CREATE INDEX ext_payments_cc ON ext_payments(kind, ref_month);

-- Parcela: "Paguei" (aguardando confirmação do Mais Controle) e justificativa de despesa prevista sem pagamento
ALTER TABLE finance_items ADD COLUMN marked_paid_at TEXT;
ALTER TABLE finance_items ADD COLUMN marked_paid_by INTEGER REFERENCES users(id);
ALTER TABLE finance_items ADD COLUMN marked_amount REAL;
ALTER TABLE finance_items ADD COLUMN justify_kind TEXT;             -- vai_ocorrer | nao_ocorre
ALTER TABLE finance_items ADD COLUMN justify_reason TEXT;
ALTER TABLE finance_items ADD COLUMN justified_at TEXT;
ALTER TABLE finance_items ADD COLUMN justified_by INTEGER REFERENCES users(id);
