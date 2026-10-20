-- Contratos por empresa (Charão Engenharia & Construção ou Ludimila Siqueira Arquitetura & Design — LuS) e por tipo
-- (lista própria em Configurações › Tipos de contrato). O boletim sai com o logo e o nome da empresa do contrato.
-- company_auto = 1 enquanto a empresa não foi escolhida à mão (a importação das planilhas pode ajustar pela conta "(LUS)").
-- Migração apenas aditiva: contratos existentes começam como Charão; a classificação automática roda uma vez na subida.
CREATE TABLE contract_types (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE COLLATE NOCASE,
  active      INTEGER NOT NULL DEFAULT 1,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO contract_types (name, sort_order) VALUES
  ('Administração', 1), ('Construção', 2), ('Reforma', 3), ('Fiscalização', 4), ('Projeto', 5),
  ('Orçamento', 6), ('Consultoria', 7), ('Gestão de Projetos', 8), ('Sondagem', 9);

ALTER TABLE contracts ADD COLUMN company TEXT NOT NULL DEFAULT 'charao' CHECK (company IN ('charao', 'lus'));
ALTER TABLE contracts ADD COLUMN company_auto INTEGER NOT NULL DEFAULT 1;
ALTER TABLE contracts ADD COLUMN type_id INTEGER REFERENCES contract_types(id);
CREATE INDEX idx_contracts_type ON contracts(type_id);

-- Conta bancária de cada linha importada (para reconhecer a LuS pela conta "(LUS)")
ALTER TABLE contract_import_rows ADD COLUMN account TEXT;
