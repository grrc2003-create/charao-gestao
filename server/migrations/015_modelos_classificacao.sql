-- Modelos de classificação das tarefas (Grupo/Local/Etapa), cadastrados em Configurações e aplicados no cadastro
-- do projeto: as classificações do modelo são copiadas para o projeto (cada projeto continua com a sua lista).
-- Migração apenas aditiva.
CREATE TABLE stage_templates (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE COLLATE NOCASE,
  items       TEXT NOT NULL DEFAULT '[]', -- lista JSON de nomes, na ordem de exibição
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO stage_templates (name, items, sort_order) VALUES
  ('Etapas de obra — padrão', '["Serviços preliminares","Fundação","Estrutura","Alvenaria","Instalações","Cobertura","Revestimentos","Esquadrias","Pintura","Limpeza e entrega"]', 1),
  ('Ambientes — apartamento', '["Sala","Cozinha","Área de serviço","Banheiro social","Suíte","Dormitório","Varanda","Área externa"]', 2);
