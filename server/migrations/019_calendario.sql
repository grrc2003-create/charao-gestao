-- Calendário de trabalho: local da obra (UF/município IBGE) e dias não trabalhados.
-- Feriados nacionais são calculados pelo sistema; estaduais e municipais vêm da base aberta "feriados-brasil"
-- (GitHub, licença MIT) e ficam guardados por obra; ajustes manuais por obra e dias não trabalhados da empresa.
-- Migração apenas aditiva.
ALTER TABLE projects ADD COLUMN uf TEXT;
ALTER TABLE projects ADD COLUMN municipio TEXT;
ALTER TABLE projects ADD COLUMN ibge_code INTEGER;
ALTER TABLE projects ADD COLUMN holidays_synced_at TEXT;

CREATE TABLE calendar_days (
  id          INTEGER PRIMARY KEY,
  project_id  INTEGER REFERENCES projects(id) ON DELETE CASCADE, -- NULL = dia não trabalhado da empresa (todas as obras)
  date        TEXT NOT NULL,
  name        TEXT NOT NULL,
  scope       TEXT NOT NULL,   -- nacional | estadual | municipal | empresa | obra
  source      TEXT NOT NULL,   -- auto (internet) | manual
  working     INTEGER NOT NULL DEFAULT 0, -- 1 = a obra trabalha neste dia (feriado desconsiderado)
  created_by  INTEGER REFERENCES users(id),
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_calendar_project_date ON calendar_days(project_id, date);

-- Padrões: sábado e domingo não trabalhados; Carnaval e Corpus Christi (ponto facultativo) não trabalhados
INSERT OR IGNORE INTO app_settings (key, value) VALUES ('work_saturday', '0'), ('work_sunday', '0'), ('carnaval_off', '1'), ('corpus_off', '1');
