-- Empresas: cadastro (Configurações → Empresas) e empresa de cada pessoa e de cada projeto.
-- Tipos: 'grupo' (Charão, LuS), 'parceira' (outra empresa cuja equipe é gerenciada aqui) e 'terceirizada'.
-- A empresa NÃO muda o acesso (perfil e projetos liberados continuam valendo); só quem é de empresa de fora do grupo
-- passa a enxergar apenas as pessoas da própria empresa (administradores veem todos). Migração apenas aditiva.
CREATE TABLE companies (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL,
  kind        TEXT NOT NULL DEFAULT 'parceira' CHECK (kind IN ('grupo','parceira','terceirizada')),
  cnpj        TEXT,
  group_key   TEXT UNIQUE,                 -- empresas do grupo: chave usada na Folha e nos Contratos (charao, lus)
  active      INTEGER NOT NULL DEFAULT 1,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX idx_companies_name ON companies(name COLLATE NOCASE);
INSERT INTO companies (name, kind, group_key, sort_order) VALUES
  ('Charão Engenharia & Construção', 'grupo', 'charao', 1),
  ('Ludimila Siqueira Arquitetura & Design', 'grupo', 'lus', 2);
-- Empresas já digitadas nos terceirizados viram cadastro (nomes iguais, sem diferenciar maiúsculas, viram uma só)
INSERT OR IGNORE INTO companies (name, kind, sort_order)
  SELECT TRIM(company), 'terceirizada', 10 FROM users WHERE is_external = 1 AND TRIM(IFNULL(company, '')) <> '' GROUP BY TRIM(company) COLLATE NOCASE;

ALTER TABLE users ADD COLUMN company_id INTEGER REFERENCES companies(id);
UPDATE users SET company_id = (SELECT c.id FROM companies c WHERE c.name = TRIM(users.company) COLLATE NOCASE)
  WHERE is_external = 1 AND TRIM(IFNULL(company, '')) <> '';
UPDATE users SET company_id = (SELECT id FROM companies WHERE group_key = 'charao') WHERE company_id IS NULL AND is_external = 0;

-- Projetos: a empresa do contrato ligado ao projeto (Charão ou LuS); sem contrato, Charão
ALTER TABLE projects ADD COLUMN company_id INTEGER REFERENCES companies(id);
UPDATE projects SET company_id = (SELECT c.id FROM contracts ct JOIN companies c ON c.group_key = ct.company WHERE ct.project_id = projects.id ORDER BY ct.id LIMIT 1);
UPDATE projects SET company_id = (SELECT id FROM companies WHERE group_key = 'charao') WHERE company_id IS NULL;
CREATE INDEX idx_users_company ON users(company_id);
CREATE INDEX idx_projects_company ON projects(company_id);
