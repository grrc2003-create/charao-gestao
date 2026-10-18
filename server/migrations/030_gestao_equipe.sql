-- Gestão da Equipe: organograma, cadastro da equipe (função e responsabilidades) e férias (regras da CLT).
-- Migração apenas aditiva.
ALTER TABLE users ADD COLUMN responsibilities TEXT;   -- o que a pessoa faz na empresa (obrigatório no Cadastro da Equipe)
ALTER TABLE users ADD COLUMN department TEXT;         -- setor / departamento
ALTER TABLE users ADD COLUMN admission_date TEXT;     -- data de admissão (base dos períodos aquisitivos de férias)

CREATE TABLE vacations (
  id            INTEGER PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  period_start  TEXT NOT NULL,                        -- início do período aquisitivo a que as férias pertencem
  start_date    TEXT NOT NULL,
  end_date      TEXT NOT NULL,
  days          INTEGER NOT NULL,
  status        TEXT NOT NULL DEFAULT 'solicitada' CHECK (status IN ('solicitada', 'aprovada', 'recusada', 'cancelada')),
  note          TEXT,
  decision_note TEXT,
  requested_by  INTEGER REFERENCES users(id),
  decided_by    INTEGER REFERENCES users(id),
  decided_at    TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_vacations_user ON vacations(user_id, start_date);

-- Administradores com lista de seções salva recebem a nova seção Gestão da Equipe
UPDATE users SET sections = json_insert(sections, '$[#]', 'equipe')
  WHERE role = 'admin' AND sections IS NOT NULL AND json_valid(sections) AND sections NOT LIKE '%"equipe"%';
