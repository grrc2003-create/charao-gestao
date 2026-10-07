# Charão · Gestão de Obras

Aplicativo web responsivo (mobile-first) para gestão de projetos, tarefas, pendências e acompanhamento operacional da **Charão Engenharia e Construção**.

## Como rodar

Requisito: **Node.js 22.5+** (testado no 24). Não há dependências para instalar.

```bash
npm run seed    # cria/RECRIA o banco com dados de demonstração (apaga o existente)
npm start       # http://localhost:3000
npm test        # 55 testes de API ponta a ponta (usa banco temporário, não toca nos dados)
```

### Contas de demonstração

Senha de todas: `charao2026`

| Usuário | E-mail | Perfil | Acesso |
|---|---|---|---|
| Ana Charão | ana@charao.eng.br | Administrador | Total |
| Ricardo Menezes | ricardo@charao.eng.br | Gestor (equipe: Marcos, Felipe, Bruno) | Total |
| Juliana Prates | juliana@charao.eng.br | Gestor (equipe: Camila, Patrícia) | Só PRJ-002 e PRJ-004 |
| Marcos Silva | marcos@charao.eng.br | Colaborador | PRJ-001, 002, 003 |
| Felipe Andrade | felipe@charao.eng.br | Colaborador | PRJ-001, 003, 005 |
| Camila Rocha | camila@charao.eng.br | Colaborador | PRJ-002, 004 |
| Bruno Costa | bruno@charao.eng.br | Colaborador | **Somente tarefas próprias** em PRJ-001, 002, 003 |
| Patrícia Lima | patricia@charao.eng.br | Colaborador | PRJ-002, 004 |

Para desligar o modo demonstração (atalhos na tela de login e selo "Ambiente de demonstração"): `DEMO=0 npm start`.

## Estrutura

```
server/
  index.js            Rotas HTTP (API REST) + arquivos estáticos + cabeçalhos de segurança
  db.js               SQLite (node:sqlite) + executor de migrações versionadas
  migrations/         001_init.sql … (novas funcionalidades = novo arquivo NNN_*.sql)
  lib/auth.js         Senhas (scrypt), sessões, limite de tentativas
  lib/permissions.js  TODAS as regras de autorização (perfil, escopo, projeto, equipe)
  lib/http.js         Roteador, validação de entrada, erros
  services/           Regras de negócio: tasks, projects, users, reports, metrics, files, audit
  seed.js             Dados de demonstração
public/
  index.html, css/app.css (sistema visual), css/print.css (documentos A4)
  js/core.js          Templates com escape automático (anti-XSS), API, formatação, domínio
  js/app.js           Sessão, layout e roteamento
  js/views/*.js       Uma tela por arquivo
data/                 charao.db + uploads/ (fora do repositório de código)
scripts/api-test.js   Testes ponta a ponta
```

Interface, regras de negócio e dados estão separados: as telas só conversam com a API; a API só chama serviços; os serviços concentram as regras e o acesso ao banco.

## Regras principais

