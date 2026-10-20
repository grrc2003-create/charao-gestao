-- Recebimentos dos contratos (parcelas, RT e outras entradas), lançados à mão ou importados das planilhas do financeiro.
-- Contrato = cliente + obra. RT (reserva técnica paga por fornecedor) fica no contrato da obra, marcada como RT.
-- Outras entradas (aporte, empréstimo, reembolso, sem obra) ficam sem contrato e fora dos totais de faturamento.
-- Situação: recebido (data de recebimento preenchida) ou a receber (vencido quando o vencimento já passou).
-- Migração apenas aditiva.
CREATE TABLE contract_receipts (
  id              INTEGER PRIMARY KEY,
  contract_id     INTEGER REFERENCES contracts(id) ON DELETE CASCADE,   -- NULL = outras entradas
  kind            TEXT NOT NULL DEFAULT 'parcela' CHECK (kind IN ('parcela', 'rt', 'outra')),
  payer           TEXT,                                  -- quem pagou (cliente, fornecedor da RT, banco…)
  nature          TEXT,                                  -- natureza (Prestação de Serviços, Execução de Obras…)
  description     TEXT,
  doc_number      TEXT,
  installment     TEXT,                                  -- condição (ex.: 2/3 parcelas, À Vista)
  due_date        TEXT NOT NULL,                         -- vencimento
  competence_date TEXT,
  amount          REAL NOT NULL DEFAULT 0,               -- valor da parcela
  received_date   TEXT,
  received_amount REAL,
  discount        REAL NOT NULL DEFAULT 0,
  interest        REAL NOT NULL DEFAULT 0,               -- juros / multas
  account         TEXT,                                  -- conta bancária
  method          TEXT,                                  -- forma de recebimento
  notes           TEXT,
  measurement_id  INTEGER REFERENCES measurements(id) ON DELETE SET NULL, -- mesmo dinheiro de um boletim recebido (não soma duas vezes)
  import_key      TEXT UNIQUE,                           -- identifica a linha da planilha (reenviar não duplica)
  created_by      INTEGER REFERENCES users(id),
  received_by     INTEGER REFERENCES users(id),
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_contract_receipts_contract ON contract_receipts(contract_id, due_date);
CREATE INDEX idx_contract_receipts_received ON contract_receipts(received_date);

-- Origem do contrato (manual ou criado pela importação de recebimentos)
ALTER TABLE contracts ADD COLUMN source TEXT;
