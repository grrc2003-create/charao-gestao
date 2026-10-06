-- @foreign_keys_off
-- Perfil Coordenador: mesmas permissões do Gestor e também confere (aprova) as próprias tarefas.
-- O perfil é validado por CHECK na tabela users; a tabela é reconstruída conforme o procedimento oficial
-- do SQLite, preservando todos os usuários, senhas, hierarquia e vínculos.
CREATE TABLE users_new (
  id            INTEGER PRIMARY KEY,
  name          TEXT NOT NULL,
  email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('admin','gestor','coordenador','colaborador')),
  -- total = todos os projetos | projetos = só os liberados | proprias = só tarefas próprias nos projetos liberados
  access_scope  TEXT NOT NULL DEFAULT 'projetos' CHECK (access_scope IN ('total','projetos','proprias')),
  manager_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  job_title     TEXT,
  phone         TEXT,
  active        INTEGER NOT NULL DEFAULT 1,
  must_change_password INTEGER NOT NULL DEFAULT 0,
  last_login_at TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  is_external   INTEGER NOT NULL DEFAULT 0,
  company       TEXT,
  login_enabled INTEGER NOT NULL DEFAULT 1
);
INSERT INTO users_new (id, name, email, password_hash, role, access_scope, manager_id, job_title, phone, active,
  must_change_password, last_login_at, created_at, updated_at, is_external, company, login_enabled)
SELECT id, name, email, password_hash, role, access_scope, manager_id, job_title, phone, active,
  must_change_password, last_login_at, created_at, updated_at, is_external, company, login_enabled FROM users;
DROP TABLE users;
ALTER TABLE users_new RENAME TO users;
