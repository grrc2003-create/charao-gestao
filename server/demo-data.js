// Dados de DEMONSTRAÇÃO (fictícios). Usado por `npm run seed` e, se SEED_DEMO=1, no primeiro início com banco vazio.
// Senha de todos os usuários de demonstração: charao2026
import { run, one, tx } from './db.js';
import { hashPassword } from './lib/auth.js';
import { saveDemoSvg } from './services/files.js';
import { today, addDays } from './services/metrics.js';

export const DEMO_PASSWORD = 'charao2026';

export function seedDemo() {

  const hash = hashPassword(DEMO_PASSWORD);
  const T = today();
  const ts = (dayOffset, hour = 9, min = 0) => {
    const d = addDays(T, dayOffset);
    return new Date(`${d}T${String(hour + 3).padStart(2, '0')}:${String(min).padStart(2, '0')}:00Z`).toISOString(); // horário de Brasília
  };

  const users = [
    ['Ana Charão', 'ana@charao.eng.br', 'admin', 'total', null, 'Diretora Técnica', '(51) 99812-0001'],
    ['Ricardo Menezes', 'ricardo@charao.eng.br', 'gestor', 'total', 1, 'Engenheiro Coordenador de Obras', '(51) 99812-0002'],
    ['Juliana Prates', 'juliana@charao.eng.br', 'gestor', 'projetos', 1, 'Arquiteta Coordenadora', '(51) 99812-0003'],
    ['Marcos Silva', 'marcos@charao.eng.br', 'colaborador', 'projetos', 2, 'Mestre de Obras', '(51) 99812-0004'],
    ['Felipe Andrade', 'felipe@charao.eng.br', 'colaborador', 'projetos', 2, 'Técnico em Edificações', '(51) 99812-0005'],
    ['Camila Rocha', 'camila@charao.eng.br', 'colaborador', 'projetos', 3, 'Estagiária de Engenharia', '(51) 99812-0006'],
    ['Bruno Costa', 'bruno@charao.eng.br', 'colaborador', 'proprias', 2, 'Encarregado de Instalações Elétricas', '(51) 99812-0007'],
    ['Patrícia Lima', 'patricia@charao.eng.br', 'colaborador', 'projetos', 3, 'Arquiteta de Interiores', '(51) 99812-0008'],
  ];

  const projects = [
    ['Residencial Vila Serena', 'Incorporadora Horizonte', 'Rua das Acácias, 410 — Canoas/RS', 'em_andamento', -120, 150, 2, [2, 4, 5, 7],
      'Edifício residencial de 6 pavimentos, 24 unidades. Estrutura em concreto armado e vedação em bloco cerâmico.'],
    ['Reforma Clínica Bem Viver', 'Clínica Bem Viver Ltda', 'Av. Independência, 1220 — Porto Alegre/RS', 'em_andamento', -45, 40, 3, [3, 4, 6, 8, 7],
      'Reforma completa do pavimento térreo: consultórios, recepção acessível e adequação à RDC 50.'],
    ['Galpão Logístico Eldorado', 'Eldorado Logística S.A.', 'Rod. BR-290, km 112 — Eldorado do Sul/RS', 'em_andamento', -80, 90, 2, [2, 4, 5, 7],
      'Galpão pré-moldado de 4.800 m² com docas, mezanino administrativo e pavimentação em concreto.'],
    ['Retrofit Fachada Ed. Atlântico', 'Condomínio Edifício Atlântico', 'Rua Padre Chagas, 77 — Porto Alegre/RS', 'planejamento', -10, 120, 3, [3, 6, 8],
      'Recuperação estrutural de sacadas, substituição de revestimento cerâmico e nova pintura da fachada.'],
    ['Residência Lago Azul', 'Família Brandão', 'Cond. Lago Azul, lote 18 — Gravataí/RS', 'concluido', -200, -15, 2, [2, 4, 5],
      'Residência unifamiliar térrea de 280 m² com estrutura metálica na cobertura.'],
  ];

  // [projeto, título, descrição, resumo de campo, responsável, criador, prazo (dias), prioridade, comprovação, situação, observação, refs, fotos]
  const tasks = [
    [1, 'Conferir armação das vigas do 4º pavimento', 'Conferir bitolas, espaçamentos e cobrimentos das armaduras das vigas V401 a V418 conforme projeto estrutural rev. 03. Verificar espaçadores e amarrações antes da liberação para concretagem.', 'Conferir armação V401–V418 (bitolas, espaçamento, cobrimento) antes da concretagem.', 4, 2, 2, 'urgente', 'foto_descricao', 'em_andamento', 'Concretagem agendada — não liberar sem conferência.', 1, 0],
    [1, 'Executar impermeabilização do reservatório superior', 'Aplicar manta asfáltica de 4 mm no reservatório superior, com teste de estanqueidade por 72 h após a aplicação. Registrar o início e o fim do teste.', 'Manta 4 mm no reservatório + teste de estanqueidade 72 h.', 5, 2, -3, 'alta', 'foto_descricao', 'atrasada', 'Aguardar cura da regularização.', 1, 0],
    [1, 'Instalar quadros de distribuição do 2º pavimento', 'Instalar e identificar os quadros QD-201 a QD-204 conforme diagrama unifilar. Conferir disjuntores, DR e barramentos.', 'Instalar e identificar QD-201 a QD-204 conforme unifilar.', 7, 2, 5, 'media', 'foto', 'aberta', null, 0, 0],
    [1, 'Revisar prumo da alvenaria do 3º pavimento', 'Verificar prumo e alinhamento das paredes de alvenaria das unidades 301 a 304. Apontar desvios superiores a 5 mm.', 'Prumo/alinhamento alvenaria 301–304; apontar desvios > 5 mm.', 4, 4, -6, 'media', 'descricao', 'concluida_late', null, 0, 0],
    [1, 'Receber e conferir entrega de blocos cerâmicos', 'Conferir quantidade (12.000 un.), dimensões e integridade do lote de blocos. Recusar peças trincadas e registrar nota fiscal.', 'Conferir lote de 12.000 blocos e NF; recusar peças trincadas.', 5, 2, -12, 'baixa', 'foto', 'concluida_ontime', null, 0, 1],
    [1, 'Concretagem da laje do 4º pavimento', 'Acompanhar concretagem com fck 30 MPa, moldar corpos de prova (2 por caminhão) e registrar slump de cada betoneira.', 'Acompanhar concretagem fck 30, moldar CPs e registrar slump.', 4, 2, 4, 'urgente', 'foto_descricao', 'aberta', 'Depende da conferência da armação.', 0, 0],
    [1, 'Passagem de eletrodutos na laje do 4º pavimento', 'Posicionar eletrodutos e caixas octogonais conforme projeto elétrico antes da concretagem.', 'Eletrodutos e caixas octogonais na laje do 4º pav.', 7, 2, 1, 'alta', 'foto', 'aguardando', null, 0, 1],
    [1, 'Atualizar diário de obra da semana', 'Registrar efetivo, clima, serviços executados e ocorrências da semana no diário de obra.', 'Diário de obra: efetivo, clima, serviços e ocorrências.', 5, 5, -2, 'baixa', 'descricao', 'concluida_ontime', null, 0, 0],
    [1, 'Chapisco das paredes externas — fachada norte', 'Executar chapisco rolado nas paredes externas da fachada norte, do 1º ao 3º pavimento.', 'Chapisco rolado fachada norte, 1º ao 3º pav.', 4, 2, 9, 'media', 'foto', 'aberta', null, 0, 0],
    [1, 'Teste de estanqueidade das prumadas de esgoto', 'Realizar teste com coluna d’água nas prumadas TQ-1 a TQ-4 e registrar resultado.', 'Teste coluna d’água prumadas TQ-1 a TQ-4.', 5, 2, -1, 'alta', 'foto_descricao', 'devolvida', 'Refazer TQ-3: vazamento na junta.', 0, 1],
    [1, 'Organizar canteiro e área de vivência', 'Organizar baias de materiais, sinalização e limpeza da área de vivência conforme NR-18.', 'Baias, sinalização e limpeza conforme NR-18.', 4, 4, 0, 'media', 'foto', 'em_andamento', null, 0, 0],

    [2, 'Demolição das divisórias da recepção', 'Remover divisórias de gesso acartonado da recepção e consultórios 1 e 2, com descarte em caçamba licenciada.', 'Remover divisórias da recepção e consultórios 1 e 2; descarte licenciado.', 4, 3, -20, 'alta', 'foto', 'concluida_ontime', null, 0, 1],
    [2, 'Instalação de piso vinílico nos consultórios', 'Instalar piso vinílico em manta nos consultórios 1 a 5 com rodapé hospitalar boleado. Conferir nivelamento do contrapiso antes.', 'Piso vinílico em manta + rodapé boleado, consultórios 1–5.', 6, 3, 3, 'alta', 'foto_descricao', 'em_andamento', 'Usar cola acrílica indicada pelo fabricante.', 1, 0],
    [2, 'Ajustar layout do balcão de recepção acessível', 'Revisar o detalhamento do balcão com trecho rebaixado a 0,90 m conforme NBR 9050 e enviar para aprovação do cliente.', 'Detalhar balcão com trecho rebaixado 0,90 m (NBR 9050).', 8, 3, -4, 'media', 'descricao', 'atrasada', 'Cliente pediu acabamento em MDF branco.', 1, 0],
    [2, 'Pontos elétricos dos consultórios', 'Executar pontos de tomada e iluminação dos consultórios conforme projeto, incluindo circuito exclusivo para autoclave.', 'Pontos de tomada/iluminação + circuito exclusivo da autoclave.', 7, 3, -2, 'alta', 'foto', 'aguardando', null, 0, 2],
    [2, 'Pintura acrílica das áreas comuns', 'Aplicar massa corrida e duas demãos de tinta acrílica lavável nas áreas comuns.', 'Massa corrida + 2 demãos acrílica lavável nas áreas comuns.', 4, 3, 10, 'baixa', 'foto', 'aberta', null, 0, 0],
    [2, 'Especificar luminárias da sala de espera', 'Especificar luminárias embutidas com IRC > 90 e temperatura 4000 K para sala de espera.', 'Especificar luminárias IRC > 90, 4000 K.', 8, 3, -9, 'baixa', 'descricao', 'concluida_late', null, 0, 0],
    [2, 'Instalar barras de apoio nos sanitários PcD', 'Instalar barras de apoio conforme NBR 9050 nos dois sanitários acessíveis.', 'Barras de apoio NBR 9050 nos 2 sanitários PcD.', 6, 3, 6, 'media', 'foto', 'aberta', null, 0, 0],
    [2, 'Vistoria com a vigilância sanitária', 'Acompanhar a vistoria e registrar exigências apontadas pelo fiscal.', 'Acompanhar vistoria e anotar exigências.', 3, 3, 12, 'alta', 'nenhuma', 'aberta', 'Levar projeto aprovado impresso.', 0, 0],
    [2, 'Forro de gesso da recepção', 'Executar forro de gesso acartonado com tabica perimetral na recepção.', 'Forro de gesso com tabica na recepção.', 4, 6, -7, 'media', 'foto', 'concluida_ontime', null, 0, 1],

    [3, 'Montagem dos pilares pré-moldados — eixo A', 'Acompanhar içamento e prumo dos pilares P1 a P12 do eixo A. Conferir chumbadores e grauteamento.', 'Pilares P1–P12 eixo A: prumo, chumbadores e graute.', 4, 2, -15, 'urgente', 'foto_descricao', 'concluida_ontime', null, 0, 1],
    [3, 'Montagem das vigas de cobertura', 'Acompanhar montagem das vigas de cobertura entre os eixos A e D, conferindo apoios em neoprene.', 'Vigas de cobertura eixos A–D; conferir apoios em neoprene.', 4, 2, -5, 'alta', 'foto', 'atrasada', 'Guindaste disponível somente pela manhã.', 1, 0],
    [3, 'Compactação da base do piso industrial', 'Executar compactação da base em BGS com controle de grau de compactação (mín. 100% PN).', 'Base BGS com compactação mín. 100% PN.', 5, 2, 7, 'alta', 'foto_descricao', 'aberta', null, 0, 0],
    [3, 'Instalação da subestação 300 kVA', 'Acompanhar instalação da subestação abrigada e conferir aterramento com medição de resistência.', 'Subestação 300 kVA + medição de aterramento.', 7, 2, 14, 'alta', 'foto_descricao', 'aberta', null, 0, 0],
    [3, 'Locação das docas niveladoras', 'Conferir locação e cotas das 8 docas niveladoras conforme projeto arquitetônico.', 'Locação e cotas das 8 docas.', 5, 5, -8, 'media', 'descricao', 'concluida_late', null, 0, 0],
    [3, 'Drenagem pluvial do pátio', 'Executar rede de drenagem com tubos de concreto DN 600 e caixas de passagem.', 'Rede DN 600 + caixas de passagem no pátio.', 4, 2, 3, 'media', 'foto', 'em_andamento', null, 0, 0],
    [3, 'Relatório fotográfico mensal ao cliente', 'Compilar relatório fotográfico do avanço da obra para a Eldorado Logística.', 'Relatório fotográfico mensal.', 5, 2, -3, 'baixa', 'foto', 'aguardando', null, 0, 2],
    [3, 'Iluminação do mezanino administrativo', 'Executar infraestrutura e instalar luminárias LED do mezanino.', 'Infra + luminárias LED do mezanino.', 7, 7, -1, 'media', 'foto', 'atrasada', null, 0, 0],

    [4, 'Levantamento de patologias da fachada', 'Mapear fissuras, desplacamentos e pontos de corrosão nas sacadas com registro fotográfico por pavimento.', 'Mapear fissuras, desplacamentos e corrosão nas sacadas.', 6, 3, 4, 'alta', 'foto_descricao', 'em_andamento', 'Usar balancim liberado pelo condomínio.', 1, 1],
    [4, 'Teste de percussão no revestimento', 'Realizar teste de percussão em toda a fachada e marcar áreas com som cavo.', 'Percussão em toda a fachada; marcar som cavo.', 8, 3, 8, 'media', 'descricao', 'aberta', null, 0, 0],
    [4, 'Orçamento de andaimes fachadeiros', 'Cotar com 3 fornecedores locação de andaime fachadeiro por 4 meses.', 'Cotar andaime fachadeiro (3 fornecedores, 4 meses).', 3, 3, -2, 'media', 'nenhuma', 'atrasada', null, 0, 0],
    [4, 'Definir paleta de cores da fachada', 'Apresentar três opções de paleta de cores para aprovação em assembleia.', '3 opções de paleta para assembleia.', 8, 8, 15, 'baixa', 'descricao', 'aberta', null, 1, 0],

    [5, 'Vistoria final e entrega de chaves', 'Realizar vistoria final com o cliente e registrar termo de entrega.', 'Vistoria final + termo de entrega.', 2, 2, -16, 'alta', 'foto_descricao', 'concluida_ontime', null, 0, 1],
    [5, 'Limpeza fina pós-obra', 'Contratar e acompanhar limpeza fina de todos os ambientes.', 'Limpeza fina de todos os ambientes.', 4, 2, -18, 'media', 'foto', 'concluida_ontime', null, 0, 1],
    [5, 'Ajuste de esquadrias de alumínio', 'Regular roldanas e vedação das esquadrias dos dormitórios.', 'Regular roldanas e vedação das esquadrias.', 5, 2, -22, 'baixa', 'descricao', 'concluida_late', null, 0, 0],
  ];

  const svgRef = (title, kind) => {
    const isExec = kind === 'execucao';
    const color = isExec ? '#2E8B57' : '#2A3D50';
    const label = isExec ? 'REGISTRO DE EXECUÇÃO' : 'REFERÊNCIA DO PROJETO';
    const safe = s => s.replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]);
    const t = safe(title.length > 46 ? title.slice(0, 45) + '…' : title);
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 560" width="800" height="560">
  <defs><pattern id="g" width="20" height="20" patternUnits="userSpaceOnUse"><path d="M20 0H0V20" fill="none" stroke="#d6dce2" stroke-width="1"/></pattern></defs>
  <rect width="800" height="560" fill="#f4f1ea"/><rect width="800" height="560" fill="url(#g)"/>
  <g fill="none" stroke="${color}" stroke-width="3">
  <rect x="120" y="120" width="560" height="300"/><path d="M120 220h560M300 120v300M500 120v300M120 420l560-300" stroke-opacity=".35"/>
  <path d="M300 420v-90h80v90" /><rect x="530" y="160" width="110" height="60"/></g>
  <g fill="${color}" font-family="Segoe UI, Arial, sans-serif">
  <text x="40" y="60" font-size="22" font-weight="700" letter-spacing="3">${label}</text>
  <text x="40" y="500" font-size="24" font-weight="600">${t}</text>
  <text x="40" y="532" font-size="16" fill="#707E8B">Imagem ilustrativa — dados de demonstração</text></g>
  <path d="M700 40l40 70h-80z" fill="#FF6600" opacity=".9"/></svg>`;
  };

  tx(() => {
    users.forEach(([name, email, role, scope, mgr, job, phone]) => {
      run(`INSERT INTO users (name, email, password_hash, role, access_scope, manager_id, job_title, phone, created_at)
        VALUES (?,?,?,?,?,?,?,?,?)`, name, email, hash, role, scope, mgr, job, phone, ts(-210));
    });
    projects.forEach(([name, client, loc, status, start, end, lead, members, desc], i) => {
      const code = `PRJ-${String(i + 1).padStart(3, '0')}`;
      run(`INSERT INTO projects (code, name, client, location, description, status, start_date, end_date, actual_end_date, lead_id, created_by, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,1,?,?)`, code, name, client, loc, desc, status, addDays(T, start), addDays(T, end),
        status === 'concluido' ? addDays(T, end) : null, lead, ts(start - 5), ts(start - 5));
      for (const m of members) run('INSERT INTO project_members (project_id, user_id) VALUES (?,?)', i + 1, m);
    });
    // Acesso por projeto
    const access = { 3: [2, 4], 4: [1, 2, 3, 5], 5: [1, 3, 5], 6: [2, 4], 7: [1, 2, 3], 8: [2, 4] };
    for (const [u, ps] of Object.entries(access)) for (const p of ps) run('INSERT INTO user_project_access (user_id, project_id) VALUES (?,?)', Number(u), p);

    const seqs = {};
    const hist = (taskId, userId, action, details, when) =>
      run('INSERT INTO task_history (task_id, user_id, action, details, created_at) VALUES (?,?,?,?,?)', taskId, userId, action, details, when);
    const file = (taskId, kind, title, by, when, caption) => {
      const f = saveDemoSvg(svgRef(title, kind));
      run('INSERT INTO task_files (task_id, kind, stored_name, mime, size, caption, uploaded_by, created_at) VALUES (?,?,?,?,?,?,?,?)',
        taskId, kind, f.stored_name, f.mime, f.size, caption, by, when);
    };
    const reviewerFor = (creator, assignee) => (creator !== assignee ? creator : one('SELECT manager_id FROM users WHERE id = ?', assignee).manager_id || 1);
    const PL = { baixa: 'Baixa', media: 'Média', alta: 'Alta', urgente: 'Urgente' };
    const PF = { nenhuma: 'Nenhuma', foto: 'Somente foto', descricao: 'Somente descrição', foto_descricao: 'Foto + descrição' };
    const userName = id => one('SELECT name FROM users WHERE id = ?', id).name;

    for (const [p, title, desc, summary, assignee, creator, dueOff, prio, proof, state, notes, refs, photos] of tasks) {
      seqs[p] = (seqs[p] || 0) + 1;
      const code = `PRJ-${String(p).padStart(3, '0')}-${String(seqs[p]).padStart(5, '0')}`;
      const due = addDays(T, dueOff);
      const createdOff = dueOff - 12;
      const created = ts(createdOff, 8, 15);
      let status = 'aberta', delivered = null, completed = null, started = null, reviewStatus = null, reviewComment = null, reviewedBy = null, reviewedAt = null;
      let execDesc = null;
      const needsDesc = proof === 'descricao' || proof === 'foto_descricao';
      const deliveredOff = { concluida_ontime: dueOff - 1, concluida_late: dueOff + 3, aguardando: Math.min(dueOff, 0) }[state];
      if (state !== 'aberta' && state !== 'atrasada') { status = 'em_andamento'; started = ts(createdOff + 2, 10); }
      if (state === 'atrasada' && dueOff < -2) { status = 'em_andamento'; started = ts(createdOff + 3, 14); }
      if (['concluida_ontime', 'concluida_late', 'aguardando'].includes(state)) {
        delivered = ts(deliveredOff, 16, 30);
        status = state === 'aguardando' ? 'aguardando_conferencia' : 'concluida';
        reviewStatus = state === 'aguardando' ? 'pendente' : 'aprovada';
        if (needsDesc || proof === 'foto') execDesc = 'Serviço executado conforme especificado. Conferência visual realizada no local, sem pendências aparentes.';
        if (status === 'concluida') {
          completed = ts(deliveredOff + 1, 11);
          reviewedBy = reviewerFor(creator, assignee);
          reviewedAt = completed;
          reviewComment = 'Conferido e aprovado.';
        }
      }
      if (state === 'devolvida') {
        status = 'em_andamento'; reviewStatus = 'devolvida'; reviewedBy = reviewerFor(creator, assignee); reviewedAt = ts(-1, 15);
        reviewComment = 'Junta da TQ-3 apresentou vazamento. Refazer e repetir o teste.';
        execDesc = 'Teste realizado nas 4 prumadas. TQ-3 com gotejamento na junta do 2º pavimento.';
      }
      if (state === 'em_andamento' && needsDesc && dueOff > 1) execDesc = null;
      const r = run(`INSERT INTO tasks (code, project_id, seq, title, description, field_summary, notes, assignee_id, assigned_by_id, creator_id,
          due_date, priority, status, proof_type, exec_description, delivered_at, review_status, review_comment, reviewed_by, reviewed_at,
          completed_at, started_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        code, p, seqs[p], title, desc, summary, notes, assignee, creator, creator, due, prio, status, proof, execDesc, delivered,
        reviewStatus, reviewComment, reviewedBy, reviewedAt, completed, started, created, completed || delivered || started || created);
      const id = Number(r.lastInsertRowid);
      hist(id, creator, 'Tarefa criada', `Responsável: ${userName(assignee)} · Prazo: ${due.split('-').reverse().join('/')} · Prioridade: ${PL[prio]} · Comprovação: ${PF[proof]}`, created);
      for (let i = 0; i < refs; i++) file(id, 'referencia', title, creator, created, 'Croqui de referência');
      if (refs) hist(id, creator, 'Imagens de referência anexadas', `${refs} imagem(ns)`, created);
      if (started) hist(id, assignee, 'Status alterado', 'Aberta → Em andamento', started);
      if (execDesc) hist(id, assignee, 'Descrição da execução registrada', null, delivered || reviewedAt || started);
      for (let i = 0; i < photos; i++) file(id, 'execucao', title, assignee, delivered || started || created, `Registro ${i + 1}`);
      if (photos) hist(id, assignee, 'Fotos de comprovação enviadas', `${photos} imagem(ns)`, delivered || started || created);
      if (delivered || state === 'devolvida') {
        const sentAt = delivered || ts(-2, 17);
        hist(id, assignee, 'Status alterado', 'Em andamento → Aguardando conferência', sentAt);
        hist(id, assignee, 'Enviada para conferência', 'Comprovação anexada', sentAt);
      }
      if (state === 'devolvida') {
        hist(id, reviewedBy, 'Status alterado', 'Aguardando conferência → Em andamento', reviewedAt);
        hist(id, reviewedBy, 'Devolvida para ajustes', reviewComment, reviewedAt);
      }
      if (completed) {
        hist(id, reviewedBy, 'Status alterado', 'Aguardando conferência → Concluída', completed);
        hist(id, reviewedBy, 'Conferência aprovada — tarefa concluída', reviewComment, completed);
      }
    }
    for (const [p, n] of Object.entries(seqs)) run('UPDATE projects SET task_seq = ? WHERE id = ?', n, Number(p));
    // Subtarefas de exemplo na concretagem da laje (PRJ-001)
    const mother = one(`SELECT * FROM tasks WHERE title = 'Concretagem da laje do 4º pavimento'`);
    const subs = [
      ['Conferir fôrmas e escoramento', 'Verificar prumo, travamento e estanqueidade das fôrmas e escoras metálicas da laje.', 5, -1, 'foto', 'concluida'],
      ['Programar caminhões-betoneira e bomba', 'Confirmar com a concreteira volume (42 m³), horário e bomba lança; registrar confirmação.', 4, 2, 'descricao', 'em_andamento'],
      ['Moldar corpos de prova', 'Moldar 2 CPs por caminhão, identificar e armazenar em local protegido.', 4, 4, 'foto_descricao', 'aberta'],
    ];
    subs.forEach(([title, desc, assignee, dueOff, proof, st], i) => {
      const code = `${mother.code}-${String(i + 1).padStart(2, '0')}`;
      const created = ts(-6, 9, 30);
      const done = st === 'concluida';
      const r = run(`INSERT INTO tasks (code, project_id, parent_id, seq, title, description, assignee_id, assigned_by_id, creator_id, due_date,
          priority, status, proof_type, exec_description, delivered_at, review_status, reviewed_by, reviewed_at, completed_at, started_at, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?, 'alta', ?,?,?,?,?,?,?,?,?,?,?)`,
        code, mother.project_id, mother.id, i + 1, title, desc, assignee, 2, 2, addDays(T, dueOff), st, proof,
        done ? 'Fôrmas e escoramento conferidos e liberados.' : null, done ? ts(-2, 16) : null, done ? 'aprovada' : null,
        done ? 2 : null, done ? ts(-1, 10) : null, done ? ts(-1, 10) : null, st !== 'aberta' ? ts(-5, 8) : null, created, created);
      const id = Number(r.lastInsertRowid);
      hist(id, 2, `Subtarefa criada em ${mother.code}`, `Responsável: ${userName(assignee)} · Prazo: ${addDays(T, dueOff).split('-').reverse().join('/')}`, created);
      hist(mother.id, 2, 'Subtarefa adicionada', `${code} · ${title} · Responsável: ${userName(assignee)}`, created);
      if (done) {
        file(id, 'execucao', title, assignee, ts(-2, 16), 'Escoramento');
        hist(id, assignee, 'Enviada para conferência', 'Comprovação anexada', ts(-2, 16));
        hist(id, 2, 'Conferência aprovada — tarefa concluída', null, ts(-1, 10));
        hist(mother.id, 2, 'Subtarefa concluída', `${code} · ${title}`, ts(-1, 10));
      }
    });
    run('UPDATE tasks SET sub_seq = ? WHERE id = ?', subs.length, mother.id);

    run(`INSERT INTO audit_log (actor_id, entity, entity_id, action, details) VALUES (1, 'system', NULL, 'Base de demonstração criada', NULL)`);
  });


  return { users: users.length, projects: projects.length, tasks: tasks.length };
}