- **Códigos**: projetos `PRJ-001`; tarefas `PRJ-001-00001` (sequência por projeto, gerada no servidor dentro de transação).
- **Status**: Aberta, Em andamento, Aguardando conferência, Concluída. **Atrasada** é calculada (prazo vencido sem entrega), nunca gravada — assim não fica desatualizada.
- **Comprovação**: nenhuma, só foto, só descrição ou foto + descrição. O servidor bloqueia o envio para conferência se faltar o exigido.
- **Conferência**: o responsável não confere a própria entrega. Devolução e reabertura exigem motivo.
- **Pontualidade**: entrega (envio para conferência) até o prazo. Média de atraso considera entregas tardias e atrasos ativos.
- **Gestor**: acompanha a equipe (direta e indireta) sem se tornar responsável pelas tarefas dos subordinados; desempenho próprio e consolidado da equipe aparecem separados.
- **Coordenador**: mesmas permissões do Gestor (projetos, equipe, configurações, recorrências, conferência das tarefas da equipe) e, além disso, **aprova as próprias tarefas**. O Gestor continua sem conferir a própria entrega.
- **Classificação (Grupo/Local/Etapa)**: cadastrada por projeto (formulário do projeto). Toda tarefa pertence a uma classificação; sem escolha, assume **Geral**. Classificações com tarefas não podem ser removidas (apenas renomeadas). Filtro em Tarefas, andamento por classificação no painel do projeto, agrupamento nos relatórios e na lista de campo.
- **Cronograma (Gantt)**: nos relatórios (página A4 paisagem). Início = início previsto da tarefa (campo opcional) ou, na falta dele, início da execução/data de criação; fim = prazo (ou conclusão).
- **Reagendamento de prazos**: alterar um prazo já definido (botão "Reagendar prazo" ou edição da tarefa) exige uma justificativa da lista cadastrada em **Configurações** (comum a todos os projetos) e, opcionalmente, uma observação — obrigatória para "Outro motivo". Cada reagendamento guarda prazo anterior, novo prazo, justificativa, usuário e data/hora; a tarefa mostra quantas vezes foi reagendada e o prazo original. Definir o primeiro prazo de uma tarefa sem prazo não conta como reagendamento. Pontualidade e atraso seguem calculados sobre o prazo vigente. Quem pode reagendar: quem pode editar a tarefa (administrador, gestor responsável, criador).
- **Indicadores de prazo e repactuação** (Dashboard, projeto, usuário e relatórios):
  - *Ficaram atrasadas*: % das tarefas com prazo que passaram do prazo vigente ao menos uma vez.
  - *Episódio de atraso*: cada repactuação feita com o prazo já vencido, a entrega após o prazo e o atraso atual contam 1 (a tarefa mostra "atrasou Nx").
  - *Preventiva × corretiva*: reagendamento antes de vencer (planejamento) × depois de vencer (cobre um atraso).
  - *Taxa de repactuação*, distribuição 0/1/2/3+, *dias acrescidos*, *tarefas crônicas* (limite em Configurações, padrão 3).
  - *Pontualidade real × repactuada*: entregas até o prazo original × até o prazo vigente.
  - Evolução mensal (mês do prazo original), comparação por responsável e por classificação, semáforo (atraso ≤15% bom, ≤30% atenção; corretivas ≤30% bom, ≤50% atenção; crônicas: nenhuma bom, até 5% atenção).
  - Filtros em Tarefas: "Ficaram atrasadas alguma vez", "Repactuadas após vencer", "Crônicas".
