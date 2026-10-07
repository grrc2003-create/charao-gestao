// Testes de API ponta a ponta (fluxos e permissões). Usa um banco temporário — não altera os dados reais.
// Uso: npm test
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'charao-test-'));
const PORT = 3999;
const BASE = `http://localhost:${PORT}`;
const PW = 'charao2026'; // senha das contas de demonstração (server/seed.js)
const env = { ...process.env, DATA_DIR, PORT: String(PORT) };
const NODE = [process.execPath, '--disable-warning=ExperimentalWarning'];

execFileSync(NODE[0], [NODE[1], path.join(ROOT, 'server/seed.js')], { env, stdio: 'ignore' });
const server = spawn(NODE[0], [NODE[1], path.join(ROOT, 'server/index.js')], { env, stdio: 'ignore' });

let passed = 0, failed = 0;
const ok = (cond, name) => { if (cond) { passed++; console.log(`  ✓ ${name}`); } else { failed++; console.log(`  ✗ ${name}`); } };

function client() {
  let cookie = '';
  return async (method, p, body) => {
    const res = await fetch(BASE + '/api' + p, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'charao-app', cookie },
      body: body ? JSON.stringify(body) : undefined,
    });
    const sc = res.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    let data = null;
    try { data = await res.json(); } catch {}
    return { status: res.status, data, headers: res.headers };
  };
}
async function cookieOf(email, password = PW) {
  const r = await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'charao-app' }, body: JSON.stringify({ email, password }) });
  return (r.headers.get('set-cookie') || '').split(';')[0];
}
async function login(email, password = PW) {
  const c = client();
  const r = await c('POST', '/auth/login', { email, password });
  if (r.status !== 200) throw new Error(`login ${email}: ${r.status}`);
  return c;
}

