-- Cadastro da Equipe: vínculo da pessoa (CLT, PJ, Estagiário). Define as regras de férias:
--   CLT: regras da CLT (como antes) · PJ: férias do acordo (30 dias/12 meses, proporcional, partes livres)
--   Estagiário: recesso (30 dias/12 meses, proporcional, partes livres, pode antecipar até 5 dias).
-- Sem vínculo informado: vale a regra da CLT (comportamento anterior).
ALTER TABLE users ADD COLUMN employment TEXT CHECK (employment IS NULL OR employment IN ('clt', 'pj', 'estagio'));

-- Ausência combinada: falta com reposição (dia inteiro, reposto até o fim do mês seguinte) ou falta descontada.
-- A pessoa pede e o gestor aprova; o gestor também pode lançar (já aprovada). Depois do dia da reposição, o gestor
-- confirma se foi cumprida; não cumprida vira falta descontada na Folha.
CREATE TABLE absences (
  id                INTEGER PRIMARY KEY,
  user_id           INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind              TEXT NOT NULL CHECK (kind IN ('reposicao', 'descontada')),
  off_date          TEXT NOT NULL,
  makeup_date       TEXT,
  status            TEXT NOT NULL DEFAULT 'solicitada' CHECK (status IN ('solicitada', 'aprovada', 'recusada', 'cancelada')),
  makeup_status     TEXT CHECK (makeup_status IS NULL OR makeup_status IN ('pendente', 'cumprida', 'nao_cumprida')),
  note              TEXT,
  decision_note     TEXT,
  requested_by      INTEGER REFERENCES users(id),
  decided_by        INTEGER REFERENCES users(id),
  decided_at        TEXT,
  makeup_checked_by INTEGER REFERENCES users(id),
  makeup_checked_at TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_absences_user ON absences(user_id, off_date);