- **Organização por dia, semana ou mês**: seletor "Organizar: Lista · Dia · Semana · Mês" em Tarefas e nas listas do projeto e do usuário (a escolha fica lembrada no aparelho); nos relatórios (detalhamento, Gantt e tabela "Andamento por período") e na lista de campo. Usa o prazo vigente; semanas de segunda a domingo; tarefas sem prazo ficam no grupo "Sem prazo".
- **Cancelar tarefa** (quem pode editá-la, exceto concluídas): motivo obrigatório; a tarefa sai das listas, indicadores, relatórios e lista de campo, fica no filtro "Canceladas" e pode ser **reativada** (volta ao status anterior). Cancelar a principal cancela as subtarefas não concluídas; subtarefas canceladas não impedem concluir a principal.
- **Excluir definitivamente** (somente Administrador): apenas tarefas sem execução registrada (ainda abertas, sem descrição/fotos de execução, nunca enviadas para conferência e sem subtarefas). Motivo e confirmação obrigatórios; apaga tarefa, histórico, imagens e reagendamentos e registra a exclusão na Auditoria (código, título, projeto, responsável, prazo, motivo).
- **Tarefas recorrentes**: em Nova tarefa, "Repetir esta tarefa". Frequência diária (opção só dias úteis), semanal (dias da semana, a cada N semanas) ou mensal (dia do mês; meses sem o dia usam o último dia); término em uma data, após N ocorrências ou sem término. Cada ocorrência é uma tarefa normal criada automaticamente N dias antes do prazo (antecedência configurável), verificada ao iniciar o servidor e de hora em hora. A série (Tarefas → Recorrentes, ou no projeto) mostra regra, próximas datas e ocorrências; editar o molde/término vale para as próximas; encerrar exige motivo e pode cancelar as ocorrências futuras não iniciadas. Criar segue a regra de criar tarefa; editar/encerrar: criador, Gestor do projeto e Administrador.
- **Áreas internas da empresa**: projetos do tipo "Interno (empresa)" (código INT-000, tarefas INT-000-00000) para tarefas da própria Charão, sem cliente/local obrigatórios. A área padrão "Charão — Interno" é criada automaticamente uma única vez, com departamentos como classificações (Administrativo, Comercial, Financeiro, Equipamentos e manutenção, Pessoas, Segurança do trabalho) e acesso inicial para Administradores e Gestores. Aparecem separadas das obras em Projetos e no Dashboard; filtro "Somente obras / Somente interno" em Tarefas e nos relatórios. O tipo não muda após a criação.
- **Check-list** (Nova tarefa → Tipo: Check-list, ou Tarefas → Novo check-list): tarefa com itens Conforme / Não conforme / N/A preenchidos numa tela só, com avanço automático para o próximo item.
  - Criação rápida: digitar e Enter, colar uma lista (um item por linha), `# Grupo` para ambiente/local e `@Nome` para o responsável do item ou do grupo.
  - Responsável global (o da tarefa: responde qualquer item e envia para conferência) e responsável por item (vê o check-list e responde só os seus, filtro "Meus itens"; aviso no Dashboard). Terceirizado sem acesso: o líder responde.
  - Fotos: "Obrigatória em todos" (Conforme/Não conforme só com foto; o botão abre a câmera) ou "Livre escolha". Observação por item (destacada no Não conforme).
  - Envio para conferência só com todos os itens respondidos (e com foto, se obrigatória). Itens podem ser incluídos ("+ Adicionar itens" ou "+ Item" no grupo), editados (menu ⋯: texto, grupo, responsável), atribuídos por grupo e excluídos (se ainda sem resposta) pelo responsável global, pelo criador, gestor/coordenador ou administrador. Itens respondidos ficam recolhidos (toque para ver/alterar).
  - Relatório PDF do check-list (termo de vistoria): resumo, itens por grupo, não conformidades com fotos, registro fotográfico e assinaturas. Filtro "Somente check-lists" em Tarefas.
- **Alocar tarefa (Alterar responsável)**: qualquer pessoa liberada no projeto que veja a tarefa pode passá-la para outra pessoa da equipe do projeto, enquanto ela estiver aberta ou em andamento; motivo opcional; registrado no histórico. Criar tarefas para qualquer pessoa da equipe já era permitido a todos do projeto. Editar os demais dados continua com o criador, gestor/coordenador e administrador.
- **Equipe do projeto = acesso**: marcar alguém na equipe (cadastro/edição do projeto) libera o projeto para essa pessoa, que passa a vê-lo e a aparecer como responsável nas tarefas; desmarcar retira. É a mesma liberação de Usuários → Permissões (sincronizada nos dois sentidos). Administradores e usuários com acesso total aparecem fixos. A migração 011 liberou o acesso de quem já estava na equipe de projetos existentes.
- **Relatório da tela Tarefas**: botão **Emitir relatório** gera o documento A4 com exatamente os filtros aplicados na lista (busca, status, projeto, responsável, prazo, prioridade, classificação, tipo). Escolhe-se nível de detalhe, organização e Gantt; o cabeçalho descreve os filtros. Canceladas não entram.
- **Anexos**: ao anexar (referência ou comprovação da execução) o app oferece **Tirar foto** (abre a câmera do celular; também há o botão "Tirar foto" direto na execução da tarefa), **Galeria** e **Arquivo PDF** (até 8 MB cada; fotos são reduzidas no aparelho). O tipo é validado pelo conteúdo no servidor. O PDF abre no visualizador do navegador com o nome original e aparece listado no relatório completo; quando a comprovação exige foto, o PDF não a substitui.
- **Terceirizados** (Usuários → Novo terceirizado): responsável por tarefas, com líder obrigatório (colaborador, gestor ou administrador interno) e projetos liberados próprios — só aparece nos projetos marcados no cadastro.
  - **Sem login** (padrão): a tarefa é conduzida pelo líder, que registra a execução em nome do terceirizado (histórico: "em nome de") e aprova ou devolve a entrega. O desempenho fica no nome do terceirizado, na equipe do líder. E-mail opcional (só contato).
  - **Com acesso ao sistema** (opção no cadastro ou na edição): exige e-mail e senha provisória e segue as mesmas regras de um Colaborador — executa as próprias tarefas e quem confere é o gestor/criador. Desligar o acesso encerra as sessões.
  - Não pode virar responsável técnico de projeto nem gestor de outros usuários.
