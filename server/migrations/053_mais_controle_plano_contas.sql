-- Mais Controle: tipo da conta bancária vindo do próprio Mais Controle ("Quem Paga" dos lançamentos da conta) e
-- Plano de Contas de cada lançamento (agrupamento do planejamento anual). Migração apenas aditiva.
ALTER TABLE ext_accounts ADD COLUMN auto_kind TEXT;       -- empresa | cliente, pelo "Quem Paga" do Mais Controle
ALTER TABLE ext_payments ADD COLUMN plan_account TEXT;    -- Plano de Contas do Mais Controle

-- Escolha manual igual ao que o Mais Controle informa passa a seguir o Mais Controle; escolha diferente continua manual
UPDATE ext_accounts SET kind = NULL
WHERE kind IS NOT NULL AND kind = (
  SELECT CASE WHEN SUM(lower(p.payer) = 'cliente') > SUM(lower(p.payer) = 'empresa') THEN 'cliente'
              WHEN SUM(lower(p.payer) = 'empresa') > SUM(lower(p.payer) = 'cliente') THEN 'empresa' END
  FROM ext_payments p WHERE p.source = ext_accounts.source AND p.account_key = ext_accounts.ext_key);
