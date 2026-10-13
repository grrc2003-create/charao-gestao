-- Data de conclusão informada com atraso: quem executou informa o dia em que terminou (anterior ao registro);
-- quem confere autoriza ou nega (usa a data do registro ou outra). Guarda o registro original e o atraso de preenchimento.
-- Migração apenas aditiva.
ALTER TABLE tasks ADD COLUMN claimed_done_date TEXT;          -- data informada, aguardando autorização
ALTER TABLE tasks ADD COLUMN done_date_status TEXT CHECK (done_date_status IS NULL OR done_date_status IN ('pendente','autorizada','negada'));
ALTER TABLE tasks ADD COLUMN delivered_registered_at TEXT;    -- quando a entrega foi registrada no sistema (se a data valida for outra)
ALTER TABLE tasks ADD COLUMN filling_delay_days INTEGER;      -- dias entre a conclusão valida e o registro