- **Configurações** (Gestor e Administrador): limite de tarefa crônica e justificativas de reagendamento — incluir, renomear, ordenar, inativar; as já usadas não podem ser excluídas e o histórico guarda o texto usado na época.
- **Histórico**: criação, mudança de responsável, prazo, prioridade, status, comprovação, envio, devolução, conclusão e reabertura — com usuário, data e hora.
- **Auditoria administrativa**: logins, falhas de login, criação/alteração de usuários e permissões, projetos.

## Segurança

- Sessão em cookie `HttpOnly` + `SameSite=Strict` (token aleatório; no banco só o hash), expiração deslizante de 12 h.
- Proteção CSRF (cabeçalho obrigatório em mutações), CSP restritiva, `X-Frame-Options`, `nosniff`.
- Senhas com scrypt; bloqueio de 10 min após 5 tentativas; troca obrigatória de senha provisória.
- Autorização sempre validada no backend (perfil, escopo de acesso, projeto, equipe). Dados pessoais (e-mail/telefone) só para o próprio, o gestor e administradores.
- Alterar permissões ou desativar um usuário encerra as sessões dele.
- Uploads validados pela assinatura binária (JPG/PNG/WEBP), servidos apenas a quem pode ver a tarefa. Fotos são reduzidas no aparelho antes do envio.

## O que ainda é protótipo

- **Dados de demonstração**: usuários, projetos, tarefas e imagens são fictícios (as imagens do seed são croquis ilustrativos).
- **Hospedagem**: roda localmente. Para uso real em campo é preciso publicar em um servidor com **HTTPS** (o cookie passa a ser `Secure` automaticamente atrás de proxy HTTPS) e **mover a pasta `data/` para fora do OneDrive/SharePoint** — sincronização de nuvem pode corromper um banco SQLite aberto.
- **Recuperação de senha por e-mail**: não implementada (o administrador redefine a senha).
- **Modo offline**: não há sincronização offline; a lista de campo impressa cobre o uso sem sinal.
- **Escala**: filtros e indicadores são calculados em memória — adequado para milhares de tarefas. Acima disso, mover filtros para SQL (as regras já estão isoladas em `services/`).
- **Backup**: copiar `data/charao.db` e `data/uploads/` periodicamente (ainda não automatizado).

## Evolução sem perda de dados

1. Crie `server/migrations/002_sua_mudanca.sql` com `ALTER TABLE`/`CREATE TABLE`.
2. Ao iniciar, o servidor aplica só as migrações novas, em transação, e registra em `schema_migrations`.
3. Nunca edite uma migração já aplicada; nunca rode `npm run seed` na base real (ele recria o banco).

## Publicação (Render)

1. Envie este repositório para o GitHub (privado).
2. No Render: **New → Blueprint**, escolha o repositório. O `render.yaml` cria o serviço web (Docker) com disco persistente em `/var/data`.
3. Preencha `ADMIN_NAME`, `ADMIN_EMAIL` e `ADMIN_PASSWORD` (mín. 8 caracteres, letras e números). Esse administrador é criado apenas no primeiro início, com banco vazio.
4. Após o deploy, entre com esse administrador e cadastre projetos e usuários. Cada `git push` na branch `main` publica de novo automaticamente, preservando o banco e as fotos do disco.

Variáveis opcionais: `SEED_DEMO=1` (carrega dados fictícios no primeiro início — não use com dados reais), `DEMO=1` (exibe atalhos de demonstração no login), `SESSION_HOURS`.
