-- Check-list: equipe necessária de cada item (profissionais da Folha de Campo ou só a função, com os dias de cada um).
-- O valor do item = quantidade × dias × diária. Enquanto o item está em aberto acompanha a diária atual;
-- ao ficar Conforme a diária usada é guardada em frozen_rate (mudança posterior não altera o que já foi executado).
-- Funções: cadastro com a diária genérica, começa com as funções já usadas nos profissionais (diária a preencher).
-- Migração apenas aditiva.
CREATE TABLE field_roles (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE COLLATE NOCASE,
  daily_rate  REAL NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT OR IGNORE INTO field_roles (name)
  SELECT DISTINCT TRIM(role) FROM field_workers WHERE role IS NOT NULL AND TRIM(role) <> '';

CREATE TABLE checklist_item_team (
  id          INTEGER PRIMARY KEY,
  item_id     INTEGER NOT NULL REFERENCES checklist_items(id) ON DELETE CASCADE,
  worker_id   INTEGER REFERENCES field_workers(id),   -- profissional da folha (a diária vem do cadastro dele)
  role        TEXT,                                   -- só a função (a diária vem de field_roles)
  qty         INTEGER NOT NULL DEFAULT 1,             -- quantas pessoas da função (profissional = 1)
  days        REAL NOT NULL,                          -- dias de cada pessoa neste item
  frozen_rate REAL,
  CHECK ((worker_id IS NOT NULL) <> (role IS NOT NULL))
);
CREATE INDEX idx_checklist_item_team_item ON checklist_item_team(item_id);
