-- Mais Controle: guarda a resposta da API (CSV) antes de ler. Se a leitura falhar, dá para reprocessar sem gastar outra
-- consulta da cota do plano. Migração apenas aditiva.
ALTER TABLE ext_fetches ADD COLUMN raw TEXT;
ALTER TABLE ext_fetches ADD COLUMN error TEXT;
