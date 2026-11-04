-- Check-list: início REALIZADO do item (quem marcou e em que dia começou). O planejado continua em start_date e não muda.
-- Migração apenas aditiva.
ALTER TABLE checklist_items ADD COLUMN started_on TEXT;
ALTER TABLE checklist_items ADD COLUMN started_by INTEGER REFERENCES users(id);
