// Testes de API ponta a ponta (fluxos e permissões). Usa um banco temporário — não altera os dados reais.
// Uso: npm test
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { writeXlsx } from '../server/lib/xlsx-write.js';
import { readXlsx } from '../server/lib/xlsx.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'charao-test-'));
const PORT = 3999;
const BASE = `http://localhost:${PORT}`;
const PW = 'charao2026'; // senha das contas de demonstração (server/seed.js)
const env = { ...process.env, DATA_DIR, PORT: String(PORT), HOLIDAYS_OFFLINE: '1' };
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
const r2t = v => Math.round(v * 100) / 100;
function tinyPng() {
  const crc = buf => { let c, crc = 0xffffffff; for (const b of buf) { c = (crc ^ b) & 0xff; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crc = (crc >>> 8) ^ c; } return (crc ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(2, 0); ihdr.writeUInt32BE(2, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.from([0, 255, 0, 0, 0, 255, 0, 0, 0, 0, 255, 255, 255, 255]);
  const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
  return 'data:image/png;base64,' + png.toString('base64');
}

let felipeLoginCheck;
// Tarefa sem data de início: avanço, envio e conclusão exigem informar o início (testes enviam uma data passada)
const SD = { start_date: '2020-01-01' };

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
  ok((await marcos('POST', `/tasks/${tid}/actions/submit`, SD)).status === 400, 'envio bloqueado sem comprovação exigida');
  await marcos('PATCH', `/tasks/${tid}/execution`, { exec_description: 'Armação conferida e liberada.', exec_notes: 'Sem pendências.' });
  t = (await marcos('GET', `/tasks/${tid}`)).data;
  ok(t.status === 'em_andamento', 'registro de execução inicia a tarefa automaticamente');
  const bad = await marcos('POST', `/tasks/${tid}/files`, { kind: 'execucao', images: [{ data: 'data:image/png;base64,' + Buffer.from('<svg></svg>').toString('base64') }] });
  ok(bad.status === 400, 'arquivo que não é imagem real é rejeitado');
  ok((await marcos('POST', `/tasks/${tid}/files`, { kind: 'execucao', images: [{ data: tinyPng() }] })).status === 200, 'responsável envia foto da execução');
  ok((await marcos('POST', `/tasks/${tid}/actions/approve`)).status === 403, 'responsável não confere a própria entrega');
  ok((await marcos('POST', `/tasks/${tid}/actions/submit`, SD)).data.status === 'aguardando_conferencia', 'enviada para conferência');
  ok((await ricardo('POST', `/tasks/${tid}/actions/return`, {})).status === 400, 'devolução exige motivo');
  ok((await ricardo('POST', `/tasks/${tid}/actions/return`, { comment: 'Ajustar foto' })).data.status === 'em_andamento', 'gestor devolve para ajustes');
  await marcos('POST', `/tasks/${tid}/actions/submit`, SD);
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
  ok((await marcos('POST', `/tasks/${mother}/actions/submit`, SD)).status >= 400 && m.can.auto_from_subtasks && !m.can.start && !m.can.progress, 'principal não vai para conferência com subtarefas pendentes (status e avanço pelas subtarefas)');
  ok((await ricardo('POST', `/tasks/${mother}/actions/conclude`, SD)).status >= 400, 'principal não é concluída com subtarefas pendentes');
  const fel = await login('felipe@charao.eng.br');
  ok((await fel('POST', `/tasks/${s1.id}/actions/submit`, SD)).status === 400, 'subtarefa exige a própria comprovação');
  await fel('POST', `/tasks/${s1.id}/files`, { kind: 'execucao', images: [{ data: tinyPng() }] });
  ok((await fel('POST', `/tasks/${s1.id}/actions/submit`, SD)).data.status === 'aguardando_conferencia', 'subtarefa segue o fluxo de execução e conferência');
  m = (await ricardo('GET', `/tasks/${mother}`)).data;
  ok(m.status === 'em_andamento' && m.progress_pct === 50, 'principal em andamento e avanço pela média das subtarefas (50%)');
  await ricardo('POST', `/tasks/${s1.id}/actions/approve`, SD);
  await marcos('POST', `/tasks/${s2}/actions/submit`, SD);
  await ricardo('POST', `/tasks/${s2}/actions/approve`, SD);
  m = (await ricardo('GET', `/tasks/${mother}`)).data;
  ok(m.sub_done === 2 && m.history.filter(h => h.action === 'Subtarefa concluída').length === 2, 'conclusão das subtarefas registrada na principal');
  ok(m.status === 'aguardando_conferencia' && m.progress_pct === 100 && m.history.some(h => h.details === 'Automático: todas as subtarefas foram concluídas'), 'principal vai sozinha para conferência quando todas as subtarefas são concluídas');
  await ricardo('POST', `/tasks/${mother}/actions/approve`, SD);
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
  await ricardo('POST', `/tasks/${tReal}/actions/submit`, SD); // responsável = Ricardo (mk)
  x = (await ricardo('GET', `/tasks/${tReal}`)).data;
  ok(x.on_time === true && x.on_time_original === false, 'entrega no prazo repactuado, mas fora do prazo original');
  ok((await ricardo('GET', '/tasks?due=ja_atrasadas')).data.some(t => t.id === tCorr) && !(await ricardo('GET', '/tasks?due=ja_atrasadas')).data.some(t => t.id === tPrev), 'filtro "ficaram atrasadas"');
  ok((await ricardo('GET', '/tasks?due=corretivas')).data.every(t => t.reschedules_corrective > 0), 'filtro "repactuadas após atraso"');
  ok((await ricardo('GET', '/tasks?due=cronicas')).data.some(t => t.id === tChr), 'filtro "crônicas"');
  // Concluída com atraso: entrega após o prazo vigente
  const tLateDone = await mk('Concluída com atraso', '2020-05-01');
  await ricardo('POST', `/tasks/${tLateDone}/actions/conclude`, SD);
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
  await ricardo('POST', `/tasks/${cS2}/actions/conclude`, SD);
  await ricardo('POST', `/tasks/${cP}/cancel`, { reason: 'Etapa eliminada do projeto' });
  ok((await ricardo('GET', `/tasks/${cS1}`)).data.cancelled_at && !(await ricardo('GET', `/tasks/${cS2}`)).data.cancelled_at, 'cancelar a principal cancela as subtarefas não concluídas');
  ok((await ricardo('POST', `/tasks/${cS1}/reactivate`, {})).status === 400, 'subtarefa só reativa com a principal ativa');
  // Subtarefa cancelada não trava a conclusão da principal
  const cP2 = await mkC('Principal 2', { due_date: '2099-01-01' });
  const cS3 = (await ricardo('POST', '/tasks', { parent_id: cP2, title: 'Sub 3', description: 'Sub 3' })).data.id;
  await ricardo('POST', `/tasks/${cS3}/cancel`, { reason: 'Não será mais necessária' });
  ok((await ricardo('POST', `/tasks/${cP2}/actions/conclude`, SD)).data.status === 'concluida', 'subtarefa cancelada não impede concluir a principal');
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
  ok(nInt.status === 201 && nIntD.code === 'INT-004' && nIntD.client === 'Charão Engenharia e Construção', 'nova área interna sem cliente (INT-004; INT-002 Contratos e INT-003 Financeiro são áreas restritas)');
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
  te = (await marcos('POST', `/tasks/${tExt}/actions/submit`, SD)).data;
  ok(te.status === 'aguardando_conferencia' && te.history.some(h => h.action === 'Enviada para conferência' && h.details.includes('em nome de José Pedreiro (terceirizado)')), 'histórico registra "em nome de" o terceirizado');
  ok(te.can.review, 'líder (colaborador) pode conferir a entrega do terceirizado sem login');
  ok((await marcos('POST', `/tasks/${tExt}/actions/return`, { comment: 'Faltou a foto do encunhamento.' })).data.status === 'em_andamento', 'líder devolve a entrega do terceirizado');
  await marcos('POST', `/tasks/${tExt}/actions/submit`, SD);
  ok((await marcos('POST', `/tasks/${tExt}/actions/approve`, SD)).data.status === 'concluida', 'líder aprova e conclui a entrega do terceirizado');
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
  tl = (await paulo('POST', `/tasks/${tL}/actions/submit`, SD)).data;
  ok(tl.status === 'aguardando_conferencia' && !tl.history.some(h => (h.details || '').includes('em nome de')), 'com acesso: envio registrado pelo próprio terceirizado');
  ok(!(await marcos('GET', `/tasks/${tL}`)).data.can.review, 'com acesso: líder colaborador não confere (regra de Colaborador)');
  ok((await ricardo('POST', `/tasks/${tL}/actions/approve`, SD)).data.status === 'concluida', 'com acesso: gestor confere');
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
  await marcos('POST', `/tasks/${tA}/actions/submit`, SD);
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
  ok(it0.open_nc && it0.nc_count === 1 && cl.checklist.summary.nao_conforme === 4 && cl.checklist.summary.pending === 4 && cl.cl_nc === 4,
    'item cadastrado já é uma não conformidade em aberto (ainda não verificada)');
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
  ok(!cl.checklist.check.ok && (await marcos('POST', `/tasks/${clId}/actions/submit`, SD)).status === 400, 'envio bloqueado com item sem resposta');
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
  ok((await marcos('POST', `/tasks/${clId}/actions/submit`, SD)).status === 400 && (await marcos('GET', `/tasks/${clId}`)).data.checklist.check.missing.some(m => m.includes('não conformidade')), 'não conformidade em aberto bloqueia o envio');
  await marcos('POST', `/tasks/${clId}/items/${iPia}/answer`, { result: 'conforme', images: [{ data: tinyPng() }] });
  cl = (await marcos('POST', `/tasks/${clId}/actions/submit`, SD)).data;
  ok(cl.status === 'aguardando_conferencia' && cl.cl_total === 5 && cl.cl_done === 5 && cl.cl_nc === 0 && cl.checklist.summary.nc_total === 7, `tudo Conforme/N/A: vai para conferência, guardando as não conformidades no histórico (5 cadastradas com foto + 2 respondidas = ${cl.checklist.summary.nc_total})`);
  ok((await brunoC('POST', `/tasks/${clId}/items/${iTom}/answer`, { result: 'na' })).status === 400, 'depois de entregue os itens não mudam');
  ok((await ricardo('POST', `/tasks/${clId}/actions/approve`, SD)).data.status === 'concluida', 'gestor confere e conclui o check-list');
  const clLivre = (await ricardo('POST', '/tasks', { ...clBase, photo_rule: 'livre', items: [{ text: 'Item livre' }] })).data.id;
  const clLivreView = (await ricardo('GET', `/tasks/${clLivre}`)).data;
  const il = clLivreView.checklist.items[0].id;
  ok(clLivreView.checklist.items[0].open_nc && clLivreView.checklist.items[0].nc_count === 1 && clLivreView.cl_nc === 1
    && clLivreView.checklist.items[0].history[0]?.registration, 'item cadastrado sem foto também é não conformidade (registrada no histórico do item)');
  ok((await marcos('POST', `/tasks/${clLivre}/items/${il}/answer`, { result: 'conforme' })).status === 200, 'foto livre: responde sem foto');
  // Dashboard: cada item do check-list conta como subtarefa nos indicadores
  const d0 = (await ricardo('GET', '/dashboard')).data;
  const clK = (await ricardo('POST', '/tasks', { ...clBase, photo_rule: 'livre', assignee_id: 5, items: [
    { text: 'Item atrasado', start_date: '2020-01-01', due_date: '2020-01-05' }, { text: 'Item em dia' }, { text: 'Item resolvido' }] })).data.id;
  const iRes = (await ricardo('GET', `/tasks/${clK}`)).data.checklist.items[2].id;
  await ricardo('POST', `/tasks/${clK}/items/${iRes}/answer`, { result: 'conforme' });
  const d1 = (await ricardo('GET', '/dashboard')).data;
  ok(d1.summary.total === d0.summary.total + 4 && d1.checklist_items >= 3, `dashboard soma o check-list e os 3 itens como subtarefas (${d0.summary.total} → ${d1.summary.total})`);
  ok(d1.summary.late === d0.summary.late + 3 && d1.summary.done === d0.summary.done + 1, `atrasados: o item vencido, o item sem prazo próprio (segue o do check-list) e o próprio check-list; item Conforme concluído (late ${d0.summary.late}→${d1.summary.late}, done ${d0.summary.done}→${d1.summary.done})`);
  // Prazo do check-list acompanha o maior prazo dos itens
  let ck = (await ricardo('GET', `/tasks/${clK}`)).data;
  ok(ck.due_date === '2020-01-05' && ck.can.due_from_items && !ck.can.reschedule, 'check-list criado com o prazo do item mais longo (sem reagendamento manual)');
  const iEmDia = ck.checklist.items[1].id;
  ck = (await ricardo('PATCH', `/tasks/${clK}/items/${iEmDia}`, { start_date: '2099-03-01', due_date: '2099-03-20' })).data;
  ok(ck.due_date === '2099-03-20' && ck.history.some(h => h.action === 'Prazo do check-list ajustado' && h.details.includes('20/03/2099')), 'prazo do item maior: prazo do check-list acompanha e fica no histórico');
  ok((await ricardo('PATCH', `/tasks/${clK}`, { due_date: '2099-12-31', reschedule_reason_id: 1 })).status === 400, 'prazo do check-list não muda à mão enquanto os itens têm prazo');
  ck = (await ricardo('PATCH', `/tasks/${clK}/items/${iEmDia}`, { due_date: '2099-02-10', start_date: '2099-02-01' })).data;
  ok(ck.due_date === '2099-02-10', 'prazo do item reduzido: o check-list acompanha o novo maior prazo');
  ck = (await ricardo('POST', `/tasks/${clK}/items`, { items: [{ text: 'Item tardio', due_date: '2099-05-05' }] })).data;
  const iTard = ck.checklist.items.find(i => i.text === 'Item tardio').id;
  ok(ck.due_date === '2099-05-05', 'item novo com prazo maior estende o prazo do check-list');
  ck = (await ricardo('DELETE', `/tasks/${clK}/items/${iTard}`)).data;
  ok(ck.due_date === '2099-02-10', 'item excluído: o prazo volta ao maior dos itens restantes');
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
  let tc = (await carla('POST', `/tasks/${tOwn}/actions/submit`, SD)).data;
  ok(tc.status === 'aguardando_conferencia' && tc.can.review, 'coordenador pode conferir a própria entrega');
  ok((await carla('POST', `/tasks/${tOwn}/actions/approve`, SD)).data.status === 'concluida', 'coordenador aprova a própria tarefa');
  // Tarefa da equipe
  const diego = await login('diego@charao.eng.br', 'diego1234');
  const tTeam = (await carla('POST', '/tasks', { project_id: 1, title: 'Tarefa do Diego', description: 'x', assignee_id: membroId, proof_type: 'descricao', due_date: '2099-04-02' })).data.id;
  await diego('PATCH', `/tasks/${tTeam}/execution`, { exec_description: 'Feito.' });
  await diego('POST', `/tasks/${tTeam}/actions/submit`, SD);
  ok(!(await diego('GET', `/tasks/${tTeam}`)).data.can.review, 'colaborador continua sem conferir a própria entrega');
  ok((await carla('POST', `/tasks/${tTeam}/actions/approve`, SD)).data.status === 'concluida', 'coordenador aprova a tarefa da equipe');
  // Gestor continua sem aprovar a própria
  const tGest = (await ricardo('POST', '/tasks', { project_id: 1, title: 'Tarefa do gestor', description: 'x', assignee_id: 2, proof_type: 'descricao', due_date: '2099-04-03' })).data.id;
  await ricardo('PATCH', `/tasks/${tGest}/execution`, { exec_description: 'Feito.' });
  const tg = (await ricardo('POST', `/tasks/${tGest}/actions/submit`, SD)).data;
  ok(!tg.can.review && (await ricardo('POST', `/tasks/${tGest}/actions/approve`, SD)).status === 403, 'gestor continua sem aprovar a própria tarefa');
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
  console.log('Duplicar tarefa');
  const tasksP1 = (await ricardo('GET', '/tasks?project=1')).data;
  const mae = tasksP1.find(t => !t.parent_id && tasksP1.some(s => s.parent_id === t.id) && !t.cancelled_at);
  const maeView = (await ricardo('GET', `/tasks/${mae.id}`)).data;
  const nSubs = maeView.subtasks.filter(s => !s.cancelled_at).length;
  ok(maeView.can.duplicate, 'gestor pode duplicar a tarefa');
  const dup = await ricardo('POST', `/tasks/${mae.id}/duplicate`, { title: 'Cópia da tarefa' });
  ok(dup.status === 201 && dup.data.subtasks === nSubs, `tarefa duplicada com as ${nSubs} subtarefas`);
  const dupView = (await ricardo('GET', `/tasks/${dup.data.id}`)).data;
  ok(dupView.title === 'Cópia da tarefa' && dupView.status === 'aberta' && !dupView.assignee_id && !dupView.due_date && dupView.subtasks.length === nSubs
    && dupView.subtasks.every(s => !s.assignee_id && !s.due_date && s.status === 'aberta') && dupView.stage_id && dupView.history.some(h => h.action === 'Tarefa duplicada'),
    'cópia aberta, sem responsáveis e sem prazos, com a mesma classificação e registro no histórico');
  const dup2 = (await ricardo('POST', `/tasks/${mae.id}/duplicate`, { keep_assignees: '1', keep_dates: '1' })).data;
  const dup2View = (await ricardo('GET', `/tasks/${dup2.id}`)).data;
  ok(dup2View.assignee_id === maeView.assignee_id && dup2View.due_date === maeView.due_date && dup2View.title === maeView.title, 'com as opções, mantém responsável e prazo');
  const dupCl = (await ricardo('POST', `/tasks/${clId}/duplicate`, {})).data;
  const dupClView = (await ricardo('GET', `/tasks/${dupCl.id}`)).data;
  const srcCl = (await ricardo('GET', `/tasks/${clId}`)).data;
  ok(dupClView.checklist.items.length === srcCl.checklist.items.length && dupClView.checklist.items.every(i => !i.result && !i.refs.length && !i.assignee_id),
    'check-list duplicado com os itens, sem respostas, fotos nem responsáveis');

  console.log('Dependências');
  const dpNodes = (await ricardo('GET', '/projects/1/nodes')).data;
  ok(dpNodes.some(n => n.type === 'tarefa') && dpNodes.some(n => n.type === 'subtarefa') && dpNodes.some(n => n.type === 'item'), 'opções: tarefas, subtarefas e itens de check-list do projeto');
  const [dpA, dpB, dpC] = tasksP1.filter(t => !t.parent_id && t.task_type !== 'checklist' && t.status !== 'concluida').map(t => t.id);
  const dpAB = await ricardo('POST', '/dependencies', { pred: `t:${dpA}`, succ: `t:${dpB}`, lag_days: 2 });
  ok(dpAB.status === 201, 'cria dependência entre tarefas (com folga)');
  let dpVB = (await ricardo('GET', `/tasks/${dpB}`)).data;
  ok(dpVB.dependencies.predecessors.length === 1 && dpVB.dependencies.predecessors[0].lag_days === 2 && dpVB.dependencies.waiting.length === 1 && dpVB.waiting_on === 1,
    'sucessora mostra a predecessora e fica "aguardando"');
  ok((await ricardo('GET', `/tasks/${dpA}`)).data.dependencies.successors.some(s => s.key === `t:${dpB}`), 'predecessora mostra que libera a sucessora');
  ok((await ricardo('POST', '/dependencies', { pred: `t:${dpA}`, succ: `t:${dpB}` })).status === 400, 'dependência repetida é recusada');
  await ricardo('POST', '/dependencies', { pred: `t:${dpB}`, succ: `t:${dpC}` });
  ok((await ricardo('POST', '/dependencies', { pred: `t:${dpC}`, succ: `t:${dpA}` })).status === 400, 'ligação circular (A→B→C→A) é recusada');
  ok((await ricardo('POST', '/dependencies', { pred: `t:${dpA}`, succ: `t:${dpA}` })).status === 400, 'tarefa não depende dela mesma');
  const dpOutro = (await ricardo('GET', '/tasks?project=3')).data.find(t => !t.parent_id);
  ok((await ricardo('POST', '/dependencies', { pred: `t:${dpOutro.id}`, succ: `t:${dpA}` })).status === 400, 'não liga tarefas de projetos diferentes');
  const dpItem = dpNodes.find(n => n.type === 'item');
  ok((await ricardo('POST', '/dependencies', { pred: dpItem.key, succ: `t:${dpC}` })).status === 201, 'item de check-list pode ser predecessor de tarefa');
  const dpClItem = srcCl.checklist.items[0];
  ok((await ricardo('POST', '/dependencies', { pred: `t:${clId}`, succ: `i:${dpClItem.id}` })).status === 400, 'item não depende do próprio check-list');
  ok((await ricardo('POST', '/dependencies', { pred: `i:${srcCl.checklist.items[1].id}`, succ: `i:${dpClItem.id}` })).status === 201
    && (await ricardo('GET', `/tasks/${clId}`)).data.checklist.item_deps[dpClItem.id]?.predecessors.length === 1, 'itens do mesmo check-list podem depender entre si');
  const dpSub = tasksP1.find(t => t.parent_id === mae.id);
  ok((await ricardo('POST', '/dependencies', { pred: `t:${mae.id}`, succ: `t:${dpSub.id}` })).status === 400, 'subtarefa não depende da própria tarefa principal');
  ok((await marcos('POST', '/dependencies', { pred: `t:${dpA}`, succ: `t:${dpC}` })).status === 403, 'colaborador sem gestão das tarefas não cria dependência');
  ok((await ricardo('DELETE', `/dependencies/${dpAB.data.id}`)).status === 200 && !(await ricardo('GET', `/tasks/${dpB}`)).data.dependencies.predecessors.length, 'dependência removida');
  ok((await ricardo('GET', `/tasks/${dpB}`)).data.history.some(h => h.action === 'Dependência removida'), 'adição e remoção ficam no histórico');

  console.log('Dependências: empurrar sucessoras e impacto');
  const mkDep = async (title, start, due) => (await ricardo('POST', '/tasks', { project_id: 1, title, description: 'Teste de dependência', assignee_id: 4, start_date: start, due_date: due, priority: 'media', proof_type: 'nenhuma' })).data.id;
  const xA = await mkDep('Dep A', '2099-01-01', '2099-01-10');
  const xB = await mkDep('Dep B', '2099-01-12', '2099-01-20');
  const xC = await mkDep('Dep C', '2099-01-21', '2099-01-25');
  const xD = await mkDep('Dep D (com folga)', '2099-03-01', '2099-03-05');
  await ricardo('POST', '/dependencies', { pred: `t:${xA}`, succ: `t:${xB}`, lag_days: 1 });
  await ricardo('POST', '/dependencies', { pred: `t:${xB}`, succ: `t:${xC}` });
  await ricardo('POST', '/dependencies', { pred: `t:${xA}`, succ: `t:${xD}` });
  const dpVB1 = (await ricardo('GET', `/tasks/${xB}`)).data;
  const dpVC1 = (await ricardo('GET', `/tasks/${xC}`)).data;
  ok(dpVB1.start_date > '2099-01-10' && dpVC1.start_date > dpVB1.due_date, `ao ligar, a sucessora que começava antes do permitido é alinhada (B ${dpVB1.start_date}→${dpVB1.due_date}, C ${dpVC1.start_date})`);
  ok(!dpVB1.reschedule_count && !dpVB1.impact && dpVB1.history.some(h => h.action === 'Datas ajustadas pela dependência'), 'alinhamento de planejamento não conta como reagendamento nem impacto');
  const dpPrev = (await ricardo('POST', `/tasks/${xA}/impact-preview`, { due_date: '2099-01-15' })).data;
  ok(dpPrev.impacted.length === 2 && dpPrev.impacted.every(i => i.days > 0) && dpPrev.impacted.every(i => i.code !== dpVB1.code || i.new_due > dpVB1.due_date),
    `prévia: reagendar A empurra B e C (D tem folga) (${JSON.stringify(dpPrev.impacted.map(i => [i.code, i.days]))})`);
  const dpReason = (await ricardo('GET', '/settings/reasons')).data[0].id;
  ok((await ricardo('PATCH', `/tasks/${xA}`, { due_date: '2099-01-15', reschedule_reason_id: dpReason })).status === 200, 'reagenda a predecessora (com justificativa)');
  const dpVA = (await ricardo('GET', `/tasks/${xA}`)).data;
  const dpVB2 = (await ricardo('GET', `/tasks/${xB}`)).data;
  const dpVC2 = (await ricardo('GET', `/tasks/${xC}`)).data;
  const dpVD2 = (await ricardo('GET', `/tasks/${xD}`)).data;
  ok(dpVB2.start_date > '2099-01-15' && dpVB2.work_days === dpVB1.work_days && dpVC2.start_date > dpVB2.due_date && dpVC2.work_days === dpVC1.work_days && dpVD2.due_date === '2099-03-05',
    `sucessoras empurradas em cascata mantendo a duração em dias úteis (B ${dpVB2.start_date}→${dpVB2.due_date}, ${dpVB2.work_days} úteis); D não muda`);
  ok(!dpVB2.reschedule_count && !dpVC2.reschedule_count && dpVA.reschedule_count === 1, 'só a causa conta como reagendada; as empurradas não');
  ok(dpVB2.history.some(h => h.action === 'Prazo ajustado por dependência' && h.details.includes('Dep A')) && dpVB2.dep_shift?.days > 0, 'sucessora registra o ajuste e a causa');
  ok(dpVA.impact?.tasks === 2 && dpVA.impact.days > 0 && dpVA.history.some(h => h.action === 'Impacto em outras tarefas'), `impacto na causa: 2 tarefas e os dias-tarefa (${JSON.stringify({ t: dpVA.impact?.tasks, d: dpVA.impact?.days, fim: dpVA.impact?.project_end_days })})`);
  const dpRank = (await ricardo('GET', '/impact-ranking?project=1')).data;
  ok(dpRank[0]?.id === xA && dpRank[0].days === dpVA.impact.days, 'ranking "atrasos com maior impacto" traz a causa');
  // Antecipar não puxa as sucessoras de volta
  await ricardo('PATCH', `/tasks/${xA}`, { due_date: '2099-01-11', reschedule_reason_id: dpReason });
  ok((await ricardo('GET', `/tasks/${xB}`)).data.due_date === dpVB2.due_date, 'antecipar a predecessora não puxa as sucessoras de volta');
  // Término com atraso: empurra pelo atraso real
  const xE = await mkDep('Dep E (atrasada)', '2020-01-01', '2020-01-05');
  const xF = await mkDep('Dep F', '2020-01-06', '2020-01-08');
  await ricardo('POST', '/dependencies', { pred: `t:${xE}`, succ: `t:${xF}` });
  await ricardo('POST', `/tasks/${xE}/actions/conclude`, { ...SD, comment: 'Concluída com atraso' });
  const dpVF = (await ricardo('GET', `/tasks/${xF}`)).data;
  ok(dpVF.start_date > '2020-01-06' && dpVF.due_date > '2020-01-08' && !dpVF.reschedule_count && (await ricardo('GET', `/tasks/${xE}`)).data.impact?.tasks === 1,
    'predecessora concluída com atraso empurra a sucessora (sem penalizá-la) e registra o impacto');
  // Etapa 3: Gantt com ligações e caminho crítico; impacto no relatório e na pessoa
  const dpXG = await mkDep('Dep G (fim)', '2099-12-01', '2099-12-31');
  await ricardo('POST', '/dependencies', { pred: `t:${xC}`, succ: `t:${dpXG}` });
  await ricardo('PATCH', `/tasks/${xC}`, { due_date: '2099-12-10', reschedule_reason_id: dpReason });
  const dpRep = (await ricardo('GET', '/reports?type=projeto&id=1&level=resumo')).data;
  const dpGG = dpRep.gantt_tasks.find(t => t.id === dpXG), dpGC = dpRep.gantt_tasks.find(t => t.id === xC);
  ok(dpGG?.preds.some(p => p.key === `t:${xC}`) && dpGG.critical && dpGC.critical && !dpRep.gantt_tasks.find(t => t.id === xD).critical,
    'Gantt do relatório: ligações e caminho crítico (C → G, sem folga, até a data final)');
  ok(dpRep.impact_rank.some(r => r.id === xA) && dpRep.impact_rank.some(r => r.id === xC), 'relatório traz os atrasos com maior impacto');
  const dpUImp = (await ricardo('GET', '/users/4')).data.impact;
  ok(dpUImp && dpUImp.days >= 10 && dpUImp.list.some(x => x.id === xA), 'página da pessoa soma o impacto dos atrasos das tarefas dela');

  console.log('Calendário de trabalho');
  const muns = (await ricardo('GET', '/ibge/municipios?uf=RS')).data;
  ok(muns.some(m => m.nome === 'Canoas' && m.id === 4304606), 'lista de municípios do estado (IBGE)');
  const calProj = await ricardo('POST', '/projects', { name: 'Obra Canoas', client: 'Cliente Teste', status: 'em_andamento', uf: 'RS', municipio: 'Canoas', ibge_code: 4304606 });
  ok(calProj.status === 201 && calProj.data.holidays?.ok && calProj.data.holidays.count >= 3 && calProj.data.holidays.municipal_found,
    `ao cadastrar a obra com estado/município, os feriados são buscados (${JSON.stringify(calProj.data.holidays)})`);
  const cpId = calProj.data.id;
  const yr = new Date().getFullYear();
  let cal = (await ricardo('GET', `/projects/${cpId}/calendar?year=${yr}`)).data;
  ok(cal.days.some(d => d.scope === 'municipal' && d.name === 'Dia do Município' && d.date === `${yr}-06-27`)
    && cal.days.some(d => d.scope === 'estadual' && d.date === `${yr}-09-20`) && cal.days.some(d => d.scope === 'nacional' && d.name === 'Natal'),
    'calendário da obra: nacionais (calculados), estadual e municipal');
  ok(cal.days.find(d => d.name === 'Corpus Christi')?.off && cal.days.find(d => d.name === 'Carnaval (segunda)')?.off, 'Carnaval e Corpus Christi não trabalhados por padrão');
  // Dias úteis: semana com o feriado municipal de 27/06 (no ano seguinte, para não depender do dia da semana deste ano)
  const mkCal = async (title, start, due) => (await ricardo('POST', '/tasks', { project_id: cpId, title, description: 'Teste de calendário', start_date: start, due_date: due, priority: 'media', proof_type: 'nenhuma' })).data.id;
  const tW = await mkCal('Semana comum', '2099-03-09', '2099-03-13');
  const tWv = (await ricardo('GET', `/tasks/${tW}`)).data;
  ok(tWv.work_days === 5 && tWv.calendar_days === 5, 'quadro de prazo: 5 dias úteis em uma semana de segunda a sexta');
  const tWe = await mkCal('Com fim de semana', '2099-03-09', '2099-03-20');
  ok((await ricardo('GET', `/tasks/${tWe}`)).data.work_days === 10, 'fim de semana não conta como dia útil (12 corridos = 10 úteis)');
  // Natal de 2098 cai numa quinta: semana de 22 (seg) a 26/12 (sex) tem 4 dias úteis
  const tNat = await mkCal('Semana do Natal', '2098-12-22', '2098-12-26');
  ok((await ricardo('GET', `/tasks/${tNat}`)).data.work_days === 4, 'feriado nacional (Natal) não conta como dia útil');
  // A obra trabalha no Natal → volta a contar
  ok((await ricardo('PATCH', `/projects/${cpId}/calendar/days`, { date: '2098-12-25', working: true, name: 'Natal' })).status === 200, 'obra marca que trabalha num feriado');
  ok((await ricardo('GET', `/tasks/${tNat}`)).data.work_days === 5, 'feriado trabalhado volta a contar como dia útil');
  // Dia não trabalhado só da obra
  ok((await ricardo('POST', `/projects/${cpId}/calendar/days`, { date: '2099-03-11', name: 'Paralisação' })).status === 201
    && (await ricardo('GET', `/tasks/${tW}`)).data.work_days === 4, 'dia não trabalhado da obra desconta dos dias úteis');
  // Dia não trabalhado da empresa (Configurações) e sábado trabalhado
  ok((await marcos('PUT', '/settings/calendar', { work_saturday: true })).status === 403, 'colaborador não altera o calendário da empresa');
  await ricardo('PUT', '/settings/calendar', { company_days: [{ date: '2099-03-10', name: 'Recesso' }] });
  ok((await ricardo('GET', `/tasks/${tW}`)).data.work_days === 3, 'dia não trabalhado da empresa vale para todas as obras');
  await ricardo('PUT', '/settings/calendar', { work_saturday: true, company_days: [] });
  ok((await ricardo('GET', `/tasks/${tWe}`)).data.work_days === 9 + 1, 'com sábado trabalhado, o sábado passa a contar (9 úteis com a paralisação + 1 sábado)');
  await ricardo('PUT', '/settings/calendar', { work_saturday: false });
  ok((await ricardo('GET', '/settings/calendar')).data.company_days.length === 0, 'configurações do calendário salvas');


  console.log('Datas automáticas e datas da tarefa principal');
  const mkBlank = async title => (await ricardo('POST', '/tasks', { project_id: cpId, title, description: 'Sem datas', priority: 'media', proof_type: 'nenhuma' })).data.id;
  const pFix = await mkCal('Predecessora com datas', '2099-03-02', '2099-03-06');
  const sBlank = await mkBlank('Sucessora sem datas');
  await ricardo('POST', '/dependencies', { pred: `t:${pFix}`, succ: `t:${sBlank}`, lag_days: 2 });
  let sbv = (await ricardo('GET', `/tasks/${sBlank}`)).data;
  ok(sbv.start_date === '2099-03-12' && !sbv.due_date && sbv.history.some(h => h.action === 'Datas definidas pelas dependências'),
    `sem início: começa depois do término da predecessora + folga em dias úteis (sex 06/03 → seg 09, ter 10, qua 11 é paralisação da obra → qui 12/03) → ${sbv.start_date}`);
  const preBlank = await mkBlank('Predecessora sem término');
  await ricardo('PATCH', `/tasks/${preBlank}`, { start_date: '2099-02-23' });
  await ricardo('POST', '/dependencies', { pred: `t:${preBlank}`, succ: `t:${pFix}` });
  const pbv = (await ricardo('GET', `/tasks/${preBlank}`)).data;
  ok(pbv.due_date === '2099-02-27', `sem término: termina no dia útil antes da sucessora (sucessora começa seg 02/03 → sex 27/02) → ${pbv.due_date}`);
  // Subtarefa sem datas: usa as datas da tarefa principal
  const subNo = (await ricardo('POST', '/tasks', { parent_id: pFix, title: 'Sub sem datas', description: 'x', priority: 'media', proof_type: 'nenhuma' })).data.id;
  const subV = (await ricardo('POST', `/tasks/${subNo}/parent-dates`, {})).data;
  ok(subV.start_date === '2099-03-02' && subV.due_date === '2099-03-06' && subV.history.some(h => h.action === 'Datas copiadas da tarefa principal'), 'botão copia início e término da tarefa principal para a subtarefa');
  ok((await ricardo('POST', `/tasks/${subNo}/parent-dates`, {})).status === 400, 'botão só vale para subtarefa sem datas');
  ok((await ricardo('POST', `/tasks/${pFix}/parent-dates`, {})).status === 400, 'botão só existe em subtarefas');


  // Subtarefa criada em branco, ligada a uma predecessora e a uma sucessora: as datas saem dos dois vínculos
  const pX = await mkCal('Pred da sub', '2099-03-16', '2099-03-20');
  const sX = await mkCal('Suc da sub', '2099-03-30', '2099-04-03');
  const subX = (await ricardo('POST', '/tasks', { parent_id: pFix, title: 'Sub em branco', description: 'x', priority: 'media', proof_type: 'nenhuma' })).data.id;
  ok(!(await ricardo('GET', `/tasks/${subX}`)).data.due_date, 'subtarefa nasce sem datas');
  await ricardo('POST', '/dependencies', { pred: `t:${pX}`, succ: `t:${subX}` });
  await ricardo('POST', '/dependencies', { pred: `t:${subX}`, succ: `t:${sX}` });
  const subXv = (await ricardo('GET', `/tasks/${subX}`)).data;
  ok(subXv.start_date === '2099-03-23' && subXv.due_date === '2099-03-27' && subXv.work_days === 5,
    `subtarefa em branco recebe início pela predecessora (seg 23/03) e término antes da sucessora (sex 27/03) → ${subXv.start_date} a ${subXv.due_date}`);

  // Tipos de projeto: cadastro em Configurações, escolha no projeto, agrupamento e análise no Dashboard
  const pTypes = (await ricardo('GET', '/settings/project-types')).data;
  ok(pTypes.map(t => t.name).join('|') === 'Orçamento|Consultoria|Obra|Reforma', 'tipos de projeto padrão cadastrados');
  ok((await marcos('PUT', '/settings/project-types', { types: [] })).status === 403, 'colaborador não altera os tipos de projeto');
  const tObra = pTypes.find(t => t.name === 'Obra').id;
  const tRef = pTypes.find(t => t.name === 'Reforma').id;
  const ptA = (await ricardo('POST', '/projects', { name: 'Obra Tipo A', client: 'Cliente T', type_id: tObra })).data.id;
  const ptB = (await ricardo('POST', '/projects', { name: 'Reforma Tipo B', client: 'Cliente T', type_id: tRef })).data.id;
  ok((await ricardo('GET', `/projects/${ptA}`)).data.type_name === 'Obra', 'projeto guarda o tipo escolhido');
  ok((await ricardo('POST', '/projects', { name: 'X', client: 'Y', type_id: 99999 })).status === 400, 'tipo inexistente é recusado');
  const ptInt = (await ricardo('POST', '/projects', { name: 'Área T', kind: 'interno', type_id: tObra })).data.id;
  ok((await ricardo('GET', `/projects/${ptInt}`)).data.type_id === null, 'área interna não recebe tipo');
  await ricardo('POST', '/tasks', { project_id: ptB, title: 'Demolição', description: 'x', priority: 'media', proof_type: 'nenhuma', due_date: '2000-01-10' });
  const dTypes = (await ricardo('GET', '/dashboard')).data.by_type;
  const dRef = dTypes.find(t => t.name === 'Reforma');
  ok(dRef && dRef.projects >= 1 && dRef.summary.total >= 1 && dRef.summary.late >= 1, 'Dashboard: análise por tipo conta projetos, tarefas e atrasos do tipo');
  ok(dTypes.some(t => t.id === null && t.name === 'Sem tipo'), 'Dashboard: projetos sem tipo aparecem em "Sem tipo"');
  ok(!dTypes.some(t => t.name === 'Orçamento'), 'Dashboard: tipos sem projetos não aparecem');
  // Configurações: renomear, inativar, incluir e excluir
  const typeBody = list => list.map(t => ({ id: t.id, name: t.name, active: t.active }));
  ok((await ricardo('PUT', '/settings/project-types', { types: typeBody(pTypes).filter(t => t.id !== tRef) })).status === 400, 'tipo em uso não pode ser excluído');
  ok((await ricardo('PUT', '/settings/project-types', { types: [...typeBody(pTypes), { name: 'obra' }] })).status === 400, 'tipo repetido é recusado');
  let tSaved = (await ricardo('PUT', '/settings/project-types', { types: [...typeBody(pTypes).map(t => (t.id === tRef ? { ...t, active: false } : t)), { name: 'Manutenção predial' }] })).data;
  ok(tSaved.length === 5 && !tSaved.find(t => t.id === tRef).active && tSaved.find(t => t.id === tRef).use_count >= 1, 'inclui tipo novo e inativa tipo em uso');
  ok(!(await ricardo('GET', '/settings/project-types')).data.some(t => t.id === tRef), 'tipo inativo some da lista para novos projetos');
  ok((await ricardo('POST', '/projects', { name: 'X2', client: 'Y', type_id: tRef })).status === 400, 'tipo inativo não vale para novo projeto');
  ok((await ricardo('PUT', `/projects/${ptB}`, { name: 'Reforma Tipo B (editada)' })).status === 200 && (await ricardo('GET', `/projects/${ptB}`)).data.type_id === tRef, 'projeto mantém o tipo inativo ao ser editado');
  tSaved = (await ricardo('PUT', '/settings/project-types', { types: typeBody(tSaved).filter(t => t.name !== 'Manutenção predial') })).data;
  ok(tSaved.length === 4, 'tipo sem uso pode ser excluído');

  // Planejamento da semana (tela do usuário): projetos disponíveis e criação já direcionada à pessoa
  const marcosId = 4;
  const planM = (await ricardo('GET', `/users/${marcosId}`)).data;
  ok(Array.isArray(planM.plan_projects) && planM.plan_projects.length > 0 && planM.plan_projects.every(p => p.code && p.name), 'tela do usuário traz os projetos para planejar a semana');
  const wpProj = planM.plan_projects[0].id;
  const wpId = (await ricardo('POST', '/tasks', { project_id: wpProj, title: 'Planejada na semana', description: 'Planejada na semana', assignee_id: marcosId, start_date: '2099-05-04', due_date: '2099-05-04', priority: 'alta', proof_type: 'foto' })).data.id;
  const wpT = (await ricardo('GET', `/users/${marcosId}`)).data.tasks.find(t => t.id === wpId);
  ok(wpT && wpT.due_date === '2099-05-04' && wpT.assignee_id === marcosId, 'tarefa criada pelo planejamento aparece na semana da pessoa');
  const encerrado = (await ricardo('GET', '/projects')).data.find(p => p.status === 'concluido');
  ok(!encerrado || !planM.plan_projects.some(p => p.id === encerrado.id), 'projeto concluído não aparece para planejar');

  // Avanço parcial (%) opcional: tarefa, subtarefa e item de check-list; preenche o Gantt
  const pgT = (await ricardo('POST', '/tasks', { project_id: 1, title: 'Tarefa com avanço', description: 'x', assignee_id: 4, priority: 'media', proof_type: 'nenhuma', start_date: '2099-08-03', due_date: '2099-08-14' })).data.id;
  ok((await ricardo('GET', `/tasks/${pgT}`)).data.progress_pct === null, 'avanço nasce não informado');
  ok((await camila('POST', `/tasks/${pgT}/progress`, { progress: 10 })).status === 404 || (await camila('POST', `/tasks/${pgT}/progress`, { progress: 10 })).status === 403, 'quem não é responsável nem gestor não informa avanço');
  ok((await marcos('POST', `/tasks/${pgT}/progress`, { progress: 140 })).status === 400, 'avanço fora de 0–100 é recusado');
  let pgV = (await marcos('POST', `/tasks/${pgT}/progress`, { progress: 40 })).data;
  ok(pgV.progress_pct === 40 && pgV.status === 'em_andamento' && pgV.history.some(h => h.action === 'Avanço atualizado' && /não informado → 40%/.test(h.details || '')), 'responsável informa 40%: tarefa entra em andamento e fica no histórico');
  const pgG = (await ricardo('GET', '/gantt?project=1')).data.tasks.find(x => x.id === pgT);
  ok(pgG && pgG.progress_pct === 40, 'Gantt recebe o avanço da tarefa');
  pgV = (await marcos('POST', `/tasks/${pgT}/progress`, { progress: null })).data;
  ok(pgV.progress_pct === null && pgV.history.some(h => h.action === 'Avanço removido'), 'avanço pode ser removido (opcional)');
  const pgSub = (await ricardo('POST', '/tasks', { parent_id: pgT, title: 'Sub com avanço', description: 'x', assignee_id: 4, priority: 'media', proof_type: 'nenhuma' })).data.id;
  const pgNoStart = await marcos('POST', `/tasks/${pgSub}/progress`, { progress: 75 });
  ok(pgNoStart.status === 400 && /data de início/.test(pgNoStart.data.error), 'subtarefa sem data de início: avanço exige informar o início');
  ok((await marcos('POST', `/tasks/${pgSub}/progress`, { progress: 75, start_date: '2099-01-01' })).status === 400, 'data de início no futuro é recusada');
  const pgSubV = (await marcos('POST', `/tasks/${pgSub}/progress`, { progress: 75, start_date: '2026-01-05' })).data;
  ok(pgSubV.progress_pct === 75 && pgSubV.start_date === '2026-01-05' && pgSubV.history.some(h => h.action === 'Data de início informada'), 'subtarefa aceita avanço com a data de início (gravada no histórico)');
  // Enviar e concluir sem data de início também exigem informar o início
  const nsT = (await ricardo('POST', '/tasks', { project_id: 1, title: 'Sem início', description: 'x', assignee_id: 4, priority: 'media', proof_type: 'nenhuma' })).data.id;
  const nsSub = await marcos('POST', `/tasks/${nsT}/actions/submit`);
  ok(nsSub.status === 400 && /data de início/.test(nsSub.data.error), 'enviar para conferência sem data de início é bloqueado');
  ok((await ricardo('POST', `/tasks/${nsT}/actions/conclude`, {})).status === 400, 'concluir diretamente sem data de início é bloqueado');
  const nsV = (await ricardo('POST', `/tasks/${nsT}/actions/conclude`, { start_date: '2026-02-02' })).data;
  ok(nsV.start_date === '2026-02-02', 'concluir informando a data de início');
  ok(nsV.due_date === nsV.completed_at.slice(0, 10) || !!nsV.due_date, 'sem prazo: ao concluir, o prazo final vira o dia da conclusão');
  ok(nsV.history.some(h => h.action === 'Prazo definido na conclusão') && nsV.on_time === true && !nsV.reschedule_count, 'prazo automático fica no histórico, não conta como reagendamento e a entrega fica no prazo');
  const nsT2 = (await ricardo('POST', '/tasks', { project_id: 1, title: 'Sem prazo — envio', description: 'x', assignee_id: 4, priority: 'media', proof_type: 'nenhuma', start_date: '2026-03-02' })).data.id;
  const nsV2 = (await marcos('POST', `/tasks/${nsT2}/actions/submit`)).data;
  ok(!!nsV2.due_date && nsV2.history.some(h => h.action === 'Prazo definido na conclusão'), 'sem prazo: ao enviar para conferência, o prazo final vira o dia da entrega');
  // Realizado x previsto: conclusão real, antecipação/atraso e tempo total percorrido
  const rlT = (await ricardo('POST', '/tasks', { project_id: 1, title: 'Antecipada', description: 'x', assignee_id: 4, priority: 'media', proof_type: 'nenhuma', start_date: '2026-03-02', due_date: '2099-03-31' })).data.id;
  const rlV = (await ricardo('POST', `/tasks/${rlT}/actions/conclude`, {})).data;
  ok(rlV.actual && rlV.actual.vs_due < 0 && rlV.actual.start === '2026-03-02' && rlV.actual.calendar_days > 1 && rlV.actual.work_days > 0, 'concluída antes do prazo: desvio negativo (antecipada) e tempo total em dias úteis e corridos');
  const rlL = (await ricardo('POST', '/tasks', { project_id: 1, title: 'Atrasada', description: 'x', assignee_id: 4, priority: 'media', proof_type: 'nenhuma', start_date: '2026-03-02', due_date: '2026-03-06' })).data.id;
  const rlLV = (await ricardo('POST', `/tasks/${rlL}/actions/conclude`, {})).data;
  ok(rlLV.actual.vs_due > 0 && rlLV.actual.planned_work_days === 5, 'concluída após o prazo: desvio positivo e duração planejada');
  const rlG = (await ricardo('GET', '/gantt?project=1')).data.tasks.find(x => x.id === rlL);
  ok(rlG && rlG.actual && rlG.actual.vs_due === rlLV.actual.vs_due, 'Gantt recebe a conclusão real e o desvio');
  // Avanço 100%: o status muda (responsável → Aguardando conferência; gestor pode concluir direto)
  const mk100 = async (title, proof) => (await ricardo('POST', '/tasks', { project_id: 1, title, description: 'x', assignee_id: 4, priority: 'media', proof_type: proof, start_date: '2026-03-02', due_date: '2099-03-31' })).data.id;
  const h1 = await mk100('100 envio', 'nenhuma');
  const h1v = (await marcos('POST', `/tasks/${h1}/progress`, { progress: 100 })).data;
  ok(h1v.status === 'aguardando_conferencia' && h1v.progress_pct === 100, 'responsável dá 100%: tarefa vai para Aguardando conferência');
  const h2 = await mk100('100 conclui', 'nenhuma');
  const h2v = (await ricardo('POST', `/tasks/${h2}/progress`, { progress: 100, finish: 'conclude' })).data;
  ok(h2v.status === 'concluida', 'gestor dá 100% escolhendo concluir: tarefa concluída');
  const h3 = await mk100('100 sem foto', 'foto');
  const h3r = await marcos('POST', `/tasks/${h3}/progress`, { progress: 100 });
  const h3v = (await ricardo('GET', `/tasks/${h3}`)).data;
  ok(h3r.status === 400 && /Comprovação/.test(h3r.data.error) && h3v.progress_pct === null && h3v.status === 'aberta', '100% sem a comprovação exigida é recusado e nada é gravado');
  // Data de conclusão informada com atraso: vai para autorização de quem confere
  const mkDone = async title => (await ricardo('POST', '/tasks', { project_id: 1, title, description: 'x', assignee_id: 4, priority: 'media', proof_type: 'nenhuma', start_date: '2026-03-02', due_date: '2026-03-10' })).data.id;
  const c1 = await mkDone('Data autorizada');
  ok((await marcos('POST', `/tasks/${c1}/actions/submit`, { done_date: '2099-01-01' })).status === 400, 'data de conclusão no futuro é recusada');
  ok((await marcos('POST', `/tasks/${c1}/actions/submit`, { done_date: '2026-02-01' })).status === 400, 'data de conclusão antes do início é recusada');
  let c1v = (await marcos('POST', `/tasks/${c1}/actions/submit`, { done_date: '2026-03-09' })).data;
  ok(c1v.status === 'aguardando_conferencia' && c1v.done_date_status === 'pendente' && c1v.claimed_done_date === '2026-03-09' && c1v.on_time === false, 'responsável informa que terminou em 09/03: fica aguardando autorização (até lá vale o registro)');
  ok((await ricardo('POST', `/tasks/${c1}/actions/approve`, {})).status === 400, 'aprovar exige decidir sobre a data informada');
  c1v = (await ricardo('POST', `/tasks/${c1}/actions/approve`, { date_decision: 'autorizar' })).data;
  ok(c1v.status === 'concluida' && c1v.delivered_date === '2026-03-09' && c1v.on_time === true && c1v.done_date_status === 'autorizada'
    && c1v.actual.filling_delay_days > 0 && c1v.actual.registered > '2026-03-09', 'superior autoriza: conta como entregue no prazo e registra o atraso de preenchimento');
  const c2 = await mkDone('Data negada');
  await marcos('POST', `/tasks/${c2}/actions/submit`, { done_date: '2026-03-09' });
  const c2v = (await ricardo('POST', `/tasks/${c2}/actions/approve`, { date_decision: 'registro' })).data;
  ok(c2v.done_date_status === 'negada' && c2v.on_time === false && c2v.delivered_date > '2026-03-10' && !c2v.filling_delay_days, 'superior nega: vale a data do registro (atrasada)');
  const c3 = await mkDone('Outra data');
  await marcos('POST', `/tasks/${c3}/actions/submit`, { done_date: '2026-03-09' });
  ok((await ricardo('POST', `/tasks/${c3}/actions/approve`, { date_decision: 'outra' })).status === 400, 'negar com outra data exige a data');
  const c3v = (await ricardo('POST', `/tasks/${c3}/actions/approve`, { date_decision: 'outra', decided_date: '2026-03-12' })).data;
  ok(c3v.delivered_date === '2026-03-12' && c3v.done_date_status === 'negada' && c3v.on_time === false && c3v.filling_delay_days > 0, 'superior define outra data (12/03): vale essa data, com atraso de preenchimento');
  const c4 = await mkDone('Devolvida');
  await marcos('POST', `/tasks/${c4}/actions/submit`, { done_date: '2026-03-09' });
  const c4v = (await ricardo('POST', `/tasks/${c4}/actions/return`, { comment: 'Refazer acabamento' })).data;
  ok(c4v.status === 'em_andamento' && !c4v.claimed_done_date && !c4v.done_date_status, 'devolver para ajustes descarta a data informada');
  const c5 = await mkDone('Conclusão direta com data');
  const c5v = (await ricardo('POST', `/tasks/${c5}/actions/conclude`, { done_date: '2026-03-08' })).data;
  ok(c5v.delivered_date === '2026-03-08' && c5v.on_time === true && c5v.filling_delay_days > 0, 'superior conclui direto informando o dia real (com atraso de preenchimento)');
  // Indicadores de execução do usuário: média de dias, antecipadas e atraso de preenchimento
  const ust = (await ricardo('GET', '/users/4')).data.stats;
  ok(ust.exec_days_avg > 0 && ust.exec_work_days_avg > 0 && ust.exec_count > 0, `média de dias de execução (${ust.exec_days_avg} corridos · ${ust.exec_work_days_avg} úteis)`);
  ok(ust.early >= 2 && ust.early_days_avg > 0, `tarefas antecipadas contadas (${ust.early})`);
  ok(ust.filling_delays >= 3 && ust.filling_delay_days_avg > 0 && ust.behavior.some(b => /atraso de preenchimento/.test(b)), `atraso de preenchimento contado (${ust.filling_delays}) e no resumo do comportamento`);
  // ---------- Contratos: liberação, área restrita, medições e faturamento ----------
  const kAnaId = (await ana('GET', '/auth/me')).data.user.id;
  ok((await ana('GET', '/contracts')).status === 403, 'sem liberação, nem o administrador acessa Contratos');
  ok(!(await ana('GET', '/meta')).data.can.contracts, 'menu Contratos oculto sem liberação');
  const kAnaU = (await ana('GET', `/users/${kAnaId}`)).data.user;
  ok((await ana('PUT', `/users/${kAnaId}`, { ...kAnaU, can_contracts: true })).status === 200, 'administrador libera Contratos para si');
  const kAnaC = await login('ana@charao.eng.br');
  ok((await kAnaC('GET', '/meta')).data.can.contracts === true, 'liberado: menu Contratos aparece');
  const kCtBody = { client: 'Orbe Consultoria', title: 'Gerenciamento', scope: 'Relatórios técnicos e planejamento', bulletin_prefix: 'orbe', payment_info: 'Santander', start_date: '2026-01-01',
    items: [{ description: 'Entrega de projetos', unit: 'vb', unit_price: '10.000,00', quantity: 12 }, { description: 'Aditivo - apoio', unit: 'vb', unit_price: 3500, quantity: 2, additive: true }] };
  const kCtId = (await kAnaC('POST', '/contracts', kCtBody)).data.id;
  let kCt = (await kAnaC('GET', `/contracts/${kCtId}`)).data;
  ok(kCt.code === 'CT-001' && kCt.bulletin_prefix === 'ORBE' && kCt.summary.value === 127000 && kCt.items[0].unit_price === 10000, `contrato cadastrado com itens e aditivo (valor ${kCt.summary.value})`);
  ok((await ricardo('GET', `/contracts/${kCtId}`)).status === 403, 'gestor sem liberação não vê o contrato');
  ok((await kAnaC('PUT', `/contracts/${kCtId}`, { status: 'suspenso' })).data.status === 'suspenso' && (await kAnaC('PUT', `/contracts/${kCtId}`, { status: 'vigente' })).data.items.length === 2, 'muda a situação do contrato sem reenviar os itens');
  const kM1 = (await kAnaC('POST', `/contracts/${kCtId}/measurements`, { ref_month: '2026-01' })).data.id;
  ok((await kAnaC('POST', `/contracts/${kCtId}/measurements`, { ref_month: '2026-02' })).status === 400, 'só um rascunho por vez');
  let kMv = (await kAnaC('GET', `/measurements/${kM1}`)).data;
  ok(kMv.code === 'ORBE0001.26' && kMv.period_start === '2026-01-01' && kMv.period_end === '2026-01-31' && kMv.status === 'rascunho', 'boletim numerado (ORBE0001.26) com o período do mês');
  ok((await kAnaC('POST', `/measurements/${kM1}/actions/issue`)).status === 400, 'não emite medição vazia');
  const kIt1 = kCt.items[0].id;
  kMv = (await kAnaC('PUT', `/measurements/${kM1}`, { lines: { [kIt1]: 1 }, adjustments: [{ description: 'Desconto AMIL', amount: '-158,95' }] })).data;
  ok(kMv.totals.measured === 10000 && kMv.totals.adj === -158.95 && kMv.totals.to_bill === 9841.05 && kMv.rows[0].bal_qty === 11, `totais do boletim: medição 10.000, desconto −158,95, a faturar ${kMv.totals.to_bill}`);
  kMv = (await kAnaC('POST', `/measurements/${kM1}/actions/issue`)).data;
  ok(kMv.status === 'emitida' && !kMv.can.edit, 'medição emitida (não edita mais)');
  ok((await kAnaC('PUT', `/measurements/${kM1}`, { lines: { [kIt1]: 2 } })).status === 400, 'emitida não aceita alteração');
  const kM2 = (await kAnaC('POST', `/contracts/${kCtId}/measurements`, { ref_month: '2026-02' })).data.id;
  let kMv2 = (await kAnaC('GET', `/measurements/${kM2}`)).data;
  ok(kMv2.adjustments.some(a => a.description === 'Desconto AMIL' && a.prev === -158.95 && a.amount === 0), 'desconto recorrente repetido na medição seguinte, com o acumulado anterior');
  kMv2 = (await kAnaC('PUT', `/measurements/${kM2}`, { lines: { [kIt1]: 1 } })).data;
  ok(kMv2.rows[0].prev_qty === 1 && kMv2.rows[0].acc_qty === 2 && kMv2.rows[0].bal_qty === 10 && kMv2.totals.prev === 10000, 'acumulado anterior, acumulado atual e saldo contratual');
  ok((await kAnaC('POST', `/measurements/${kM1}/actions/bill`, {})).status === 400, 'faturar exige o nº da NF');
  kMv = (await kAnaC('POST', `/measurements/${kM1}/actions/bill`, { nf_number: '123', nf_date: '2026-02-05' })).data;
  ok(kMv.status === 'faturada' && kMv.nf_number === '123', 'medição faturada com NF');
  kMv = (await kAnaC('POST', `/measurements/${kM1}/actions/receive`, { paid_date: '2026-02-20' })).data;
  ok(kMv.status === 'recebida' && kMv.paid_amount === 9841.05, 'recebimento registrado (valor do boletim)');
  const kDsh = (await kAnaC('GET', '/contracts/dashboard')).data;
  ok(kDsh.totals.value === 127000 && kDsh.totals.measured === 9841.05 && kDsh.totals.received === 9841.05 && kDsh.totals.drafts === 1 && kDsh.series.length === 12, 'faturamento global: contratado, medido, recebido e série mensal');
  const kAnn = kDsh.annual.find(y => y.year === '2026');
  ok(kAnn && kAnn.billed[1] === 9841.05 && kAnn.received[1] === 9841.05 && kAnn.measured[0] === 9841.05 && kAnn.totals.billed === 9841.05, 'comparativo anual: meses de medido (jan), faturado e recebido (fev)');
  ok((await kAnaC('POST', `/measurements/${kM2}/actions/delete`)).data.deleted, 'rascunho pode ser excluído');
  // Área restrita: tarefas só para liberados (inclusive administradores)
  const kArea = kDsh.area_id;
  ok(!!kArea, 'área interna restrita de Contratos criada');
  const kCtTask = (await kAnaC('POST', '/tasks', { project_id: kArea, title: 'Emitir medição de outubro', description: 'x', priority: 'media', proof_type: 'nenhuma' })).data.id;
  ok(!!kCtTask, 'liberado cria tarefa na área restrita');
  ok((await ricardo('GET', `/tasks/${kCtTask}`)).status === 404 && !(await ricardo('GET', '/tasks')).data.some(t => t.id === kCtTask), 'sem liberação, a tarefa da área restrita não aparece');
  ok(!(await ricardo('GET', '/projects')).data.some(p => p.id === kArea), 'sem liberação, a área restrita não aparece em Projetos');
  ok((await ricardo('POST', '/tasks', { project_id: kArea, title: 'x', description: 'x', priority: 'media', proof_type: 'nenhuma' })).status === 403, 'sem liberação não cria tarefa na área restrita');
  ok((await kAnaC('POST', '/tasks', { project_id: kArea, title: 'y', description: 'x', assignee_id: (await ricardo('GET', '/auth/me')).data.user.id, priority: 'media', proof_type: 'nenhuma' })).status === 400, 'não atribui tarefa restrita a quem não é liberado');
  ok(!(await ricardo('GET', '/dashboard')).data.internal_areas.some(p => p.id === kArea), 'Dashboard de quem não é liberado não mostra a área restrita');

  // ---------- Tarefas financeiras: liberação própria, parcelas pendente/paga e tarefas na área restrita ----------
  ok((await kAnaC('GET', '/finance/month')).status === 403, 'sem a liberação própria, Tarefas financeiras ficam fechadas (mesmo com Contratos)');
  const fAnaU = (await kAnaC('GET', `/users/${kAnaId}`)).data.user;
  await kAnaC('PUT', `/users/${kAnaId}`, { ...fAnaU, can_contracts: true, can_finance: true });
  const fAna = await login('ana@charao.eng.br');
  ok((await fAna('GET', '/meta')).data.can.finance === true, 'liberado: menu Tarefas financeiras aparece');
  const fRef = new Date().toISOString().slice(0, 7);
  ok((await fAna('POST', '/finance/obligations', { title: 'X', amount: 10, assignee_id: (await ricardo('GET', '/auth/me')).data.user.id })).status === 400, 'responsável precisa ter a liberação financeira');
  const fObId = (await fAna('POST', '/finance/obligations', { title: 'DAS Simples Nacional', category: 'Impostos', payee: 'Receita Federal', amount: '1.234,50', frequency: 'mensal', due_day: 20, start_month: fRef })).data.id;
  let fMonth = (await fAna('GET', '/finance/month')).data;
  const fIt = fMonth.items.find(i => i.obligation_id === fObId && i.ref_month === fRef);
  ok(fIt && fIt.amount_expected === 1234.5 && fIt.due_date === `${fRef}-20` && fIt.status === 'pendente' && fIt.task_id, 'obrigação mensal gera a parcela do mês (vencimento dia 20, valor previsto) e a tarefa');
  const fOb = (await fAna('GET', `/finance/obligations/${fObId}`)).data;
  ok(fOb.items.length === 3, 'gera as parcelas até 2 meses à frente');
  const fTask = (await fAna('GET', `/tasks/${fIt.task_id}`)).data;
  ok(fTask.title.startsWith('DAS Simples Nacional —') && fTask.assignee_id === kAnaId && fTask.stage_name === 'Impostos', 'tarefa da parcela: título com o mês, responsável e classificação = categoria');
  ok((await ricardo('GET', `/tasks/${fIt.task_id}`)).status === 404, 'sem liberação financeira, a tarefa da parcela não aparece');
  ok((await fAna('GET', '/tasks')).data.some(t => t.id === fIt.task_id), 'liberado vê a tarefa da parcela na lista de Tarefas');
  let fPaid = (await fAna('POST', `/finance/items/${fIt.id}/pay`, { paid_date: new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date()), paid_amount: '1.200,00', files: [{ data: tinyPng() }] })).data;
  ok(fPaid.status === 'paga' && fPaid.paid_amount === 1200 && fPaid.files.length === 1, 'pagamento registrado com valor e comprovante');
  ok((await fAna('GET', `/tasks/${fIt.task_id}`)).data.status === 'concluida', 'a tarefa da parcela fica concluída');
  ok((await fAna('POST', `/finance/items/${fIt.id}/pay`, {})).status === 400, 'não paga duas vezes');
  fPaid = (await fAna('POST', `/finance/items/${fIt.id}/unpay`)).data;
  ok(fPaid.status === 'pendente' && (await fAna('GET', `/tasks/${fIt.task_id}`)).data.status === 'aberta', 'desfazer pagamento volta a parcela e a tarefa');
  const fNext = fOb.items.find(i => i.ref_month !== fRef);
  ok((await fAna('PUT', `/finance/items/${fNext.id}/amount`, { amount_expected: '1.500,00' })).data.amount_expected === 1500, 'ajusta o valor previsto de uma parcela');
  await fAna('PUT', `/finance/obligations/${fObId}`, { due_day: 25 });
  ok((await fAna('GET', `/finance/items/${fIt.id}`)).data.due_date === `${fRef}-25`, 'mudar o dia de vencimento atualiza as parcelas pendentes');
  await fAna('PUT', `/finance/obligations/${fObId}`, { active: false });
  ok((await fAna('GET', `/finance/obligations/${fObId}`)).data.items.length === 1, 'inativar remove as parcelas futuras pendentes (mantém a do mês)');
  fMonth = (await fAna('GET', '/finance/month')).data;
  ok(fMonth.totals.count >= 1 && fMonth.categories.some(c => c.category === 'Impostos'), 'visão do mês com totais e resumo por categoria');
  // Concluir a tarefa pela tela de tarefas marca a parcela como paga
  const fOb2 = (await fAna('POST', '/finance/obligations', { title: 'Aluguel do escritório', category: 'Aluguel e condomínio', amount: 3000, due_day: 5, start_month: fRef })).data.id;
  const fIt2 = (await fAna('GET', `/finance/obligations/${fOb2}`)).data.items.find(i => i.ref_month === fRef);
  await fAna('POST', `/tasks/${fIt2.task_id}/actions/conclude`, { start_date: '2020-01-01' });
  ok((await fAna('GET', `/finance/items/${fIt2.id}`)).data.status === 'paga', 'concluir a tarefa da parcela marca a parcela como paga');
  // Análise comparativa: gastos x faturado por período, com variação
  for (const [por, n] of [['mes', 12], ['tri', 8], ['sem', 6], ['ano', 5]]) {
    const an = (await fAna('GET', `/finance/analysis?por=${por}`)).data;
    ok(an.periods.length >= 1 && an.periods.length <= n && an.periods.at(-1).partial && an.show_billed && an.periods.at(-1).spend > 0, `análise ${por}: até ${n} períodos (sem os vazios do início), atual parcial, gastos e faturado`);
  }
  const anMes = (await fAna('GET', '/finance/analysis?por=mes')).data;
  ok(anMes.categories.some(c => c.category === 'Aluguel e condomínio' && c.current === 3000), 'análise por categoria no período atual');
  ok((await ricardo('GET', '/finance/analysis')).status === 403, 'análise financeira exige a liberação');

  // Sem responsável indicado: a tarefa/subtarefa fica com quem a criou
  const rpT = (await marcos('POST', '/tasks', { project_id: 1, title: 'Sem responsável indicado', description: 'x', priority: 'media', proof_type: 'nenhuma' })).data.id;
  ok((await ricardo('GET', `/tasks/${rpT}`)).data.assignee_id === 4, 'tarefa criada sem responsável fica com quem criou');
  const rpS = (await ricardo('POST', '/tasks', { parent_id: rpT, title: 'Sub sem responsável', description: 'x', priority: 'media', proof_type: 'nenhuma' })).data.id;
  ok((await ricardo('GET', `/tasks/${rpS}`)).data.assignee_name === 'Ricardo Menezes', 'subtarefa criada sem responsável fica com quem criou');

  // Prazo rápido: início + nº de dias (úteis pelo calendário da obra, ou corridos)
  const qd1 = (await ricardo('GET', '/projects/1/plan-dates?start=2099-03-02&days=5')).data;
  ok(qd1.due === '2099-03-06' && qd1.work_days === 5, `5 dias úteis a partir de seg 02/03 → sex 06/03 (${qd1.due})`);
  const qd2 = (await ricardo('GET', '/projects/1/plan-dates?start=2099-03-02&days=10&mode=corridos')).data;
  ok(qd2.due === '2099-03-11' && qd2.calendar_days === 10, `10 dias corridos → 11/03 (${qd2.due})`);
  const qd3 = (await ricardo('GET', '/projects/1/plan-dates?start=2099-03-02&due=2099-03-13')).data;
  ok(qd3.work_days === 10 && qd3.calendar_days === 12, 'início + prazo → dias úteis e corridos');
  ok((await ricardo('GET', '/projects/1/plan-dates?start=2099-03-02')).status === 400, 'sem dias nem prazo é recusado');
  // Datas sugeridas pelas dependências (botões Puxar)
  const pullA = (await ricardo('POST', '/tasks', { project_id: 1, title: 'Pred puxar', description: 'x', priority: 'media', proof_type: 'nenhuma', start_date: '2099-04-06', due_date: '2099-04-10' })).data.id;
  const pullB = (await ricardo('POST', '/tasks', { project_id: 1, title: 'Meio puxar', description: 'x', priority: 'media', proof_type: 'nenhuma' })).data.id;
  const pullC = (await ricardo('POST', '/tasks', { project_id: 1, title: 'Suc puxar', description: 'x', priority: 'media', proof_type: 'nenhuma', start_date: '2099-04-27', due_date: '2099-04-30' })).data.id;
  await ricardo('POST', '/dependencies', { pred: `t:${pullA}`, succ: `t:${pullB}` });
  await ricardo('POST', '/dependencies', { pred: `t:${pullB}`, succ: `t:${pullC}` });
  const pullS = (await ricardo('GET', `/tasks/${pullB}/dep-dates`)).data;
  ok(pullS.from_pred?.start === '2099-04-13' && pullS.from_succ?.due === '2099-04-24', `sugestão: início pela predecessora (seg 13/04) e término pela sucessora (sex 24/04) → ${pullS.from_pred?.start} / ${pullS.from_succ?.due}`);
  ok(!(await ricardo('GET', `/tasks/${pullA}/dep-dates`)).data.has_pred, 'sem predecessora: não sugere início');

  // Os mesmos indicadores por projeto, por classificação e nas subtarefas de uma tarefa
  const pj1 = (await ricardo('GET', '/projects/1')).data;
  ok(pj1.summary.exec_count > 0 && pj1.summary.early >= 1 && pj1.summary.filling_delays >= 1 && pj1.summary.exec_work_days_avg > 0, 'projeto: média de execução, antecipadas e atraso de preenchimento');
  ok(pj1.stages.some(st => st.summary.exec_count > 0 && 'filling_delays' in st.summary && 'exec_work_days_avg' in st.summary), 'classificações trazem os indicadores de execução');
  ok((await ricardo('GET', '/projects')).data.find(x => x.id === 1).summary.exec_work_days_avg > 0, 'lista de projetos traz a média de execução');
  const sumT = (await ricardo('GET', `/tasks/${pgT}`)).data;
  ok(sumT.sub_summary && sumT.sub_summary.total >= 1 && 'early' in sumT.sub_summary, 'tarefa com subtarefas traz o desempenho das subtarefas');
  const pgCl = (await ricardo('POST', '/tasks', { project_id: 1, task_type: 'checklist', title: 'CL avanço', assignee_id: 4, photo_rule: 'livre', items: [{ text: 'Item A', start_date: '2099-08-03', due_date: '2099-08-05' }, { text: 'Item B' }] })).data.id;
  let pgClV = (await ricardo('GET', `/tasks/${pgCl}`)).data;
  ok((await marcos('POST', `/tasks/${pgCl}/progress`, { progress: 10 })).status === 400, 'check-list: avanço vem dos itens, não é informado na tarefa');
  const pgIa = pgClV.checklist.items.find(i => i.text === 'Item A').id;
  pgClV = (await marcos('POST', `/tasks/${pgCl}/items/${pgIa}/progress`, { progress: 60 })).data;
  ok(pgClV.checklist.items.find(i => i.id === pgIa).progress_pct === 60 && pgClV.checklist.summary.progress === 30, 'item recebe 60% e o check-list mostra a média (30%)');
  ok(((await ricardo('GET', '/gantt?project=1')).data.tasks.find(x => x.id === pgCl) || {}).progress_pct === 30, 'Gantt do projeto usa o avanço calculado do check-list');
  pgClV = (await marcos('POST', `/tasks/${pgCl}/items/${pgIa}/answer`, { result: 'conforme' })).data;
  ok(pgClV.checklist.items.find(i => i.id === pgIa).progress_pct === 100 && pgClV.checklist.summary.progress === 50, 'item conforme conta 100%');
  ok((await marcos('POST', `/tasks/${pgCl}/items/${pgIa}/progress`, { progress: 20 })).status === 400, 'item resolvido não recebe avanço');

  // ---------- Seções liberadas por usuário ----------
  const secM = (await fAna('GET', '/users/4')).data.user;
  ok(secM.section_list.includes('dashboard') && secM.section_list.includes('tarefas') && !secM.section_list.includes('auditoria'), 'sem lista salva: seções padrão do perfil');
  await fAna('PUT', '/users/4', { ...secM, sections: ['tarefas', 'financeiro'] });
  const secMarcos = await login('marcos@charao.eng.br');
  const secMeta = (await secMarcos('GET', '/meta')).data;
  ok(secMeta.can.sections.join(',') === 'tarefas,financeiro' && secMeta.can.finance === true, 'seções salvas: só Tarefas e Tarefas financeiras (liberação financeira espelhada)');
  ok((await secMarcos('GET', '/dashboard')).status === 403 && (await secMarcos('GET', '/projects')).status === 403 && (await secMarcos('GET', '/reports')).status === 403, 'seções desligadas são bloqueadas no servidor');
  ok((await secMarcos('GET', '/tasks')).status === 200 && (await secMarcos('GET', '/users/4')).status === 200 && (await secMarcos('GET', '/users/5')).status === 403, 'Tarefas liberada; a própria tela de usuário sempre abre, a de outros não');
  ok((await secMarcos('GET', '/finance/month')).status === 200, 'Tarefas financeiras liberada pela lista de seções');
  await fAna('PUT', '/users/4', { ...secM, sections: ['dashboard', 'projetos', 'usuarios', 'relatorios'] });
  const secMarcos2 = await login('marcos@charao.eng.br');
  ok((await secMarcos2('GET', '/tasks')).status === 403 && (await secMarcos2('GET', `/tasks/${(await secMarcos2('GET', '/users/4')).data.tasks[0].id}`)).status === 200, 'sem a seção Tarefas: some a lista, mas as próprias tarefas abrem');
  const secAna = (await fAna('GET', `/users/${kAnaId}`)).data.user;
  await fAna('PUT', `/users/${kAnaId}`, { ...secAna, sections: ['dashboard', 'contratos', 'financeiro'] });
  const secAna2 = await login('ana@charao.eng.br');
  ok((await secAna2('GET', '/meta')).data.can.sections.includes('cadastro_usuarios') && (await secAna2('GET', '/audit')).status === 403, 'administrador nunca perde o Cadastro de usuários; Auditoria pode ser desligada');
  ok((await secAna2('GET', '/meta')).data.can.home === 'pessoal', 'tela de entrada padrão: Meu painel');
  await secAna2('PUT', `/users/${kAnaId}`, { ...secAna, sections: ['dashboard', 'projetos', 'tarefas', 'usuarios', 'relatorios', 'contratos', 'financeiro', 'auditoria', 'configuracoes'] });
  // Cadastro de usuários como seção própria (gestor liberado) e tela de entrada
  const cuAna = await login('ana@charao.eng.br');
  const cuR = (await cuAna('GET', '/users/2')).data.user;
  ok((await ricardo('POST', '/users', { name: 'X', email: 'x@x.com', role: 'colaborador', password: 'Senha!2026x' })).status === 403, 'sem a seção Cadastro de usuários, o gestor não cadastra');
  const cuPut = await cuAna('PUT', '/users/2', { ...cuR, sections: ['dashboard', 'usuarios', 'cadastro_usuarios'], home: 'empresa' });
  const cuRic = await login('ricardo@charao.eng.br');
  ok((await cuRic('GET', '/meta')).data.can.manage_users === true && (await cuRic('GET', '/meta')).data.can.home === 'empresa', 'gestor com Cadastro de usuários e entrada na Visão da empresa');
  const cuNew = await cuRic('POST', '/users', { name: 'Novo Colab', email: 'novo.colab@charao.eng.br', role: 'colaborador', password: 'Senha!2026x', sections: ['usuarios', 'dashboard'] });
  ok(cuNew.status === 201, 'gestor liberado cadastra usuário');
  ok((await cuRic('POST', '/users', { name: 'Adm', email: 'adm2@charao.eng.br', role: 'admin', password: 'Senha!2026x' })).status === 403, 'quem não é administrador não cria administrador');
  ok((await cuRic('POST', '/users', { name: 'Y', email: 'y2@charao.eng.br', role: 'colaborador', password: 'Senha!2026x', sections: ['auditoria'] })).status === 403, 'só libera seções que ele mesmo tem');
  ok((await cuRic('PUT', `/users/${kAnaId}`, { name: 'Ana' })).status === 403, 'quem não é administrador não edita administrador');

  // ---------- Registros do projeto ----------
  console.log('Registros do projeto');
  const rgAna = await login('ana@charao.eng.br');
  const rgRicU = (await rgAna('GET', '/users/2')).data.user;
  await rgAna('PUT', '/users/2', { ...rgRicU, sections: ['dashboard', 'projetos', 'tarefas', 'usuarios', 'relatorios', 'configuracoes'], home: 'pessoal' });
  const rgRic = await login('ricardo@charao.eng.br');
  const rgMar = await login('marcos@charao.eng.br');
  const rgTypes = (await rgAna('GET', '/settings/record-types')).data;
  ok(rgTypes.length === 10 && rgTypes.some(t => t.behavior === 'reuniao') && rgTypes.some(t => t.requires_approval), 'tipos de registro padrão cadastrados (10)');
  const rgTid = n => rgTypes.find(t => t.name === n).id;
  const rgObs = await rgMar('POST', '/projects/1/records', { type_id: rgTid('Observação'), title: 'Acesso de caminhões só após 8h', body: 'Combinado com o condomínio.', pinned: true, files: [{ data: tinyPng(), caption: 'Placa' }] });
  ok(rgObs.status === 201, 'colaborador registra observação (tipo liberado a colaboradores)');
  const rgObsV = (await rgMar('GET', `/records/${rgObs.data.id}`)).data;
  ok(rgObsV.status === 'ativo' && rgObsV.pinned === 1 && rgObsV.files.length === 1 && !rgObsV.code, 'observação fixada, com anexo e sem numeração');
  ok((await rgMar('GET', `/record-files/${rgObsV.files[0].id}`)).status === 200, 'anexo do registro abre para quem acessa o projeto');
  ok((await rgMar('POST', '/projects/1/records', { type_id: rgTid('Definição'), title: 'X' })).status === 403, 'colaborador não registra definição (tipo não liberado)');
  ok((await rgRic('POST', '/projects/1/records', { type_id: rgTid('Definição'), title: 'X', record_date: '2099-01-01' })).status === 400, 'data do registro não pode ser futura');
  const rgD1 = (await rgRic('POST', '/projects/1/records', { type_id: rgTid('Definição'), title: 'Piso do térreo: porcelanato 60x60', decided_by: 'Cliente', origin: 'E-mail' })).data.id;
  const rgD1v = (await rgRic('GET', `/records/${rgD1}`)).data;
  ok(rgD1v.status === 'vigente' && rgD1v.code === 'DEF-PRJ-001-001', 'definição vigente com numeração própria (DEF-PRJ-001-001)');
  const rgD2 = (await rgRic('POST', '/projects/1/records', { type_id: rgTid('Definição'), title: 'Piso do térreo: porcelanato 90x90 cinza', replaces_id: rgD1 })).data.id;
  ok((await rgRic('GET', `/records/${rgD1}`)).data.status === 'substituida' && (await rgRic('GET', `/records/${rgD2}`)).data.history_chain.length === 1, 'nova definição substitui a anterior e guarda o histórico');
  // Pendência gera tarefa automaticamente
  const rgP = (await rgRic('POST', '/projects/1/records', { type_id: rgTid('Solicitação do cliente'), title: 'Instalar ponto extra de tomada na sala', decided_by: 'Cliente', assignee_id: 4, due_date: '2099-03-10', create_task: true })).data.id;
  const rgPv = (await rgRic('GET', `/records/${rgP}`)).data;
  ok(rgPv.status === 'aberta' && rgPv.task_id && rgPv.code === 'SOL-PRJ-001-001', 'pendência aberta gera a tarefa automaticamente');
  const rgPt = (await rgMar('GET', `/tasks/${rgPv.task_id}`)).data;
  ok(rgPt.assignee_id === 4 && rgPt.due_date === '2099-03-10' && rgPt.origin_record?.code === 'SOL-PRJ-001-001', 'tarefa gerada com responsável, prazo e origem');
  await rgRic('POST', `/tasks/${rgPv.task_id}/actions/conclude`, SD);
  ok((await rgRic('GET', `/records/${rgP}`)).data.eff_status === 'resolvida', 'pendência fica resolvida quando a tarefa é concluída');
  // Aprovação
  const rgA = (await rgRic('POST', '/projects/1/records', { type_id: rgTid('Alteração de escopo / aditivo'), title: 'Incluir pérgola na cobertura' })).data.id;
  ok((await rgRic('GET', `/records/${rgA}`)).data.status === 'aguardando_aprovacao', 'tipo que exige aprovação fica aguardando');
  ok((await rgRic('POST', `/records/${rgA}/actions/approve`)).status === 403, 'quem registrou não aprova o próprio registro');
  ok((await rgAna('POST', `/records/${rgA}/actions/approve`, { note: 'ok' })).data.status === 'vigente', 'administrador aprova e a alteração fica vigente');
  // Ata: rascunho → emitida (definições e demandas)
  const rgAta = await rgRic('POST', '/projects/1/records', { type_id: rgTid('Ata de reunião'), title: 'Reunião de alinhamento com o cliente', meeting_time: '09:30', location: 'Canteiro',
    participants: 'Ricardo Menezes\nCarlos Souza - Incorporadora Horizonte', agenda: 'Acabamentos e prazos',
    items: [{ kind: 'info', text: 'Cliente aprovou o cronograma' }, { kind: 'definicao', text: 'Bancadas em granito preto São Gabriel' }, { kind: 'demanda', text: 'Enviar amostras de rejunte', assignee_id: 4, due_date: '2099-02-15', create_task: true }, { kind: 'demanda', text: 'Conferir medidas no local', assignee_id: 4 }] });
  ok(rgAta.status === 201, 'ata criada em rascunho');
  let rgAv = (await rgRic('GET', `/records/${rgAta.data.id}`)).data;
  ok(rgAv.status === 'rascunho' && rgAv.items.length === 4 && !rgAv.items.some(i => i.task_id) && rgAv.participants[1].company === 'Incorporadora Horizonte', 'rascunho guarda itens e participantes (sem gerar nada ainda)');
  rgAv = (await rgRic('POST', `/records/${rgAta.data.id}/actions/emit`)).data;
  const rgDem = rgAv.items.find(i => i.kind === 'demanda');
  const rgDef = rgAv.items.find(i => i.kind === 'definicao');
  ok(rgAv.status === 'emitida' && rgDem.task_id && rgDef.decision_id && rgAv.code === 'ATA-PRJ-001-001', 'emitir a ata cria a tarefa da demanda e a definição vigente');
  ok((await rgRic('GET', `/records/${rgDef.decision_id}`)).data.source_code === 'ATA-PRJ-001-001', 'definição gerada aponta a ata de origem');
  ok((await rgMar('GET', `/tasks/${rgDem.task_id}`)).data.origin_record?.code === 'ATA-PRJ-001-001', 'tarefa da demanda mostra a ata de origem');
  ok((await rgRic('PUT', `/records/${rgAta.data.id}`, { title: 'Mudou' })).status === 403, 'ata emitida não é editada');
  ok((await rgMar('POST', `/records/${rgAta.data.id}/actions/addendum`, { items: [{ kind: 'demanda', text: 'X' }] })).status === 403, 'colaborador não inclui adendo');
  rgAv = (await rgRic('POST', `/records/${rgAta.data.id}/actions/addendum`, { items: [{ kind: 'demanda', text: 'Revisar memorial de acabamentos', assignee_id: 4, create_task: true }] })).data;
  ok(rgAv.items.length === 5 && rgAv.items[4].addendum === 1 && rgAv.items[4].task_id, 'adendo na ata emitida gera a nova tarefa');
  // Tarefa opcional: sem marcar, a demanda/pendência fica só registrada (dá para gerar depois)
  const rgSem = rgAv.items.find(i => i.text === 'Conferir medidas no local');
  ok(rgSem && !rgSem.task_id, 'demanda sem “Gerar tarefa” não cria tarefa ao emitir');
  const rgAv2 = (await rgRic('POST', `/records/${rgAta.data.id}/actions/item_task`, { item_id: rgSem.id })).data;
  ok(rgAv2.items.find(i => i.id === rgSem.id).task_id, 'gerar a tarefa da demanda depois, pela ata');
  const rgP2 = (await rgRic('POST', '/projects/1/records', { type_id: rgTid('Solicitação do cliente'), title: 'Trocar torneira do lavabo', assignee_id: 4, due_date: '2099-03-12' })).data.id;
  const rgP2v = (await rgRic('GET', `/records/${rgP2}`)).data;
  ok(rgP2v.status === 'aberta' && !rgP2v.task_id && rgP2v.can.task && rgP2v.can.resolve, 'pendência sem a opção marcada não gera tarefa');
  ok((await rgRic('POST', `/records/${rgP2}/actions/task`)).data.task_id, 'opção de gerar a tarefa da pendência depois');
  const rgP3 = (await rgRic('POST', '/projects/1/records', { type_id: rgTid('Solicitação do cliente'), title: 'Retocar pintura do hall' })).data.id;
  ok((await rgRic('POST', `/records/${rgP3}/actions/resolve`)).data.eff_status === 'resolvida', 'pendência sem tarefa pode ser marcada como resolvida');
  // Cancelar a definição atual devolve a anterior
  await rgRic('POST', `/records/${rgD2}/actions/cancel`, { reason: 'Cliente voltou atrás' });
  ok((await rgRic('GET', `/records/${rgD1}`)).data.status === 'vigente', 'cancelar a definição que substituiu reativa a anterior');
  // Terceirizado com acesso não vê tipos internos
  const rgExt = await rgAna('POST', '/users', { role: 'terceirizado', name: 'Lia Pintora', email: 'lia@pinta.com', company: 'Pinta Bem', login_enabled: true, access_scope: 'projetos', manager_id: 4, project_ids: [1], password: 'pinta12345' });
  const rgLia = await login('lia@pinta.com', 'pinta12345');
  const rgLiaList = (await rgLia('GET', '/projects/1/records')).data;
  ok(rgExt.status === 201 && rgLiaList.records.length > 0 && !rgLiaList.records.some(r => r.internal) && (await rgLia('GET', `/records/${rgA}`)).status === 404, 'terceirizado não vê registros de tipos internos');
  // Gantt e história
  const rgG = (await rgRic('GET', '/gantt?project=1')).data;
  ok(rgG.marks.some(m => m.code === 'ATA-PRJ-001-001') && !rgG.marks.some(m => m.status === 'cancelada'), 'Gantt do projeto traz as marcas dos registros');
  ok((await rgRic('GET', '/gantt?user=4')).data.marks.length === 0, 'Gantt por usuário não traz marcas de registros');
  const rgH = (await rgRic('GET', '/projects/1/history')).data;
  ok(rgH.chapters.length > 0 && rgH.chapters.some(c => c.paragraphs.some(x => x.includes('ATA-PRJ-001-001'))) && rgH.intro[0].includes('PRJ-001'), 'história do projeto narra a reunião no capítulo do mês');
  ok(rgH.vigentes.some(v => v.code === 'DEF-PRJ-001-001') && rgH.timeline.some(e => e.kind === 'registro'), 'história traz definições vigentes e a linha do tempo');
  // Vínculo de registro com tarefas existentes (pelo registro e pela tarefa)
  const rgLinkT = (await rgRic('GET', '/projects/1/record-tasks')).data;
  const rgT1 = rgLinkT.find(t => !t.parent_code).id;
  const rgT2x = rgLinkT.filter(t => !t.parent_code)[1].id;
  const rgOc = (await rgRic('POST', '/projects/1/records', { type_id: rgTid('Ocorrência / incidente'), title: 'Falta de energia no canteiro', task_ids: [rgT1] })).data.id;
  let rgOcV = (await rgRic('GET', `/records/${rgOc}`)).data;
  ok(rgOcV.linked_tasks.length === 1 && rgOcV.linked_tasks[0].id === rgT1, 'registro criado já vinculado a uma tarefa existente');
  let rgTv = (await rgRic('GET', `/tasks/${rgT1}`)).data;
  ok(rgTv.records.some(r => r.id === rgOc && r.linked) && rgTv.history.some(h => h.action === 'Registro do projeto vinculado'), 'a tarefa mostra o registro vinculado e registra no histórico');
  rgTv = (await rgMar('POST', `/tasks/${rgT2x}/record-links`, { record_id: rgOc })).data;
  ok(rgTv.records.some(r => r.id === rgOc), 'vínculo feito pela tela da tarefa');
  ok((await rgRic('GET', `/records/${rgOc}`)).data.linked_tasks.length === 2, 'registro lista as duas tarefas vinculadas');
  const rgOther = (await rgAna('GET', '/projects/2/record-tasks')).data[0];
  ok((await rgAna('POST', `/records/${rgOc}/links`, { task_id: rgOther.id })).status === 400, 'tarefa de outro projeto não é vinculada');
  rgOcV = (await rgRic('DELETE', `/records/${rgOc}/links/${rgT1}`)).data;
  ok(rgOcV.linked_tasks.length === 1 && !(await rgRic('GET', `/tasks/${rgT1}`)).data.records.some(r => r.id === rgOc), 'desvincular remove dos dois lados');
  ok((await rgMar('GET', `/tasks/${rgDem.task_id}`)).data.records.some(r => r.origin && r.code === 'ATA-PRJ-001-001'), 'tarefa gerada pela ata lista a ata como origem');
  const rgHm = rgH.chapters.find(c => c.detail.records.some(r => r.code === 'ATA-PRJ-001-001'));
  ok(rgHm && rgHm.detail.opened.some(t => t.title === 'Enviar amostras de rejunte') && rgH.chapters.some(c => c.detail.done.length && c.detail.done[0].code), 'história detalha no mês as tarefas abertas, concluídas e os registros');
  ok(rgG.marks.every(m => m.icon) && rgTypes.find(t => t.name === 'Ata de reunião').icon === 'reuniao', 'cada tipo de registro tem ícone próprio (Gantt e listas)');
  const rgRep = (await rgRic('GET', '/reports?type=projeto&id=1&level=resumo')).data;
  ok(rgRep.gantt_marks.length > 0, 'relatório do projeto leva as marcas para o Gantt');
  // Tipos editáveis em Configurações
  const rgT2 = [...rgTypes.map(t => ({ ...t })), { name: 'Diário de obra', behavior: 'nota', color: '#336699', prefix: 'RDO', allow_colab: 1 }];
  ok((await rgAna('PUT', '/settings/record-types', { types: rgT2 })).data.some(t => t.name === 'Diário de obra' && t.prefix === 'RDO'), 'novo tipo de registro cadastrado');
  ok((await rgAna('PUT', '/settings/record-types', { types: rgT2.map(t => (t.name === 'Definição' ? { ...t, behavior: 'nota' } : t)) })).status === 400, 'tipo com registros não troca de comportamento');
  ok((await rgMar('PUT', '/settings/record-types', { types: rgT2 })).status === 403, 'sem Configurações não altera os tipos');

  // ---------- Gestão da Equipe: organograma, cadastro e férias ----------
  console.log('Gestão da Equipe');
  const eqAna0 = await login('ana@charao.eng.br');
  const eqAnaU = (await eqAna0('GET', `/users/${kAnaId}`)).data.user;
  await eqAna0('PUT', `/users/${kAnaId}`, { ...eqAnaU, sections: [...eqAnaU.section_list, 'equipe'] });
  const eqAna = await login('ana@charao.eng.br');
  const eqRic = await login('ricardo@charao.eng.br');
  const eqMar = await login('marcos@charao.eng.br');
  const eqOrg = await eqAna('GET', '/team/org');
  ok(eqOrg.status === 200 && eqOrg.data.people.some(p => p.id === 4 && p.manager_id === 2) && 'missing_function' in eqOrg.data.people[0], 'organograma traz a hierarquia (gestor de cada pessoa)');
  ok((await eqRic('GET', '/team/org')).status === 403 && (await eqRic('GET', '/vacations/overview')).status === 403, 'sem a liberação Gestão da Equipe, não abre organograma nem férias da empresa');
  ok((await eqAna('POST', '/team', { name: 'João Servente', job_title: 'Servente' })).status === 400, 'cadastro da equipe exige responsabilidades');
  const eqNew = await eqAna('POST', '/team', { name: 'João Servente', job_title: 'Servente de obras', responsibilities: 'Apoio aos pedreiros, limpeza e organização do canteiro.', department: 'Obras', manager_id: 4, admission_date: new Date(Date.now() - 100 * 86400e3).toISOString().slice(0, 10) });
  ok(eqNew.status === 201 && eqNew.data.login_enabled === 0 && eqNew.data.manager_id === 4, 'pessoa sem acesso ao sistema cadastrada na equipe');
  ok((await eqAna('GET', '/users')).data.some(u => u.id === eqNew.data.id && !u.login_enabled), 'pessoa sem acesso aparece nos usuários como sem login');
  // Função e responsabilidades obrigatórias também ao editar quem já é usuário
  ok((await eqAna('PUT', '/team/4', { job_title: 'Mestre de Obras', responsibilities: '' })).status === 400, 'editar sem responsabilidades é bloqueado');
  const eqRef = new Date(); const eqIso = d => d.toISOString().slice(0, 10);
  const eqAdm = eqIso(new Date(eqRef.getTime() - 450 * 86400e3));
  const eqM = await eqAna('PUT', '/team/4', { job_title: 'Mestre de Obras', responsibilities: 'Coordena as equipes de campo, confere a execução e organiza o canteiro.', department: 'Obras', admission_date: eqAdm, manager_id: 2 });
  ok(eqM.status === 200 && eqM.data.responsibilities.startsWith('Coordena') && !eqM.data.missing_function, 'cadastro da equipe salva função, responsabilidades e admissão');
  // Organograma: mover gestor (com proteção contra ciclo)
  ok((await eqAna('PUT', '/team/2/manager', { manager_id: 4 })).status === 400, 'organograma impede ciclo na hierarquia');
  const eqMv = await eqAna('PUT', `/team/${eqNew.data.id}/manager`, { manager_id: 2 });
  ok(eqMv.status === 200 && eqMv.data.people.find(p => p.id === eqNew.data.id).manager_id === 2, 'arrastar no organograma troca o gestor');
  // Férias: períodos e saldo
  const eqMe = (await eqMar('GET', '/vacations/me')).data;
  ok(eqMe.periods.length >= 2 && eqMe.summary.available === 30 && eqMe.periods.some(p => !p.acquired), 'férias: período aquisitivo completo com 30 dias e o atual em aquisição');
  // Início válido: segunda-feira daqui a ~60 dias (sem feriado nos 2 dias seguintes)
  let eqSt = new Date(eqRef.getTime() + 60 * 86400e3);
  while (eqSt.getUTCDay() !== 1) eqSt = new Date(eqSt.getTime() + 86400e3);
  let eqPv = (await eqMar('POST', '/vacations/preview', { start_date: eqIso(eqSt), days: 10 })).data;
  for (let k = 0; !eqPv.ok && /feriado/.test(eqPv.error || '') && k < 6; k++) { eqSt = new Date(eqSt.getTime() + 7 * 86400e3); eqPv = (await eqMar('POST', '/vacations/preview', { start_date: eqIso(eqSt), days: 10 })).data; }
  ok(eqPv.ok && eqPv.end_date && eqPv.period.balance_after === 20, 'prévia calcula o término e o saldo restante');
  const eqFri = new Date(eqSt.getTime() - 3 * 86400e3);
  const eqPvFri = (await eqMar('POST', '/vacations/preview', { start_date: eqIso(eqFri), days: 10 })).data;
  ok(!eqPvFri.ok && /repouso|domingo/.test(eqPvFri.error), 'férias: não começa nos 2 dias antes do repouso semanal');
  ok(!(await eqMar('POST', '/vacations/preview', { start_date: eqIso(eqSt), days: 4 })).data.ok, 'férias: cada parte com no mínimo 5 dias');
  ok(/Sobrariam/.test((await eqMar('POST', '/vacations/preview', { start_date: eqIso(eqSt), days: 27 })).data.error || ''), 'férias: não deixa sobra menor que 5 dias');
  const eqReq = await eqMar('POST', '/vacations', { start_date: eqIso(eqSt), days: 10, note: 'Viagem em família' });
  ok(eqReq.status === 201 && eqReq.data.status === 'solicitada', 'a própria pessoa solicita as férias');
  const eqSt2 = new Date(eqSt.getTime() + 21 * 86400e3);
  const eqPv2 = (await eqMar('POST', '/vacations/preview', { start_date: eqIso(eqSt2), days: 10 })).data;
  ok(!eqPv2.ok && /14 dias/.test(eqPv2.error || ''), 'férias: uma das partes precisa ter ao menos 14 dias');
  ok((await eqMar('POST', `/vacations/${eqReq.data.id}/approve`)).status === 403, 'quem solicita não aprova as próprias férias');
  const eqRicMe = (await eqRic('GET', '/vacations/me')).data;
  ok(eqRicMe.approvals.some(v => v.id === eqReq.data.id), 'gestor direto vê a solicitação para aprovar no Meu painel');
  ok((await eqRic('POST', `/vacations/${eqReq.data.id}/approve`)).status === 200 && (await eqMar('GET', '/vacations/me')).data.summary.available === 20, 'gestor aprova e o saldo cai para 20 dias');
  const eqOv = (await eqAna('GET', '/vacations/overview')).data;
  ok(eqOv.people.some(p => p.id === 4 && p.vacations.length) && 'expiring' in eqOv.kpis, 'férias da empresa: visão geral do ano');
  const eqLaunch = await eqAna('POST', '/vacations', { user_id: eqNew.data.id, start_date: eqIso(new Date(eqSt.getTime() + 35 * 86400e3)), days: 30 });
  ok(eqLaunch.status === 400 && /ainda não completou|período aquisitivo/.test(eqLaunch.data.error), 'sem período aquisitivo completo não há férias');
  // Liberar acesso de quem foi cadastrado sem login
  const eqU = (await eqAna('GET', `/users/${eqNew.data.id}`)).data.user;
  const eqGrant = await eqAna('PUT', `/users/${eqNew.data.id}`, { ...eqU, email: 'joao.servente@charao.eng.br', password: 'Servente!2026', sections: ['tarefas'] });
  ok(eqGrant.status === 200 && (await client()('POST', '/auth/login', { email: 'joao.servente@charao.eng.br', password: 'Servente!2026' })).status === 200, 'Cadastro de usuários libera o acesso de quem não tinha login');

  // Férias × prazos: dias de férias não contam como úteis; entregas no período exigem novo prazo proposto
  const fpIso = d => d.toISOString().slice(0, 10);
  const fpVacEnd = fpIso(new Date(eqSt.getTime() + 9 * 86400e3));
  const fpPlanU = (await eqRic('GET', `/projects/1/plan-dates?start=${fpIso(eqSt)}&days=3&user=4`)).data;
  const fpPlan = (await eqRic('GET', `/projects/1/plan-dates?start=${fpIso(eqSt)}&days=3`)).data;
  ok(fpPlanU.due > fpVacEnd && fpPlan.due < fpVacEnd && fpPlanU.vacations.length === 1, 'prazo em dias úteis pula as férias aprovadas do responsável');
  const fpStart = new Date(eqSt.getTime() + 28 * 86400e3);
  const fpDueIn = fpIso(new Date(fpStart.getTime() + 3 * 86400e3));
  const fpTask = (await eqRic('POST', '/tasks', { project_id: 1, title: 'Entrega durante as férias', description: 'Teste de conflito com férias', assignee_id: 4, due_date: fpDueIn })).data.id;
  const fpPv = (await eqMar('POST', '/vacations/preview', { start_date: fpIso(fpStart), days: 20 })).data;
  ok(fpPv.ok && fpPv.conflicts.some(c => c.id === fpTask && c.suggested > fpPv.end_date), 'prévia lista as entregas no período com sugestão de novo prazo');
  const fpNo = await eqMar('POST', '/vacations', { start_date: fpIso(fpStart), days: 20 });
  ok(fpNo.status === 400 && /Proponha o novo prazo/.test(fpNo.data.error), 'sem propor o novo prazo das entregas, não solicita');
  ok((await eqMar('POST', '/vacations', { start_date: fpIso(fpStart), days: 20, reschedules: [{ task_id: fpTask, new_due: fpDueIn }] })).status === 400, 'novo prazo dentro das férias é recusado');
  const fpNew = fpPv.conflicts.find(c => c.id === fpTask).suggested;
  const fpReq = await eqMar('POST', '/vacations', { start_date: fpIso(fpStart), days: 20, reschedules: fpPv.conflicts.map(c => ({ task_id: c.id, new_due: c.suggested })) });
  ok(fpReq.status === 201 && fpReq.data.reschedules >= 1 && (await eqRic('GET', `/tasks/${fpTask}`)).data.due_date === fpDueIn, 'solicitação guarda a proposta; o prazo só muda na aprovação');
  ok((await eqRic('GET', '/vacations/me')).data.approvals.find(v => v.id === fpReq.data.id).reschedules.some(r => r.task_id === fpTask && r.new_due === fpNew), 'gestor vê os reagendamentos propostos');
  ok((await eqRic('POST', `/vacations/${fpReq.data.id}/approve`)).status === 200, 'gestor aprova as férias');
  const fpT = (await eqRic('GET', `/tasks/${fpTask}`)).data;
  ok(fpT.due_date === fpNew && fpT.reschedules.some(r => r.reason_name === 'Férias do responsável'), 'aprovação aplica o reagendamento com a justificativa Férias do responsável');
  // Foto de perfil
  ok((await eqMar('POST', '/users/4/avatar', { data: tinyPng() })).status === 200, 'a própria pessoa coloca a foto de perfil');
  ok((await eqAna('GET', '/meta')).data.avatars.some(a => a.id === 4) && (await eqAna('GET', '/avatars/4')).status === 200, 'a foto aparece para os demais (meta e imagem)');
  ok((await eqRic('POST', '/users/5/avatar', { data: tinyPng() })).status === 403, 'sem Cadastro/Gestão da Equipe não troca a foto de outra pessoa');
  ok((await eqAna('POST', '/users/5/avatar', { data: tinyPng() })).status === 200, 'quem tem a Gestão da Equipe troca a foto de outra pessoa');
  ok((await eqMar('POST', '/users/4/avatar', { data: 'data:application/pdf;base64,' + Buffer.from('%PDF-1.4 teste').toString('base64') })).status === 400, 'foto precisa ser imagem');
  ok((await eqMar('DELETE', '/users/4/avatar')).status === 200 && (await eqAna('GET', '/avatars/4')).status === 404, 'remover a foto volta às iniciais');
  // Cadastro da Equipe também com a seção Cadastro de usuários (sem a Gestão da Equipe)
  const nuRicU = (await eqAna('GET', '/users/2')).data.user;
  await eqAna('PUT', '/users/2', { ...nuRicU, sections: ['dashboard', 'projetos', 'cadastro_usuarios'] });
  const nuRic = await login('ricardo@charao.eng.br');
  ok((await nuRic('GET', '/team')).status === 200 && (await nuRic('GET', '/team/org')).status === 403 && (await nuRic('GET', '/vacations/overview')).status === 403, 'Cadastro de usuários abre o Cadastro da Equipe; organograma e férias seguem na Gestão da Equipe');

  // ---------- Processos da Empresa ----------
  // Ana tem lista de seções salva (testes anteriores): recebe a edição de processos
  const prAnaU = (await eqAna('GET', '/users/1')).data.user;
  await eqAna('PUT', '/users/1', { ...prAnaU, sections: [...prAnaU.section_list, 'processos'] });
  const prAna = await login('ana@charao.eng.br');
  const prFel = await login('felipe@charao.eng.br');
  const prList = (await prFel('GET', '/processes')).data;
  const prPrc = prList.items.filter(i => i.code.startsWith('PRC-'));
  ok(prPrc.length === 8 && prPrc.reduce((n, i) => n + i.controls, 0) === 13 && new Set(prPrc.map(i => i.area)).size === 5 && !prList.can_edit, 'carga inicial: 8 processos publicados, 13 pontos de controle, leitura para todos');
  const prSis = (await prAna('GET', '/processes')).data.items.filter(i => i.code.startsWith('SIS-'));
  const prFelSecs = (await prFel('GET', '/meta')).data.can.sections;
  const prFelSis = prList.items.filter(i => i.code.startsWith('SIS-'));
  const prExp = prSis.filter(i => !i.section || i.section.split('|').some(k => prFelSecs.includes(k)));
  ok(prFelSis.length === prExp.length && prFelSis.length < 19 && !prFelSis.some(i => i.code === 'SIS-12' && !prFelSecs.includes('contratos')), 'tutoriais aparecem só para quem tem acesso à seção correspondente');
  ok(prFelSecs.includes('contratos') || (await prFel('GET', `/processes/${prSis.find(i => i.code === 'SIS-12').id}`)).status === 404, 'sem a seção, o tutorial não abre nem pelo endereço');
  const prSis5 = (await prFel('GET', `/processes/${prSis.find(i => i.code === 'SIS-05').id}`)).data;
  ok(prSis.length === 19 && prSis.every(i => i.status === 'publicado' && i.area.startsWith('Sistema · ')) && prSis5.content.related_items.some(r => r.code === 'SIS-06') && prSis5.versions.length === 1, 'tutoriais do sistema: 19 processos SIS publicados, com relacionados');
  ok((await prAna('GET', '/meta')).data.can.edit_processes && !(await prFel('GET', '/meta')).data.can.edit_processes, 'edição de processos: administrador sim, colaborador não');
  const prRdo = (await prFel('GET', '/processes/1')).data;
  ok(prRdo.content.steps.length === 5 && prRdo.content.steps[2].control && prRdo.content.steps[2].back_to === 1 && prRdo.content.links[0].kind === 'video', 'ficha do RDO com etapas, ponto de controle, retorno e vídeo');
  ok((await prFel('PUT', '/processes/1', { ...prRdo.content })).status === 403 && (await prFel('POST', '/processes', { title: 'X' })).status === 403, 'colaborador não edita nem cria processos');
  const prBody = { title: 'Fechamento de Obra', area: 'Obras', frequency: 'Sob demanda', objective: 'Encerrar a obra com a documentação completa.',
    links: [{ kind: 'video', label: 'Treinamento', url: 'https://www.youtube.com/watch?v=abc' }], indicators: 'Prazo de entrega da documentação\n- Pendências no recebimento',
    steps: [{ responsible: 'Engenheiro de Obra', activity: 'Vistoria final', details: '- conferir itens\n**assinar** o termo' }, { responsible: 'Diretoria', activity: 'Aprova o encerramento', control: true, fail: 'Reprovado → nova vistoria', back_to: 1 }], related: [1, 7] };
  ok((await prAna('POST', '/processes', { ...prBody, steps: [] })).status === 400, 'processo sem etapas é recusado');
  ok((await prAna('POST', '/processes', { ...prBody, links: [{ kind: 'link', url: 'javascript:alert(1)' }] })).status === 400, 'link de material de apoio precisa ser http(s)');
  ok((await prAna('POST', '/processes', { ...prBody, steps: [{ responsible: 'A', activity: 'B', control: true, back_to: 1 }] })).status === 400, 'etapa não pode retornar para ela mesma');
  const prNew = (await prAna('POST', '/processes', prBody)).data;
  ok(prNew.code === 'PRC-09' && prNew.status === 'rascunho' && prNew.content.indicators.length === 2 && prNew.content.related_items.length === 2, 'novo processo nasce como rascunho com código automático');
  ok(!(await prFel('GET', '/processes')).data.items.some(i => i.id === prNew.id) && (await prFel('GET', `/processes/${prNew.id}`)).status === 404, 'rascunho não aparece para os leitores');
  ok((await prAna('POST', `/processes/${prNew.id}/publicar`, { note: 'Primeira versão' })).data.version === 1 && (await prFel('GET', `/processes/${prNew.id}`)).status === 200, 'publicado, passa a aparecer para todos');
  await prAna('PUT', `/processes/${prNew.id}`, { ...prBody, title: 'Fechamento e Entrega de Obra' });
  ok((await prFel('GET', `/processes/${prNew.id}`)).data.content.title === 'Fechamento de Obra' && (await prAna('GET', `/processes/${prNew.id}`, null)).data.has_draft, 'alteração fica em rascunho; leitores seguem vendo a versão publicada');
  ok((await prAna('GET', `/processes/${prNew.id}?ver=rascunho`)).data.content.title === 'Fechamento e Entrega de Obra', 'quem edita vê o rascunho');
  const prV2 = (await prAna('POST', `/processes/${prNew.id}/publicar`, { note: 'Nome ajustado' })).data;
  ok(prV2.version === 2 && prV2.versions.length === 2 && prV2.versions[0].note === 'Nome ajustado' && (await prFel('GET', `/processes/${prNew.id}?ver=1`)).data.content.title === 'Fechamento de Obra', 'nova versão publicada; a anterior fica no histórico');
  ok((await prAna('PUT', `/processes/${prNew.id}`, { ...prBody, code: 'PRC-01' })).status === 400, 'código repetido é recusado');
  const prFile = (await prAna('POST', `/processes/${prNew.id}/files`, { files: [{ data: tinyPng(), name: 'modelo.png' }] })).data.files[0];
  ok(prFile && (await prFel('GET', `/process-files/${prFile.id}`)).status === 200 && (await prFel('POST', `/processes/${prNew.id}/files`, { files: [{ data: tinyPng() }] })).status === 403, 'documentos: quem edita anexa, todos baixam');
  ok((await prAna('DELETE', `/processes/${prNew.id}`)).status === 400, 'processo publicado não é excluído (só arquivado)');
  await prAna('POST', `/processes/${prNew.id}/arquivar`);
  ok((await prFel('GET', `/processes/${prNew.id}`)).status === 404 && (await prFel('GET', `/process-files/${prFile.id}`)).status === 404 && (await prAna('GET', '/processes?arquivados=1')).data.items.some(i => i.id === prNew.id), 'arquivado some para os leitores e segue para quem edita');
  ok((await prAna('POST', `/processes/${prNew.id}/restaurar`)).data.status === 'publicado', 'processo restaurado');
  const prDel = (await prAna('POST', '/processes', { ...prBody, title: 'Rascunho descartável' })).data;
  ok((await prAna('DELETE', `/processes/${prDel.id}`)).status === 200 && (await prAna('GET', `/processes/${prDel.id}`)).status === 404, 'rascunho nunca publicado pode ser excluído');
  ok((await prAna('GET', '/processes/manual')).data.processes.length === 28, 'manual completo com os processos publicados');
  // Aprovação: gestor/coordenador criam e enviam; só o administrador publica
  const prJu = await login('juliana@charao.eng.br');
  const prJuMeta = (await prJu('GET', '/meta')).data.can;
  ok(prJuMeta.edit_processes && !prJuMeta.approve_processes && (await prAna('GET', '/meta')).data.can.approve_processes, 'gestor edita processos por padrão; só o administrador aprova');
  const prJ = (await prJu('POST', '/processes', { ...prBody, title: 'Entrega de Chaves', related: [], submit: true, note: 'Novo processo' })).data;
  ok(prJ.status === 'rascunho' && prJ.review.status === 'enviado' && prJ.can.submit === false && prJ.can.publish === false, 'gestor cria e envia para aprovação');
  ok((await prFel('GET', `/processes/${prJ.id}`)).status === 404, 'enviado ainda não aparece para os leitores');
  ok((await prJu('POST', `/processes/${prJ.id}/publicar`, {})).status === 403 && (await prJu('POST', '/processes/1/arquivar')).status === 403, 'gestor não publica nem arquiva');
  ok((await prJu('POST', '/processes/1/files', { files: [{ data: tinyPng() }] })).status === 403 && (await prJu('POST', `/processes/${prJ.id}/files`, { files: [{ data: tinyPng() }] })).status === 200, 'documentos: gestor só anexa em processo ainda não publicado');
  ok((await prAna('GET', '/processes')).data.summary.pending >= 1, 'administrador vê os processos aguardando aprovação');
  ok((await prAna('POST', `/processes/${prJ.id}/devolver`, { note: '' })).status === 400, 'devolver exige o motivo');
  const prRet = (await prAna('POST', `/processes/${prJ.id}/devolver`, { note: 'Detalhar a vistoria' })).data;
  ok(prRet.review.status === 'devolvido' && prRet.review.note === 'Detalhar a vistoria' && (await prJu('GET', `/processes/${prJ.id}`)).data.review.note === 'Detalhar a vistoria', 'administrador devolve e o gestor vê o motivo');
  const prJ2 = (await prJu('PUT', `/processes/${prJ.id}`, { ...prBody, title: 'Entrega de Chaves', objective: 'Entregar as chaves com a vistoria detalhada.', related: [] })).data;
  ok(prJ2.review.status === null && prJ2.can.submit, 'ajustado, volta a rascunho para novo envio');
  await prJu('POST', `/processes/${prJ.id}/enviar`, { note: 'Vistoria detalhada' });
  const prPub = (await prAna('POST', `/processes/${prJ.id}/publicar`, {})).data;
  ok(prPub.status === 'publicado' && prPub.version === 1 && prPub.versions[0].note === 'Vistoria detalhada' && (await prFel('GET', `/processes/${prJ.id}`)).status === 200, 'administrador aprova e publica; nota do envio vai para o histórico');
  // Alteração de processo publicado: nada muda para os leitores até a aprovação (inclusive responsável)
  const prP1 = (await prAna('GET', '/processes/1')).data;
  await prJu('PUT', '/processes/1', { ...prP1.editable, title: 'RDO (revisado)', owner_id: 3, submit: true });
  const prFelP1 = (await prFel('GET', '/processes/1')).data;
  ok(prFelP1.content.title === 'Relatório Diário de Obra (RDO)' && !prFelP1.owner_id, 'alteração enviada não muda a versão publicada nem o responsável');
  const prP1b = (await prAna('POST', '/processes/1/publicar', {})).data;
  ok(prP1b.version === 2 && prP1b.owner_id === 3 && (await prFel('GET', '/processes/1')).data.content.title === 'RDO (revisado)', 'na aprovação valem o novo conteúdo e o novo responsável');

  // ---------- Folha (Administrativa) ----------
  const fpAnaU = (await prAna('GET', '/users/1')).data.user;
  await prAna('PUT', '/users/1', { ...fpAnaU, sections: [...fpAnaU.section_list, 'folha'] });
  const fo = await login('ana@charao.eng.br');
  ok((await prFel('GET', '/payroll/months')).status === 403 && !(await prFel('GET', '/meta')).data.can.payroll && (await fo('GET', '/meta')).data.can.payroll, 'Folha: só quem tem a seção');
  const allVt = { 1: { vt: 1 }, 2: { vt: 1 }, 3: { vt: 1 }, 4: { vt: 1 }, 5: { vt: 1 } };
  const foP1 = (await fo('POST', '/payroll/people', { user_id: 6, company: 'charao', kind: 'estagio', monthly_value: '900', shift: '08:00 às 12:00', schedule: allVt, pix: 'chave-teste', start_date: '2026-01-01' })).data;
  const foP2 = (await fo('POST', '/payroll/people', { user_id: 8, company: 'lus', kind: 'estagio', monthly_value: 900, schedule: { 2: { vr: 1 }, 4: { vr: 1 }, 5: { vr: 1 } } })).data;
  const foP3 = (await fo('POST', '/payroll/people', { user_id: 7, kind: 'profissional', monthly_value: 3000, schedule: allVt })).data;
  ok(foP1.id && foP2.company_name.startsWith('Ludimila') && foP3.kind === 'profissional', 'pessoas incluídas na folha (empresa e tipo)');
  ok((await fo('POST', '/payroll/people', { user_id: 6, monthly_value: 1 })).status === 400, 'a mesma pessoa não entra duas vezes');
  const foM = (await fo('POST', '/payroll/months', { ref: '2026-10', vt_fare: 5.9, vr_daily: 22 })).data;
  const foE = id => foM.entries.find(e => e.person_id === id);
  // Setembro/2026: 22 dias de seg a sex, menos o feriado de 7/9 = 21. Outubro/2026: 22, menos 12/10 = 21.
  ok(foM.business_days === 21 && foM.benefit_days === 21 && foM.entries.length >= 3, 'dias úteis pelo calendário da empresa (com feriados)');
  ok(foE(foP1.id).calc.base === 900 && foE(foP1.id).calc.vt_days === 21 && foE(foP1.id).calc.vt === 247.8 && foE(foP1.id).calc.vr === 0, 'bolsa integral e VT = dias da escala × 2 × tarifa');
  ok(foE(foP2.id).calc.vt === 0 && foE(foP2.id).calc.vr === foE(foP2.id).calc.vr_days * 22 && foE(foP2.id).calc.vr_days === 14, 'VR só nos dias marcados (ter, qui, sex)');
  ok(foE(foP3.id).calc.vt === 0 && foE(foP3.id).calc.vr === 0 && foE(foP3.id).calc.total === 3000, 'profissional: valor proporcional, sem VT/VR');
  const foM2 = (await fo('PUT', `/payroll/entries/${foE(foP1.id).id}`, { absences: 2, ho_days: 3, reimbursement: '821.38', reimbursement_note: 'Material', vt_adjust: 10 })).data;
  const foC = foM2.entries.find(e => e.person_id === foP1.id).calc;
  ok(foC.worked_days === 19 && foC.base === 814.29 && foC.ho_discount === 35.4 && foC.vt === 222.4 && foC.total === 1858.07, 'faltas descontam a bolsa; home office desconta o VT; reembolso e diferença somam');
  ok((await fo('PUT', `/payroll/entries/${foE(foP1.id).id}`, { start_date: '2026-10-02' })).status === 400, 'período trabalhado precisa estar no mês da bolsa');
  const foClosed = (await fo('POST', `/payroll/months/${foM.id}/close`)).data;
  ok(foClosed.status === 'fechada' && foClosed.generated === foClosed.entries.filter(e => e.calc.total > 0).length && foClosed.entries.every(e => e.obligation_id), 'fechar a folha gera um pagamento por pessoa em Tarefas financeiras');
  ok((await fo('PUT', `/payroll/entries/${foE(foP1.id).id}`, { absences: 0 })).status === 400, 'folha fechada não aceita alteração');
  await fo('PUT', `/payroll/people/${foP1.id}`, { ...foP1, monthly_value: 1200 });
  ok((await fo('GET', `/payroll/months/${foM.id}`)).data.entries.find(e => e.person_id === foP1.id).calc.base === 814.29, 'folha fechada mantém os valores congelados');
  const foOb = (await fo('GET', '/finance/obligations')).data.find(o => o.title === 'Folha 10/2026 — Camila Rocha');
  ok(foOb && foOb.amount === 1858.07 && foOb.category === 'Folha de pagamento', 'pagamento gerado com o total e a categoria Folha');
  const foItem = (await fo('GET', `/finance/obligations/${foOb.id}`)).data.items[0];
  await fo('POST', `/finance/items/${foItem.id}/pay`, { paid_date: '2026-10-05', paid_amount: 1858.07 });
  ok((await fo('POST', `/payroll/months/${foM.id}/reopen`)).status === 400, 'com pagamento registrado, a folha não reabre');
  await fo('POST', `/finance/items/${foItem.id}/unpay`);
  const foRe = (await fo('POST', `/payroll/months/${foM.id}/reopen`)).data;
  ok(foRe.status === 'aberta' && !(await fo('GET', '/finance/obligations')).data.some(o => o.title === 'Folha 10/2026 — Camila Rocha') && foRe.entries.find(e => e.person_id === foP1.id).calc.base === 1085.71, 'reabrir remove os pagamentos pendentes e volta a calcular com os dados atuais');
  ok((await fo('POST', '/payroll/months', { ref: '2026-10' })).status === 400, 'uma folha por mês');
  // Folha pré-lançada em Tarefas financeiras (valor estimado, corrigido no fechamento)
  const ffOb = (await fo('POST', '/finance/obligations', { title: 'Folha estagiários', category: 'Folha de pagamento', amount: 4000, variable: true, repeat_last: true, frequency: 'mensal', due_day: 5, start_month: '2026-11' })).data;
  const ffObD = (await fo('GET', `/finance/obligations/${ffOb.id || ffOb}`)).data;
  const ffNov = ffObD.items.find(i => i.ref_month === '2026-11');
  ok(ffObD.repeat_last === 1 && ffNov && ffNov.estimated === 1 && ffNov.amount_expected === 4000, 'folha pré-lançada nasce com valor estimado');
  ok((await fo('PUT', `/finance/items/${ffNov.id}/amount`, { use_previous: true })).status === 400, 'sem mês anterior, não copia valor');
  await fo('PUT', `/finance/items/${ffNov.id}/amount`, { amount_expected: 4200, estimated: true });
  const ffDec = (await fo('GET', `/finance/obligations/${ffObD.id}`)).data.items.find(i => i.ref_month === '2026-12');
  if (ffDec) {
    await fo('PUT', `/finance/items/${ffDec.id}/amount`, { amount_expected: 1, estimated: true });
    ok((await fo('PUT', `/finance/items/${ffDec.id}/amount`, { use_previous: true })).data.amount_expected === 4200, 'opção de usar o valor do mês anterior');
  }
  ok((await fo('POST', '/payroll/months', { ref: '2026-11' })).status === 400, 'nova folha exige escolher a folha pré-lançada');
  const ffM = (await fo('POST', '/payroll/months', { ref: '2026-11', finance_item_id: ffNov.id })).data;
  ok(ffM.finance_item?.id === ffNov.id && ffM.pay_date === ffNov.due_date && !(await fo('GET', '/payroll/months')).data.finance_candidates.some(c => c.id === ffNov.id), 'folha vinculada à parcela pré-lançada (que deixa de ser opção para outras folhas)');
  const ffClosed = (await fo('POST', `/payroll/months/${ffM.id}/close`)).data;
  const ffItem = (await fo('GET', `/finance/items/${ffNov.id}`)).data;
  const ffOther = (await fo('POST', '/payroll/months', { ref: '2027-02', finance_item_id: 'nenhuma' })).data;
  ok((await fo('POST', '/payroll/months', { ref: '2027-03', finance_item_id: ffNov.id })).status === 400 && (await fo('PUT', `/payroll/months/${ffOther.id}`, { finance_item_id: ffNov.id })).status === 400, 'duas folhas não podem usar a mesma folha pré-lançada');
  await fo('DELETE', `/payroll/months/${ffOther.id}`);
  ok(ffClosed.corrected && ffClosed.generated === 0 && ffClosed.entries.every(e => !e.obligation_id) && ffItem.amount_expected === ffClosed.totals.total && ffItem.estimated === 0, 'fechar corrige o valor da folha pré-lançada (sem pagamentos por pessoa)');
  const ffRe = (await fo('POST', `/payroll/months/${ffM.id}/reopen`)).data;
  const ffItem2 = (await fo('GET', `/finance/items/${ffNov.id}`)).data;
  ok(ffRe.status === 'aberta' && ffItem2.amount_expected === 4200 && ffItem2.estimated === 1, 'reabrir volta a parcela ao valor estimado');
  ok((await fo('POST', '/payroll/months', { ref: '2027-01', finance_item_id: 'nenhuma' })).status === 201, 'sem folha pré-lançada: “Nenhuma” gera pagamentos por pessoa');
  // Reembolsos: a pessoa lança no Meu painel; a Folha puxa para o pagamento
  const rbCam = await login('camila@charao.eng.br');
  ok((await rbCam('POST', '/reimbursements', { expense_date: '2026-10-01', amount: '50', description: 'Táxi' })).status === 400, 'reembolso exige comprovante');
  ok((await rbCam('POST', '/reimbursements', { expense_date: '2099-01-01', amount: 50, description: 'Táxi', files: [{ data: tinyPng() }] })).status === 400, 'data da despesa não pode ser futura');
  const rb1 = (await rbCam('POST', '/reimbursements', { expense_date: '2026-10-10', amount: '120.50', description: 'Material de escritório', files: [{ data: tinyPng(), name: 'nota.png' }] })).data;
  const rb2 = (await rbCam('POST', '/reimbursements', { expense_date: '2026-10-11', amount: 30, description: 'Estacionamento', files: [{ data: tinyPng() }] })).data;
  ok(rb1.status === 'enviado' && rb1.situation === 'enviado' && rb1.files.length === 1 && (await rbCam('GET', '/reimbursements/me')).data.pending_total === 150.5, 'pessoa lança reembolsos com comprovante no Meu painel');
  ok((await rbCam('GET', `/reimbursement-files/${rb1.files[0].id}`)).status === 200 && (await prFel('GET', `/reimbursement-files/${rb1.files[0].id}`)).status === 404 && (await fo('GET', `/reimbursement-files/${rb1.files[0].id}`)).status === 200, 'comprovante: só a pessoa e quem cuida da folha');
  ok((await prFel('GET', '/reimbursements/pending')).status === 403 && (await fo('GET', '/reimbursements/pending')).data.some(r => r.id === rb1.id && r.in_payroll), 'Folha vê os reembolsos aguardando');
  const rbM = (await fo('GET', `/payroll/months/${ffM.id}`)).data;
  const rbPend = rbM.pending_reimbursements.find(r => r.id === rb1.id);
  const rbCamEntry = rbM.entries.find(e => e.person_id === foP1.id);
  const rbOther = rbM.entries.find(e => e.person_id === foP2.id);
  ok(rbPend && rbPend.entry_id === rbCamEntry.id, 'na montagem da folha aparecem os reembolsos das pessoas da folha');
  ok((await fo('POST', `/reimbursements/${rb1.id}/include`, { entry_id: rbOther.id })).status === 400, 'reembolso só entra no lançamento da própria pessoa');
  const rbM2 = (await fo('POST', `/reimbursements/${rb1.id}/include`, { entry_id: rbCamEntry.id })).data;
  const rbE2 = rbM2.entries.find(e => e.id === rbCamEntry.id);
  ok(rbE2.requests.length === 1 && rbE2.calc.reimb_requests === 120.5 && rbE2.calc.reimbursement === r2t(rbCamEntry.calc.reimbursement + 120.5) && rbE2.calc.total === r2t(rbCamEntry.calc.total + 120.5), 'reembolso puxado soma no pagamento da pessoa');
  ok((await rbCam('GET', '/reimbursements/me')).data.items.find(r => r.id === rb1.id).situation === 'incluido' && (await rbCam('POST', `/reimbursements/${rb1.id}/cancel`)).status === 400, 'pessoa vê “incluído na folha” e não cancela mais');
  ok((await fo('POST', `/reimbursements/${rb1.id}/release`)).data.entries.find(e => e.id === rbCamEntry.id).requests.length === 0, 'tirar da folha devolve o reembolso para aguardar');
  await fo('POST', `/reimbursements/${rb1.id}/include`, { entry_id: rbCamEntry.id });
  ok((await fo('POST', `/reimbursements/${rb2.id}/reject`, { note: '' })).status === 400, 'recusar exige o motivo');
  await fo('POST', `/reimbursements/${rb2.id}/reject`, { note: 'Sem nota fiscal válida' });
  const rbClosed = (await fo('POST', `/payroll/months/${ffM.id}/close`)).data;
  const rbMe = (await rbCam('GET', '/reimbursements/me')).data.items;
  ok(rbClosed.entries.find(e => e.id === rbCamEntry.id).requests.length === 1 && rbMe.find(r => r.id === rb1.id).situation === 'pago' && rbMe.find(r => r.id === rb2.id).decision_note === 'Sem nota fiscal válida', 'folha fechada: reembolso pago; recusado com o motivo para a pessoa');
  // Exclusão permanente de pessoa (administrador, sem tarefas)
  const duX = (await fo('POST', '/team', { name: 'Pessoa Teste Exclusão', job_title: 'Auxiliar', responsibilities: 'Cadastro feito por engano para testar a exclusão.', manager_id: 1 })).data;
  const duY = (await fo('POST', '/team', { name: 'Subordinado Teste', job_title: 'Auxiliar', responsibilities: 'Subordinado da pessoa que será excluída.', manager_id: duX.id })).data;
  ok((await prFel('GET', `/users/${duX.id}/deletion`)).status === 403 && (await prFel('DELETE', `/users/${duX.id}`)).status === 403, 'só o administrador exclui pessoas');
  const duInfo = (await fo('GET', `/users/${duX.id}/deletion`)).data;
  ok(duInfo.can_delete && duInfo.tasks === 0 && duInfo.subordinates === 1, 'pessoa sem tarefas pode ser excluída');
  const duMar = (await fo('GET', '/users/4/deletion')).data;
  ok(!duMar.can_delete && duMar.blockers.some(b => b.label === 'Tarefas') && (await fo('DELETE', '/users/4')).status === 400, 'pessoa com tarefas não é excluída (mostra o motivo)');
  ok((await fo('DELETE', '/users/1')).status === 400, 'administrador não exclui a si mesmo');
  ok((await fo('DELETE', `/users/${duX.id}`)).status === 200 && (await fo('GET', `/users/${duX.id}`)).status === 404, 'exclusão permanente');
  ok((await fo('GET', `/team/${duY.id}`)).data.manager_id === 1, 'subordinados passam para o gestor da pessoa excluída');
  ok((await fo('GET', '/audit')).data.some(a => a.action === 'Usuário excluído permanentemente'), 'exclusão registrada na auditoria');
  // Tarefa principal acompanha a maior data final das subtarefas
  const pdP = (await fo('POST', '/tasks', { project_id: 1, title: 'Tarefa mãe (prazos)', description: 'Teste de prazo da tarefa principal', assignee_id: 4, start_date: '2099-05-01', due_date: '2099-05-10' })).data.id;
  const pdS1 = (await fo('POST', '/tasks', { parent_id: pdP, project_id: 1, title: 'Sub 1', description: 'Subtarefa 1', assignee_id: 4, start_date: '2099-05-01', due_date: '2099-05-05' })).data.id;
  const pdS2 = (await fo('POST', '/tasks', { parent_id: pdP, project_id: 1, title: 'Sub 2', description: 'Subtarefa 2', assignee_id: 4, start_date: '2099-05-02', due_date: '2099-05-07' })).data.id;
  ok((await fo('GET', `/tasks/${pdP}`)).data.due_date === '2099-05-10', 'subtarefa nova com prazo menor não encolhe a tarefa principal');
  const pdReason = reasons[0].id;
  await fo('POST', `/tasks/${pdS1}/reschedule`, { due_date: '2099-05-20', reason_id: pdReason });
  let pdPv = (await fo('GET', `/tasks/${pdP}`)).data;
  ok(pdPv.due_date === '2099-05-20' && pdPv.can.due_from_subtasks && !pdPv.can.reschedule, 'subtarefa reagendada depois da principal: a principal estende para a maior data final');
  await fo('POST', `/tasks/${pdS1}/reschedule`, { due_date: '2099-05-06', reason_id: pdReason });
  pdPv = (await fo('GET', `/tasks/${pdP}`)).data;
  ok(pdPv.due_date === '2099-05-07' && pdPv.reschedule_count === 0 && pdPv.history.some(h => h.action === 'Datas ajustadas pelas subtarefas'), 'subtarefa antecipada: a principal antecipa para a maior data final (sem contar como reagendamento)');
  ok((await fo('PATCH', `/tasks/${pdP}`, { due_date: '2099-06-01', reschedule_reason_id: pdReason })).status === 400, 'prazo da principal não é alterado direto quando acompanha as subtarefas');
  await fo('PATCH', `/tasks/${pdS2}`, { start_date: '2099-04-25' });
  ok((await fo('GET', `/tasks/${pdP}`)).data.start_date === '2099-04-25', 'subtarefa começando antes: o início da principal acompanha a que começa mais cedo');
  await fo('PATCH', `/tasks/${pdS2}`, { start_date: '2099-05-03' });
  ok((await fo('GET', `/tasks/${pdP}`)).data.start_date === '2099-05-01', 'início adiado: a principal passa a começar com a subtarefa mais cedo');
  ok((await fo('PATCH', `/tasks/${pdP}`, { start_date: '2099-04-01' })).status === 400, 'início da principal não é alterado direto quando acompanha as subtarefas');
  const pdS3 = (await fo('POST', '/tasks', { parent_id: pdP, project_id: 1, title: 'Sub 3 sem datas', description: 'Subtarefa sem datas', assignee_id: 4 })).data.id;
  await fo('POST', `/tasks/${pdS3}/parent-dates`);
  const pdS3v = (await fo('GET', `/tasks/${pdS3}`)).data, pdPv3 = (await fo('GET', `/tasks/${pdP}`)).data;
  ok(pdS3v.start_date === pdPv3.start_date && pdS3v.due_date === pdPv3.due_date && pdPv3.due_date === '2099-05-07', 'subtarefa continua podendo puxar as datas da tarefa mãe (sem alterar a mãe)');
  // Mãe empurrada por dependência: as subtarefas em aberto andam junto
  const mvA = (await fo('POST', '/tasks', { project_id: 1, title: 'Predecessora (mover subtarefas)', description: 'Teste', assignee_id: 4, start_date: '2099-07-01', due_date: '2099-07-03' })).data.id;
  const mvP = (await fo('POST', '/tasks', { project_id: 1, title: 'Mãe sucessora', description: 'Teste', assignee_id: 4, start_date: '2099-07-06', due_date: '2099-07-10' })).data.id;
  const mvS = (await fo('POST', '/tasks', { parent_id: mvP, project_id: 1, title: 'Sub da mãe sucessora', description: 'Teste', assignee_id: 4, start_date: '2099-07-06', due_date: '2099-07-10' })).data.id;
  await fo('POST', '/dependencies', { pred: `t:${mvA}`, succ: `t:${mvP}` });
  await fo('POST', `/tasks/${mvA}/reschedule`, { due_date: '2099-07-15', reason_id: pdReason });
  const mvPv = (await fo('GET', `/tasks/${mvP}`)).data, mvSv = (await fo('GET', `/tasks/${mvS}`)).data;
  ok(mvPv.start_date > '2099-07-15' && mvSv.start_date === mvPv.start_date && mvSv.due_date === mvPv.due_date && mvSv.reschedule_count === 0, 'mãe empurrada por dependência leva as subtarefas junto (sem contar como reagendamento)');

  // ---------- Contratos: importar BMs das planilhas de recebimentos ----------
  const biFile = n => ({ name: n, data: fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', n)).toString('base64') });
  const biFiles = [biFile('recebimentos-exemplo.xlsx')];
  const biNo = await login('marcos@charao.eng.br');
  ok((await biNo('POST', '/contracts/import-bms/preview', { files: biFiles })).status === 403, 'sem liberação de Contratos não importa BMs');
  ok((await fo('POST', '/contracts/import-bms/preview', { files: [{ name: 'x.xlsx', data: Buffer.from('não é planilha').toString('base64') }] })).status === 400, 'arquivo que não é .xlsx é recusado');
  const biPv = (await fo('POST', '/contracts/import-bms/preview', { files: biFiles })).data;
  const biA1 = biPv.groups.find(g => g.obra === 'Reforma - Casa Exemplo A1'), biA2 = biPv.groups.find(g => g.obra === 'Projeto - Sala Exemplo A2'), biGer = biPv.groups.find(g => g.obra === 'Gerenciamento');
  ok(biPv.total_rows === 12 && biPv.groups.length === 4 && biPv.skipped.others === 2, `prévia: 4 obras e 2 outras entradas fora (${biPv.groups.length}/${biPv.skipped.others})`);
  ok(biA1.client === 'Cliente Exemplo Alfa' && biA1.bms === 3 && biA1.value_add === 40000 && biA1.open_add === 10000 && biA1.rt === 750.5, 'obra: valor do contrato com todas as parcelas, BM só dos meses recebidos (jan, fev, mar)');
  const biMar = biA1.months.find(m => m.month === '2025-03'), biFev = biA1.months.find(m => m.month === '2025-02');
  ok(biMar.total === 10750.5 && biMar.adjustments.some(a => a.description === 'RT - Fornecedor Exemplo Móveis' && a.amount === 750.5), 'RT do fornecedor entra como acréscimo no BM do mês');
  ok(biFev.measured === 10000 && biFev.total === 9800 && biFev.adjustments.some(a => a.description === 'Descontos no recebimento' && a.amount === -200), 'desconto do recebimento entra como desconto (total = valor recebido)');
  ok(biA2.months.length === 1 && biA2.months[0].measured === 5000 && biA2.months[0].count === 2 && biA2.value_add === 9000, 'linhas do mesmo mês somam num único BM');
  ok(biGer.match && biGer.match.code === 'CT-001', 'obra com o nome de um contrato existente já vem ligada a ele');
  const biCt1Before = (await fo('GET', `/contracts/${kCtId}`)).data;
  const biImp = (await fo('POST', '/contracts/import-bms', { files: biFiles, mapping: { [biA2.key]: 'skip' } })).data;
  ok(biImp.bms === 5 && biImp.contracts_created.length === 2 && biImp.value_added === 40000 + 6000 + 9841.05, `importação: 5 BMs, 2 contratos novos e valor somado (${JSON.stringify(biImp)})`);
  const biCts = (await fo('GET', '/contracts')).data;
  ok(!biCts.some(c => c.title === 'Projeto - Sala Exemplo A2'), 'obra marcada "não importar" fica de fora');
  const biCtA1 = biCts.find(c => c.title === 'Reforma - Casa Exemplo A1');
  let biA1v = (await fo('GET', `/contracts/${biCtA1.id}`)).data;
  ok(biA1v.client === 'Cliente Exemplo Alfa' && biA1v.status === 'vigente' && biA1v.items.length === 1 && biA1v.items[0].unit === 'R$' && biA1v.items[0].description === 'Execução de Obras' && biA1v.items[0].quantity === 40000,
    'contrato novo: item por natureza com o valor de todas as parcelas (recebidas + em aberto)');
  ok(biA1v.measurements.length === 3 && biA1v.measurements.every(m => m.status === 'recebida') && biA1v.summary.received === 30550.5 && biA1v.summary.value === 40000 && biA1v.summary.balance === 10000,
    'BMs só do recebido; parcela em aberto fica como saldo a medir');
  const biM = (await fo('GET', `/measurements/${biA1v.measurements.find(m => m.ref_month === '2025-03').id}`)).data;
  ok(biM.code === `${biA1v.bulletin_prefix}0003.25` && biM.totals.to_bill === 10750.5 && biM.paid_amount === 10750.5 && biM.nf_date === '2025-03-10' && biM.rows[0].acc_value === 30000 && biM.rows[0].bal_value === 10000, 'boletim completo: código, acumulado, saldo e valor recebido');
  ok(biCts.find(c => c.title === 'Orçamento - Estudo Exemplo B1').status === 'encerrado', 'contrato antigo, sem nada em aberto, nasce encerrado');
  const biCt1 = (await fo('GET', `/contracts/${kCtId}`)).data;
  ok(biCt1.measurements.length === biCt1Before.measurements.length + 1 && biCt1.items.some(i => i.additive && i.description.includes('importado')) && biCt1.summary.value === biCt1Before.summary.value + 9841.05,
    'contrato lançado à mão: BM do mês acrescentado e item importado entra como aditivo');
  const biAgain = (await fo('POST', '/contracts/import-bms', { files: biFiles, mapping: { [biA2.key]: 'skip' } })).data;
  ok(biAgain.bms === 0 && biAgain.value_added === 0 && biAgain.contracts_created.length === 0, 'reenviar não duplica (nem BM, nem valor do contrato)');
  ok((await fo('POST', '/contracts/import-bms/preview', { files: biFiles })).data.groups.filter(g => g.key !== biA2.key).every(g => !g.pending), 'prévia de reenvio: obras já importadas aparecem como concluídas');
  // Planilha mais nova: a parcela que estava em aberto foi recebida (com juros) → ganha o BM, sem somar de novo no contrato
  const biBx = (await fo('POST', '/contracts/import-bms', { files: [biFile('recebimentos-exemplo-baixa.xlsx')] })).data;
  biA1v = (await fo('GET', `/contracts/${biCtA1.id}`)).data;
  const biAbr = biA1v.measurements.find(m => m.ref_month === '2025-04');
  ok(biBx.bms === 1 && biBx.value_added === 0 && biAbr && biAbr.paid_amount === 10150 && biA1v.summary.value === 40000 && biA1v.summary.balance === 0, 'parcela recebida depois ganha o BM (com juros) e o saldo zera, sem mudar o valor do contrato');
  ok((await fo('GET', '/audit')).data.some(a => a.action === 'BMs importados das planilhas de recebimentos'), 'importação registrada na auditoria');

  // ---------- Contratos: empresa (Charão / LuS) e tipo ----------
  const ctTypes = (await fo('GET', '/settings/contract-types')).data;
  ok(Array.isArray(ctTypes) && ctTypes.length === 9 && ctTypes[0].name === 'Administração', 'tipos de contrato já vêm cadastrados');
  ok((await biNo('GET', '/settings/contract-types')).status === 403, 'tipos de contrato só para quem tem Contratos');
  const tyId = n => ctTypes.find(t => t.name === n).id;
  const biCtsCls = (await fo('GET', '/contracts')).data;
  const clsA1 = biCtsCls.find(c => c.title === 'Reforma - Casa Exemplo A1'), clsB1 = biCtsCls.find(c => c.title === 'Orçamento - Estudo Exemplo B1');
  ok(clsA1.company === 'charao' && clsA1.type_id === tyId('Reforma') && clsA1.type_name === 'Reforma', 'importação: tipo pelo início do nome (Reforma) e empresa Charão');
  ok(clsB1.company === 'lus' && clsB1.company_name.startsWith('Ludimila') && clsB1.type_id === tyId('Orçamento'), 'importação: recebimento na conta "(LUS)" → contrato da LuS');
  const clsBm = (await fo('GET', `/measurements/${(await fo('GET', `/contracts/${clsB1.id}`)).data.measurements[0].id}`)).data;
  ok(clsBm.contract.company_logo === '/assets/logo-lus-h.png' && clsBm.contract.company_name.startsWith('Ludimila'), 'boletim do contrato LuS sai com o logo e o nome da LuS');
  const ctLus = (await fo('POST', '/contracts', { client: 'Cliente Teste LuS', title: 'Projeto de interiores', bulletin_prefix: 'LUS', company: 'lus', type_id: tyId('Projeto'), items: [{ description: 'Projeto', unit: 'vb', unit_price: 1000, quantity: 1 }] })).data.id;
  let ctLusV = (await fo('GET', `/contracts/${ctLus}`)).data;
  ok(ctLusV.company === 'lus' && ctLusV.company_auto === 0 && ctLusV.type_name === 'Projeto', 'contrato cadastrado com empresa e tipo');
  ok((await fo('POST', '/contracts', { client: 'X', title: 'Y', bulletin_prefix: 'X', company: 'outra' })).status === 400, 'empresa inválida é recusada');
  ok((await fo('PUT', `/contracts/${ctLus}`, { type_id: '' })).data.type_id === null, 'contrato pode ficar sem tipo');
  // Painel filtrado por empresa e tipo
  const dCoLus = (await fo('GET', '/contracts/dashboard?empresa=lus')).data;
  ok(dCoLus.contracts.length >= 2 && dCoLus.contracts.every(c => c.company === 'lus') && dCoLus.filter.company === 'lus', 'painel filtrado: só contratos da LuS');
  const dCoAll = (await fo('GET', '/contracts/dashboard')).data;
  ok(dCoAll.totals.contracts > dCoLus.totals.contracts && dCoLus.companies.find(c => c.key === 'lus').contracts === dCoLus.contracts.length, 'totais seguem o filtro; contagem por empresa sempre completa');
  const dTySem = (await fo('GET', '/contracts/dashboard?tipo=sem')).data;
  ok(dTySem.contracts.every(c => !c.type_id) && dTySem.contracts.some(c => c.id === ctLus), 'filtro "Sem tipo" para revisar');
  const dTyRef = (await fo('GET', `/contracts/dashboard?tipo=${tyId('Reforma')}`)).data;
  ok(dTyRef.contracts.length && dTyRef.contracts.every(c => c.type_id === tyId('Reforma')), 'filtro por tipo');
  // Reenviar a planilha ajusta empresa/tipo do contrato importado (empresa automática), sem duplicar nada
  await fo('PUT', `/contracts/${clsA1.id}`, { company: 'lus' });
  ok((await fo('GET', `/contracts/${clsA1.id}`)).data.company_auto === 0, 'empresa escolhida à mão deixa de ser automática');
  const clsPv = (await fo('POST', '/contracts/import-bms/preview', { files: biFiles })).data;
  ok(clsPv.groups.find(g => g.obra === 'Reforma - Casa Exemplo A1').company === 'lus', 'reenvio respeita a empresa escolhida à mão');
  const clsApply = (await fo('POST', '/contracts/import-bms', { files: biFiles, mapping: { [biA2.key]: 'skip' }, classify: { [biA1.key]: { company: 'charao', type_id: tyId('Construção') } } })).data;
  const clsA1b = (await fo('GET', `/contracts/${clsA1.id}`)).data;
  ok(clsApply.bms === 0 && clsApply.reclassified >= 1 && clsA1b.company === 'charao' && clsA1b.type_name === 'Construção', 'na prévia dá para corrigir empresa e tipo dos contratos já importados');
  // Configurações: tipos de contrato
  const ctTypes2 = (await fo('PUT', '/settings/contract-types', { types: [...ctTypes.map(t => ({ id: t.id, name: t.name, active: true })), { name: 'Laudo técnico', active: true }] })).data;
  ok(ctTypes2.length === 10 && ctTypes2.at(-1).name === 'Laudo técnico', 'novo tipo de contrato em Configurações');
  ok((await fo('PUT', '/settings/contract-types', { types: ctTypes2.filter(t => t.name !== 'Orçamento').map(t => ({ id: t.id, name: t.name, active: true })) })).status === 400, 'tipo em uso não pode ser excluído');

  // ---------- Importar BMs: descartar um pagamento antes de importar ----------
  const dsPv = (await fo('POST', '/contracts/import-bms/preview', { files: biFiles })).data;
  const dsA2 = dsPv.groups.find(g => g.key === biA2.key);
  const dsOpen = dsA2.items.find(i => !i.received_date);
  ok(dsA2.items.length === 3 && dsA2.items.every(i => i.state === 'novo') && dsA2.value_add === 9000, 'prévia lista os pagamentos da obra, um a um');
  const dsPv2 = (await fo('POST', '/contracts/import-bms/preview', { files: biFiles, exclude: [dsOpen.key] })).data.groups.find(g => g.key === biA2.key);
  ok(dsPv2.value_add === 5000 && dsPv2.discarded === 1 && dsPv2.items.find(i => i.key === dsOpen.key).state === 'descartado', 'pagamento desmarcado sai do valor do contrato na prévia');
  const dsImp = (await fo('POST', '/contracts/import-bms', { files: biFiles, exclude: [dsOpen.key] })).data;
  const dsCt = (await fo('GET', '/contracts')).data.find(c => c.title === 'Projeto - Sala Exemplo A2');
  ok(dsImp.discarded === 1 && dsCt && dsCt.summary.value === 5000 && dsCt.summary.balance === 0, 'importado sem o pagamento descartado (contrato só com o que ficou)');
  const dsPv3 = (await fo('POST', '/contracts/import-bms/preview', { files: biFiles })).data.groups.find(g => g.key === biA2.key);
  ok(!dsPv3.pending && dsPv3.items.find(i => i.key === dsOpen.key).state === 'descartado' && dsPv3.items.find(i => i.key === dsOpen.key).saved_off, 'reenviar a planilha: o descartado continua fora');
  const dsPv4 = (await fo('POST', '/contracts/import-bms/preview', { files: biFiles, restore: [dsOpen.key] })).data.groups.find(g => g.key === biA2.key);
  ok(dsPv4.pending && dsPv4.value_add === 4000, 'pagamento descartado pode ser reativado na prévia');
  const dsRest = (await fo('POST', '/contracts/import-bms', { files: biFiles, restore: [dsOpen.key] })).data;
  ok(dsRest.restored === 1 && (await fo('GET', `/contracts/${dsCt.id}`)).data.summary.value === 9000, 'reativado: volta a somar no contrato');
  const dsDone = dsA2.items.find(i => i.received_date);
  ok((await fo('POST', '/contracts/import-bms', { files: biFiles, exclude: [dsDone.key] })).data.discarded === 0, 'pagamento já importado não é descartado');

  // ---------- Tarefas financeiras: planilha modelo e importação ----------
  const fiCookie = await cookieOf('ana@charao.eng.br');
  const fiTpl = await fetch(BASE + '/api/finance/import/template', { headers: { 'X-Requested-With': 'charao-app', cookie: fiCookie } });
  const fiBuf = Buffer.from(await fiTpl.arrayBuffer());
  const fiGrid = readXlsx(fiBuf);
  ok(fiTpl.status === 200 && fiTpl.headers.get('content-type').includes('spreadsheetml') && fiBuf.slice(0, 2).toString() === 'PK' && fiGrid[0][0] === 'Descrição *' && fiGrid[0][5] === 'Periodicidade *' && !fiGrid[0].includes('Favorecido') && fiGrid.length === 1,
    'planilha modelo: cabeçalho na aba Tarefas, sem linhas de exemplo');
  ok((await (await fetch(BASE + '/api/finance/import/template', { headers: { 'X-Requested-With': 'charao-app', cookie: await cookieOf('marcos@charao.eng.br') } })).status) === 403, 'planilha modelo só para quem tem Tarefas financeiras');
  await fo('POST', '/finance/obligations', { title: 'Aluguel teste importação', category: 'Aluguel e condomínio', amount: 2000, frequency: 'mensal', due_day: 5, start_month: '2099-01' });
  const fiAna = (await fo('GET', '/auth/me')).data.user;
  const fiHead = fiGrid[0];
  const fiFile = writeXlsx([{ name: 'Tarefas', header: true, rows: [fiHead,
    ['DAS teste importação', 'Impostos', '1.850,00', 'Sim', 'Sim', 'Mensal', 20, '01/2099', null, fiAna.name, 'Guia no portal'],
    ['Seguro anual teste', 'Seguros', 3600, 'Não', null, 'Anual', 15, 'mar/2099', '12/2101', null, null],
    ['Taxa única teste', null, 120.5, null, null, 'Única', 31, 72718, null, null, null],
    [null, 'Impostos', null, null, null, 'Quinzenal', 40, '13/2099', null, 'Pessoa Inexistente', null],
    ['Aluguel teste importação', 'Aluguel e condomínio', 2000, null, null, 'Mensal', 5, '01/2099', null, null, null],
    ['DAS teste importação', 'Impostos', 1850, null, null, 'Mensal', 20, '02/2099', null, null, null],
    ['Linha desmarcada teste', 'Outros', 10, null, null, 'Mensal', 1, '01/2099', null, null, null],
  ] }]).toString('base64');
  const fiPv = (await fo('POST', '/finance/import/preview', { file: { name: 'teste.xlsx', data: fiFile } })).data;
  const fiRow = n => fiPv.rows.find(r => r.line === n);
  ok(fiPv.totals.rows === 7 && fiPv.totals.ok === 4 && fiPv.totals.erro === 1 && fiPv.totals.existe === 1 && fiPv.totals.repetida === 1, `prévia: 4 prontas, 1 com erro, 1 já existe, 1 repetida (${JSON.stringify(fiPv.totals)})`);
  ok(fiRow(2).view.amount === 1850 && fiRow(2).view.variable && fiRow(2).view.repeat_last && fiRow(2).view.assignee_name === fiAna.name && fiRow(3).view.start_month === '2099-03' && fiRow(3).view.end_month === '2101-12' && fiRow(4).view.start_month === '2099-02' && fiRow(4).view.frequency === 'unica',
    'valores, Sim/Não, responsável e meses em vários formatos (MM/AAAA, mar/2099, data do Excel)');
  ok(fiRow(5).errors.length >= 4 && fiRow(5).errors.some(e => e.includes('Descrição')) && fiRow(5).errors.some(e => e.includes('Quinzenal')) && fiRow(5).errors.some(e => e.includes('Pessoa Inexistente')), 'linha com erro mostra o que corrigir');
  ok(fiRow(7).repeated_line === 2, 'repetida aponta a linha original');
  ok((await biNo('POST', '/finance/import/preview', { file: { name: 'teste.xlsx', data: fiFile } })).status === 403, 'sem liberação não importa');
  const fiImp = (await fo('POST', '/finance/import', { file: { name: 'teste.xlsx', data: fiFile }, skip: [8] })).data;
  const fiObs = (await fo('GET', '/finance/obligations')).data;
  ok(fiImp.imported === 3 && fiObs.some(o => o.title === 'DAS teste importação' && o.variable && o.repeat_last && o.due_day === 20) && fiObs.some(o => o.title === 'Seguro anual teste' && o.frequency === 'anual' && o.end_month === '2101-12')
    && !fiObs.some(o => o.title === 'Linha desmarcada teste') && fiObs.filter(o => o.title === 'Aluguel teste importação').length === 1, 'importa só as prontas e marcadas; a que já existia não duplica');
  ok((await fo('POST', '/finance/import', { file: { name: 'teste.xlsx', data: fiFile } })).data.imported === 1, 'reenviar: só a que ficou de fora entra (as importadas viram "já existe")');
  ok((await fo('POST', '/finance/import/preview', { file: { name: 'x.xlsx', data: writeXlsx([{ name: 'A', rows: [['outra coisa']] }]).toString('base64') } })).status === 400, 'planilha fora do modelo é recusada');

  // ---------- Projeto: planejamento por planilha (tarefas, subtarefas, dependências) ----------
  const plPid = (await fo('POST', '/projects', { name: 'Obra Planejamento Planilha', client: 'Cliente Plan', stages: [{ name: 'Fundação' }, { name: 'Bloco A' }] })).data.id;
  const plTplRes = await fetch(BASE + `/api/planning/template?projeto=${plPid}`, { headers: { 'X-Requested-With': 'charao-app', cookie: fiCookie } });
  const plTpl = readXlsx(Buffer.from(await plTplRes.arrayBuffer()));
  ok(plTplRes.status === 200 && plTpl[0][0] === 'ID *' && plTpl[0][2] === 'Título *' && plTpl[0][10] === 'Predecessoras (IDs)' && plTpl[0][11] === 'Sucessoras (IDs)', 'planilha modelo do planejamento (predecessoras e sucessoras)');
  const plCam = (await fo('GET', '/users')).data.find(u => u.email === 'camila@charao.eng.br');
  const plHead = plTpl[0];
  const plRows = [
    ['1', null, 'Fundação', 'Executar fundação', 'Fundação', null, '03/11/2099', '28/11/2099', 'Alta', 'Foto', null, '4', null, null],
    ['2', '1', 'Escavação', null, 'Fundação', plCam.name, '03/11/2099', '10/11/2099', null, 'Foto', null, null, null, 'subtarefa'],
    ['3', '1', 'Concretagem', null, 'Fundação', null, '11/11/2099', '28/11/2099', 'Urgente', null, null, null, null, null],
    ['4', null, 'Estrutura', 'Pilares e vigas', 'Bloco A', null, '01/11/2099', '20/12/2099', 'Média', 'Foto e descrição', null, null, '2', null],
  ];
  const plFile = rows => ({ name: 'plan.xlsx', data: writeXlsx([{ name: 'Planejamento', header: true, rows: [plHead, ...rows] }]).toString('base64') });
  const plPv = (await fo('POST', `/projects/${plPid}/planning/preview`, { file: plFile(plRows) })).data;
  ok(plPv.totals.ok === 4 && plPv.totals.erro === 0 && plPv.totals.subtasks === 2 && plPv.totals.deps === 1, `prévia do planejamento: 2 tarefas, 2 subtarefas, 1 dependência (${JSON.stringify(plPv.totals)})`);
  const plP4 = plPv.rows.find(r => r.ref === '4').view, plP1 = plPv.rows.find(r => r.ref === '1').view;
  ok(plP4.preds.length === 1 && plP4.preds[0].ref === '1' && plP4.preds[0].auto && plP1.succs[0].ref === '4' && !plP1.succs[0].auto && plPv.totals.auto === 1, 'sucessora preenchida: a predecessora do outro lado é completada automaticamente');
  const plBoth = (await fo('POST', `/projects/${plPid}/planning/preview`, { file: plFile([plRows[0], ['4', null, 'Estrutura', 'x', null, null, null, null, null, null, '1', null, '2', null]]) })).data;
  ok(plBoth.totals.deps === 1 && plBoth.totals.auto === 0, 'predecessora e sucessora preenchidas nos dois lados: uma ligação só');
  const plOnlyPred = (await fo('POST', `/projects/${plPid}/planning/preview`, { file: plFile([['1', null, 'A', 'x', null, null, null, null, null, null, null, null, null, null], ['2', null, 'B', 'x', null, null, null, null, null, null, '1', null, null, null]]) })).data;
  ok(plOnlyPred.rows.find(r => r.ref === '1').view.succs.some(x => x.ref === '2' && x.auto), 'predecessora preenchida: a sucessora do outro lado é completada automaticamente');
  ok(plPv.rows.find(r => r.ref === '2').view.description === null && plPv.rows.find(r => r.ref === '4').view.proof === 'Foto e descrição', 'descrição em branco e comprovação por nome');
  const plBad = (await fo('POST', `/projects/${plPid}/planning/preview`, { file: plFile([...plRows,
    ['5', '2', 'Neta', null, 'Bloco C', 'Ninguém Existe', '40/11/2099', null, 'Altíssima', null, '9', null, null, null],
    ['6', null, 'Ciclo A', 'x', null, null, null, null, null, null, null, '7', null, null],
    ['7', null, 'Ciclo B', 'x', null, null, null, null, null, null, null, '6', null, null],
    ['8', null, 'Depende de erro', 'x', null, null, null, null, null, null, '5', null, null, null],
    ['1', null, 'ID repetido', 'x', null, null, null, null, null, null, null, null, null, null],
  ]) })).data;
  const plErr = ref => plBad.rows.filter(r => r.ref === ref).flatMap(r => r.errors).join(' | ');
  ok(plErr('5').includes('já é subtarefa') && plErr('5').includes('Bloco C') && plErr('5').includes('Ninguém Existe') && plErr('5').includes('Início previsto inválido') && plErr('5').includes('Prioridade') && plErr('5').includes('9'), `erros por linha (subtarefa de subtarefa, classificação, responsável, prioridade, dependência inexistente): ${plErr('5')}`);
  ok(plErr('6').includes('circular') && plErr('7').includes('circular') && plErr('8').includes('erro') && plBad.rows.some(r => r.errors.some(e => e.includes('repetido'))), 'dependência circular, ID repetido e linha ligada a linha com erro');
  ok((await fo('POST', `/projects/${plPid}/planning`, { file: plFile([...plRows, ['9', null, 'Com erro', 'x', 'Inexistente', null, null, null, null, null, null, null, null, null]]) })).status === 400, 'com qualquer erro, nada é importado');
  ok((await fo('GET', `/projects/${plPid}`)).data.tasks.length === 0, 'nada gravado quando há erro');
  ok((await biNo('POST', `/projects/${plPid}/planning/preview`, { file: plFile(plRows) })).status === 403, 'sem acesso ao projeto não importa');
  const plImp = (await fo('POST', `/projects/${plPid}/planning`, { file: plFile(plRows) })).data;
  const plTasks = (await fo('GET', `/projects/${plPid}`)).data.tasks;
  const plT = t => plTasks.find(x => x.title === t);
  ok(plImp.tasks === 2 && plImp.subtasks === 2 && plImp.deps === 1 && plImp.granted.includes(plCam.name), `importado: 2 tarefas, 2 subtarefas, 1 dependência e acesso liberado (${JSON.stringify(plImp)})`);
  ok(plT('Escavação').parent_id === plT('Fundação').id && plT('Escavação').assignee_id === plCam.id && plT('Escavação').description === 'Escavação' && plT('Concretagem').priority === 'urgente', 'subtarefas ligadas à principal, responsável e descrição = título');
  ok(plT('Fundação').start_date === '2099-11-03' && plT('Fundação').due_date === '2099-11-28', 'principal acompanha as datas das subtarefas');
  ok(plT('Estrutura').start_date > '2099-11-28', `dependência ajusta o início da sucessora (fim da Fundação + 2 dias de folga): ${plT('Estrutura').start_date}`);
  ok((await login('camila@charao.eng.br').then(c => c('GET', `/projects/${plPid}`))).status === 200, 'responsável ganhou acesso ao projeto');

  // ---------- Contratos › Próximas ações ----------
  const acD = (await fo('GET', '/contracts/dashboard')).data;
  const acA1 = (await fo('GET', `/contracts/${clsA1.id}`)).data, acA2 = (await fo('GET', `/contracts/${dsCt.id}`)).data;
  ok(acA1.status === 'vigente' && acA1.summary.balance === 0 && acD.actions.some(a => a.kind === 'encerrar' && a.code === acA1.code && a.group), 'contrato vigente 100% medido: sugere encerrar (aviso agrupável)');
  ok(!acD.actions.some(a => a.kind === 'medir' && a.code === acA1.code), '100% medido não é cobrado de medição mensal');
  ok(acA2.summary.balance > 0 && !acD.actions.some(a => a.kind === 'medir' && a.code === acA2.code), 'contrato com saldo, mas sem medição mês a mês recente, não é cobrado de medição');
  ok(acD.actions.filter(a => a.kind === 'medir').every(a => a.group && a.group.startsWith('Sem medição de')), 'avisos de medição agrupáveis pelo mês');
  // Consistência: boletim emitido (aguardando NF) aparece igual no painel, no contrato e por cliente; contrato com pendência não é "encerrar"
  const csId = (await fo('POST', '/contracts', { client: 'Cliente Consistência', title: 'Serviço único', bulletin_prefix: 'CONS', items: [{ description: 'Serviço', unit: 'vb', unit_price: 5000, quantity: 1 }] })).data.id;
  const csM = (await fo('POST', `/contracts/${csId}/measurements`, { ref_month: '2026-01' })).data.id;
  const csIt = (await fo('GET', `/contracts/${csId}`)).data.items[0].id;
  await fo('PUT', `/measurements/${csM}`, { lines: { [csIt]: 1 }, adjustments: [{ description: 'Desconto comercial', amount: -300 }] });
  await fo('POST', `/measurements/${csM}/actions/issue`);
  const csD = (await fo('GET', '/contracts/dashboard')).data;
  const csC = csD.contracts.find(c => c.id === csId), csB = csD.by_client.find(b => b.client === 'Cliente Consistência');
  ok(csC.summary.to_bill === 4700 && csC.summary.balance === 0 && csB.to_bill === 4700 && csB.balance === 0, `aguardando NF igual no contrato e por cliente, mesmo com desconto (${csC.summary.to_bill}/${csB.to_bill})`);
  ok(csD.actions.some(a => a.kind === 'faturar' && a.client === 'Cliente Consistência') && !csD.actions.some(a => a.kind === 'encerrar' && a.code === csC.code), '100% medido com boletim aguardando NF: aparece em Faturar e não em "encerrar"');
  // Corrigir medição já emitida/recebida (somente administrador), mantendo situação, NF e recebimento
  const crM = (await fo('GET', `/measurements/${csM}`)).data;
  ok(crM.can.correct && crM.status === 'emitida', 'administrador pode corrigir boletim emitido');
  ok((await fo('PUT', `/measurements/${csM}/correction`, { adjustments: [{ description: 'Desconto comercial', amount: -500 }] })).status === 400, 'correção exige motivo');
  const crM2 = (await fo('PUT', `/measurements/${csM}/correction`, { reason: 'Desconto combinado era 500', adjustments: [{ description: 'Desconto comercial', amount: -500 }] })).data;
  ok(crM2.status === 'emitida' && crM2.totals.to_bill === 4500 && crM2.code === crM.code, 'boletim emitido corrigido: total novo, mesma situação e número');
  const crR = (await fo('GET', `/measurements/${kM1}`)).data;
  const crLines = Object.fromEntries(crR.rows.map(r => [r.item_id, r.qty]));
  const crKeep = (await fo('PUT', `/measurements/${kM1}/correction`, { reason: 'Inclui reajuste', lines: crLines, adjustments: [...crR.adjustments.filter(a => a.id).map(a => ({ description: a.description, amount: a.amount })), { description: 'Reajuste', amount: 100 }], paid: 'keep' })).data;
  ok(crKeep.status === 'recebida' && crKeep.totals.to_bill === r2t(crR.totals.to_bill + 100) && crKeep.paid_amount === crR.paid_amount && crKeep.nf_number === crR.nf_number, 'boletim recebido corrigido mantendo NF e valor recebido');
  const crTot = (await fo('PUT', `/measurements/${kM1}/correction`, { reason: 'Recebido com o reajuste', paid: 'total' })).data;
  ok(crTot.paid_amount === crTot.totals.to_bill, 'opção: valor recebido acompanha o novo total');
  ok((await fo('GET', '/audit')).data.some(a => a.action === 'Medição corrigida (boletim já emitido)'), 'correção registrada na auditoria com motivo');
  const crCam = await login('camila@charao.eng.br');
  ok((await crCam('PUT', `/measurements/${csM}/correction`, { reason: 'x' })).status === 403, 'quem não é administrador não corrige');
  // Nota fiscal não é pré-requisito: faturar sem NF e receber direto do boletim emitido
  const nfCt = (await fo('POST', '/contracts', { client: 'Cliente Sem NF', title: 'Serviço sem nota', bulletin_prefix: 'SNF', items: [{ description: 'Serviço', unit: 'vb', unit_price: 1000, quantity: 3 }] })).data.id;
  const nfIt = (await fo('GET', `/contracts/${nfCt}`)).data.items[0].id;
  const nfNew = async ref => { const id = (await fo('POST', `/contracts/${nfCt}/measurements`, { ref_month: ref })).data.id; await fo('PUT', `/measurements/${id}`, { lines: { [nfIt]: 1 } }); await fo('POST', `/measurements/${id}/actions/issue`); return id; };
  const nfA = await nfNew('2026-01');
  const nfAv = (await fo('POST', `/measurements/${nfA}/actions/bill`, { no_nf: true, nf_date: '2026-02-03' })).data;
  ok(nfAv.status === 'faturada' && nfAv.nf_number === null && nfAv.nf_date === '2026-02-03', 'faturar sem nota fiscal (data do faturamento/cobrança)');
  const nfB = await nfNew('2026-02');
  ok((await fo('GET', `/measurements/${nfB}`)).data.can.receive, 'boletim emitido já pode registrar recebimento');
  const nfBv = (await fo('POST', `/measurements/${nfB}/actions/receive`, { paid_date: '2026-03-10' })).data;
  ok(nfBv.status === 'recebida' && nfBv.nf_number === null && nfBv.nf_date === '2026-03-10' && nfBv.paid_amount === 1000, 'recebido direto do emitido, sem NF: data do recebimento vale como faturamento');
  const nfD = (await fo('GET', '/contracts/dashboard')).data;
  const nfAnn = nfD.annual.find(y => y.year === '2026');
  ok(nfD.contracts.find(c => c.id === nfCt).summary.billed === 2000 && nfAnn.billed[2] >= 1000 && nfAnn.received[2] >= 1000, 'sem NF também conta no faturado e recebido do painel');
  ok((await fo('POST', `/measurements/${nfB}/actions/undo`)).data.status === 'faturada' && (await fo('POST', `/measurements/${nfB}/actions/undo`)).data.status === 'emitida', 'desfazer volta para faturada e depois emitida');

}

main()
  .catch(e => { failed++; console.error(e); })
  .finally(() => {
    server.kill();
    setTimeout(() => fs.rmSync(DATA_DIR, { recursive: true, force: true }), 300);
    console.log(`\n${passed} passaram, ${failed} falharam`);
    process.exitCode = failed ? 1 : 0;
  });
