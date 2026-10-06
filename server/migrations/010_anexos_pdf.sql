-- Anexos em PDF (além de imagens): guarda o nome original do arquivo para exibição/download. Migração apenas aditiva.
ALTER TABLE task_files ADD COLUMN original_name TEXT;
ALTER TABLE recurrence_files ADD COLUMN original_name TEXT;
