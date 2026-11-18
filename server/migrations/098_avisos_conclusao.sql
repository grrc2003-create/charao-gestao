-- Avisos de tarefas mostrados pelo mascote Charão (canto da tela) até a pessoa marcar "Ciente". Migração apenas aditiva.
-- task_alerts: cada aviso para uma pessoa.
--   kind: concluida / ressalvas (aviso escolhido por quem conclui) · status · prazo · atraso · avanco · alteracao (alertas configurados na tarefa)
--   tone: reação do mascote (parabens, atencao, insatisfacao)
--   dedupe_key: evita repetir o mesmo alerta de prazo/atraso para a mesma pessoa
-- task_watchers: alertas configurados na tarefa (nenhum por padrão): quem recebe e quais eventos.
CREATE TABLE task_alerts (
  id           INTEGER PRIMARY KEY,
  task_id      INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  sender_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  recipient_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL CHECK (kind IN ('concluida','ressalvas','status','prazo','atraso','avanco','alteracao')),
  tone         TEXT NOT NULL DEFAULT 'atencao' CHECK (tone IN ('parabens','atencao','insatisfacao')),
  title        TEXT NOT NULL,
  note         TEXT,
  dedupe_key   TEXT,
  created_at   TEXT NOT NULL,
  seen_at      TEXT,
  UNIQUE (recipient_id, dedupe_key)
);
CREATE INDEX idx_task_alerts_recipient ON task_alerts (recipient_id, seen_at);
CREATE INDEX idx_task_alerts_task ON task_alerts (task_id);

CREATE TABLE task_watchers (
  task_id    INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  events     TEXT NOT NULL,
  due_days   INTEGER,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (task_id, user_id)
);
CREATE INDEX idx_task_watchers_user ON task_watchers (user_id);
