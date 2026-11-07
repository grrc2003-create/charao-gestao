-- Folha (Administrativa): tipo da chave PIX (CPF, CNPJ, Telefone, E-mail, Aleatória), usado no PIX Copia e Cola com valor.
-- Migração apenas aditiva: sem tipo, o sistema deduz pelo formato da chave e pede para conferir.
ALTER TABLE payroll_people ADD COLUMN pix_type TEXT;
