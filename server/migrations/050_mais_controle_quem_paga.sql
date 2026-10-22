-- Mais Controle: "Quem Paga" (Empresa ou Cliente) de cada pagamento, para conferir lançamentos pagos pelo cliente no
-- centro de custo Empresa. Migração apenas aditiva.
ALTER TABLE ext_payments ADD COLUMN payer TEXT;
