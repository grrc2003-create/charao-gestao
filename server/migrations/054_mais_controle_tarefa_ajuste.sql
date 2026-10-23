-- Mais Controle: tarefa de ajuste (projeto interno INT-001, classificação "Mais Controle") criada ao decidir "ajustar no
-- Mais Controle" — no verificador, na regra por categoria e no stand by da conferência. Migração apenas aditiva.
ALTER TABLE ext_issue_marks ADD COLUMN task_id INTEGER REFERENCES tasks(id) ON DELETE SET NULL;
ALTER TABLE ext_category_rules ADD COLUMN task_id INTEGER REFERENCES tasks(id) ON DELETE SET NULL;
ALTER TABLE ext_reviews ADD COLUMN task_id INTEGER REFERENCES tasks(id) ON DELETE SET NULL;
