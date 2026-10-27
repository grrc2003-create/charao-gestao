-- Folha de Campo: medição da mão de obra própria (diárias por dia trabalhado) e das empreitadas (contrato com saldo), por obra.
-- Preenchimento: responsável do projeto, gestores/coordenadores do projeto e quem tem a seção folha_campo.
-- Valores, documento e PIX: somente a seção folha_campo, que também fecha a folha (gera o pagamento no Financeiro).
-- Migração apenas aditiva.
CREATE TABLE field_workers (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL,
  kind        TEXT NOT NULL DEFAULT 'diarista' CHECK (kind IN ('diarista', 'empreiteiro')),
  role        TEXT,                                             -- função (Pedreiro, Ajudante, Mestre...)
  daily_rate  REAL NOT NULL DEFAULT 0,                          -- valor da diária (diarista)
  doc         TEXT,                                             -- CPF / CNPJ
  pix         TEXT,
  pix_type    TEXT,
  phone       TEXT,
  notes       TEXT,
  active      INTEGER NOT NULL DEFAULT 1,
  created_by  INTEGER REFERENCES users(id),
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Empreitada: contrato com o empreiteiro na obra (valor total); medida em % a cada folha
CREATE TABLE field_contracts (
  id          INTEGER PRIMARY KEY,
  project_id  INTEGER NOT NULL REFERENCES projects(id),
  worker_id   INTEGER NOT NULL REFERENCES field_workers(id),
  service     TEXT NOT NULL,
  total       REAL NOT NULL DEFAULT 0,
  start_date  TEXT,
  notes       TEXT,
  status      TEXT NOT NULL DEFAULT 'ativa' CHECK (status IN ('ativa', 'encerrada')),
  created_by  INTEGER REFERENCES users(id),
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_field_contracts_project ON field_contracts(project_id);

CREATE TABLE field_sheets (
  id            INTEGER PRIMARY KEY,
  project_id    INTEGER NOT NULL REFERENCES projects(id),
  seq           INTEGER NOT NULL,                               -- FC-01, FC-02... por obra
  start_date    TEXT NOT NULL,
  end_date      TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'aberta' CHECK (status IN ('aberta', 'fechada')),
  activities    TEXT,                                           -- atividades desenvolvidas
  pay_date      TEXT,                                           -- vencimento do pagamento gerado no fechamento
  obligation_id INTEGER REFERENCES finance_obligations(id) ON DELETE SET NULL,
  snapshot      TEXT,                                           -- valores congelados no fechamento (JSON)
  closed_at     TEXT,
  closed_by     INTEGER REFERENCES users(id),
  created_by    INTEGER REFERENCES users(id),
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (project_id, seq)
);
CREATE INDEX idx_field_sheets_project ON field_sheets(project_id);

-- Mão de obra própria na folha: diárias por dia, serviço a apropriar, parte paga pelo cliente e ajuste (desconto/adiantamento)
CREATE TABLE field_sheet_people (
  id           INTEGER PRIMARY KEY,
  sheet_id     INTEGER NOT NULL REFERENCES field_sheets(id) ON DELETE CASCADE,
  worker_id    INTEGER NOT NULL REFERENCES field_workers(id),
  days         TEXT NOT NULL DEFAULT '{}',                      -- {"AAAA-MM-DD": 1 | 0.5 ...}
  service      TEXT,                                            -- apropriar (etapa/serviço)
  client_paid  REAL NOT NULL DEFAULT 0,
  adjust       REAL NOT NULL DEFAULT 0,
  adjust_note  TEXT,
  paid_at      TEXT,                                            -- pago (data), marcado por pessoa
  paid_by      INTEGER REFERENCES users(id),
  UNIQUE (sheet_id, worker_id)
);

-- Empreitadas medidas na folha: % executado no período
CREATE TABLE field_sheet_contracts (
  id           INTEGER PRIMARY KEY,
  sheet_id     INTEGER NOT NULL REFERENCES field_sheets(id) ON DELETE CASCADE,
  contract_id  INTEGER NOT NULL REFERENCES field_contracts(id),
  pct          REAL NOT NULL DEFAULT 0,
  client_paid  REAL NOT NULL DEFAULT 0,
  notes        TEXT,
  paid_at      TEXT,
  paid_by      INTEGER REFERENCES users(id),
  UNIQUE (sheet_id, contract_id)
);

-- Administradores com lista de seções salva recebem a Folha de Campo
UPDATE users SET sections = json_insert(sections, '$[#]', 'folha_campo')
  WHERE role = 'admin' AND sections IS NOT NULL AND json_valid(sections) AND sections NOT LIKE '%"folha_campo"%';
