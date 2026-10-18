-- Processos da Empresa: gestores e coordenadores criam e editam; a publicação depende da aprovação do administrador.
-- review_status: NULL (rascunho em edição) | 'enviado' (aguardando aprovação) | 'devolvido' (administrador pediu ajustes).
-- Migração apenas aditiva.
ALTER TABLE processes ADD COLUMN review_status TEXT CHECK (review_status IN ('enviado', 'devolvido'));
ALTER TABLE processes ADD COLUMN submit_note TEXT;        -- o que mudou (informado no envio para aprovação)
ALTER TABLE processes ADD COLUMN submitted_by INTEGER REFERENCES users(id);
ALTER TABLE processes ADD COLUMN submitted_at TEXT;
ALTER TABLE processes ADD COLUMN review_note TEXT;        -- motivo da devolução
ALTER TABLE processes ADD COLUMN reviewed_by INTEGER REFERENCES users(id);
ALTER TABLE processes ADD COLUMN reviewed_at TEXT;

-- Gestores e coordenadores com lista de seções salva recebem a edição de processos
UPDATE users SET sections = json_insert(sections, '$[#]', 'processos')
  WHERE role IN ('gestor', 'coordenador') AND sections IS NOT NULL AND json_valid(sections) AND sections NOT LIKE '%"processos"%';
