-- Esquema inicial — Charão Gestão de Obras
CREATE TABLE users (
  id            INTEGER PRIMARY KEY,
  name          TEXT NOT NULL,
  email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('admin','gestor','colaborador')),
  -- total = todos os projetos | projetos = só os liberados | proprias = só tarefas próprias nos projetos liberados
  access_scope  TEXT NOT NULL DEFAULT 'projetos' CHECK (access_scope IN ('total','projetos','proprias')),
  manager_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  job_title     TEXT,
  phone         TEXT,
  active        INTEGER NOT NULL DEFAULT 1,
  must_change_password INTEGER NOT NULL DEFAULT 0,
  last_login_at TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen  TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  ip         TEXT,
  user_agent TEXT
);
CREATE INDEX idx_sessions_user ON sessions(user_id);

CREATE TABLE projects (
  id          INTEGER PRIMARY KEY,
  code        TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  client      TEXT NOT NULL,
  location    TEXT,
  description TEXT,
  status      TEXT NOT NULL DEFAULT 'planejamento'
              CHECK (status IN ('planejamento','em_andamento','pausado','concluido','cancelado')),
  start_date  TEXT,
  end_date    TEXT,
  actual_end_date TEXT,
  lead_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  task_seq    INTEGER NOT NULL DEFAULT 0,
  created_by  INTEGER REFERENCES users(id),
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Equipe/responsáveis do projeto (não concede acesso por si só)
CREATE TABLE project_members (
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (project_id, user_id)
);

-- Restrição de acesso por projeto (para access_scope = projetos/proprias)
CREATE TABLE user_project_access (
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, project_id)
);

CREATE TABLE tasks (
  id            INTEGER PRIMARY KEY,
  code          TEXT NOT NULL UNIQUE,
  project_id    INTEGER NOT NULL REFERENCES projects(id),
  seq           INTEGER NOT NULL,
  title         TEXT NOT NULL,
  description   TEXT NOT NULL DEFAULT '',
  field_summary TEXT,
  notes         TEXT,
  assignee_id   INTEGER REFERENCES users(id),
  assigned_by_id INTEGER REFERENCES users(id),
  creator_id    INTEGER NOT NULL REFERENCES users(id),
  due_date      TEXT,
  priority      TEXT NOT NULL DEFAULT 'media' CHECK (priority IN ('baixa','media','alta','urgente')),
  -- 'atrasada' é derivada (prazo vencido sem entrega), não armazenada
  status        TEXT NOT NULL DEFAULT 'aberta'
                CHECK (status IN ('aberta','em_andamento','aguardando_conferencia','concluida')),
  proof_type    TEXT NOT NULL DEFAULT 'nenhuma' CHECK (proof_type IN ('nenhuma','foto','descricao','foto_descricao')),
  exec_description TEXT,
  exec_notes    TEXT,
  delivered_at  TEXT,
  review_status TEXT CHECK (review_status IN ('pendente','aprovada','devolvida')),
  review_comment TEXT,
  reviewed_by   INTEGER REFERENCES users(id),
  reviewed_at   TEXT,
  completed_at  TEXT,
  started_at    TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (project_id, seq)
);
CREATE INDEX idx_tasks_project ON tasks(project_id);
CREATE INDEX idx_tasks_assignee ON tasks(assignee_id);
CREATE INDEX idx_tasks_status ON tasks(status);

CREATE TABLE task_files (
  id          INTEGER PRIMARY KEY,
  task_id     INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('referencia','execucao')),
  stored_name TEXT NOT NULL UNIQUE,
  mime        TEXT NOT NULL,
  size        INTEGER NOT NULL,
  caption     TEXT,
  uploaded_by INTEGER NOT NULL REFERENCES users(id),
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_task_files_task ON task_files(task_id);

CREATE TABLE task_history (
  id         INTEGER PRIMARY KEY,
  task_id    INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  user_id    INTEGER REFERENCES users(id),
  action     TEXT NOT NULL,
  details    TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_task_history_task ON task_history(task_id);

-- Auditoria administrativa (usuários, permissões, projetos, logins)
CREATE TABLE audit_log (
  id         INTEGER PRIMARY KEY,
  actor_id   INTEGER REFERENCES users(id),
  entity     TEXT NOT NULL,
  entity_id  INTEGER,
  action     TEXT NOT NULL,
  details    TEXT,
  ip         TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
