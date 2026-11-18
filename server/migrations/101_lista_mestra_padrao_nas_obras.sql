-- Lista Mestra: o formato padrão (Configurações) passa a repassar as mudanças às obras.
-- Marca para, ao iniciar, acrescentar uma vez às obras os tipos e etapas do padrão que ainda faltam nelas
-- (nada é apagado; o que a obra criou ou ajustou por conta própria é mantido).
INSERT OR REPLACE INTO app_settings (key, value) VALUES ('ml_sync_pending', '1');
