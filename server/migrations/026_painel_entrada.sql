-- Tela de entrada de cada usuário: 'pessoal' (Meu painel) ou 'empresa' (Visão da empresa). NULL = padrão.
ALTER TABLE users ADD COLUMN home TEXT CHECK (home IS NULL OR home IN ('pessoal', 'empresa'));
