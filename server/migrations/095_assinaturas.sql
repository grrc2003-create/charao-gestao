-- Assinatura eletrônica nos documentos (recibos das folhas, boletim de medição, check-list, relatórios e História do projeto).
-- Cada assinatura guarda: documento (tipo + chave), linha (slot), quem assinou, a imagem, quem coletou, aparelho e a
-- "impressão" do conteúdo no momento (para avisar quando o documento muda depois). Nada é apagado: remover = marcar.
-- Assinatura salva: cada pessoa com acesso pode guardar a própria (usada com a confirmação da senha). Migração apenas aditiva.
ALTER TABLE users ADD COLUMN signature_file TEXT;
ALTER TABLE users ADD COLUMN signature_updated_at TEXT;

CREATE TABLE document_signatures (
  id              INTEGER PRIMARY KEY,
  doc_type        TEXT NOT NULL CHECK (doc_type IN ('campo','folha','medicao','checklist','relatorio','historia')),
  doc_key         TEXT NOT NULL,
  slot            TEXT NOT NULL,
  slot_label      TEXT,
  signer_user_id  INTEGER REFERENCES users(id),
  signer_name     TEXT NOT NULL,
  signer_doc      TEXT,
  method          TEXT NOT NULL CHECK (method IN ('desenho','salva')),
  image_file      TEXT NOT NULL,
  content_hash    TEXT,
  collected_by    INTEGER NOT NULL REFERENCES users(id),
  ip              TEXT,
  user_agent      TEXT,
  signed_at       TEXT NOT NULL,
  removed_at      TEXT,
  removed_by      INTEGER REFERENCES users(id),
  remove_reason   TEXT
);
CREATE INDEX idx_doc_signatures ON document_signatures(doc_type, doc_key, slot);
