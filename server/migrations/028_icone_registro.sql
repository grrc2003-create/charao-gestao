-- Ícone de cada tipo de registro (Gantt, listas e relatórios). Migração apenas aditiva.
ALTER TABLE record_types ADD COLUMN icon TEXT NOT NULL DEFAULT 'nota';
UPDATE record_types SET icon = 'check' WHERE name = 'Definição';
UPDATE record_types SET icon = 'reuniao' WHERE name = 'Ata de reunião';
UPDATE record_types SET icon = 'balao' WHERE name = 'Solicitação do cliente';
UPDATE record_types SET icon = 'troca' WHERE name = 'Alteração de escopo / aditivo';
UPDATE record_types SET icon = 'alerta' WHERE name = 'Ocorrência / incidente';
UPDATE record_types SET icon = 'olho' WHERE name = 'Visita técnica / vistoria';
UPDATE record_types SET icon = 'megafone' WHERE name = 'Comunicado / notificação';
UPDATE record_types SET icon = 'pergunta' WHERE name = 'Pendência de projeto (RFI)';
UPDATE record_types SET icon = 'lampada' WHERE name = 'Lição aprendida';
