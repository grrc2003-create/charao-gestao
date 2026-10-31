-- Projetos: "Controle de folha de campo". Só as obras marcadas aparecem na Folha de Campo.
-- Migração apenas aditiva: as obras que já usam a Folha de Campo (folhas, empreitadas, medições do terceiro
-- ou dívidas anteriores) já ficam marcadas, para nada sumir.
ALTER TABLE projects ADD COLUMN field_control INTEGER NOT NULL DEFAULT 0;
UPDATE projects SET field_control = 1 WHERE kind = 'obra' AND (
  id IN (SELECT project_id FROM field_sheets)
  OR id IN (SELECT project_id FROM field_contracts)
  OR id IN (SELECT project_id FROM field_measurements)
  OR id IN (SELECT project_id FROM field_debts)
);
