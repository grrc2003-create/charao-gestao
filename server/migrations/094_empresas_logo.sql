-- Empresas: logo próprio. Quem é de uma empresa com logo vê o logo dela no sistema (menu lateral, topo do celular e
-- título da aba). Sem logo enviado: a LuS usa o logo que já existe no sistema; as demais, o logo da Charão. Migração apenas aditiva.
ALTER TABLE companies ADD COLUMN logo_file TEXT;
