-- @foreign_keys_off
-- Tarefas recorrentes: frequência anual e período de cada ocorrência definido pelo INÍCIO + N dias úteis ou corridos.
-- Mensal: início no dia X de cada mês; anual: início em DD/MM de cada ano. O término (prazo) é calculado pelos dias
-- (úteis = calendário da obra e jornada do responsável). Sem período (period_days nulo) vale a regra antiga: prazo no dia + duração.
-- A tabela é reconstruída só para a regra de frequência aceitar 'anual'; ids e dados são mantidos.
CREATE TABLE recurrences_new (
  id             INTEGER PRIMARY KEY,
  project_id     INTEGER NOT NULL REFERENCES projects(id),
  title          TEXT NOT NULL,
  description    TEXT NOT NULL DEFAULT '',
  field_summary  TEXT,
  notes          TEXT,
  assignee_id    INTEGER REFERENCES users(id),
  stage_id       INTEGER REFERENCES project_stages(id),
  priority       TEXT NOT NULL DEFAULT 'media',
  proof_type     TEXT NOT NULL DEFAULT 'nenhuma',
  duration_days  INTEGER NOT NULL DEFAULT 1,           -- início previsto = prazo - (duração - 1) (sem período definido)
  freq           TEXT NOT NULL CHECK (freq IN ('diaria','semanal','mensal','anual')),
  interval_n     INTEGER NOT NULL DEFAULT 1,
  weekdays       TEXT,                                 -- '1,3' (0 = domingo)
  month_day      INTEGER,                              -- dia do prazo (ou do início, com período) — mensal e anual
  year_month     INTEGER,                              -- mês do prazo (ou do início, com período) — anual, 1 a 12
  period_days    INTEGER,                              -- com período: quantidade de dias a partir do início (o início conta como 1º dia)
  period_day_type TEXT CHECK (period_day_type IN ('uteis','corridos')),
  workdays_only  INTEGER NOT NULL DEFAULT 0,
  start_date     TEXT NOT NULL,                        -- prazo da 1ª ocorrência (com período: início da 1ª ocorrência)
  end_type       TEXT NOT NULL CHECK (end_type IN ('data','ocorrencias','nunca')),
  end_date       TEXT,
  end_count      INTEGER,
  lead_days      INTEGER NOT NULL DEFAULT 7,           -- cria cada ocorrência N dias antes do prazo (ou do início do período)
  generated_count INTEGER NOT NULL DEFAULT 0,
  last_generated_date TEXT,
  active         INTEGER NOT NULL DEFAULT 1,
  ended_at       TEXT,
  ended_by       INTEGER REFERENCES users(id),
  end_reason     TEXT,
  created_by     INTEGER NOT NULL REFERENCES users(id),
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO recurrences_new (id, project_id, title, description, field_summary, notes, assignee_id, stage_id, priority, proof_type, duration_days,
    freq, interval_n, weekdays, month_day, workdays_only, start_date, end_type, end_date, end_count, lead_days, generated_count, last_generated_date,
    active, ended_at, ended_by, end_reason, created_by, created_at, updated_at)
  SELECT id, project_id, title, description, field_summary, notes, assignee_id, stage_id, priority, proof_type, duration_days,
    freq, interval_n, weekdays, month_day, workdays_only, start_date, end_type, end_date, end_count, lead_days, generated_count, last_generated_date,
    active, ended_at, ended_by, end_reason, created_by, created_at, updated_at FROM recurrences;
DROP TABLE recurrences;
ALTER TABLE recurrences_new RENAME TO recurrences;
CREATE INDEX idx_recurrences_project ON recurrences(project_id);
