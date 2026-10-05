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
    return { status: res.status, data };
  };
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

async function main() {
  for (let i = 0; i < 50; i++) { try { await fetch(BASE + '/api/config'); break; } catch { await new Promise(r => setTimeout(r, 100)); } }

  console.log('Autenticação e sessão');
  const anon = client();
  ok((await anon('GET', '/dashboard')).status === 401, 'rota protegida exige login');
  ok((await anon('POST', '/auth/login', { email: 'ana@charao.eng.br', password: 'errada123' })).status === 401, 'senha inválida é rejeitada');
  const noCsrf = await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  ok(noCsrf.status === 403, 'mutação sem cabeçalho anti-CSRF é bloqueada');
  const ana = await login('ana@charao.eng.br');
  const ricardo = await login('ricardo@charao.eng.br');
  const juliana = await login('juliana@charao.eng.br');
  const marcos = await login('marcos@charao.eng.br');
  const bruno = await login('bruno@charao.eng.br');
  const camila = await login('camila@charao.eng.br');
  ok((await ana('GET', '/auth/me')).data.user.password_hash === undefined, 'hash de senha nunca é exposto');

  console.log('Restrição por projeto e perfil');
  const julProjects = (await juliana('GET', '/projects')).data.map(p => p.code);
  ok(julProjects.join() === 'PRJ-002,PRJ-004', `gestora restrita vê só PRJ-002 e PRJ-004 (${julProjects})`);
  ok((await juliana('GET', '/projects/1')).status === 404, 'gestora restrita não abre PRJ-001');
  const brunoTasks = (await bruno('GET', '/tasks')).data;
  ok(brunoTasks.every(t => t.assignee_name === 'Bruno Costa' || t.creator_name === 'Bruno Costa'), 'escopo "somente próprias" vê apenas as próprias tarefas');
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
  const upd = (await ricardo('PATCH', `/tasks/${t2}`, { due_date: '2099-03-01', assignee_id: 4 })).data;
  ok(upd.history.some(h => h.action === 'Prazo alterado' && h.details.includes('01/03/2099')), 'mudança de prazo registrada');
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
