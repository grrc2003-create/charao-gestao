-- Processos da Empresa: tutorial da Lista Mestra de projetos (SIS-25)
INSERT OR IGNORE INTO processes (code, status, version, published, published_at)
VALUES ('SIS-25', 'publicado', 1, json_object(
  'title', 'Lista Mestra de projetos: etapas, datas e alterações',
  'area', 'Sistema · Gestão de Obras',
  'frequency', 'Semanal',
  'section', 'projetos',
  'objective', 'Controlar em que etapa está cada projeto da obra (arquitetura, estrutural, complementares), as datas previstas das próximas etapas e o porquê de cada alteração de data.',
  'erp_module', 'Charão Gestão → Projetos → (projeto) → Lista Mestra',
  'links', json_array(json_object('kind', 'link', 'label', 'Abrir Projetos', 'url', 'https://charao-gestao.onrender.com/#/projetos')),
  'inputs', 'Projetos contratados de cada obra, projetistas e cronograma de entregas de cada etapa.',
  'outputs', 'Lista Mestra atualizada: etapa atual, próximas datas, desvio em relação à data base e histórico de alterações (tela, Excel e PDF).',
  'rules', 'A Lista Mestra só existe nos projetos marcados no cadastro (Este projeto terá Lista Mestra), como as cotações.
Somente o responsável da obra e os gestores alteram as datas; a alteração vale na hora e fica registrada.
A primeira data prevista de cada etapa é a data base e não muda. O desvio é contado em dias em relação a ela.
Mudar uma data prevista que já existia exige o motivo (da lista) e a explicação do porquê.
Nova linha de base só para gestores e administradores, com motivo (ex.: aditivo assinado).
As etapas vêm do tipo de projeto, cadastrado em Configurações; etapas com datas não são excluídas, são inativadas.',
  'indicators', json_array('Projetos atrasados (etapa com previsão vencida)', 'Projetos com alteração de data', 'Desvio do término em dias', 'Principais motivos das alterações'),
  'steps', json_array(
    json_object('responsible', 'Gestor / Coordenador', 'activity', 'Marca no cadastro do projeto “Este projeto terá Lista Mestra”', 'details', 'Projetos → (projeto) → **Editar**. Só os projetos marcados mostram o card **Lista Mestra de projetos**; desmarcando, a área some do projeto, mas nada é apagado.', 'control', json('false'), 'fail', NULL, 'back_to', NULL),
    json_object('responsible', 'Gestor', 'activity', 'Confere os tipos de projeto e as etapas', 'details', '- **Configurações → Lista Mestra: tipos de projeto e etapas**
- Cada tipo (Arquitetura, Estrutural, Elétrico…) tem a sua sequência de etapas; use **Editar etapas** para incluir, renomear, reordenar ou inativar
- Mudanças valem para os projetos já cadastrados, sem perder as datas', 'control', json('false'), 'fail', NULL, 'back_to', NULL),
    json_object('responsible', 'Responsável da obra / Gestor', 'activity', 'Inclui os projetos da obra', 'details', '- No projeto: card **Lista Mestra de projetos** → **Abrir** → **Novo projeto**
- **Obra** e **Tipo de projeto** (obrigatórios), Complemento (ex.: Bloco A), Projetista e Revisão
- Informe as **datas previstas** de cada etapa: elas viram a data base', 'control', json('false'), 'fail', NULL, 'back_to', NULL),
    json_object('responsible', 'Responsável da obra / Gestor', 'activity', 'Atualiza as datas a cada entrega', 'details', '- Toque no projeto → **Atualizar datas**
- **Realizado**: data em que a etapa foi entregue (botão **Hoje**); a etapa seguinte passa a ser a atual
- **Previsto**: nova previsão; com a opção marcada, as etapas seguintes são deslocadas pelo mesmo número de dias', 'control', json('false'), 'fail', NULL, 'back_to', NULL),
    json_object('responsible', 'Responsável da obra / Gestor', 'activity', 'Registra o motivo de toda mudança de previsão', 'details', '- Ao mudar uma previsão já existente aparece **Previsão alterada: informe o motivo**
- Escolha o **Motivo** (Cliente, Aprovações e licenças, Projetista / fornecedor, Compatibilização, Escopo / aditivo…) e **explique o porquê**', 'control', json('true'), 'fail', 'Sem motivo e explicação a alteração não é salva', 'back_to', 4),
    json_object('responsible', 'Gestor / Diretoria', 'activity', 'Acompanha a Lista Mestra', 'details', '- Indicadores: em dia, atrasados, com alteração, entregas em 30 dias e sem datas (toque para filtrar)
- **Motivos das alterações** e **Etapa atual dos projetos**
- Trilha de etapas: verde concluída, azul atual, vermelha atrasada, cinza prevista
- **Desvio**: +N dias depois da data base; −N antes', 'control', json('false'), 'fail', NULL, 'back_to', NULL),
    json_object('responsible', 'Usuário', 'activity', 'Emite a Lista Mestra', 'details', '- **Excel**: abas Lista Mestra, Etapas (base, previsto, realizado) e Histórico
- **PDF**: A4 paisagem com a lista por obra e o histórico das alterações', 'control', json('false'), 'fail', NULL, 'back_to', NULL)
  ),
  'related', json_array()
), datetime('now'));

UPDATE processes SET published = json_set(published, '$.related', json_array(
    (SELECT id FROM processes WHERE code = 'SIS-03'), (SELECT id FROM processes WHERE code = 'SIS-18')))
  WHERE code = 'SIS-25' AND version = 1 AND NOT EXISTS (SELECT 1 FROM process_versions v WHERE v.process_id = processes.id);
INSERT INTO process_versions (process_id, version, content, note, published_at)
  SELECT id, 1, published, 'Novo tutorial: Lista Mestra de projetos', published_at FROM processes
  WHERE code = 'SIS-25' AND NOT EXISTS (SELECT 1 FROM process_versions v WHERE v.process_id = processes.id);
