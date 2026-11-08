-- Cotações do projeto: itens a cotar (por disciplina), cadastro único de fornecedores, solicitações de proposta
-- (com evidência do envio e cobranças) e propostas recebidas (preço por item, com revisões e arquivo).
CREATE TABLE suppliers (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL,
  cnpj        TEXT,
  phone       TEXT,
  email       TEXT,
  address     TEXT,
  contact     TEXT,
  disciplines TEXT,                 -- JSON: disciplinas que atende
  notes       TEXT,
  active      INTEGER NOT NULL DEFAULT 1,
  created_by  INTEGER REFERENCES users(id),
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_suppliers_name ON suppliers(name COLLATE NOCASE);

CREATE TABLE quote_items (
  id          INTEGER PRIMARY KEY,
  project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  discipline  TEXT NOT NULL,
  code        TEXT,                 -- código do orçamento
  location    TEXT,
  description TEXT NOT NULL,
  qty         REAL,
  unit        TEXT,
  abc         TEXT CHECK (abc IS NULL OR abc IN ('A', 'B', 'C')),
  notes       TEXT,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_by  INTEGER REFERENCES users(id),
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_quote_items_project ON quote_items(project_id, discipline);

CREATE TABLE quote_requests (
  id            INTEGER PRIMARY KEY,
  project_id    INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  supplier_id   INTEGER NOT NULL REFERENCES suppliers(id),
  status        TEXT NOT NULL DEFAULT 'enviada' CHECK (status IN ('enviada', 'recebida', 'declinou')),
  sent_date     TEXT NOT NULL,
  channel       TEXT,               -- e-mail, WhatsApp, portal, telefone
  due_date      TEXT,               -- responder até
  notes         TEXT,
  received_date TEXT,
  valid_until   TEXT,
  conditions    TEXT,
  imported      INTEGER NOT NULL DEFAULT 0,   -- veio da planilha (sem evidência do envio)
  created_by    INTEGER REFERENCES users(id),
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_quote_requests_project ON quote_requests(project_id);

CREATE TABLE quote_request_items (
  request_id INTEGER NOT NULL REFERENCES quote_requests(id) ON DELETE CASCADE,
  item_id    INTEGER NOT NULL REFERENCES quote_items(id) ON DELETE CASCADE,
  PRIMARY KEY (request_id, item_id)
);

-- Preço por item (cada nova proposta/revisão acrescenta uma linha; vale a mais recente)
CREATE TABLE quote_prices (
  id          INTEGER PRIMARY KEY,
  request_id  INTEGER NOT NULL REFERENCES quote_requests(id) ON DELETE CASCADE,
  item_id     INTEGER NOT NULL REFERENCES quote_items(id) ON DELETE CASCADE,
  price       REAL NOT NULL,
  revision    INTEGER NOT NULL DEFAULT 0,
  created_by  INTEGER REFERENCES users(id),
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_quote_prices ON quote_prices(item_id, request_id);

-- Cobranças (reenvio / follow-up)
CREATE TABLE quote_followups (
  id          INTEGER PRIMARY KEY,
  request_id  INTEGER NOT NULL REFERENCES quote_requests(id) ON DELETE CASCADE,
  date        TEXT NOT NULL,
  channel     TEXT,
  notes       TEXT,
  created_by  INTEGER REFERENCES users(id),
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Arquivos: evidência do envio, evidência da cobrança e arquivo da proposta
CREATE TABLE quote_files (
  id            INTEGER PRIMARY KEY,
  request_id    INTEGER NOT NULL REFERENCES quote_requests(id) ON DELETE CASCADE,
  followup_id   INTEGER REFERENCES quote_followups(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL CHECK (kind IN ('envio', 'cobranca', 'proposta')),
  revision      INTEGER,
  stored_name   TEXT NOT NULL UNIQUE,
  mime          TEXT NOT NULL,
  size          INTEGER NOT NULL,
  original_name TEXT,
  uploaded_by   INTEGER REFERENCES users(id),
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_quote_files_request ON quote_files(request_id);
