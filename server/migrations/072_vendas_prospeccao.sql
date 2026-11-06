-- Vendas e Prospecção (Gestão da Empresa): funil em Kanban com colunas personalizadas.
-- Cada coluna tem um "tipo de etapa" que define o que é exigido ao entrar nela:
--   prospeccao (cliente, endereço, origem e empresa) · apresentacao (escopo possível) · proposta (escopo final, valor e proposta anexada)
--   negociacao (revisões, desconto e avaliação do cliente) · ganho (pergunta se cria o contrato) · perdido (motivo) · livre (sem exigência extra)
-- Listas de apoio em Configurações: origens, motivos de perda e avaliações do cliente. Migração apenas aditiva.
CREATE TABLE sales_stages (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL,
  kind        TEXT NOT NULL DEFAULT 'livre' CHECK (kind IN ('prospeccao', 'apresentacao', 'proposta', 'negociacao', 'ganho', 'perdido', 'livre')),
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO sales_stages (name, kind, sort_order) VALUES
  ('Prospecção', 'prospeccao', 1), ('Apresentação', 'apresentacao', 2), ('Proposta', 'proposta', 3),
  ('Negociação', 'negociacao', 4), ('Contrato fechado', 'ganho', 5), ('Contrato perdido', 'perdido', 6);

CREATE TABLE sales_sources (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE, active INTEGER NOT NULL DEFAULT 1, sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO sales_sources (name, sort_order) VALUES ('Indicação', 1), ('Site', 2), ('Instagram', 3), ('Google', 4), ('Cliente antigo', 5), ('Prospecção ativa', 6), ('Outro', 7);

CREATE TABLE sales_loss_reasons (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE, active INTEGER NOT NULL DEFAULT 1, sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO sales_loss_reasons (name, sort_order) VALUES ('Preço acima do esperado', 1), ('Escolheu um concorrente', 2), ('Prazo não atendeu', 3),
  ('Projeto adiado ou cancelado', 4), ('Sem retorno do cliente', 5), ('Escopo fora do nosso perfil', 6);

CREATE TABLE sales_profiles (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE, active INTEGER NOT NULL DEFAULT 1, sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO sales_profiles (name, sort_order) VALUES ('Duro na negociação', 1), ('Exigente', 2), ('Moderado', 3), ('Tranquilo', 4), ('Decidido', 5);

CREATE TABLE sales_opportunities (
  id               INTEGER PRIMARY KEY,
  code             TEXT NOT NULL UNIQUE,
  stage_id         INTEGER NOT NULL REFERENCES sales_stages(id),
  sort_order       INTEGER NOT NULL DEFAULT 0,
  company          TEXT NOT NULL DEFAULT 'charao' CHECK (company IN ('charao', 'lus')),
  client           TEXT NOT NULL,
  client_doc       TEXT,
  contact_name     TEXT,
  phone            TEXT,
  email            TEXT,
  address          TEXT,
  city             TEXT,
  source_id        INTEGER REFERENCES sales_sources(id),
  source_detail    TEXT,
  title            TEXT,
  possible_scope   TEXT,
  final_scope      TEXT,
  proposal_value   REAL,
  discount_pct     REAL,
  profile_id       INTEGER REFERENCES sales_profiles(id),
  negotiation_notes TEXT,
  lost_reason_id   INTEGER REFERENCES sales_loss_reasons(id),
  lost_notes       TEXT,
  contract_id      INTEGER REFERENCES contracts(id),
  owner_id         INTEGER REFERENCES users(id),
  notes            TEXT,
  stage_since      TEXT NOT NULL DEFAULT (datetime('now')),
  closed_at        TEXT,
  created_by       INTEGER REFERENCES users(id),
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_sales_opp_stage ON sales_opportunities(stage_id, sort_order);

-- Propostas e revisões (R00, R01…): valor, desconto e arquivo (PDF ou imagem)
CREATE TABLE sales_proposals (
  id             INTEGER PRIMARY KEY,
  opportunity_id INTEGER NOT NULL REFERENCES sales_opportunities(id) ON DELETE CASCADE,
  rev            INTEGER NOT NULL,
  value          REAL,
  discount_pct   REAL,
  notes          TEXT,
  stored_name    TEXT,
  mime           TEXT,
  original_name  TEXT,
  size           INTEGER,
  created_by     INTEGER REFERENCES users(id),
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_sales_prop_opp ON sales_proposals(opportunity_id, rev);

-- Histórico de movimentação entre colunas
CREATE TABLE sales_moves (
  id             INTEGER PRIMARY KEY,
  opportunity_id INTEGER NOT NULL REFERENCES sales_opportunities(id) ON DELETE CASCADE,
  from_stage     TEXT,
  to_stage       TEXT NOT NULL,
  user_id        INTEGER REFERENCES users(id),
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_sales_moves_opp ON sales_moves(opportunity_id);
