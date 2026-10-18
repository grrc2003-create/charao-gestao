-- Folha (Administrativa): pessoas da folha, folha do mês e lançamentos por pessoa.
-- Folha do mês = mês do pagamento (AAAA-MM): bolsa/valor proporcional do mês anterior + VT/VR adiantados do próprio mês.
-- Acesso: seção "folha" (padrão: administradores). Migração apenas aditiva.
CREATE TABLE payroll_people (
  id            INTEGER PRIMARY KEY,
  user_id       INTEGER NOT NULL UNIQUE REFERENCES users(id),     -- pessoa do Cadastro da Equipe
  company       TEXT NOT NULL DEFAULT 'charao',                   -- empresa do recibo (logo)
  kind          TEXT NOT NULL DEFAULT 'estagio' CHECK (kind IN ('estagio', 'profissional')), -- profissional: sem VT/VR
  monthly_value REAL NOT NULL DEFAULT 0,                          -- bolsa / valor mensal
  shift         TEXT,                                             -- turno (ex.: 08:00 às 12:00)
  regime        TEXT NOT NULL DEFAULT 'Mensalista',
  schedule      TEXT NOT NULL DEFAULT '{}',                       -- {"1":{"vt":1,"vr":0},...} seg(1)..sex(5)
  pix           TEXT,
  cost_center   TEXT,
  start_date    TEXT,                                             -- início do contrato
  end_date      TEXT,                                             -- término do contrato
  notes         TEXT,
  active        INTEGER NOT NULL DEFAULT 1,
  created_by    INTEGER REFERENCES users(id),
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE payroll_months (
  id            INTEGER PRIMARY KEY,
  ref           TEXT NOT NULL UNIQUE,                             -- AAAA-MM do pagamento
  vt_fare       REAL NOT NULL DEFAULT 5.9,                        -- valor da passagem (ida e volta = 2 por dia)
  vr_daily      REAL NOT NULL DEFAULT 22,                         -- VR por dia
  pay_date      TEXT,                                             -- data prevista do pagamento
  status        TEXT NOT NULL DEFAULT 'aberta' CHECK (status IN ('aberta', 'fechada')),
  notes         TEXT,
  closed_at     TEXT,
  closed_by     INTEGER REFERENCES users(id),
  created_by    INTEGER REFERENCES users(id),
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE payroll_entries (
  id                 INTEGER PRIMARY KEY,
  month_id           INTEGER NOT NULL REFERENCES payroll_months(id) ON DELETE CASCADE,
  person_id          INTEGER NOT NULL REFERENCES payroll_people(id),
  start_date         TEXT,                                        -- período trabalhado no mês da bolsa
  end_date           TEXT,
  absences           INTEGER NOT NULL DEFAULT 0,                  -- faltas (descontam dias trabalhados)
  ho_days            INTEGER NOT NULL DEFAULT 0,                  -- dias em home office (descontam VT já adiantado)
  vt_adjust          REAL NOT NULL DEFAULT 0,                     -- VT diferença (manual)
  vr_adjust          REAL NOT NULL DEFAULT 0,                     -- VR diferença (manual)
  reimbursement      REAL NOT NULL DEFAULT 0,                     -- reembolso / outros
  reimbursement_note TEXT,
  notes              TEXT,                                        -- observação do recibo
  snapshot           TEXT,                                        -- valores congelados no fechamento (JSON)
  obligation_id      INTEGER REFERENCES finance_obligations(id) ON DELETE SET NULL,
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at         TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (month_id, person_id)
);
CREATE INDEX idx_payroll_entries_month ON payroll_entries(month_id);

-- Administradores com lista de seções salva recebem a Folha
UPDATE users SET sections = json_insert(sections, '$[#]', 'folha')
  WHERE role = 'admin' AND sections IS NOT NULL AND json_valid(sections) AND sections NOT LIKE '%"folha"%';
