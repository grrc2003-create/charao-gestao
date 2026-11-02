-- Check-list: intervalo (dias úteis livres) antes de um item na sequência do profissional. Migração apenas aditiva.
ALTER TABLE checklist_plan ADD COLUMN gap_days INTEGER NOT NULL DEFAULT 0;
