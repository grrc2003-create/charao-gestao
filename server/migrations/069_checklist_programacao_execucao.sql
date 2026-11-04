-- Check-list: programação do profissional. Função da vaga quando ele assume uma atividade de outra função (ao sair, a vaga
-- volta para ela) e registro de que está trabalhando no item (início e situação atual). Migração apenas aditiva.
ALTER TABLE checklist_plan ADD COLUMN from_role TEXT;
ALTER TABLE checklist_plan ADD COLUMN started_at TEXT;
ALTER TABLE checklist_plan ADD COLUMN working_at TEXT;
ALTER TABLE checklist_plan ADD COLUMN working_by INTEGER REFERENCES users(id);
