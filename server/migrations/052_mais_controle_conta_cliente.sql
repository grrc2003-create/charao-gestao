-- Mais Controle: tipo da conta bancária — Empresa (contas controladas: custos entram nas tarefas financeiras) ou Cliente
-- (gastos do cliente por obra, sem detalhar). Conta de cliente no centro de custo Empresa vai para o verificador.
-- Lançamentos do verificador marcados como "vou ajustar no Mais Controle". Migração apenas aditiva.
ALTER TABLE ext_accounts ADD COLUMN kind TEXT;           -- empresa | cliente | NULL (não classificada)
UPDATE ext_accounts SET kind = 'empresa' WHERE active = 1;

CREATE TABLE ext_issue_marks (
  source    TEXT NOT NULL DEFAULT 'maiscontrole',
  ext_key   TEXT NOT NULL,
  marked_by INTEGER REFERENCES users(id),
  marked_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (source, ext_key)
);