// PNG 2x2 válido gerado em memória
function tinyPng() {
  const crc = buf => { let c, crc = 0xffffffff; for (const b of buf) { c = (crc ^ b) & 0xff; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crc = (crc >>> 8) ^ c; } return (crc ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(2, 0); ihdr.writeUInt32BE(2, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.from([0, 255, 0, 0, 0, 255, 0, 0, 0, 0, 255, 255, 255, 255]);
  const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
  return 'data:image/png;base64,' + png.toString('base64');
}

let felipeLoginCheck;
async function main() {
  for (let i = 0; i < 50; i++) { try { await fetch(BASE + '/api/config'); break; } catch { await new Promise(r => setTimeout(r, 100)); } }

  console.log('Autenticação e sessão');
  const anon = client();
  ok((await anon('GET', '/dashboard')).status === 401, 'rota protegida exige login');
  ok((await anon('POST', '/auth/login', { email: 'ana@charao.eng.br', password: 'errada123' })).status === 401, 'senha inválida é rejeitada');
  const noCsrf = await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  ok(noCsrf.status === 403, 'mutação sem cabeçalho anti-CSRF é bloqueada');
  const ana = await login('ana@charao.eng.br');
  felipeLoginCheck = async () => { const f = await login('felipe@charao.eng.br'); const tl = (await f('GET', '/tasks?q=Assentar')).data; return tl[0] ? (await f('GET', `/tasks/${tl[0].id}`)).data : null; };
  const ricardo = await login('ricardo@charao.eng.br');
  const juliana = await login('juliana@charao.eng.br');
  const marcos = await login('marcos@charao.eng.br');
  const bruno = await login('bruno@charao.eng.br');
  const camila = await login('camila@charao.eng.br');
  ok((await ana('GET', '/auth/me')).data.user.password_hash === undefined, 'hash de senha nunca é exposto');

  console.log('Restrição por projeto e perfil');
  const julProjects = (await juliana('GET', '/projects')).data.map(p => p.code);
  ok(julProjects.join() === 'PRJ-002,PRJ-004,INT-001', `gestora restrita vê só PRJ-002, PRJ-004 e a área interna (${julProjects})`);
  ok((await juliana('GET', '/projects/1')).status === 404, 'gestora restrita não abre PRJ-001');
  const brunoTasks = (await bruno('GET', '/tasks')).data;
  ok(brunoTasks.every(t => t.assignee_name === 'Bruno Costa' || t.creator_name === 'Bruno Costa' || t.task_type === 'checklist'), 'escopo "somente próprias" vê apenas as próprias tarefas (e check-lists com itens dele)');
  ok(brunoTasks.filter(t => t.task_type === 'checklist').every(t => t.title.includes('Unidade 501')), 'check-list visível ao Bruno é o que tem itens atribuídos a ele');
  const camilaUsers = (await camila('GET', '/users')).data;
  ok(camilaUsers.length === 1 && camilaUsers[0].name === 'Camila Rocha', 'colaborador vê apenas o próprio perfil');
  ok((await camila('GET', '/users/1')).status === 404, 'colaborador não abre perfil de terceiros');
  ok((await camila('POST', '/users', { name: 'X', email: 'x@x.com', role: 'admin', password: 'abc12345' })).status === 403, 'colaborador não cria usuários');
  ok((await camila('POST', '/projects', { name: 'X', client: 'Y' })).status === 403, 'colaborador não cria projetos');
  const ricTeam = (await ricardo('GET', '/users')).data.map(u => u.name).sort();
  ok(ricTeam.includes('Marcos Silva') && !ricTeam.includes('Camila Rocha'), 'gestor vê a própria equipe e não a de outros gestores');
  const marcosForRic = (await ricardo('GET', '/users/4')).data;
  ok(marcosForRic.user.email === 'marcos@charao.eng.br', 'gestor vê dados pessoais da equipe');

  console.log('Fluxo da tarefa: criação → execução → conferência → conclusão');
  const created = await ricardo('POST', '/tasks', {
    project_id: 1, title: 'Teste automatizado', description: 'Executar verificação de teste.', assignee_id: 4,
    due_date: '2099-01-10', priority: 'alta', proof_type: 'foto_descricao', images: [{ data: tinyPng() }],
  });
  ok(created.status === 201, 'gestor cria tarefa com imagem de referência');
  const tid = created.data.id;
  let t = (await ricardo('GET', `/tasks/${tid}`)).data;
  ok(/^PRJ-001-\d{5}$/.test(t.code), `código padronizado (${t.code})`);
  ok(t.files.length === 1 && t.files[0].kind === 'referencia', 'imagem de referência armazenada');
  ok((await camila('GET', `/tasks/${tid}`)).status === 404, 'usuário sem acesso ao projeto não vê a tarefa');
  ok((await ricardo('PATCH', `/tasks/${tid}/execution`, { exec_description: 'x' })).status === 403, 'apenas o responsável registra a execução');
  ok((await marcos('POST', `/tasks/${tid}/actions/submit`)).status === 400, 'envio bloqueado sem comprovação exigida');
  await marcos('PATCH', `/tasks/${tid}/execution`, { exec_description: 'Armação conferida e liberada.', exec_notes: 'Sem pendências.' });
  t = (await marcos('GET', `/tasks/${tid}`)).data;
  ok(t.status === 'em_andamento', 'registro de execução inicia a tarefa automaticamente');
  const bad = await marcos('POST', `/tasks/${tid}/files`, { kind: 'execucao', images: [{ data: 'data:image/png;base64,' + Buffer.from('<svg></svg>').toString('base64') }] });
  ok(bad.status === 400, 'arquivo que não é imagem real é rejeitado');
  ok((await marcos('POST', `/tasks/${tid}/files`, { kind: 'execucao', images: [{ data: tinyPng() }] })).status === 200, 'responsável envia foto da execução');
  ok((await marcos('POST', `/tasks/${tid}/actions/approve`)).status === 403, 'responsável não confere a própria entrega');
  ok((await marcos('POST', `/tasks/${tid}/actions/submit`)).data.status === 'aguardando_conferencia', 'enviada para conferência');
  ok((await ricardo('POST', `/tasks/${tid}/actions/return`, {})).status === 400, 'devolução exige motivo');
  ok((await ricardo('POST', `/tasks/${tid}/actions/return`, { comment: 'Ajustar foto' })).data.status === 'em_andamento', 'gestor devolve para ajustes');
  await marcos('POST', `/tasks/${tid}/actions/submit`);
  t = (await ricardo('POST', `/tasks/${tid}/actions/approve`, { comment: 'Ok' })).data;
  ok(t.status === 'concluida' && t.on_time === true, 'gestor aprova; entrega no prazo');
  const actions = t.history.map(h => h.action);
  ok(['Tarefa criada', 'Enviada para conferência', 'Devolvida para ajustes', 'Conferência aprovada — tarefa concluída'].every(a => actions.includes(a)), 'histórico registra criação, envio, devolução e conclusão');
  ok(t.history.every(h => h.user_name && h.created_at), 'histórico registra usuário, data e hora');
  const fileId = t.files[0].id;
  ok((await fetch(`${BASE}/api/files/${fileId}`)).status === 401, 'imagens exigem autenticação');
  ok((await camila('GET', `/files/${fileId}`)).status === 404, 'imagens respeitam permissão do projeto');

  console.log('Alterações rastreadas');
  const t2 = (await ricardo('POST', '/tasks', { project_id: 1, title: 'Prazo', description: 'Teste de prazo', assignee_id: 5, due_date: '2099-02-01' })).data.id;
  const reason1 = (await ricardo('GET', '/settings/reasons')).data[0].id;
  const upd = (await ricardo('PATCH', `/tasks/${t2}`, { due_date: '2099-03-01', assignee_id: 4, reschedule_reason_id: reason1 })).data;
  ok(upd.history.some(h => h.action.startsWith('Prazo reagendado') && h.details.includes('01/03/2099')), 'mudança de prazo registrada');
  ok(upd.history.some(h => h.action === 'Responsável alterado'), 'mudança de responsável registrada');
  ok((await ricardo('PATCH', `/tasks/${t2}`, { assignee_id: 6 })).status === 400, 'responsável sem acesso ao projeto é recusado');

  console.log('Relatórios e lista de campo');
  for (const [type, id] of [['projeto', 1], ['usuario', 4], ['equipe', 2], ['geral', null]]) {
    for (const level of ['resumo', 'detalhado', 'completo']) {
      const r = await ana('GET', `/reports?type=${type}&level=${level}${id ? `&id=${id}` : ''}`);
      ok(r.status === 200 && r.data.summary.total >= 0 && (level === 'resumo' ? r.data.tasks.length === 0 : true), `relatório ${type}/${level}`);
    }
  }
  ok((await juliana('GET', '/reports?type=projeto&id=1&level=resumo')).status === 404, 'relatório respeita restrição de projeto');
  const flp = (await ricardo('GET', '/field-list?project=1')).data;
  ok(flp.tasks.length > 0 && flp.tasks.every(x => x.eff_status !== 'concluida'), 'lista de campo do projeto (sem concluídas)');
  const flu = (await ricardo('GET', '/field-list?user=4')).data;
  ok(flu.context.show_project && flu.tasks.length > 0, 'lista de campo do usuário');

  console.log('Subtarefas');
  const mother = (await ricardo('POST', '/tasks', { project_id: 1, title: 'Tarefa com etapas', description: 'Principal', assignee_id: 4, due_date: '2099-05-01', proof_type: 'nenhuma' })).data.id;
  const motherT = (await ricardo('GET', `/tasks/${mother}`)).data;
  ok(motherT.can.add_subtask, 'gestor pode criar subtarefas');
  const s1r = await ricardo('POST', '/tasks', { parent_id: mother, project_id: 3, title: 'Etapa 1', description: 'Primeira etapa', assignee_id: 5, due_date: '2099-04-20', proof_type: 'foto', images: [{ data: tinyPng() }] });
  ok(s1r.status === 201, 'subtarefa criada com imagem de referência');
  const s1 = (await ricardo('GET', `/tasks/${s1r.data.id}`)).data;
  ok(s1.code === `${motherT.code}-01` && s1.project_id === 1 && s1.parent_id === mother, `código e projeto herdados da tarefa principal (${s1.code})`);
  ok(s1.proof_type === 'foto' && s1.files.length === 1 && s1.assignee_name === 'Felipe Andrade', 'subtarefa tem responsável, comprovação e imagens próprios');
  const s2 = (await marcos('POST', '/tasks', { parent_id: mother, title: 'Etapa 2', description: 'Segunda etapa', assignee_id: 4, proof_type: 'nenhuma' })).data.id;
  ok(!!s2, 'responsável pela tarefa principal também pode dividi-la');
  ok((await ricardo('POST', '/tasks', { parent_id: s1.id, title: 'Neta', description: 'x' })).status === 400, 'subtarefa não aceita nova subtarefa');
  ok((await camila('POST', '/tasks', { parent_id: mother, title: 'X', description: 'x' })).status === 404, 'sem acesso ao projeto não cria subtarefa');
  let m = (await ricardo('GET', `/tasks/${mother}`)).data;
  ok(m.subtasks.length === 2 && m.sub_total === 2 && m.history.some(h => h.action === 'Subtarefa adicionada'), 'tarefa principal lista subtarefas e registra no histórico');
  ok((await marcos('POST', `/tasks/${mother}/actions/submit`)).status === 400, 'principal não vai para conferência com subtarefas pendentes');
  ok((await ricardo('POST', `/tasks/${mother}/actions/conclude`, {})).status === 400, 'principal não é concluída com subtarefas pendentes');
  const fel = await login('felipe@charao.eng.br');
  ok((await fel('POST', `/tasks/${s1.id}/actions/submit`)).status === 400, 'subtarefa exige a própria comprovação');
  await fel('POST', `/tasks/${s1.id}/files`, { kind: 'execucao', images: [{ data: tinyPng() }] });
  ok((await fel('POST', `/tasks/${s1.id}/actions/submit`)).data.status === 'aguardando_conferencia', 'subtarefa segue o fluxo de execução e conferência');
  await ricardo('POST', `/tasks/${s1.id}/actions/approve`, {});
  await marcos('POST', `/tasks/${s2}/actions/submit`);
  await ricardo('POST', `/tasks/${s2}/actions/approve`, {});
  m = (await ricardo('GET', `/tasks/${mother}`)).data;
  ok(m.sub_done === 2 && m.history.filter(h => h.action === 'Subtarefa concluída').length === 2, 'conclusão das subtarefas registrada na principal');
  ok((await marcos('POST', `/tasks/${mother}/actions/submit`)).data.status === 'aguardando_conferencia', 'principal liberada após concluir subtarefas');
  await ricardo('POST', `/tasks/${mother}/actions/approve`, {});
  ok((await ricardo('POST', `/tasks/${s1.id}/actions/reopen`, { comment: 'x' })).status === 400, 'subtarefa não reabre com a principal concluída');
  const onlySubs = (await ricardo('GET', '/tasks?nivel=subtarefas')).data;
  ok(onlySubs.length >= 2 && onlySubs.every(t => t.parent_id), 'filtro "somente subtarefas"');
  ok((await ricardo('GET', '/field-list?user=5&include_done=1')).data.tasks.some(t => t.parent_code === motherT.code), 'subtarefas aparecem na lista de campo');

  console.log('Classificação (Grupo/Local/Etapa) e Gantt');
  const np = await ricardo('POST', '/projects', { name: 'Obra Teste Classificação', client: 'Cliente X', stages: [{ name: 'Fundação' }, { name: 'Bloco A' }] });
  ok(np.status === 201, 'projeto criado com classificações');
  let pj = (await ricardo('GET', `/projects/${np.data.id}`)).data;
  ok(pj.stages.map(s => s.name).join() === 'Geral,Fundação,Bloco A' && pj.stages[0].is_default, 'cada projeto tem "Geral" + as próprias classificações');
  const metaStages = (await ricardo('GET', '/meta')).data.projects.find(p => p.id === np.data.id).stages;
  ok(metaStages.length === 3, 'classificações disponíveis para a lista suspensa');
  const fund = pj.stages.find(s => s.name === 'Fundação').id;
  const geral = pj.stages.find(s => s.is_default).id;
  const otherProjStage = (await ricardo('GET', '/projects/1')).data.stages.find(s => !s.is_default)?.id;
  const tFund = (await ricardo('POST', '/tasks', { project_id: np.data.id, title: 'Estacas', description: 'Cravar estacas', stage_id: fund, start_date: '2099-01-01', due_date: '2099-01-10' })).data.id;
  const tSem = (await ricardo('POST', '/tasks', { project_id: np.data.id, title: 'Sem classe', description: 'Sem classificação' })).data.id;
  ok((await ricardo('GET', `/tasks/${tFund}`)).data.stage_name === 'Fundação', 'tarefa classificada na criação');
  ok((await ricardo('GET', `/tasks/${tSem}`)).data.stage_id === geral, 'sem classificação assume "Geral" automaticamente');
  ok((await ricardo('POST', '/tasks', { project_id: np.data.id, title: 'X', description: 'x', stage_id: otherProjStage })).status === 400, 'classificação de outro projeto é recusada');
  ok((await ricardo('POST', '/tasks', { project_id: np.data.id, title: 'X', description: 'x', start_date: '2099-02-01', due_date: '2099-01-01' })).status === 400, 'início previsto após o prazo é recusado');
  const moved = (await ricardo('PATCH', `/tasks/${tSem}`, { stage_id: fund })).data;
  ok(moved.stage_name === 'Fundação' && moved.history.some(h => h.action === 'Classificação alterada'), 'reclassificação registrada no histórico');
  const sub = (await ricardo('POST', '/tasks', { parent_id: tFund, title: 'Sub', description: 'sub', stage_id: fund })).data.id;
  ok((await ricardo('GET', `/tasks/${sub}`)).data.stage_name === 'Fundação', 'subtarefa também é classificada');
  const filtered = (await ricardo('GET', `/tasks?stage=${fund}`)).data;
  ok(filtered.length === 3 && filtered.every(t => t.stage_id === fund), 'filtro de tarefas por classificação');
  ok((await ricardo('PUT', `/projects/${np.data.id}`, { stages: [{ id: pj.stages[2].id, name: 'Bloco A' }] })).status === 400, 'classificação com tarefas não pode ser removida');
  ok((await ricardo('PUT', `/projects/${np.data.id}`, { stages: [{ id: fund, name: 'Fundações' }, { name: 'Cobertura' }] })).status === 200, 'renomear, adicionar e remover classificação sem tarefas');
  pj = (await ricardo('GET', `/projects/${np.data.id}`)).data;
  ok(pj.stages.map(s => s.name).join() === 'Geral,Fundações,Cobertura' && (await ricardo('GET', `/tasks/${tFund}`)).data.stage_name === 'Fundações', 'tarefas acompanham a classificação renomeada');
  ok((await ricardo('PUT', `/projects/${np.data.id}`, { stages: [{ name: 'Geral' }] })).status === 400, '"Geral" é reservada');
  const rep = (await ricardo('GET', `/reports?type=projeto&id=${np.data.id}&level=detalhado&group=classificacao`)).data;
  ok(rep.by_stage.some(g => g.label === 'Fundações' && g.summary.total === 3) && rep.tasks.every(t => t.stage_name === 'Fundações'), 'relatório agrupado por classificação');
  ok(rep.gantt_tasks.length === rep.tasks.length && rep.gantt_tasks.find(t => t.id === tFund).start_date === '2099-01-01', 'relatório traz dados do Gantt');
  const repF = (await ricardo('GET', `/reports?type=projeto&id=${np.data.id}&level=resumo&stage=${geral}`)).data;
  ok(repF.summary.total === 0 && repF.stage_filter.join() === 'Geral', 'relatório filtrado por classificação');
  ok((await ricardo('GET', `/reports?type=geral&level=resumo&gantt=0`)).data.gantt_tasks.length === 0, 'Gantt pode ser desligado');
  ok((await juliana('GET', `/tasks?stage=${fund}`)).data.length === 0, 'filtro por classificação respeita restrição de projeto');
  const fl = (await ricardo('GET', `/field-list?project=${np.data.id}&stage=${fund}`)).data;
  ok(fl.context.stage === 'Fundações' && fl.tasks.length === 3 && fl.tasks.every(t => t.stage_name === 'Fundações'), 'lista de campo por classificação');

  console.log('Reagendamento de prazos e Configurações');
  const reasons = (await marcos('GET', '/settings/reasons')).data;
  ok(reasons.length >= 5 && reasons.every(r => r.active), 'justificativas pré-cadastradas disponíveis a todos os usuários');
  ok((await marcos('PUT', '/settings/reasons', { reasons: [] })).status === 403, 'colaborador não altera as justificativas');
  ok((await marcos('GET', '/meta')).data.can.manage_settings === false && (await ricardo('GET', '/meta')).data.can.manage_settings === true, 'Configurações liberada para gestor e oculta para colaborador');
  const gAll = (await ricardo('GET', '/settings/reasons?all=1')).data;
  const gSave = await ricardo('PUT', '/settings/reasons', { reasons: [...gAll, { name: 'Embargo / fiscalização' }] });
  ok(gSave.status === 200 && gSave.data.some(r => r.name === 'Embargo / fiscalização'), 'gestor altera as justificativas');
  ok((await ana('GET', '/audit')).data.some(a => a.action === 'Justificativas de reagendamento atualizadas' && a.actor_name === 'Ricardo Menezes'), 'alteração do gestor registrada na auditoria');
  const rTask = (await ricardo('POST', '/tasks', { project_id: 1, title: 'Prazo a reagendar', description: 'Teste de reagendamento', assignee_id: 4, due_date: '2099-03-10' })).data.id;
  ok((await ricardo('PATCH', `/tasks/${rTask}`, { due_date: '2099-03-20' })).status === 400, 'alterar prazo sem justificativa é recusado');
  ok((await ricardo('POST', `/tasks/${rTask}/reschedule`, { due_date: '2099-03-20' })).status === 400, 'reagendar exige justificativa');
  ok((await marcos('POST', `/tasks/${rTask}/reschedule`, { due_date: '2099-03-20', reason_id: reasons[0].id })).status === 403, 'responsável colaborador não reagenda (regra de edição mantida)');
  let rt = (await ricardo('POST', `/tasks/${rTask}/reschedule`, { due_date: '2099-03-20', reason_id: reasons[1].id, note: 'Fornecedor atrasou' })).data;
  ok(rt.due_date === '2099-03-20' && rt.reschedule_count === 1 && rt.original_due === '2099-03-10', 'reagendamento registrado (contagem e prazo original)');
  rt = (await ricardo('PATCH', `/tasks/${rTask}`, { due_date: '2099-04-02', reschedule_reason_id: reasons[0].id })).data;
  ok(rt.reschedule_count === 2 && rt.reschedules.length === 2 && rt.reschedules[1].old_due === '2099-03-20', 'reagendamento também pela edição da tarefa');
  ok(rt.history.some(h => h.action === 'Prazo reagendado (2º reagendamento)' && h.details.includes(reasons[0].name)), 'histórico registra o reagendamento com a justificativa');
  const outro = reasons.find(r => /outro/i.test(r.name));
  ok((await ricardo('POST', `/tasks/${rTask}/reschedule`, { due_date: '2099-04-05', reason_id: outro.id })).status === 400, '"Outro motivo" exige observação');
  const noDue = (await ricardo('POST', '/tasks', { project_id: 1, title: 'Sem prazo', description: 'x' })).data.id;
  ok((await ricardo('PATCH', `/tasks/${noDue}`, { due_date: '2099-05-01' })).data.reschedule_count === 0, 'definir o primeiro prazo não é reagendamento');
  ok((await ricardo('GET', '/tasks?due=reagendadas')).data.some(t => t.id === rTask), 'filtro "reagendadas"');
  const rr = (await ricardo('GET', '/reports?type=projeto&id=1&level=detalhado')).data;
  ok(rr.summary.rescheduled >= 1 && rr.reschedules.reasons.length >= 2 && rr.reschedules.tasks.find(t => t.id === rTask).entries.length === 2, 'relatório traz reagendamentos e motivos');
  ok(rr.gantt_tasks.find(t => t.id === rTask).original_due === '2099-03-10', 'Gantt recebe o prazo original');
  // Configurações (administrador)
  const all1 = (await ana('GET', '/settings/reasons?all=1')).data;
  const used = all1.find(r => r.id === reasons[1].id);
  ok(used.use_count >= 1 && all1.some(r => r.use_count === 0), 'contagem de uso da justificativa');
  ok((await ana('PUT', '/settings/reasons', { reasons: all1.filter(r => r.id !== used.id) })).status === 400, 'justificativa já usada não pode ser excluída');
  const edited = [{ ...all1[0], name: 'Chuva / clima' }, { ...used, active: false }, ...all1.slice(2).filter(r => r.id !== used.id), { name: 'Interdição da via de acesso' }];
  const saved = await ana('PUT', '/settings/reasons', { reasons: edited });
  ok(saved.status === 200 && saved.data.some(r => r.name === 'Interdição da via de acesso') && !saved.data.find(r => r.id === used.id).active, 'renomear, inativar e incluir justificativas');
  ok(!(await marcos('GET', '/settings/reasons')).data.some(r => r.id === used.id), 'justificativa inativa some da lista suspensa');
  ok((await ricardo('GET', `/tasks/${rTask}`)).data.reschedules[0].reason_name === reasons[1].name, 'histórico preserva o texto original da justificativa');
  ok((await ricardo('POST', `/tasks/${rTask}/reschedule`, { due_date: '2099-04-09', reason_id: used.id })).status === 400, 'justificativa inativa não pode ser usada');

  console.log('Indicadores de prazo e repactuação');
  const rsn = (await ricardo('GET', '/settings/reasons')).data[0].id;
  const np2 = (await ricardo('POST', '/projects', { name: 'Obra Indicadores', client: 'Cliente Y' })).data.id;
  const mk = async (title, due) => (await ricardo('POST', '/tasks', { project_id: np2, title, description: title, assignee_id: 2, due_date: due })).data.id;
  const tPrev = await mk('Preventiva', '2099-06-10');
  await ricardo('POST', `/tasks/${tPrev}/reschedule`, { due_date: '2099-06-20', reason_id: rsn });
  const tCorr = await mk('Corretiva ainda atrasada', '2020-01-10');
  await ricardo('POST', `/tasks/${tCorr}/reschedule`, { due_date: '2020-02-10', reason_id: rsn }); // vencido → corretiva; segue vencido
  const tChr = await mk('Crônica', '2099-01-01');
  for (const d of ['2099-01-05', '2099-01-09', '2099-01-12']) await ricardo('POST', `/tasks/${tChr}/reschedule`, { due_date: d, reason_id: rsn });
  const tOk = await mk('Sem repactuação', '2099-01-01');
  let x = (await ricardo('GET', `/tasks/${tPrev}`)).data;
  ok(x.reschedules[0].kind === 'preventiva' && x.reschedules_preventive === 1 && x.late_episodes === 0, 'reagendamento antes do vencimento = preventivo (sem atraso)');
  x = (await ricardo('GET', `/tasks/${tCorr}`)).data;
  ok(x.reschedules[0].kind === 'corretiva' && x.reschedules_corrective === 1, 'reagendamento com prazo vencido = corretivo');
  ok(x.late_episodes === 2 && x.ever_late, 'episódios de atraso: repactuação corretiva + atraso atual = 2');
  ok((await ricardo('GET', `/tasks/${tChr}`)).data.chronic === true, 'tarefa reagendada 3x é crônica (limite padrão 3)');
  ok(x.original_due === '2020-01-10' && (await ricardo('GET', `/tasks/${tPrev}`)).data.days_added === 10, 'prazo original e dias acrescidos');
  const ps = (await ricardo('GET', `/projects/${np2}`)).data.summary;
  ok(ps.with_due === 4 && ps.rescheduled === 3 && ps.reschedule_rate === 75, `taxa de repactuação (${ps.reschedule_rate}%)`);
  ok(ps.preventive === 4 && ps.corrective === 1 && ps.corrective_pct === 20, 'preventivas × corretivas');
  ok(ps.ever_late === 1 && ps.late_rate === 25 && ps.late_episodes === 2, 'taxa de atraso (alguma vez) e episódios');
  ok(ps.chronic === 1 && ps.reschedule_dist.r0 === 1 && ps.reschedule_dist.r1 === 2 && ps.reschedule_dist.r3 === 1, 'distribuição 0/1/2/3+ e crônicas');
  // Pontualidade real × repactuada: entrega após o prazo original e antes do prazo vigente
  const tReal = await mk('Pontualidade', '2020-03-01');
  await ricardo('POST', `/tasks/${tReal}/reschedule`, { due_date: '2099-03-01', reason_id: rsn });
  await ricardo('POST', `/tasks/${tReal}/actions/submit`); // responsável = Ricardo (mk)
  x = (await ricardo('GET', `/tasks/${tReal}`)).data;
  ok(x.on_time === true && x.on_time_original === false, 'entrega no prazo repactuado, mas fora do prazo original');
  ok((await ricardo('GET', '/tasks?due=ja_atrasadas')).data.some(t => t.id === tCorr) && !(await ricardo('GET', '/tasks?due=ja_atrasadas')).data.some(t => t.id === tPrev), 'filtro "ficaram atrasadas"');
  ok((await ricardo('GET', '/tasks?due=corretivas')).data.every(t => t.reschedules_corrective > 0), 'filtro "repactuadas após atraso"');
  ok((await ricardo('GET', '/tasks?due=cronicas')).data.some(t => t.id === tChr), 'filtro "crônicas"');
  // Concluída com atraso: entrega após o prazo vigente
  const tLateDone = await mk('Concluída com atraso', '2020-05-01');
  await ricardo('POST', `/tasks/${tLateDone}/actions/conclude`, {});
  const lateDone = (await ricardo('GET', '/tasks?due=concluidas_atraso')).data;
  ok(lateDone.some(t => t.id === tLateDone && t.days_late > 0) && lateDone.every(t => t.status === 'concluida' && t.on_time === false), 'filtro "concluídas com atraso"');
  ok(!lateDone.some(t => t.id === tOk), 'tarefas no prazo não entram no filtro de concluídas com atraso');
  const dash = (await ricardo('GET', '/dashboard')).data;
  ok(dash.trend.length === 6 && dash.summary.late_rate !== undefined && dash.deadline_watch.length > 0, 'dashboard com indicadores, evolução mensal e tarefas em atenção');
  const urep = (await ricardo('GET', `/reports?type=projeto&id=${np2}&level=detalhado`)).data;
  ok(urep.trend.length === 6 && urep.reschedules.tasks.find(t => t.id === tCorr).entries[0].kind === 'corretiva', 'relatório com evolução mensal e tipo de repactuação');
  ok((await ricardo('GET', `/users/2`)).data.stats.behavior.some(l => l.includes('Repactuou')), 'resumo de comportamento comenta a repactuação');
  // Limite de crônica configurável (gestor/admin)
  ok((await marcos('PUT', '/settings/general', { chronic_reschedule_threshold: 2 })).status === 403, 'colaborador não altera o limite de crônica');
  ok((await ricardo('PUT', '/settings/general', { chronic_reschedule_threshold: 1 })).status === 400, 'limite inválido é recusado');
  ok((await ricardo('PUT', '/settings/general', { chronic_reschedule_threshold: 4 })).data.chronic_reschedule_threshold === 4, 'gestor altera o limite de crônica');
  ok((await ricardo('GET', `/tasks/${tChr}`)).data.chronic === false, 'com limite 4, a tarefa reagendada 3x deixa de ser crônica');
  await ricardo('PUT', '/settings/general', { chronic_reschedule_threshold: 3 });

  console.log('Organização por dia, semana e mês');
  const npP = (await ricardo('POST', '/projects', { name: 'Obra Períodos', client: 'Cliente Z' })).data.id;
  for (const [t, d] of [['Seg', '2099-06-01'], ['Dom', '2099-06-07'], ['Seg seguinte', '2099-06-08'], ['Julho', '2099-07-02'], ['Sem prazo', '']]) {
    await ricardo('POST', '/tasks', { project_id: npP, title: t, description: t, due_date: d || undefined });
  }
  const rw = (await ricardo('GET', `/reports?type=projeto&id=${npP}&level=detalhado&group=semana`)).data;
  ok(rw.by_period.map(g => g.key).join() === '2099-06-01,2099-06-08,2099-06-29,9999', `semanas de segunda a domingo (${rw.by_period.map(g => g.key).join()})`);
  ok(rw.by_period[0].summary.total === 2 && rw.by_period.at(-1).label === 'Sem prazo', 'agrupamento semanal com "Sem prazo" por último');
  ok(rw.tasks.map(t => t.due_date || '-').join() === '2099-06-01,2099-06-07,2099-06-08,2099-07-02,-', 'tarefas em ordem cronológica do prazo');
  const rm = (await ricardo('GET', `/reports?type=projeto&id=${npP}&level=resumo&group=mes`)).data;
  ok(rm.by_period.map(g => g.label).join('|') === 'Junho de 2099|Julho de 2099|Sem prazo' && rm.by_period[0].summary.total === 3, 'agrupamento mensal');
  const rd = (await ricardo('GET', `/reports?type=projeto&id=${npP}&level=resumo&group=dia`)).data;
  ok(rd.by_period.length === 5 && rd.by_period[0].label.startsWith('Seg,'), 'agrupamento diário com dia da semana');
  ok((await ricardo('GET', `/reports?type=projeto&id=${npP}&level=resumo&group=quinzena`)).status === 400, 'organização inválida é recusada');
  const flw = (await ricardo('GET', `/field-list?project=${npP}&org=semana`)).data;
  ok(flw.context.org === 'semana' && flw.tasks[0].period_label.startsWith('Semana de 01/06') && flw.tasks.at(-1).period_label === 'Sem prazo', 'lista de campo organizada por semana');

  console.log('Cancelamento e exclusão de tarefas');
  const npC = (await ricardo('POST', '/projects', { name: 'Obra Cancelamentos', client: 'Cliente C' })).data.id;
  const mkC = async (title, extra = {}) => (await ricardo('POST', '/tasks', { project_id: npC, title, description: title, assignee_id: 2, due_date: '2020-01-01', ...extra })).data.id;
  const cA = await mkC('Atrasada a cancelar');
  let sumBefore = (await ricardo('GET', `/projects/${npC}`)).data.summary;
  ok(sumBefore.total === 1 && sumBefore.late === 1, 'antes: tarefa conta nos indicadores');
  ok((await marcos('POST', `/tasks/${cA}/cancel`, { reason: 'Duplicada' })).status === 404, 'usuário sem acesso não cancela');
  ok((await ricardo('POST', `/tasks/${cA}/cancel`, { reason: '' })).status === 400, 'cancelamento exige motivo');
  let cT = (await ricardo('POST', `/tasks/${cA}/cancel`, { reason: 'Serviço retirado do escopo pelo cliente' })).data;
  ok(cT.eff_status === 'cancelada' && cT.cancelled_by_name === 'Ricardo Menezes' && cT.cancel_reason.includes('escopo'), 'tarefa cancelada com motivo e responsável');
  ok(cT.history.some(h => h.action === 'Tarefa cancelada'), 'cancelamento registrado no histórico');
  ok(cT.can.reactivate && !cT.can.edit && !cT.can.reschedule, 'tarefa cancelada fica bloqueada (só reativar)');
  ok((await ricardo('PATCH', `/tasks/${cA}`, { title: 'x' })).status === 400, 'não edita tarefa cancelada');
  const sumAfter = (await ricardo('GET', `/projects/${npC}`)).data.summary;
  ok(sumAfter.total === 0 && sumAfter.late === 0, 'cancelada sai dos indicadores do projeto');
  ok(!(await ricardo('GET', '/tasks')).data.some(t => t.id === cA), 'cancelada sai da lista padrão');
  ok((await ricardo('GET', '/tasks?status=cancelada')).data.some(t => t.id === cA && t.eff_status === 'cancelada'), 'filtro "Canceladas"');
  ok(!(await ricardo('GET', `/field-list?project=${npC}`)).data.tasks.some(t => t.id === cA), 'cancelada sai da lista de campo');
  ok((await ricardo('GET', `/reports?type=projeto&id=${npC}&level=detalhado`)).data.summary.total === 0, 'cancelada sai dos relatórios');
  cT = (await ricardo('POST', `/tasks/${cA}/reactivate`, {})).data;
  ok(!cT.cancelled_at && cT.eff_status === 'atrasada' && cT.history.some(h => h.action === 'Tarefa reativada'), 'reativação devolve o status anterior');
  // Principal com subtarefas: cancelamento em cascata
  const cP = await mkC('Principal', { due_date: '2099-01-01' });
  const cS1 = (await ricardo('POST', '/tasks', { parent_id: cP, title: 'Sub 1', description: 'Sub 1' })).data.id;
  const cS2 = (await ricardo('POST', '/tasks', { parent_id: cP, title: 'Sub 2', description: 'Sub 2' })).data.id;
  await ricardo('POST', `/tasks/${cS2}/actions/conclude`, {});
  await ricardo('POST', `/tasks/${cP}/cancel`, { reason: 'Etapa eliminada do projeto' });
  ok((await ricardo('GET', `/tasks/${cS1}`)).data.cancelled_at && !(await ricardo('GET', `/tasks/${cS2}`)).data.cancelled_at, 'cancelar a principal cancela as subtarefas não concluídas');
  ok((await ricardo('POST', `/tasks/${cS1}/reactivate`, {})).status === 400, 'subtarefa só reativa com a principal ativa');
  // Subtarefa cancelada não trava a conclusão da principal
  const cP2 = await mkC('Principal 2', { due_date: '2099-01-01' });
  const cS3 = (await ricardo('POST', '/tasks', { parent_id: cP2, title: 'Sub 3', description: 'Sub 3' })).data.id;
  await ricardo('POST', `/tasks/${cS3}/cancel`, { reason: 'Não será mais necessária' });
  ok((await ricardo('POST', `/tasks/${cP2}/actions/conclude`, {})).data.status === 'concluida', 'subtarefa cancelada não impede concluir a principal');
  // Exclusão definitiva
  const dOk = await mkC('Criada por engano', { images: [{ data: tinyPng() }] });
  ok((await ricardo('GET', `/tasks/${dOk}`)).data.can.delete === false, 'gestor não vê a opção de excluir');
  ok((await ricardo('DELETE', `/tasks/${dOk}`, { reason: 'Duplicada' })).status === 403, 'gestor não exclui');
  ok((await ana('GET', `/tasks/${dOk}`)).data.can.delete === true, 'administrador pode excluir tarefa sem execução');
  ok((await ana('DELETE', `/tasks/${dOk}`, { reason: '' })).status === 400, 'exclusão exige motivo');
  const del = await ana('DELETE', `/tasks/${dOk}`, { reason: 'Cadastrada em duplicidade' });
  ok(del.status === 200 && (await ana('GET', `/tasks/${dOk}`)).status === 404, 'tarefa excluída definitivamente');
  ok((await ana('GET', '/audit')).data.some(a => a.action === 'Tarefa excluída definitivamente' && a.details.includes('Cadastrada em duplicidade') && a.details.includes('"imagens":1')), 'exclusão registrada na auditoria com motivo');
  const dExec = await mkC('Com execução', { due_date: '2099-01-01' });
  await ricardo('PATCH', `/tasks/${dExec}/execution`, { exec_description: 'Iniciado o serviço' });
  const blocked = (await ana('GET', `/tasks/${dExec}`)).data.can;
  ok(blocked.delete === false && blocked.delete_blocked.includes('Cancelar'), 'tarefa com execução não pode ser excluída (orienta cancelar)');
  ok((await ana('DELETE', `/tasks/${dExec}`, { reason: 'Teste de bloqueio' })).status === 400, 'servidor recusa excluir tarefa com execução');
  ok((await ana('DELETE', `/tasks/${cP2}`, { reason: 'Teste de bloqueio' })).status === 400, 'servidor recusa excluir tarefa com subtarefas');

  console.log('Tarefas recorrentes');
  const TODAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
  const plus = n => new Date(Date.parse(TODAY + 'T00:00:00Z') + n * 86400e3).toISOString().slice(0, 10);
  const wd = d => new Date(Date.parse(d + 'T00:00:00Z')).getUTCDay();
  let nextMon = plus(1); while (wd(nextMon) !== 1) nextMon = plus((Date.parse(nextMon) - Date.parse(TODAY)) / 86400e3 + 1);
  const npR = (await ricardo('POST', '/projects', { name: 'Obra Recorrências', client: 'Cliente R', stages: [{ name: 'Segurança' }] })).data.id;
  const segStage = (await ricardo('GET', `/projects/${npR}`)).data.stages.find(s => s.name === 'Segurança').id;
  const pv = (await ricardo('POST', '/recurrences/preview', { freq: 'semanal', weekdays: [1, 3], start_date: nextMon, end_type: 'ocorrencias', end_count: 6 })).data;
  ok(pv.description.startsWith('Toda semana: segunda e quarta') && pv.next.length === 6 && pv.total === 6, 'prévia da regra (descrição e próximas datas)');
  ok((await ricardo('POST', '/recurrences', { project_id: npR, title: 'X', description: 'x', freq: 'diaria', start_date: plus(-1), end_type: 'nunca' })).status === 400, '1ª ocorrência no passado é recusada');
  ok((await ricardo('POST', '/recurrences', { project_id: npR, title: 'X', description: 'x', freq: 'diaria', start_date: plus(1), end_type: 'data', end_date: TODAY })).status === 400, 'término antes da 1ª ocorrência é recusado');
  const recW = await ricardo('POST', '/recurrences', { project_id: npR, title: 'Inspeção de segurança (DDS)', description: 'Inspeção semanal de EPIs e andaimes', assignee_id: 2,
    stage_id: segStage, priority: 'alta', proof_type: 'foto', freq: 'semanal', weekdays: [1, 3], start_date: nextMon, end_type: 'ocorrencias', end_count: 6,
    lead_days: 14, duration_days: 1, images: [{ data: tinyPng() }] });
  ok(recW.status === 201, 'recorrência semanal criada');
  let rw2 = (await ricardo('GET', `/recurrences/${recW.data.id}`)).data;
  const expectedW = [...Array(15).keys()].map(plus).filter(d => d >= nextMon && [1, 3].includes(wd(d))).slice(0, 6);
  ok(rw2.tasks.length === expectedW.length && rw2.tasks.map(t => t.due_date).join() === expectedW.join(), `ocorrências criadas até hoje + 14 dias (${rw2.tasks.length})`);
  ok(rw2.tasks.every(t => t.recurrence_id === recW.data.id && /^PRJ-\d{3}-\d{5}$/.test(t.code) && t.stage_name === 'Segurança' && t.priority === 'alta' && t.ref_count === 1), 'ocorrências são tarefas normais com molde, classificação e imagem');
  ok(rw2.description === 'Inspeção semanal de EPIs e andaimes' && rw2.rule_text.startsWith('Toda semana: segunda e quarta'), 'molde e regra preservados separadamente');
  ok(rw2.generated_count === rw2.tasks.length && rw2.next_dates.length > 0 && rw2.active, 'série acompanha quantas foram criadas e as próximas datas');
  const occ = (await ricardo('GET', `/tasks/${rw2.tasks[0].id}`)).data;
  ok(occ.recurrence_title === 'Inspeção de segurança (DDS)' && occ.recurrence_seq === 1 && occ.history.some(h => h.action.includes('automaticamente pela recorrência')), 'tarefa mostra a série de origem e o histórico');
  ok((await ricardo('GET', `/projects/${npR}`)).data.summary.total === rw2.tasks.length, 'ocorrências entram nos indicadores do projeto');
  ok((await ricardo('PUT', `/projects/${npR}`, { stages: [] })).status === 400, 'classificação usada por recorrência não pode ser removida');
  // Término por número de ocorrências: série termina sozinha
  const recD = (await ricardo('POST', '/recurrences', { project_id: npR, title: 'Limpeza diária', description: 'Limpeza do canteiro', freq: 'diaria', start_date: plus(1), end_type: 'ocorrencias', end_count: 3, lead_days: 30 })).data;
  const rd2 = (await ricardo('GET', `/recurrences/${recD.id}`)).data;
  ok(rd2.tasks.length === 3 && !rd2.active && rd2.end_reason === 'Término da recorrência atingido', 'após a última ocorrência, a recorrência encerra sozinha');
  // Mensal ainda fora da antecedência: nada criado agora
  const recM = (await ricardo('POST', '/recurrences', { project_id: npR, title: 'Medição mensal', description: 'Boletim de medição', freq: 'mensal', start_date: plus(40), month_day: 31, end_type: 'nunca', lead_days: 5 })).data;
  const rm2 = (await ricardo('GET', `/recurrences/${recM.id}`)).data;
  ok(recM.generated === 0 && rm2.tasks.length === 0 && rm2.next_dates[0] >= plus(40) && rm2.next_dates[0].slice(0, 7) === plus(40).slice(0, 7) && rm2.active, 'ocorrência só é criada dentro da antecedência configurada');
  // Permissões
  ok((await camila('POST', '/recurrences', { project_id: 1, title: 'X', description: 'x', freq: 'diaria', start_date: plus(1), end_type: 'nunca' })).status === 403, 'sem acesso ao projeto não cria recorrência');
  ok((await camila('GET', `/recurrences/${recW.data.id}`)).status === 404, 'sem acesso ao projeto não vê a recorrência');
  const recMarcos = (await marcos('POST', '/recurrences', { project_id: 1, title: 'Diário de obra', description: 'Preencher diário', assignee_id: 4, freq: 'diaria', workdays_only: true, start_date: plus(1), end_type: 'nunca', lead_days: 3 })).data;
  ok(recMarcos.id && (await ricardo('GET', `/recurrences/${recMarcos.id}`)).data.can_manage, 'colaborador cria recorrência no projeto liberado; gestor pode gerenciá-la');
  ok((await marcos('PUT', `/recurrences/${recW.data.id}`, { title: 'X' })).status === 404 || (await marcos('PUT', `/recurrences/${recW.data.id}`, { title: 'X' })).status === 403, 'colaborador não edita recorrência de outro');
  const md = (await marcos('GET', `/recurrences/${recMarcos.id}`)).data;
  ok(md.tasks.every(t => ![0, 6].includes(wd(t.due_date))), 'somente dias úteis respeitado nas ocorrências');
  // Edição vale para as próximas ocorrências
  const before = rw2.tasks.length;
  const updR = (await ricardo('PUT', `/recurrences/${recW.data.id}`, { title: 'Inspeção de segurança e EPIs', lead_days: 30 })).data;
  ok(updR.tasks.length > before || updR.tasks.length === 6, 'aumentar a antecedência cria as ocorrências que entraram no prazo');
  ok(updR.tasks.slice(0, before).every(t => t.title === 'Inspeção de segurança (DDS)') && updR.tasks.slice(before).every(t => t.title === 'Inspeção de segurança e EPIs'), 'edição não altera ocorrências já criadas');
  ok((await ricardo('PUT', `/recurrences/${recW.data.id}`, { end_type: 'ocorrencias', end_count: 1 })).status === 400, 'não é possível reduzir o total abaixo do já criado');
  // Encerrar com cancelamento das futuras
  const recE = (await ricardo('POST', '/recurrences', { project_id: npR, title: 'Vistoria', description: 'Vistoria', freq: 'diaria', start_date: plus(1), end_type: 'nunca', lead_days: 4 })).data;
  ok((await ricardo('POST', `/recurrences/${recE.id}/end`, {})).status === 400, 'encerrar exige motivo');
  const ended = (await ricardo('POST', `/recurrences/${recE.id}/end`, { reason: 'Vistorias passaram a ser semanais', cancel_future: true })).data;
  ok(!ended.active && ended.cancelled === 4 && ended.tasks.every(t => t.cancelled_at), 'encerrar cancela as ocorrências futuras não iniciadas');
  ok((await ana('GET', '/audit')).data.some(a => a.action === 'Recorrência encerrada'), 'criação e encerramento registrados na auditoria');

  console.log('Áreas internas da empresa');
  const intArea = (await ana('GET', '/projects')).data.find(p => p.kind === 'interno');
  ok(intArea && intArea.code === 'INT-001' && intArea.name === 'Charão — Interno', 'área interna padrão criada (INT-001)');
  const intDet = (await ana('GET', `/projects/${intArea.id}`)).data;
  ok(['Administrativo', 'Financeiro', 'Equipamentos e manutenção'].every(n => intDet.stages.some(s => s.name === n)), 'departamentos como classificações');
  ok((await ricardo('GET', '/projects')).data.some(p => p.id === intArea.id), 'gestor tem acesso à área interna');
  ok(!(await marcos('GET', '/projects')).data.some(p => p.id === intArea.id) && (await marcos('GET', `/projects/${intArea.id}`)).status === 404, 'colaborador sem liberação não vê a área interna');
  const tInt = (await ricardo('POST', '/tasks', { project_id: intArea.id, title: 'Pagar fornecedores', description: 'Conferir e pagar notas da semana', assignee_id: 2,
    stage_id: intDet.stages.find(s => s.name === 'Financeiro').id, due_date: '2099-01-05' })).data.id;
  const tIntD = (await ricardo('GET', `/tasks/${tInt}`)).data;
  ok(/^INT-001-\d{5}$/.test(tIntD.code) && tIntD.project_kind === 'interno' && tIntD.stage_name === 'Financeiro', `tarefa interna com código próprio (${tIntD.code})`);
  const nInt = await ricardo('POST', '/projects', { kind: 'interno', name: 'Manutenção de frota' });
  const nIntD = (await ricardo('GET', `/projects/${nInt.data.id}`)).data;
  ok(nInt.status === 201 && nIntD.code === 'INT-002' && nIntD.client === 'Charão Engenharia e Construção', 'nova área interna sem cliente (INT-002)');
  ok((await ricardo('POST', '/projects', { name: 'Obra sem cliente' })).status === 400, 'obra continua exigindo cliente');
  await ricardo('PUT', `/projects/${nIntD.id}`, { kind: 'obra', name: 'Manutenção de frota' });
  ok((await ricardo('GET', `/projects/${nIntD.id}`)).data.kind === 'interno', 'tipo do projeto não muda na edição');
  const nObra = (await ricardo('POST', '/projects', { name: 'Obra nova', client: 'Cliente N' })).data.id;
  ok(/^PRJ-\d{3}$/.test((await ricardo('GET', `/projects/${nObra}`)).data.code), 'numeração das obras continua PRJ');
  const dsh = (await ricardo('GET', '/dashboard')).data;
  ok(dsh.projects.every(p => p.kind === 'obra') && dsh.internal_areas.some(p => p.id === intArea.id), 'dashboard separa obras e áreas internas');
  ok(dsh.summary.total >= 1 && (await ricardo('GET', '/tasks?kind=interno')).data.every(t => t.project_kind === 'interno'), 'filtro de tarefas por tipo (interno)');
  ok((await ricardo('GET', '/tasks?kind=obra')).data.every(t => t.project_kind === 'obra'), 'filtro de tarefas por tipo (obras)');
  const rk = (await ricardo('GET', '/reports?type=geral&level=resumo&kind=interno')).data;
  ok(rk.kind === 'interno' && rk.by_project.every(g => g.label.startsWith('INT-')), 'relatório geral só das áreas internas');

  console.log('Terceirizados (com líder; login opcional)');
  ok((await ana('POST', '/users', { role: 'terceirizado', name: 'José Pedreiro', project_ids: [1] })).status === 400, 'terceirizado exige líder');
  ok((await ana('POST', '/users', { role: 'terceirizado', name: 'José Pedreiro', manager_id: 4, project_ids: [] })).status === 400, 'terceirizado exige projeto liberado');
  const extR = await ana('POST', '/users', { role: 'terceirizado', name: 'José Pedreiro', company: 'Empreiteira Alfa', job_title: 'Pedreiro', manager_id: 4, project_ids: [1] });
  ok(extR.status === 201, 'terceirizado cadastrado sem e-mail e sem senha, com líder colaborador');
  const extId = extR.data.id;
  ok((await ana('POST', '/users', { role: 'terceirizado', name: 'X', manager_id: extId, project_ids: [1] })).status === 400, 'outro terceirizado não pode ser líder');
  const extU = (await ana('GET', `/users/${extId}`)).data.user;
  ok(extU.is_external === 1 && extU.company === 'Empreiteira Alfa' && extU.email === null && extU.manager_id === 4 && extU.login_enabled === 0, 'perfil terceirizado sem login (e-mail fictício nunca exposto)');
  ok((await ana('POST', `/users/${extId}/password`, { password: 'senha12345' })).status === 400, 'terceirizado sem login não recebe senha');
  await ana('POST', '/users', { role: 'terceirizado', name: 'Ana Eletricista', email: 'ana.eletrica@alfa.com', manager_id: 2, project_ids: [1] });
  ok((await client()('POST', '/auth/login', { email: 'ana.eletrica@alfa.com', password: 'qualquer123' })).status === 401, 'terceirizado sem acesso não consegue fazer login');
  ok((await ana('PUT', '/users/4', { manager_id: extId })).status === 400, 'terceirizado não pode ser gestor de usuário interno');
  ok((await ana('PUT', '/projects/1', { lead_id: extId })).status === 400, 'terceirizado não pode ser responsável técnico de projeto');
  // Projetos próprios: liberado só na PRJ-001, embora o líder (Marcos) tenha PRJ-001..003
  ok((await ricardo('GET', '/projects/1/assignees')).data.some(u => u.id === extId) && !(await ricardo('GET', '/projects/2/assignees')).data.some(u => u.id === extId), 'terceirizado só aparece nos projetos liberados a ele');
  ok((await ricardo('POST', '/tasks', { project_id: 2, title: 'X', description: 'x', assignee_id: extId })).status === 400, 'não pode ser responsável fora dos projetos liberados');
  const tExt = (await ricardo('POST', '/tasks', { project_id: 1, title: 'Assentar blocos do 5º pavimento', description: 'Alvenaria do 5º pavimento', assignee_id: extId, proof_type: 'foto_descricao', due_date: '2099-02-01' })).data.id;
  let te = (await marcos('GET', `/tasks/${tExt}`)).data;
  ok(te.assignee_external === 1 && te.can.execute && te.can.submit, 'líder registra a execução em nome do terceirizado');
  ok(!(await felipeLoginCheck())?.can?.execute, 'outro colaborador não executa pelo terceirizado');
  await marcos('PATCH', `/tasks/${tExt}/execution`, { exec_description: 'Alvenaria do 5º pavimento executada pela equipe da Alfa.' });
  await marcos('POST', `/tasks/${tExt}/files`, { kind: 'execucao', images: [{ data: tinyPng() }] });
  te = (await marcos('POST', `/tasks/${tExt}/actions/submit`)).data;
  ok(te.status === 'aguardando_conferencia' && te.history.some(h => h.action === 'Enviada para conferência' && h.details.includes('em nome de José Pedreiro (terceirizado)')), 'histórico registra "em nome de" o terceirizado');
  ok(te.can.review, 'líder (colaborador) pode conferir a entrega do terceirizado sem login');
  ok((await marcos('POST', `/tasks/${tExt}/actions/return`, { comment: 'Faltou a foto do encunhamento.' })).data.status === 'em_andamento', 'líder devolve a entrega do terceirizado');
  await marcos('POST', `/tasks/${tExt}/actions/submit`);
  ok((await marcos('POST', `/tasks/${tExt}/actions/approve`, {})).data.status === 'concluida', 'líder aprova e conclui a entrega do terceirizado');
  const leaderView = (await marcos('GET', `/users/${extId}`)).data;
  ok(leaderView.stats.assigned === 1 && leaderView.stats.done === 1, 'líder avalia o desempenho do terceirizado');
  ok((await marcos('GET', '/users/4')).data.team.some(m => m.id === extId), 'terceirizado aparece na equipe do líder');
  ok((await camila('GET', `/users/${extId}`)).status === 404, 'quem não é líder nem admin não vê o terceirizado');
  ok((await ana('PUT', `/users/${extId}`, { role: 'admin', name: 'José Pedreiro', manager_id: 4 })).status === 200 && (await ana('GET', `/users/${extId}`)).data.user.role === 'colaborador', 'terceirizado não pode virar administrador');
  ok((await ana('PUT', '/users/6', { role: 'terceirizado' })).status === 400, 'usuário interno não é convertido em terceirizado');
  ok((await ana('GET', '/audit')).data.some(a => a.action === 'Terceirizado cadastrado (sem login)'), 'cadastro registrado na auditoria');

  // Com acesso ao sistema: regras de Colaborador
  ok((await ana('POST', '/users', { role: 'terceirizado', name: 'Paulo Gesseiro', login_enabled: true, manager_id: 4, project_ids: [1], password: 'gesso1234' })).status === 400, 'acesso ao sistema exige e-mail');
  ok((await ana('POST', '/users', { role: 'terceirizado', name: 'Paulo Gesseiro', email: 'paulo@gesso.com', login_enabled: true, manager_id: 4, project_ids: [1] })).status === 400, 'acesso ao sistema exige senha');
  const extL = (await ana('POST', '/users', { role: 'terceirizado', name: 'Paulo Gesseiro', email: 'paulo@gesso.com', company: 'Gesso Sul', login_enabled: true, access_scope: 'projetos', manager_id: 4, project_ids: [1], password: 'gesso1234' })).data.id;
  const paulo = await login('paulo@gesso.com', 'gesso1234');
  ok((await paulo('GET', '/projects')).data.map(p => p.code).join() === 'PRJ-001', 'terceirizado com acesso vê só os projetos liberados');
  const tL = (await ricardo('POST', '/tasks', { project_id: 1, title: 'Forro de gesso do hall', description: 'Executar forro', assignee_id: extL, proof_type: 'descricao', due_date: '2099-02-01' })).data.id;
  ok(!(await marcos('GET', `/tasks/${tL}`)).data.can.execute, 'com acesso: o líder não executa em nome dele');
  let tl = (await paulo('GET', `/tasks/${tL}`)).data;
  ok(tl.can.execute && !tl.can.review, 'com acesso: o próprio terceirizado executa e não confere');
  await paulo('PATCH', `/tasks/${tL}/execution`, { exec_description: 'Forro executado.' });
  tl = (await paulo('POST', `/tasks/${tL}/actions/submit`)).data;
  ok(tl.status === 'aguardando_conferencia' && !tl.history.some(h => (h.details || '').includes('em nome de')), 'com acesso: envio registrado pelo próprio terceirizado');
  ok(!(await marcos('GET', `/tasks/${tL}`)).data.can.review, 'com acesso: líder colaborador não confere (regra de Colaborador)');
  ok((await ricardo('POST', `/tasks/${tL}/actions/approve`, {})).data.status === 'concluida', 'com acesso: gestor confere');
  await ana('PUT', `/users/${extL}`, { login_enabled: false });
  ok((await paulo('GET', '/projects')).status === 401 && (await client()('POST', '/auth/login', { email: 'paulo@gesso.com', password: 'gesso1234' })).status === 401, 'desligar o acesso encerra a sessão e bloqueia o login');
  ok((await ana('PUT', `/users/${extId}`, { login_enabled: true, email: 'jose@alfa.com' })).status === 400, 'ligar o acesso exige senha');
  ok((await ana('PUT', `/users/${extId}`, { login_enabled: true, email: 'jose@alfa.com', password: 'jose12345' })).status === 200, 'ligar o acesso na edição');
  ok((await client()('POST', '/auth/login', { email: 'jose@alfa.com', password: 'jose12345' })).data?.user?.must_change_password === 1, 'terceirizado liberado faz login e precisa trocar a senha');

  console.log('Anexos em PDF');
  const pdfData = 'data:application/pdf;base64,' + Buffer.from('%PDF-1.4 1 0 obj<<>>endobj trailer<<>> %%EOF').toString('base64');
  const tPdf = (await ricardo('POST', '/tasks', { project_id: 1, title: 'Laudo de estanqueidade', description: 'Teste da laje', assignee_id: 4, proof_type: 'foto', due_date: '2099-03-01',
    images: [{ data: pdfData, name: 'Projeto impermeabilização.pdf' }] })).data.id;
  let tp = (await marcos('GET', `/tasks/${tPdf}`)).data;
  ok(tp.files.length === 1 && tp.files[0].mime === 'application/pdf' && tp.files[0].original_name === 'Projeto impermeabilização.pdf', 'PDF de referência anexado na criação, com nome original');
  ok(tp.history.some(h => h.action === 'Imagens de referência anexadas' && h.details === '1 PDF'), 'histórico registra o PDF anexado');
  const fakePdf = 'data:application/pdf;base64,' + Buffer.from('<script>alert(1)</script>').toString('base64');
  ok((await marcos('POST', `/tasks/${tPdf}/files`, { kind: 'execucao', images: [{ data: fakePdf, name: 'x.pdf' }] })).status === 400, 'arquivo que não é PDF de verdade é recusado');
  tp = (await marcos('POST', `/tasks/${tPdf}/files`, { kind: 'execucao', images: [{ data: pdfData, name: '../../laudo final.pdf' }] })).data;
  const exPdf = tp.files.find(f => f.kind === 'execucao');
  ok(exPdf?.original_name === 'laudo final.pdf', 'PDF da execução anexado (nome sem caminho)');
  ok(!tp.proof_check.ok && tp.proof_check.missing.includes('foto da execução'), 'PDF não substitui a foto quando a comprovação exige foto');
  tp = (await marcos('POST', `/tasks/${tPdf}/files`, { kind: 'execucao', images: [{ data: tinyPng() }, { data: pdfData, name: 'ART.pdf' }] })).data;
  ok(tp.proof_check.ok && tp.history.some(h => h.details === '1 imagem(ns) e 1 PDF'), 'foto + PDF juntos no mesmo envio');
  const dl = await fetch(`${BASE}/api/files/${exPdf.id}`, { headers: { cookie: await cookieOf('marcos@charao.eng.br') } });
  ok(dl.status === 200 && dl.headers.get('content-type') === 'application/pdf' && /inline; filename=/.test(dl.headers.get('content-disposition') || '') && dl.headers.get('x-content-type-options') === 'nosniff', 'PDF abre no navegador com o nome original');
  const etag = dl.headers.get('etag');
  ok(etag && (await fetch(`${BASE}/api/files/${exPdf.id}`, { headers: { cookie: await cookieOf('marcos@charao.eng.br'), 'if-none-match': etag } })).status === 304, 'navegador revalida o arquivo pelo ETag (sem servir anexo antigo do cache)');
  ok((await camila('GET', `/tasks/${tPdf}`)).status === 404 && (await fetch(`${BASE}/api/files/${exPdf.id}`, { headers: { cookie: await cookieOf('camila@charao.eng.br') } })).status !== 200, 'quem não vê a tarefa não abre o PDF');
  const rp = (await ricardo('GET', `/reports?type=projeto&id=1&level=completo`)).data;
  ok(JSON.stringify(rp).includes('laudo final.pdf'), 'relatório completo lista os PDFs anexados');

  console.log('Relatório da tela Tarefas (filtros aplicados)');
  const lst = (await ricardo('GET', '/tasks?project=1&status=atrasada&status=em_andamento')).data;
  const rtF = (await ricardo('GET', '/reports?type=tarefas&level=detalhado&project=1&status=atrasada,em_andamento')).data;
  ok(rtF.type === 'tarefas' && rtF.summary.total === lst.length && rtF.tasks.map(t => t.id).sort().join() === lst.map(t => t.id).sort().join(), 'relatório traz exatamente as tarefas da lista filtrada');
  ok(rtF.scope.subtitle.includes('Status: Atrasada, Em andamento') && rtF.scope.subtitle.includes('Projeto: PRJ-001'), 'cabeçalho descreve os filtros aplicados');
  const lstMe = (await marcos('GET', '/tasks?assignee=me&due=7d')).data;
  const rtMe = (await marcos('GET', '/reports?type=tarefas&level=resumo&assignee=me&due=7d')).data;
  ok(rtMe.summary.total === lstMe.length && rtMe.scope.subtitle.includes('Responsável: Marcos Silva') && rtMe.scope.subtitle.includes('Próximos 7 dias'), 'filtros "Minhas tarefas" e prazo respeitados');
  const rtAll = (await ricardo('GET', '/reports?type=tarefas&level=resumo')).data;
  ok(rtAll.summary.total === (await ricardo('GET', '/tasks')).data.length && /sem filtros/.test(rtAll.scope.subtitle), 'sem filtros: todas as tarefas visíveis');
  const rtJ = (await juliana('GET', '/reports?type=tarefas&level=detalhado&project=1')).data;
  ok(rtJ.summary.total === 0 && !rtJ.scope.subtitle.includes('PRJ-001'), 'relatório não expõe projeto sem acesso');
  const rtC = (await ricardo('GET', '/reports?type=tarefas&level=detalhado&status=cancelada')).data;
  ok(rtC.tasks.every(t => t.eff_status !== 'cancelada'), 'canceladas não entram no relatório');
  const rtQ = (await ricardo('GET', `/reports?type=tarefas&level=detalhado&q=${encodeURIComponent('alvenaria')}`)).data;
  ok(rtQ.summary.total === (await ricardo('GET', '/tasks?q=alvenaria')).data.length && rtQ.scope.subtitle.includes('Busca'), 'busca por texto vale no relatório');

  console.log('Equipe do projeto libera o acesso (responsáveis)');
  const extT = (await ana('POST', '/users', { role: 'terceirizado', name: 'Carlos Pintor', manager_id: 4, project_ids: [1] })).data.id;
  const pNew = (await ricardo('POST', '/projects', { name: 'Obra Equipe', client: 'Cliente E', member_ids: [5, extT] })).data.id;
  let asg = (await ricardo('GET', `/projects/${pNew}/assignees`)).data.map(u => u.id);
  ok(asg.includes(5) && asg.includes(extT), 'quem é marcado na equipe aparece como responsável (colaborador e terceirizado)');
  ok(!asg.includes(6), 'quem não está na equipe nem tem acesso total não aparece');
  const felipeC = await login('felipe@charao.eng.br');
  ok((await felipeC('GET', '/projects')).data.some(p => p.id === pNew), 'integrante da equipe passa a ver o projeto');
  ok((await ana('GET', '/users/5')).data.user.project_ids.includes(pNew), 'liberação aparece em Usuários → Permissões');
  await ana('PUT', '/users/7', { project_ids: [...(await ana('GET', '/users/7')).data.user.project_ids, pNew] });
  ok((await ricardo('GET', `/projects/${pNew}`)).data.members.some(m => m.id === 7), 'liberação feita em Usuários aparece na equipe do projeto');
  await ricardo('PUT', `/projects/${pNew}`, { member_ids: [extT, 7] });
  asg = (await ricardo('GET', `/projects/${pNew}/assignees`)).data.map(u => u.id);
  ok(!asg.includes(5) && !(await felipeC('GET', '/projects')).data.some(p => p.id === pNew), 'desmarcar da equipe retira a liberação');
  await ricardo('PUT', `/projects/${pNew}`, { name: 'Obra Equipe 2' });
  ok((await ricardo('GET', `/projects/${pNew}/assignees`)).data.some(u => u.id === 7), 'editar o projeto sem mexer na equipe mantém as liberações');
  ok((await ana('GET', '/audit')).data.some(a => a.action === 'Projeto atualizado' && /equipe_e_acesso/.test(JSON.stringify(a.details || a))), 'alteração de equipe/acesso registrada na auditoria');

  console.log('Alocar tarefa para outra pessoa do projeto');
  const tA = (await ricardo('POST', '/tasks', { project_id: 1, title: 'Tarefa para repassar', description: 'x', assignee_id: 4, proof_type: 'nenhuma', due_date: '2099-05-01' })).data.id;
  let ta = (await felipeC('GET', `/tasks/${tA}`)).data;
  ok(ta.can.reassign && !ta.can.edit, 'colaborador do projeto pode alocar a tarefa (sem poder editar o resto)');
  ta = (await felipeC('POST', `/tasks/${tA}/assignee`, { assignee_id: 7, note: 'Bruno assume as instalações' })).data;
  ok(ta.assignee_id === 7 && ta.history.some(h => h.action === 'Responsável alterado' && h.details.includes('Marcos Silva → Bruno Costa') && h.details.includes('Bruno assume')), 'colaborador aloca para outra pessoa do projeto, com histórico');
  ok((await felipeC('POST', `/tasks/${tA}/assignee`, { assignee_id: 3 })).status === 400, 'não aloca para quem não tem acesso ao projeto');
  ok((await felipeC('POST', `/tasks/${tA}/assignee`, { assignee_id: 7 })).status === 400, 'não aloca para quem já é o responsável');
  ok((await camila('POST', `/tasks/${tA}/assignee`, { assignee_id: 5 })).status === 404, 'quem não está no projeto não aloca');
  const brunoC = await login('bruno@charao.eng.br');
  const rb = (await brunoC('POST', `/tasks/${tA}/assignee`, { assignee_id: 4 })).data;
  ok(rb.assignee_name === 'Marcos Silva' && (rb.hidden || rb.assignee_id === 4), 'quem só vê as próprias tarefas pode repassar a sua (e deixa de vê-la sem erro)');
  await marcos('PATCH', `/tasks/${tA}/execution`, { exec_description: 'ok' });
  await marcos('POST', `/tasks/${tA}/actions/submit`);
  ok((await felipeC('POST', `/tasks/${tA}/assignee`, { assignee_id: 5 })).status === 400 && !(await felipeC('GET', `/tasks/${tA}`)).data.can.reassign, 'tarefa entregue para conferência não troca de responsável');

  console.log('Check-list (itens, responsáveis por item, foto obrigatória, conferência)');
  const clBase = { project_id: 1, task_type: 'checklist', title: 'Check-list final de obra — Bloco A', assignee_id: 4, photo_rule: 'obrigatoria', due_date: '2099-06-01' };
  ok((await ricardo('POST', '/tasks', { ...clBase, items: [] })).status === 400, 'check-list exige ao menos um item');
  const ph = () => [{ data: tinyPng() }];
  ok((await ricardo('POST', '/tasks', { ...clBase, items: [{ text: 'X', assignee_id: 6, images: ph() }] })).status === 400, 'responsável do item precisa ter acesso ao projeto');
  const semFoto = await ricardo('POST', '/tasks', { ...clBase, items: [{ text: 'Item sem foto' }] });
  ok(semFoto.status === 400 && /foto de entrada/.test(semFoto.data.error), 'foto obrigatória: item novo precisa da foto de entrada');
  const clR = await ricardo('POST', '/tasks', { ...clBase, items: [
    { group: 'Cozinha', text: 'Tomadas e interruptores funcionando', assignee_id: 7, images: ph(), description: 'Testar todas as tomadas com o testador.', start_date: '2099-05-20', duration_days: 3 },
    { group: 'Cozinha', text: 'Pia sem vazamentos', images: ph() },
    { group: 'Sala', text: 'Pintura sem manchas', assignee_id: 5, images: ph() },
    { group: 'Sala', text: 'Rejunte do piso', assignee_id: extT, images: ph(), start_date: '2020-01-01', duration_days: 2 },
  ] });
  ok(clR.status === 201, 'gestor cria check-list sem descrição, com itens agrupados, responsáveis e fotos de entrada');
  const clId = clR.data.id;
  let cl = (await ricardo('GET', `/tasks/${clId}`)).data;
  ok(cl.task_type === 'checklist' && cl.checklist.items.length === 4 && cl.checklist.photo_rule === 'obrigatoria' && !cl.can.add_subtask, 'check-list com 4 itens, regra de foto e sem subtarefas');
  ok(cl.checklist.items[1].responsible_name === 'Marcos Silva' && cl.checklist.items[0].responsible_name === 'Bruno Costa', 'item sem responsável fica com o responsável global');
  const it0 = cl.checklist.items[0];
  ok(it0.description === 'Testar todas as tomadas com o testador.' && it0.due_date === '2099-05-23' && it0.refs.length === 1 && it0.cover?.id === it0.refs[0].id && !it0.overdue,
    'item com descrição, prazo (início + 3 dias = 23/05) e foto de entrada como capa');
  ok(cl.checklist.items[3].overdue && cl.checklist.summary.overdue === 1, 'item com prazo vencido aparece como atrasado');
  ok(it0.open_nc && it0.nc_count === 1 && cl.checklist.summary.nao_conforme === 4 && cl.checklist.summary.pending === 0 && cl.cl_nc === 4,
    'item cadastrado com foto já é uma não conformidade em aberto');
  ok(!cl.checklist.check.ok && cl.checklist.check.missing.some(m => m.includes('não conformidades em aberto')), 'não conformidades cadastradas bloqueiam o envio até serem corrigidas');
  ok(cl.history.some(h => h.action === 'Check-list criado' && h.details.includes('4 item(ns)')), 'histórico registra a criação do check-list');
  // Bruno só vê as próprias tarefas, mas tem item no check-list
  ok((await brunoC('GET', `/tasks/${clId}`)).status === 200, 'responsável por item vê o check-list (mesmo com escopo só próprias)');
  ok((await brunoC('GET', '/tasks?assignee=me')).data.some(t => t.id === clId), '"Minhas tarefas" inclui o check-list com itens meus');
  ok((await brunoC('GET', '/dashboard')).data.my_checklist.some(c => c.id === clId && c.pending === 1), 'Dashboard avisa os itens pendentes do usuário');
  const [iTom, iPia, iPint, iRej] = cl.checklist.items.map(i => i.id);
  ok((await brunoC('POST', `/tasks/${clId}/items/${iPint}/answer`, { result: 'conforme', images: [{ data: tinyPng() }] })).status === 403, 'não responde item de outro responsável');
  const viewRic = (await ricardo('GET', `/tasks/${clId}`)).data.checklist.items;
  ok(viewRic.every(i => i.can_answer), 'quem gerencia o check-list (gestor que criou) pode responder e incluir fotos em qualquer item');
  ok((await ricardo('POST', `/tasks/${clId}/items/${iPint}/answer`, { images: [{ data: tinyPng() }] })).data.checklist.items.find(i => i.id === iPint).files.length === 1, 'foto incluída no item antes de responder');
  ok((await brunoC('POST', `/tasks/${clId}/items/${iTom}/answer`, { result: 'conforme' })).status === 400, 'foto obrigatória bloqueia resposta sem foto (a foto de entrada não vale como a do depois)');
  cl = (await brunoC('POST', `/tasks/${clId}/items/${iTom}/answer`, { result: 'conforme', images: [{ data: tinyPng() }] })).data;
  ok(cl.checklist.items[0].result === 'conforme' && cl.checklist.items[0].files.length === 1 && cl.checklist.items[0].answered_by_name === 'Bruno Costa' && cl.status === 'em_andamento', 'responsável do item responde com foto (tarefa entra em andamento)');
  ok(cl.checklist.items[0].before?.id === cl.checklist.items[0].refs[0].id && cl.checklist.items[0].after?.id === cl.checklist.items[0].files[0].id, 'Conforme: antes (foto de entrada) × depois (foto da resposta)');
  const refId = cl.checklist.items[0].refs[0].id;
  ok((await ricardo('DELETE', `/tasks/${clId}/items/${iTom}/files/${refId}`)).status === 400, 'não remove a única foto de entrada obrigatória');
  ok((await ricardo('POST', `/tasks/${clId}/items/${iTom}/reference`, { images: ph() })).data.checklist.items[0].refs.length === 2, 'inclui outra foto de entrada no item');
  // Limite de 3 fotos por não conformidade (cadastro) e por resposta
  const four = () => [1, 2, 3, 4].map(() => ({ data: tinyPng() }));
  ok((await ricardo('POST', `/tasks/${clId}/items`, { items: [{ text: 'Muitas fotos', images: four() }] })).status === 400, 'cadastro aceita no máximo 3 fotos por item');
  ok((await ricardo('POST', `/tasks/${clId}/items/${iTom}/reference`, { images: [{ data: tinyPng() }, { data: tinyPng() }] })).status === 400, 'fotos de entrada: 2 + 2 passa do limite de 3');
  ok((await ricardo('POST', `/tasks/${clId}/items/${iTom}/reference`, { images: ph() })).data.checklist.items[0].refs.length === 3, 'fotos de entrada: completa as 3');
  ok((await ricardo('POST', `/tasks/${clId}/items/${iTom}/reference`, { images: ph() })).status === 400, 'fotos de entrada: a 4ª é recusada');
  ok((await brunoC('POST', `/tasks/${clId}/items/${iTom}/answer`, { images: [{ data: tinyPng() }, { data: tinyPng() }, { data: tinyPng() }] })).status === 400, 'correção já com 1 foto não aceita mais 3');
  ok((await brunoC('POST', `/tasks/${clId}/items/${iTom}/answer`, { images: [{ data: 'data:application/pdf;base64,' + Buffer.from('%PDF-1.4 x %%EOF').toString('base64') }] })).status === 400, 'item do check-list aceita só fotos');
  const clFileId = cl.checklist.items[0].files[0].id;
  ok((await brunoC('DELETE', `/tasks/${clId}/items/${iTom}/files/${clFileId}`)).status === 400, 'não remove a única foto obrigatória de item respondido');
  ok((await brunoC('POST', `/tasks/${clId}/items/${iTom}/answer`, { result: 'nao_conforme', images: [{ data: tinyPng() }] })).status === 400, 'alterar item que estava Conforme exige justificativa');
  cl = (await brunoC('POST', `/tasks/${clId}/items/${iTom}/answer`, { result: 'nao_conforme', reason: 'Tomada da bancada sem energia', note: 'Tomada da bancada sem energia', images: [{ data: tinyPng() }] })).data;
  let itTom = cl.checklist.items.find(i => i.id === iTom);
  ok(itTom.result === 'nao_conforme' && !itTom.resolved && itTom.open_nc && itTom.nc_count === 2 && itTom.cover && cl.history.some(h => h.action === 'Resposta de item alterada' && h.details.includes('Justificativa: Tomada')),
    'Conforme → Não conforme com justificativa: item volta a ficar pendente, conta 2x (cadastro + nova) e a capa é a foto do problema');
  ok((await brunoC('POST', `/tasks/${clId}/items/${iTom}/answer`, { images: [{ data: tinyPng() }, { data: tinyPng() }] })).data.checklist.items.find(i => i.id === iTom).files.length === 3, 'não conformidade completa 3 fotos');
  ok((await brunoC('POST', `/tasks/${clId}/items/${iTom}/answer`, { images: [{ data: tinyPng() }] })).status === 400, 'não conformidade: a 4ª foto é recusada');
  ok((await brunoC('POST', `/tasks/${clId}/items/${iTom}/answer`, { result: 'conforme', images: four() })).status === 400, 'correção com 4 fotos é recusada');
  ok((await brunoC('POST', `/tasks/${clId}/items/${iTom}/answer`, { result: 'conforme' })).status === 400, 'a correção (depois) também exige foto nova');
  cl = (await brunoC('POST', `/tasks/${clId}/items/${iTom}/answer`, { result: 'conforme', images: [{ data: tinyPng() }] })).data;
  itTom = cl.checklist.items.find(i => i.id === iTom);
  ok(itTom.resolved && !itTom.open_nc && itTom.before && itTom.after && itTom.before.id !== itTom.after.id && itTom.history.length === 4 && itTom.history[0].registration && itTom.nc_count === 2,
    'corrigido: antes (não conformidade) × depois (conforme) e histórico com o cadastro + 3 respostas');
  ok((await felipeC('POST', `/tasks/${clId}/items/${iPint}/answer`, { result: 'na' })).status === 200, 'N/A não exige foto');
  cl = (await marcos('POST', `/tasks/${clId}/items/${iPia}/answer`, { result: 'nao_conforme', note: 'Sifão gotejando', images: [{ data: tinyPng() }] })).data;
  ok(cl.checklist.items[1].result === 'nao_conforme' && cl.checklist.items[1].note === 'Sifão gotejando', 'responsável global responde item sem responsável, com observação');
  ok(!cl.checklist.check.ok && (await marcos('POST', `/tasks/${clId}/actions/submit`)).status === 400, 'envio bloqueado com item sem resposta');
  cl = (await marcos('POST', `/tasks/${clId}/items/${iRej}/answer`, { result: 'conforme', images: [{ data: tinyPng() }] })).data;
  ok(cl.history.some(h => h.action === 'Item do check-list respondido' && h.details.includes('em nome de Carlos Pintor')), 'líder responde o item do terceirizado sem acesso (histórico "em nome de")');
  ok((await felipeC('POST', `/tasks/${clId}/items`, { items: [{ text: 'Novo' }] })).status === 403, 'responsável só de itens não altera a lista do check-list');
  cl = (await marcos('PATCH', `/tasks/${clId}/items/${iPia}`, { text: 'Pia e sifão sem vazamentos', group: 'Cozinha' })).data;
  ok(cl.checklist.items.find(i => i.id === iPia).text === 'Pia e sifão sem vazamentos' && cl.history.some(h => h.action === 'Item do check-list alterado'), 'responsável global edita o texto do item');
  cl = (await marcos('PATCH', `/tasks/${clId}/items/${iPia}`, { description: 'Verificar sifão e flexíveis', start_date: '2099-06-01', duration_days: 4 })).data;
  ok(cl.checklist.items.find(i => i.id === iPia).due_date === '2099-06-05' && cl.checklist.items.find(i => i.id === iPia).description === 'Verificar sifão e flexíveis', 'edita descrição e prazo do item (início + dias)');
  cl = (await marcos('PATCH', `/tasks/${clId}/items/${iPia}`, { start_date: '2099-06-01', due_date: '2099-06-10' })).data;
  ok(cl.checklist.items.find(i => i.id === iPia).due_date === '2099-06-10', 'edita o prazo pela data de término');
  ok((await marcos('PATCH', `/tasks/${clId}/items/${iPia}`, { start_date: '2099-06-10', due_date: '2099-06-01' })).status === 400, 'término antes do início é recusado');
  // Especialidades: modelos em Configurações, escolhidos por obra; o item guarda o nome
  const tpls = (await ricardo('GET', '/settings/specialties')).data;
  ok(tpls.length >= 1 && tpls[0].items.includes('Louças e Metais'), 'modelo padrão de especialidades cadastrado');
  ok((await marcos('PUT', '/settings/specialties', { templates: [] })).status === 403, 'colaborador não altera os modelos de especialidades');
  const keepTpls = tpls.map(x => ({ id: x.id, name: x.name, items: x.items }));
  let spSaved = (await ricardo('PUT', '/settings/specialties', { templates: [...keepTpls, { name: 'Instalações', items: ['Hidráulica', 'Elétrica', ' elétrica ', ''] }] })).data;
  const inst = spSaved.find(x => x.name === 'Instalações');
  ok(inst && inst.items.join('|') === 'Hidráulica|Elétrica', 'novo modelo criado sem linhas vazias nem repetidas');
  ok((await ricardo('PUT', '/settings/specialties', { templates: [...keepTpls, { name: 'Vazio', items: [' '] }] })).status === 400, 'modelo precisa de ao menos uma especialidade');
  const clProj = cl.project_id;
  let meta = (await ricardo('GET', '/meta')).data.projects.find(x => x.id === clProj);
  ok(meta.specialty_template_id === tpls[0].id && meta.specialties.includes('Pintura'), 'obra com modelo: especialidades disponíveis no cadastro dos itens');
  ok((await ricardo('PUT', '/settings/specialties', { templates: [{ id: inst.id, name: inst.name, items: inst.items }] })).status === 400, 'modelo em uso numa obra não pode ser excluído');
  cl = (await marcos('PATCH', `/tasks/${clId}/items/${iPia}`, { specialty: 'Louças e Metais' })).data;
  ok(cl.checklist.items.find(i => i.id === iPia).specialty === 'Louças e Metais' && cl.history.some(h => h.details?.includes('especialidade: Louças e Metais')), 'especialidade do item alterada e registrada no histórico');
  cl = (await ricardo('POST', `/tasks/${clId}/items`, { items: [{ group: 'Cozinha', specialty: 'Elétrica', text: 'Disjuntores identificados', images: ph() }] })).data;
  const iDisj = cl.checklist.items.find(i => i.text === 'Disjuntores identificados');
  ok(iDisj?.specialty === 'Elétrica', 'item novo com especialidade');
  cl = (await ricardo('DELETE', `/tasks/${clId}/items/${iDisj.id}`)).data;
  ok((await ricardo('PUT', `/projects/${clProj}`, { specialty_template_id: 99999 })).status === 400, 'modelo inexistente é recusado no projeto');
  ok((await ricardo('PUT', `/projects/${clProj}`, { specialty_template_id: inst.id })).status === 200, 'obra troca o modelo de especialidades');
  meta = (await ricardo('GET', '/meta')).data.projects.find(x => x.id === clProj);
  const clAfter = (await ricardo('GET', `/tasks/${clId}`)).data;
  ok(meta.specialties.join('|') === 'Hidráulica|Elétrica' && clAfter.checklist.items.find(i => i.id === iPia).specialty === 'Louças e Metais', 'trocar o modelo não altera os itens já cadastrados');
  await ricardo('PUT', `/projects/${clProj}`, { specialty_template_id: tpls[0].id });
  spSaved = (await ricardo('PUT', '/settings/specialties', { templates: keepTpls })).data;
  ok(spSaved.length === tpls.length, 'modelo sem uso pode ser excluído');
  // Modelos de classificação (Grupo/Local/Etapa): cadastrados em Configurações e copiados no projeto
  const stTpls = (await ricardo('GET', '/settings/stage-templates')).data;
  ok(stTpls.length >= 2 && stTpls[0].items.includes('Fundação'), 'modelos de classificação padrão cadastrados');
  ok((await marcos('PUT', '/settings/stage-templates', { templates: [] })).status === 403, 'colaborador não altera os modelos de classificação');
  const stKeep = stTpls.map(x => ({ id: x.id, name: x.name, items: x.items }));
  let stSaved = (await ricardo('PUT', '/settings/stage-templates', { templates: [...stKeep, { name: 'Torres', items: ['Torre A', 'Torre B', 'torre a'] }] })).data;
  ok(stSaved.find(x => x.name === 'Torres')?.items.join('|') === 'Torre A|Torre B', 'novo modelo de classificação (sem repetidos)');
  ok((await ricardo('PUT', '/settings/stage-templates', { templates: [...stKeep, { name: 'Etapas de obra — PADRÃO', items: ['X'] }] })).status === 400, 'nome de modelo repetido é recusado');
  stSaved = (await ricardo('PUT', '/settings/stage-templates', { templates: stKeep })).data;
  ok(stSaved.length === stTpls.length, 'modelo de classificação pode ser excluído (projetos guardam a própria lista)');
  ok((await ricardo('POST', `/tasks/${clId}/items`, { items: [{ group: 'Área externa', text: 'Calçada limpa' }] })).status === 400, 'item incluído depois também exige foto de entrada');
  cl = (await ricardo('POST', `/tasks/${clId}/items`, { items: [{ group: 'Área externa', text: 'Calçada limpa', images: ph(), start_date: '2099-07-01', due_date: '2099-07-04' }] })).data;
  ok(cl.checklist.items.find(i => i.text === 'Calçada limpa').due_date === '2099-07-04', 'item novo com data de início e de término');
  const iCal = cl.checklist.items.find(i => i.text === 'Calçada limpa').id;
  ok(cl.checklist.items.length === 5, 'gestor adiciona item depois de criado');
  cl = (await ricardo('POST', `/tasks/${clId}/items`, { items: [{ group: 'Cozinha', text: 'Exaustor funcionando', images: ph() }] })).data;
  const seqOrder = cl.checklist.items.map(i => `${i.seq}:${i.group}`).join(',');
  ok(cl.checklist.items.findIndex(i => i.text === 'Exaustor funcionando') === 2 && cl.checklist.items.every((i, k) => i.seq === k + 1), `item novo entra no fim do próprio grupo e a numeração segue em ordem (${seqOrder})`);
  const iExa = cl.checklist.items.find(i => i.text === 'Exaustor funcionando').id;
  cl = (await ricardo('PATCH', `/tasks/${clId}/items/${iExa}`, { group: 'Área externa' })).data;
  ok(cl.checklist.items.at(-1).id === iExa && cl.checklist.items.every((i, k) => i.seq === k + 1), 'trocar o grupo move o item para o fim do novo grupo');
  await ricardo('DELETE', `/tasks/${clId}/items/${iExa}`);
  cl = (await ricardo('POST', `/tasks/${clId}/items/assign`, { item_ids: [iCal], assignee_id: 5 })).data;
  ok(cl.checklist.items.find(i => i.id === iCal).assignee_id === 5, 'atribui responsável a itens em lote');
  ok((await ricardo('DELETE', `/tasks/${clId}/items/${iTom}`)).status === 400, 'item respondido não pode ser excluído');
  ok((await felipeC('POST', `/tasks/${clId}/items/${iCal}/answer`, { result: 'conforme', images: [{ data: tinyPng() }] })).status === 200, 'novo responsável responde o item atribuído');
  ok((await fetch(`${BASE}/api/checklist-files/${clFileId}`, { headers: { cookie: await cookieOf('bruno@charao.eng.br') } })).status === 200
    && (await fetch(`${BASE}/api/checklist-files/${clFileId}`, { headers: { cookie: await cookieOf('camila@charao.eng.br') } })).status === 404, 'foto do item só abre para quem vê o check-list');
  const byType = (await ricardo('GET', '/tasks?tipo=checklist')).data;
  ok(byType.every(t => t.task_type === 'checklist') && byType.some(t => t.id === clId), 'filtro por tipo Check-list');
  ok((await ana('GET', `/tasks/${clId}`)).data.can.delete === false, 'check-list com itens respondidos não pode ser excluído definitivamente');
  ok((await marcos('POST', `/tasks/${clId}/actions/submit`)).status === 400 && (await marcos('GET', `/tasks/${clId}`)).data.checklist.check.missing.some(m => m.includes('não conformidade')), 'não conformidade em aberto bloqueia o envio');
  await marcos('POST', `/tasks/${clId}/items/${iPia}/answer`, { result: 'conforme', images: [{ data: tinyPng() }] });
  cl = (await marcos('POST', `/tasks/${clId}/actions/submit`)).data;
  ok(cl.status === 'aguardando_conferencia' && cl.cl_total === 5 && cl.cl_done === 5 && cl.cl_nc === 0 && cl.checklist.summary.nc_total === 7, `tudo Conforme/N/A: vai para conferência, guardando as não conformidades no histórico (5 cadastradas com foto + 2 respondidas = ${cl.checklist.summary.nc_total})`);
  ok((await brunoC('POST', `/tasks/${clId}/items/${iTom}/answer`, { result: 'na' })).status === 400, 'depois de entregue os itens não mudam');
  ok((await ricardo('POST', `/tasks/${clId}/actions/approve`, {})).data.status === 'concluida', 'gestor confere e conclui o check-list');
  const clLivre = (await ricardo('POST', '/tasks', { ...clBase, photo_rule: 'livre', items: [{ text: 'Item livre' }] })).data.id;
  const il = (await ricardo('GET', `/tasks/${clLivre}`)).data.checklist.items[0].id;
  ok((await marcos('POST', `/tasks/${clLivre}/items/${il}/answer`, { result: 'conforme' })).status === 200, 'foto livre: responde sem foto');
  // Dashboard: cada item do check-list conta como subtarefa nos indicadores
  const d0 = (await ricardo('GET', '/dashboard')).data;
  const clK = (await ricardo('POST', '/tasks', { ...clBase, photo_rule: 'livre', assignee_id: 5, items: [
    { text: 'Item atrasado', start_date: '2020-01-01', due_date: '2020-01-05' }, { text: 'Item em dia' }, { text: 'Item resolvido' }] })).data.id;
  const iRes = (await ricardo('GET', `/tasks/${clK}`)).data.checklist.items[2].id;
  await ricardo('POST', `/tasks/${clK}/items/${iRes}/answer`, { result: 'conforme' });
  const d1 = (await ricardo('GET', '/dashboard')).data;
  ok(d1.summary.total === d0.summary.total + 4 && d1.checklist_items >= 3, `dashboard soma o check-list e os 3 itens como subtarefas (${d0.summary.total} → ${d1.summary.total})`);
  ok(d1.summary.late === d0.summary.late + 1 && d1.summary.done === d0.summary.done + 1, 'item vencido conta como atrasado e item Conforme como concluído');
  ok(d1.users.find(u => u.id === 5)?.stats.assigned > (d0.users.find(u => u.id === 5)?.stats.assigned || 0), 'itens entram no desempenho do responsável');
  const cd = d1.checklists.find(c => c.id === clK);
  ok(cd && cd.total === 3 && cd.resolved === 1 && cd.pending === 2 && cd.overdue === 1 && cd.pct === 33, 'Dashboard: situação de cada check-list (itens, concluídos, sem resposta, atrasados)');
  const cdNc = d1.checklists.find(c => c.id === clId);
  ok(cdNc && cdNc.nc_resolved === 5 && cdNc.nc_open === 0 && cdNc.eff_status === 'concluida', 'Dashboard: não conformidades resolvidas do check-list concluído');
  ok((await ricardo('GET', '/projects/1')).data.checklists.some(c => c.id === clK), 'página do projeto traz a seção de check-lists');
  const felipeCl = (await ricardo('GET', '/users/5')).data.checklists;
  const fk = felipeCl.find(c => c.id === clK);
  ok(fk && fk.user_global && fk.user_items === 3 && fk.user_open === 2 && felipeCl.some(c => c.id === clId && !c.user_global && c.user_items >= 1),
    'página do usuário: check-lists como responsável global e com itens próprios (itens da pessoa e pendentes)');

  console.log('Perfil Coordenador (gestor que também aprova as próprias tarefas)');
  const coordId = (await ana('POST', '/users', { name: 'Carla Coordenadora', email: 'carla@charao.eng.br', role: 'coordenador', access_scope: 'projetos', project_ids: [1], password: 'coord1234' })).data.id;
  ok((await ana('GET', `/users/${coordId}`)).data.user.role === 'coordenador', 'administrador cadastra o perfil Coordenador');
  const membroId = (await ana('POST', '/users', { name: 'Diego Equipe', email: 'diego@charao.eng.br', role: 'colaborador', access_scope: 'projetos', project_ids: [1], password: 'diego1234', manager_id: coordId })).data.id;
  ok((await ana('GET', `/users/${membroId}`)).data.user.manager_id === coordId, 'coordenador pode ser gestor direto de uma equipe');
  const carla = await login('carla@charao.eng.br', 'coord1234');
  const meCoord = (await carla('GET', '/meta')).data;
  ok(meCoord?.can?.manage_projects === true, 'coordenador tem as permissões de gestão (projetos)');
  ok((await carla('GET', '/users/directory')).status === 200, 'coordenador acessa o diretório de usuários (como o gestor)');
  const thr = (await carla('GET', '/settings/general')).data.chronic_reschedule_threshold;
  ok((await carla('PUT', '/settings/general', { chronic_reschedule_threshold: thr })).status === 200, 'coordenador altera as configurações (como o gestor)');
  // Própria tarefa: executa, envia e aprova
  const tOwn = (await carla('POST', '/tasks', { project_id: 1, title: 'Vistoria do coordenador', description: 'Vistoria', assignee_id: coordId, proof_type: 'descricao', due_date: '2099-04-01' })).data.id;
  await carla('PATCH', `/tasks/${tOwn}/execution`, { exec_description: 'Vistoria realizada.' });
  let tc = (await carla('POST', `/tasks/${tOwn}/actions/submit`)).data;
  ok(tc.status === 'aguardando_conferencia' && tc.can.review, 'coordenador pode conferir a própria entrega');
  ok((await carla('POST', `/tasks/${tOwn}/actions/approve`, {})).data.status === 'concluida', 'coordenador aprova a própria tarefa');
  // Tarefa da equipe
  const diego = await login('diego@charao.eng.br', 'diego1234');
  const tTeam = (await carla('POST', '/tasks', { project_id: 1, title: 'Tarefa do Diego', description: 'x', assignee_id: membroId, proof_type: 'descricao', due_date: '2099-04-02' })).data.id;
  await diego('PATCH', `/tasks/${tTeam}/execution`, { exec_description: 'Feito.' });
  await diego('POST', `/tasks/${tTeam}/actions/submit`);
  ok(!(await diego('GET', `/tasks/${tTeam}`)).data.can.review, 'colaborador continua sem conferir a própria entrega');
  ok((await carla('POST', `/tasks/${tTeam}/actions/approve`, {})).data.status === 'concluida', 'coordenador aprova a tarefa da equipe');
  // Gestor continua sem aprovar a própria
  const tGest = (await ricardo('POST', '/tasks', { project_id: 1, title: 'Tarefa do gestor', description: 'x', assignee_id: 2, proof_type: 'descricao', due_date: '2099-04-03' })).data.id;
  await ricardo('PATCH', `/tasks/${tGest}/execution`, { exec_description: 'Feito.' });
  const tg = (await ricardo('POST', `/tasks/${tGest}/actions/submit`)).data;
  ok(!tg.can.review && (await ricardo('POST', `/tasks/${tGest}/actions/approve`, {})).status === 403, 'gestor continua sem aprovar a própria tarefa');
  ok((await carla('GET', '/projects')).data.every(p => p.id === 1 || p.lead_id === coordId), 'coordenador respeita a restrição por projeto');

  console.log('Administração de usuários');
  const nu = await ana('POST', '/users', { name: 'Novo Teste', email: 'novo@teste.com', role: 'colaborador', access_scope: 'projetos', project_ids: [3], password: 'senha1234', manager_id: 2 });
  ok(nu.status === 201, 'admin cria usuário com acesso restrito');
  const novo = await login('novo@teste.com', 'senha1234');
  ok((await novo('GET', '/projects')).data.map(p => p.code).join() === 'PRJ-003', 'novo usuário vê apenas o projeto liberado');
  await ana('PUT', `/users/${nu.data.id}`, { project_ids: [3, 1] });
  ok((await novo('GET', '/projects')).status === 401, 'alteração de permissão encerra sessão ativa');
  ok((await ana('PUT', '/users/2', { manager_id: 4 })).status === 400, 'hierarquia circular é recusada');
  ok((await ana('PUT', '/users/1', { role: 'gestor' })).status === 400, 'sistema mantém ao menos um administrador');
  const audit = (await ana('GET', '/audit')).data;
  ok(audit.some(a => a.action === 'Permissões alteradas') && audit.some(a => a.action === 'Falha de login'), 'auditoria registra permissões e falhas de login');
}

main()
  .catch(e => { failed++; console.error(e); })
  .finally(() => {
    server.kill();
    setTimeout(() => fs.rmSync(DATA_DIR, { recursive: true, force: true }), 300);
    console.log(`\n${passed} passaram, ${failed} falharam`);
    process.exitCode = failed ? 1 : 0;
  });
