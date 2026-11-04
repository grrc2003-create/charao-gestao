// Check-list: tarefa cujos "passos" são itens simples (sem tela própria). Cada item tem responsável opcional
// (sem responsável = o responsável global da tarefa), resposta Conforme / Não conforme / N/A, observação e fotos.
// A regra de fotos é do check-list inteiro: obrigatória em todos os itens respondidos (exceto N/A) ou livre escolha.
import { all, one, run, tx } from '../db.js';
import { badRequest, forbidden, notFound, str, oneOf, intOrNull, date } from '../lib/http.js';
import { today, addDays, daysBetween, decorate } from './metrics.js';
import { canExecuteTask, canManageTask, hasSection, canAccessProject } from '../lib/permissions.js';
import { audit, taskHistory } from './audit.js';
import { saveImageFromDataUrl, deleteStored, isPdf } from './files.js';
import { loadVisible, validateAssignee, autoStart, checklistMaxDue, readProgress } from './tasks.js';
import { applyShift, applyPull, projectEndOf } from './dependencies.js';

export const PHOTO_RULES = ['obrigatoria', 'livre'];
export const PHOTO_RULE_LABEL = { obrigatoria: 'Foto obrigatória em todos os itens', livre: 'Foto opcional (livre escolha)' };
export const RESULTS = ['conforme', 'nao_conforme', 'na'];
export const RESULT_LABEL = { conforme: 'Conforme', nao_conforme: 'Não conforme', na: 'N/A' };
const MAX_ITEMS = 500;
// Fotos por registro: no máximo 3 no cadastro (não conformidade de entrada) e 3 em cada resposta (não conformidade ou correção)
export const PHOTO_LIMIT = 3;
const readImages = list => (Array.isArray(list) ? list : []);
const assertPhotoLimit = (current, adding, what) => {
  if (current + adding > PHOTO_LIMIT) {
    const left = Math.max(PHOTO_LIMIT - current, 0);
    throw badRequest(`Limite de ${PHOTO_LIMIT} fotos por ${what}. ${left ? `Ainda é possível incluir ${left}.` : 'Remova uma foto para incluir outra.'}`);
  }
};

const nowIso = () => new Date().toISOString();
const isOpen = t => !t.cancelled_at && ['aberta', 'em_andamento'].includes(t.status);
const needsPhoto = (t, result) => t.photo_rule === 'obrigatoria' && (result === 'conforme' || result === 'nao_conforme');

// Prazo do item: data de término informada (opcional, não pode ser antes do início) ou início + quantidade de dias
function readDeadline(it, label) {
  const end = date(it?.due_date || null, `Data de término (${label})`);
  if (end) {
    const startEnd = date(it?.start_date || null, `Data de início (${label})`);
    if (startEnd && end < startEnd) throw badRequest(`A data de término não pode ser anterior à data de início (${label}).`);
    return { start_date: startEnd, duration_days: startEnd ? daysBetween(startEnd, end) : null, due_date: end };
  }
  const raw = it?.duration_days;
  const days = raw === '' || raw === null || raw === undefined ? null : Number(raw);
  if (days !== null && (!Number.isInteger(days) || days < 0 || days > 3650)) throw badRequest(`Prazo em dias inválido (${label}).`);
  let start = date(it?.start_date || null, `Data de início (${label})`);
  if (days !== null && !start) start = today();
  return { start_date: start, duration_days: days, due_date: start && days !== null ? addDays(start, days) : null };
}

// ---------- Equipe necessária do item ----------
// Cada linha é um profissional da Folha de Campo (diária do cadastro dele) ou só a função, com quantidade (diária genérica da função).
// Valores (diárias e custo) seguem a regra da Folha de Campo: só para a seção folha_campo. Os demais veem pessoas, funções e dias.
const MAX_TEAM = 30;
const r2 = v => Math.round((Number(v) || 0) * 100) / 100;
const canSeeCost = ctx => hasSection(ctx.user, 'folha_campo');
const TEAM_SQL = `SELECT e.*, ci.task_id, w.name AS worker_name, w.role AS worker_role, COALESCE(e.frozen_rate, w.daily_rate, r.daily_rate, 0) AS rate
  FROM checklist_item_team e LEFT JOIN field_workers w ON w.id = e.worker_id LEFT JOIN field_roles r ON r.name = e.role COLLATE NOCASE`;
const TEAM_ITEM = 'JOIN checklist_items ci ON ci.id = e.item_id';
const positive = (v, label, max) => {
  const n = Number(String(v ?? '').replace(',', '.'));
  if (!Number.isFinite(n) || n <= 0 || n > max) throw badRequest(`${label} inválido.`);
  return n;
};
// Profissional inativo ou função excluída continuam aceitos se já estavam no item (current)
function readTeam(list, projectId, label, current = []) {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list)) throw badRequest(`Equipe inválida (${label}).`);
  if (list.length > MAX_TEAM) throw badRequest(`A equipe aceita no máximo ${MAX_TEAM} linhas (${label}).`);
  const seen = new Set();
  return list.map(e => {
    const days = r2(positive(e?.days, `Dias da equipe (${label})`, 3650));
    const workerId = intOrNull(e?.worker_id);
    if (workerId) {
      if (seen.has(`w${workerId}`)) throw badRequest(`Profissional repetido na equipe (${label}).`);
      seen.add(`w${workerId}`);
      const w = one(`SELECT id, active FROM field_workers WHERE id = ? AND kind = 'diarista'`, workerId);
      if (!w) throw badRequest(`Profissional inválido na equipe (${label}).`);
      const inProject = !one('SELECT 1 FROM field_worker_projects WHERE worker_id = ?', workerId) || one('SELECT 1 FROM field_worker_projects WHERE worker_id = ? AND project_id = ?', workerId, projectId);
      if ((!w.active || !inProject) && !current.some(c => c.worker_id === workerId)) throw badRequest(`Profissional não disponível para esta obra (${label}).`);
      return { worker_id: workerId, role: null, qty: 1, days };
    }
    const role = str(e?.role, { max: 80, required: true, label: `Função da equipe (${label})` });
    const known = one('SELECT name FROM field_roles WHERE name = ? COLLATE NOCASE', role)?.name
      || current.find(c => String(c.role || '').toLowerCase() === role.toLowerCase())?.role;
    if (!known) throw badRequest(`Função "${role}" não cadastrada (${label}).`);
    if (seen.has(`r${known.toLowerCase()}`)) throw badRequest(`Função repetida na equipe (${label}): ajuste a quantidade.`);
    seen.add(`r${known.toLowerCase()}`);
    const qty = positive(e?.qty ?? 1, `Quantidade da equipe (${label})`, 999);
    if (!Number.isInteger(qty)) throw badRequest(`Quantidade da equipe inválida (${label}).`);
    return { worker_id: null, role: known, qty, days };
  });
}
// Guarda a diária do item Conforme; nos demais casos volta a acompanhar o cadastro
function syncTeamRates(itemId, result) {
  run('UPDATE checklist_item_team SET frozen_rate = NULL WHERE item_id = ?', itemId);
  if (result !== 'conforme') return;
  for (const e of all(`${TEAM_SQL} ${TEAM_ITEM} WHERE e.item_id = ?`, itemId)) run('UPDATE checklist_item_team SET frozen_rate = ? WHERE id = ?', e.rate, e.id);
}
function saveTeam(itemId, team, result = null) {
  run('DELETE FROM checklist_item_team WHERE item_id = ?', itemId);
  for (const e of team) run('INSERT INTO checklist_item_team (item_id, worker_id, role, qty, days) VALUES (?,?,?,?,?)', itemId, e.worker_id, e.role, e.qty, e.days);
  syncTeamRates(itemId, result);
}
const teamText = list => list.map(e => {
  const who = e.worker_id ? one('SELECT name FROM field_workers WHERE id = ?', e.worker_id)?.name : `${e.role}${e.qty > 1 ? ` ×${e.qty}` : ''}`;
  return `${who} ${String(e.days).replace('.', ',')}d`;
}).join(', ') || 'sem equipe';
// Opções do passo Equipe: profissionais ligados à obra (ou sem obra escolhida) e funções cadastradas
export function teamOptions(ctx, projectId) {
  if (!one('SELECT id FROM projects WHERE id = ?', projectId)) throw notFound('Projeto não encontrado.');
  if (!canAccessProject(ctx.user, projectId, ctx.projects)) throw forbidden('Sem acesso a este projeto.');
  const money = canSeeCost(ctx);
  const workers = all(`SELECT id, name, role, daily_rate AS rate FROM field_workers w WHERE active = 1 AND kind = 'diarista'
    AND (NOT EXISTS (SELECT 1 FROM field_worker_projects x WHERE x.worker_id = w.id) OR EXISTS (SELECT 1 FROM field_worker_projects x WHERE x.worker_id = w.id AND x.project_id = ?))
    ORDER BY name`, projectId);
  const roles = all('SELECT name, daily_rate AS rate FROM field_roles ORDER BY name');
  const clean = list => (money ? list : list.map(({ rate, ...x }) => x));
  return { project_id: projectId, workers: clean(workers), roles: clean(roles), can_see_cost: money };
}
// Função genérica cadastrada na hora de definir a equipe: entra na mesma lista da Folha de Campo. Quem tem acesso à obra cadastra
// o nome; a diária só vale para quem vê valores (editar e excluir continuam na Folha de Campo). Nome repetido usa a que já existe.
export function createTeamRole(ctx, projectId, body, ip) {
  if (!one('SELECT id FROM projects WHERE id = ?', projectId)) throw notFound('Projeto não encontrado.');
  if (!canAccessProject(ctx.user, projectId, ctx.projects)) throw forbidden('Sem acesso a este projeto.');
  const money = canSeeCost(ctx);
  const name = str(body?.name, { max: 80, required: true, label: 'Função' });
  const view = r => ({ name: r.name, ...(money ? { rate: r.daily_rate } : {}) });
  const found = one('SELECT name, daily_rate FROM field_roles WHERE name = ? COLLATE NOCASE', name);
  if (found) return { role: view(found), created: false };
  const raw = money && body?.daily_rate !== undefined && body.daily_rate !== null && body.daily_rate !== '' ? Number(String(body.daily_rate).replace(',', '.')) : 0;
  if (!Number.isFinite(raw) || raw < 0 || raw > 100000) throw badRequest('Valor da diária inválido.');
  const rate = r2(raw);
  const id = Number(run('INSERT INTO field_roles (name, daily_rate) VALUES (?,?)', name, rate).lastInsertRowid);
  audit(ctx.user.id, 'field', id, 'Função de campo cadastrada', { nome: name, ...(money ? { diaria: rate } : {}), origem: 'equipe do check-list' }, ip);
  return { role: view({ name, daily_rate: rate }), created: true };
}
// Duplicar tarefa: a função sempre vai junto; o profissional, só se mantiver os responsáveis e estiver disponível na obra de destino
export function teamForCopy(itemId, projectId, keepWorkers) {
  return all('SELECT worker_id, role, qty, days FROM checklist_item_team WHERE item_id = ? ORDER BY id', itemId).filter(e => {
    if (!e.worker_id) return true;
    if (!keepWorkers) return false;
    return !!one('SELECT id FROM field_workers WHERE id = ? AND active = 1', e.worker_id)
      && (!one('SELECT 1 FROM field_worker_projects WHERE worker_id = ?', e.worker_id) || !!one('SELECT 1 FROM field_worker_projects WHERE worker_id = ? AND project_id = ?', e.worker_id, projectId));
  });
}

// Itens enviados pelo formulário: [{ group, text, description, assignee_id, start_date, duration_days, images, team }]
// (responsável validado contra a equipe do projeto; com foto obrigatória, cada item novo precisa da foto de entrada)
export function readItems(list, projectId, { required = false, requirePhoto = false } = {}) {
  const arr = Array.isArray(list) ? list : [];
  if (arr.length > MAX_ITEMS) throw badRequest(`O check-list aceita no máximo ${MAX_ITEMS} itens.`);
  const items = arr.map((it, i) => {
    const text = str(it?.text, { max: 300, required: true, label: `Texto do item ${i + 1}` });
    const images = readImages(it?.images);
    if (images.length > PHOTO_LIMIT) throw badRequest(`Limite de ${PHOTO_LIMIT} fotos por não conformidade (item "${text}").`);
    if (requirePhoto && !images.length) throw badRequest(`Foto obrigatória: o item "${text}" precisa de uma foto de entrada.`);
    return {
      group: str(it?.group, { max: 80, label: 'Grupo' }) || null,
      specialty: str(it?.specialty, { max: 80, label: 'Especialidade' }) || null,
      text,
      description: str(it?.description, { max: 2000, label: `Descrição do item ${i + 1}` }) || null,
      assignee_id: validateAssignee(intOrNull(it?.assignee_id), projectId),
      ...readDeadline(it, `item ${i + 1}`),
      images,
      team: readTeam(it?.team, projectId, `item ${i + 1}`),
    };
  });
  if (required && !items.length) throw badRequest('Inclua ao menos um item no check-list.');
  return items;
}

// Posição do item: no fim do grupo já existente (os seguintes são renumerados) ou no fim da lista
function slotFor(taskId, group) {
  const last = group ? one('SELECT MAX(seq) AS n FROM checklist_items WHERE task_id = ? AND group_name = ?', taskId, group).n : null;
  if (last) {
    run('UPDATE checklist_items SET seq = seq + 1 WHERE task_id = ? AND seq > ?', taskId, last);
    return last + 1;
  }
  return one('SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM checklist_items WHERE task_id = ?', taskId).n;
}

// O prazo da tarefa acompanha o maior prazo dos itens (registrado no histórico quando muda)
function syncTaskDue(t, userId) {
  const maxDue = checklistMaxDue(t.id);
  const cur = one('SELECT due_date FROM tasks WHERE id = ?', t.id).due_date;
  if (!maxDue || maxDue === cur) return;
  const fmt = d => (d ? d.split('-').reverse().join('/') : 'sem prazo');
  run('UPDATE tasks SET due_date = ?, updated_at = ? WHERE id = ?', maxDue, nowIso(), t.id);
  taskHistory(t.id, userId, 'Prazo do check-list ajustado', `${fmt(cur)} → ${fmt(maxDue)} · acompanha o maior prazo dos itens`);
}

// Grava os itens (e as fotos de entrada). userId = quem está criando.
export function insertItems(taskId, items, userId) {
  for (const it of items) {
    const id = Number(run(`INSERT INTO checklist_items (task_id, seq, group_name, specialty, text, description, assignee_id, start_date, duration_days, due_date, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`, taskId, slotFor(taskId, it.group), it.group, it.specialty || null, it.text, it.description || null, it.assignee_id,
      it.start_date || null, it.duration_days ?? null, it.due_date || null, nowIso()).lastInsertRowid);
    if (it.images?.length) saveItemPhotos({ user: { id: userId } }, id, it.images, null, 'referencia');
    if (it.team?.length) saveTeam(id, it.team);
  }
}

// Ao trocar o grupo de um item, ele passa para o fim do novo grupo e a numeração é refeita
function moveToGroup(taskId, itemId, group) {
  run('UPDATE checklist_items SET seq = -1 WHERE id = ?', itemId);
  const seq = slotFor(taskId, group);
  run('UPDATE checklist_items SET seq = ?, group_name = ? WHERE id = ?', seq, group, itemId);
  renumber(taskId);
}

const renumber = taskId => all('SELECT id FROM checklist_items WHERE task_id = ? ORDER BY seq', taskId)
  .forEach((r, i) => run('UPDATE checklist_items SET seq = ? WHERE id = ?', i + 1, r.id));

const ITEM_SQL = `SELECT ci.*, u.name AS assignee_name, u.is_external AS a_external, u.login_enabled AS a_login, u.manager_id AS a_leader,
    ab.name AS answered_by_name
  FROM checklist_items ci LEFT JOIN users u ON u.id = ci.assignee_id LEFT JOIN users ab ON ab.id = ci.answered_by`;

// Responsável do item (ou o líder dele, quando é terceirizado sem acesso ao sistema)
const isItemOwner = (ctx, item) => !!item.assignee_id
  && (item.assignee_id === ctx.user.id || (!!item.a_external && !item.a_login && item.a_leader === ctx.user.id));

// Responde: o responsável global e quem gerencia a tarefa (criador, gestor/coordenador, administrador) respondem
// qualquer item; os demais responsáveis, só os itens deles
export const canAnswerItem = (ctx, t, item) => isOpen(t) && (canExecuteTask(ctx, t) || canManageTask(ctx, t) || isItemOwner(ctx, item));
// Itens (incluir, editar, atribuir, excluir): quem gerencia a tarefa e o responsável global, com o check-list aberto
export const canManageItems = (ctx, t) => isOpen(t) && (canManageTask(ctx, t) || canExecuteTask(ctx, t));
const isMine = (ctx, t, item) => isItemOwner(ctx, item) || (!item.assignee_id && t.assignee_id === ctx.user.id);

// Resolvido = Conforme ou N/A. Não conforme continua pendente até ser corrigido.
export const isResolved = r => r === 'conforme' || r === 'na';

// Histórico de respostas de cada item, com as fotos de cada resposta (e as avulsas, ainda sem resposta)
function historyByItem(taskId) {
  const answers = all(`SELECT a.id, a.item_id, a.result, a.note, a.reason, a.created_at, u.name AS user_name
    FROM checklist_answers a JOIN checklist_items ci ON ci.id = a.item_id LEFT JOIN users u ON u.id = a.user_id
    WHERE ci.task_id = ? ORDER BY a.id`, taskId).map(a => ({ ...a, files: [] }));
  const byAnswer = new Map(answers.map(a => [a.id, a]));
  const m = new Map();
  const of = id => { if (!m.has(id)) m.set(id, { answers: [], loose: [], refs: [] }); return m.get(id); };
  for (const a of answers) of(a.item_id).answers.push(a);
  for (const f of all(`SELECT f.id, f.item_id, f.answer_id, f.kind, f.mime, f.created_at, u.name AS user_name FROM checklist_files f
      JOIN checklist_items ci ON ci.id = f.item_id LEFT JOIN users u ON u.id = f.uploaded_by WHERE ci.task_id = ? ORDER BY f.id`, taskId)) {
    const ans = f.answer_id && byAnswer.get(f.answer_id);
    if (f.kind === 'referencia') of(f.item_id).refs.push(f);
    else if (ans) ans.files.push(f); else of(f.item_id).loose.push(f);
  }
  return m;
}

// Estado do item: resposta atual, fotos atuais, quantas vezes ficou não conforme e o par antes × depois.
// Todo item cadastrado JÁ É uma não conformidade (com ou sem foto; a foto do cadastro, quando há, registra o problema):
// fica em aberto até ser corrigido (Conforme) ou encerrado (N/A). "Antes" = foto da não conformidade mais recente (ou a do cadastro).
function itemState(item, h = { answers: [], loose: [], refs: [] }) {
  const current = item.result ? h.answers.at(-1) || null : null;
  const ncs = h.answers.filter(a => a.result === 'nao_conforme');
  const registered = true;
  const lastNcPhoto = [...ncs].reverse().map(a => a.files.at(-1)).find(Boolean) || null;
  const currentFiles = current ? current.files : [];
  const beforePhoto = lastNcPhoto || h.refs[0] || null;
  const afterPhoto = item.result === 'conforme' ? currentFiles[0] || null : null;
  return {
    current, currentFiles, loose: h.loose, refs: h.refs, answers: h.answers, registered,
    nc_count: ncs.length + (registered ? 1 : 0),
    open_nc: !isResolved(item.result) && (item.result === 'nao_conforme' || (!item.result && registered)),
    before: beforePhoto && afterPhoto ? beforePhoto : null,
    after: beforePhoto && afterPhoto ? afterPhoto : null,
    // Capa: Não conforme → foto mais recente da não conformidade; ainda sem resposta → foto de entrada
    cover: item.result === 'nao_conforme' ? currentFiles.at(-1) || lastNcPhoto : !item.result ? h.refs[0] || null : null,
  };
}

function check(t, rows, hist) {
  // Todo item cadastrado é não conformidade: em aberto até Conforme ou N/A
  const unanswered = 0;
  const ncOpen = rows.filter(i => !isResolved(i.result)).length;
  const noPhoto = rows.filter(i => isResolved(i.result) && needsPhoto(t, i.result) && !itemState(i, hist.get(i.id)).currentFiles.length).length;
  const missing = [];
  if (unanswered) missing.push(`${unanswered} ${unanswered === 1 ? 'item sem resposta' : 'itens sem resposta'}`);
  if (ncOpen) missing.push(`${ncOpen} ${ncOpen === 1 ? 'não conformidade em aberto' : 'não conformidades em aberto'} (corrija e marque Conforme ou N/A)`);
  if (noPhoto) missing.push(`${noPhoto} ${noPhoto === 1 ? 'item sem a foto obrigatória' : 'itens sem a foto obrigatória'}`);
  return { ok: rows.length > 0 && !missing.length, missing: rows.length ? missing : ['nenhum item cadastrado'] };
}

// Conferência antes de enviar/concluir: tudo Conforme ou N/A (e com foto, se obrigatória)
export function checklistCheck(t) {
  return check(t, all('SELECT id, result FROM checklist_items WHERE task_id = ?', t.id), historyByItem(t.id));
}

// Dados do check-list para a tela da tarefa e para o relatório PDF
export function checklistView(ctx, t) {
  const rows = all(`${ITEM_SQL} WHERE ci.task_id = ? ORDER BY ci.seq`, t.id);
  const hist = historyByItem(t.id);
  const ref = today();
  const money = canSeeCost(ctx);
  const teams = new Map();
  for (const e of all(`${TEAM_SQL} ${TEAM_ITEM} WHERE ci.task_id = ? ORDER BY e.id`, t.id)) {
    if (!teams.has(e.item_id)) teams.set(e.item_id, []);
    teams.get(e.item_id).push(e);
  }
  // Posição do item na sequência programada de cada profissional (relatório por profissional)
  const planSeq = new Map(all('SELECT p.worker_id, p.item_id, p.seq, p.gap_days, p.working_at FROM checklist_plan p JOIN checklist_items ci ON ci.id = p.item_id WHERE ci.task_id = ?', t.id).map(p => [`${p.worker_id}:${p.item_id}`, p]));
  const items = rows.map(i => {
    const st = itemState(i, hist.get(i.id));
    const team = teams.get(i.id) || [];
    const cost = r2(team.reduce((n, e) => n + e.qty * e.days * e.rate, 0));
    return {
      team: team.map(e => ({ id: e.id, worker_id: e.worker_id, role: e.worker_id ? e.worker_role : e.role, name: e.worker_name || null, qty: e.qty, days: e.days, plan_seq: planSeq.get(`${e.worker_id}:${i.id}`)?.seq ?? null, plan_gap: planSeq.get(`${e.worker_id}:${i.id}`)?.gap_days || 0, working_at: !isResolved(i.result) ? planSeq.get(`${e.worker_id}:${i.id}`)?.working_at || null : null,
        ...(money ? { rate: e.rate, value: r2(e.qty * e.days * e.rate) } : {}) })),
      ...(money ? { cost, cost_missing: team.some(e => !e.rate) } : {}),
      id: i.id, seq: i.seq, group: i.group_name, specialty: i.specialty || null, text: i.text,
      assignee_id: i.assignee_id, assignee_name: i.assignee_name, assignee_external: !!i.a_external,
      responsible_name: i.assignee_name || t.assignee_name || 'Sem responsável',
      result: i.result, resolved: isResolved(i.result), note: i.note, answered_by_name: i.answered_by_name, answered_at: i.answered_at,
      description: i.description, start_date: i.start_date, duration_days: i.duration_days, due_date: i.due_date,
      progress_pct: isResolved(i.result) ? 100 : i.progress_pct ?? null,
      started_on: i.started_on || null,
      overdue: !isResolved(i.result) && !!i.due_date && i.due_date < ref,
      refs: st.refs,
      files: [...st.currentFiles, ...st.loose], loose_count: st.loose.length,
      nc_count: st.nc_count, open_nc: st.open_nc, registered: st.registered, before: st.before, after: st.after, cover: st.cover,
      // Histórico: o cadastro com foto é o 1º registro de não conformidade
      history: [
        ...(st.registered ? [{ id: 'cadastro', registration: true, result: 'nao_conforme', note: null, reason: null, user_name: st.refs[0]?.user_name || null, created_at: st.refs[0]?.created_at || i.created_at, files: st.refs }] : []),
        ...st.answers.map(a => ({ id: a.id, result: a.result, note: a.note, reason: a.reason, user_name: a.user_name, created_at: a.created_at, files: a.files })),
      ],
      can_answer: canAnswerItem(ctx, t, i),
      mine: isMine(ctx, t, i),
    };
  });
  const count = r => items.filter(i => i.result === r).length;
  const done = items.filter(i => i.resolved).length;
  // Total: N/A não é executado e fica de fora; "executado" = itens Conforme
  const costOf = list => r2(list.reduce((n, i) => n + (i.cost || 0), 0));
  const counted = items.filter(i => i.result !== 'na');
  return {
    photo_rule: t.photo_rule || 'livre',
    can_see_cost: money,
    ...(money ? { cost: { total: costOf(counted), done: costOf(counted.filter(i => i.result === 'conforme')), pending: costOf(counted.filter(i => i.result !== 'conforme')),
      items: counted.filter(i => i.team.length).length, missing: counted.filter(i => i.cost_missing).length, na: costOf(items.filter(i => i.result === 'na')) } } : {}),
    items,
    summary: {
      total: items.length, done, pct: items.length ? Math.round((done / items.length) * 100) : 0,
      // Avanço do check-list: média dos itens (resolvido = 100%, senão o avanço informado ou 0)
      progress: items.length ? Math.round(items.reduce((n, i) => n + (i.resolved ? 100 : i.progress_pct || 0), 0) / items.length) : 0,
      conforme: count('conforme'), nao_conforme: items.filter(i => i.open_nc).length, na: count('na'), pending: items.filter(i => !i.result).length,
      nc_total: items.reduce((n, i) => n + i.nc_count, 0),
      overdue: items.filter(i => i.overdue).length,
      mine_pending: items.filter(i => i.mine && !i.resolved).length,
    },
    check: check(t, rows, hist),
    can_manage_items: canManageItems(ctx, t),
    locked: !isOpen(t),
  };
}

export function loadChecklistTask(ctx, taskId) {
  const t = loadVisible(ctx, taskId);
  if (t.task_type !== 'checklist') throw badRequest('Esta tarefa não é um check-list.');
  return t;
}

function loadItem(t, itemId) {
  const item = one(`${ITEM_SQL} WHERE ci.id = ? AND ci.task_id = ?`, itemId, t.id);
  if (!item) throw notFound('Item não encontrado.');
  return item;
}

// Quando o líder responde por um terceirizado sem acesso ao sistema, isso fica no histórico
function behalfText(ctx, t, item) {
  if (item.assignee_id && item.assignee_id !== ctx.user.id && item.a_external && !item.a_login) {
    return `registrado por ${ctx.user.name} (líder) em nome de ${item.assignee_name} (terceirizado)`;
  }
  if (!item.assignee_id && t.assignee_id !== ctx.user.id && t.assignee_external && !t.assignee_login) {
    return `registrado por ${ctx.user.name} (líder) em nome de ${t.assignee_name} (terceirizado)`;
  }
  return null;
}

function saveItemPhotos(ctx, itemId, images, answerId, kind = 'resposta') {
  const saved = [];
  try {
    for (const img of images) {
      const f = saveImageFromDataUrl(img?.data);
      saved.push(f);
      if (isPdf(f.mime)) throw badRequest('Nos itens do check-list use fotos (imagens).');
    }
  } catch (e) {
    for (const f of saved) deleteStored(f.stored_name);
    throw e;
  }
  for (const f of saved) {
    run('INSERT INTO checklist_files (item_id, answer_id, kind, stored_name, mime, size, uploaded_by, created_at) VALUES (?,?,?,?,?,?,?,?)',
      itemId, answerId ?? null, kind, f.stored_name, f.mime, f.size, ctx.user.id, nowIso());
  }
  return saved.length;
}

const currentAnswerId = item => (item.result ? one('SELECT MAX(id) AS id FROM checklist_answers WHERE item_id = ?', item.id).id : null);

// Responder (ou trocar a resposta), registrar observação e anexar fotos — tudo numa chamada só.
// Cada resposta nova vira um registro do histórico com as próprias fotos. Alterar um item já Conforme/N/A exige justificativa.
// Avanço parcial do item (0–100% ou null). Itens já resolvidos contam 100%.
export function setItemProgress(ctx, taskId, itemId, body = {}) {
  const t = loadChecklistTask(ctx, taskId);
  const item = loadItem(t, itemId);
  if (!canAnswerItem(ctx, t, item)) {
    throw isOpen(t) ? forbidden('Este item é de outro responsável.') : badRequest('O check-list não pode ser alterado neste status.');
  }
  if (isResolved(item.result)) throw badRequest('Item já resolvido: o avanço é 100%.');
  const v = readProgress(body.progress);
  if (v === (item.progress_pct ?? null)) return;
  const fmt = x => (x === null || x === undefined ? 'não informado' : `${x}%`);
  tx(() => {
    run('UPDATE checklist_items SET progress_pct = ? WHERE id = ?', v, item.id);
    taskHistory(t.id, ctx.user.id, `Avanço do item ${item.seq} atualizado`, `${item.text}: ${fmt(item.progress_pct)} → ${fmt(v)}`);
    // Avanço sem início marcado: o realizado começa hoje (o planejado não muda)
    if (v && !item.started_on) markStarted(ctx, t, item, today());
    if (v) autoStart(ctx, t);
  });
}

// Início REALIZADO do item: hoje, um dia informado ou desmarcar. O planejado (start_date) e as dependências não mudam.
function markStarted(ctx, t, item, day) {
  run('UPDATE checklist_items SET started_on = ?, started_by = ? WHERE id = ?', day, ctx.user.id, item.id);
  taskHistory(t.id, ctx.user.id, 'Início real do item registrado', `${item.seq}. ${item.text} · iniciado em ${day.split('-').reverse().join('/')}`);
}
export function setItemStart(ctx, taskId, itemId, body = {}) {
  const t = loadChecklistTask(ctx, taskId);
  const item = loadItem(t, itemId);
  if (!canAnswerItem(ctx, t, item)) {
    throw isOpen(t) ? forbidden('Este item é de outro responsável.') : badRequest('O check-list não pode ser alterado neste status.');
  }
  if ([true, 'true', '1', 1, 'on'].includes(body.clear)) {
    if (item.result || item.progress_pct) throw badRequest('Este item já tem avanço ou resposta: informe o dia certo em vez de desmarcar.');
    if (!item.started_on) return;
    tx(() => {
      run('UPDATE checklist_items SET started_on = NULL, started_by = NULL WHERE id = ?', item.id);
      taskHistory(t.id, ctx.user.id, 'Início real do item desmarcado', `${item.seq}. ${item.text}`);
    });
    return;
  }
  const day = date(body.date || null, 'Dia do início') || today();
  if (day < '2000-01-01') throw badRequest('Data inválida: confira o ano.');
  if (day > today()) throw badRequest('O início real não pode ser no futuro. O planejado fica nas datas do item.');
  if (day === item.started_on) return;
  tx(() => {
    markStarted(ctx, t, item, day);
    if (!isResolved(item.result)) autoStart(ctx, t);
  });
}

// Avanço calculado dos check-lists (para o Gantt): média dos itens, resolvidos = 100%
export function checklistProgress(taskIds) {
  if (!taskIds.length) return new Map();
  return new Map(all(`SELECT task_id, ROUND(AVG(CASE WHEN result IN ('conforme','na') THEN 100 ELSE COALESCE(progress_pct, 0) END)) AS p
    FROM checklist_items WHERE task_id IN (${taskIds.map(() => '?').join(',')}) GROUP BY task_id`, ...taskIds).map(r => [r.task_id, r.p]));
}

export function answerItem(ctx, taskId, itemId, body = {}) {
  const t = loadChecklistTask(ctx, taskId);
  const item = loadItem(t, itemId);
  if (!canAnswerItem(ctx, t, item)) {
    throw isOpen(t) ? forbidden('Este item é de outro responsável.') : badRequest('O check-list não pode ser alterado neste status.');
  }
  const result = 'result' in body ? oneOf(body.result, RESULTS, 'Resposta') : null;
  const changing = !!result && result !== item.result;
  let reason = null;
  if (changing && isResolved(item.result)) {
    reason = str(body.reason, { max: 500, label: 'Justificativa da alteração' });
    if (!reason || reason.length < 5) throw badRequest(`O item estava "${RESULT_LABEL[item.result]}". Informe a justificativa para alterar a resposta.`);
  }
  const note = 'note' in body ? str(body.note, { max: 1000, label: 'Observação' }) : undefined;
  const images = readImages(body.images);
  const loose = one(`SELECT COUNT(*) AS n FROM checklist_files WHERE item_id = ? AND answer_id IS NULL AND kind = 'resposta'`, item.id).n;
  // Limite por resposta: nova resposta = fotos avulsas + enviadas; mesma resposta = fotos que ela já tem + enviadas
  if (images.length) {
    const target = changing ? result : item.result;
    const cur = changing || !item.result ? loose : one('SELECT COUNT(*) AS n FROM checklist_files WHERE answer_id = ?', currentAnswerId(item)).n;
    assertPhotoLimit(cur, images.length, target === 'nao_conforme' ? 'não conformidade' : target ? 'correção' : 'resposta');
  }
  // Foto obrigatória: cada resposta Conforme/Não conforme precisa da sua própria foto (a do "depois" não é a do "antes")
  if (changing && needsPhoto(t, result) && images.length + loose === 0) {
    throw badRequest('Foto obrigatória: tire uma foto do item para responder.');
  }
  if (!changing && note === undefined && !images.length) return;
  const behalf = behalfText(ctx, t, item);
  const label = `${item.seq}. ${item.text}`;
  tx(() => {
    let n = 0;
    if (changing) {
      const now = nowIso();
      const ansNote = note !== undefined ? note : null;
      const ansId = Number(run('INSERT INTO checklist_answers (item_id, result, note, reason, user_id, created_at) VALUES (?,?,?,?,?,?)',
        item.id, result, ansNote, reason, ctx.user.id, now).lastInsertRowid);
      run(`UPDATE checklist_files SET answer_id = ? WHERE item_id = ? AND answer_id IS NULL AND kind = 'resposta'`, ansId, item.id);
      n = images.length ? saveItemPhotos(ctx, item.id, images, ansId) : 0;
      run('UPDATE checklist_items SET result = ?, note = ?, answered_by = ?, answered_at = ? WHERE id = ?', result, ansNote, ctx.user.id, now, item.id);
      syncTeamRates(item.id, result);
      // Item resolvido depois do prazo: empurra as sucessoras do item pelo atraso real
      const finishDay = today();
      if (isResolved(result) && item.due_date && finishDay > item.due_date) {
        applyShift({ userId: ctx.user.id, projectId: t.project_id, cause: { taskId: t.id, itemId: item.id, code: `${t.code}·${item.seq}`, title: item.text }, kind: 'conclusao_atrasada',
          causeOldDue: item.due_date, causeNewDue: finishDay, projectEndBefore: projectEndOf(t.project_id), sources: [{ key: `i:${item.id}`, finish: finishDay }] });
      }
      const ncs = one(`SELECT COUNT(*) AS n FROM checklist_answers WHERE item_id = ? AND result = 'nao_conforme'`, item.id).n;
      const what = item.result ? `${RESULT_LABEL[item.result]} → ${RESULT_LABEL[result]}` : RESULT_LABEL[result];
      const extra = [result === 'nao_conforme' && ncs > 1 ? `${ncs}ª não conformidade` : '', reason ? `Justificativa: ${reason}` : '',
        n ? `${n} foto(s)` : '', ansNote ? `Obs.: ${ansNote}` : '', behalf].filter(Boolean).join(' · ');
      taskHistory(t.id, ctx.user.id, item.result ? 'Resposta de item alterada' : 'Item do check-list respondido', `${label}: ${what}${extra ? ` · ${extra}` : ''}`);
    } else {
      const ansId = currentAnswerId(item);
      n = images.length ? saveItemPhotos(ctx, item.id, images, ansId) : 0;
      if (note !== undefined) {
        run('UPDATE checklist_items SET note = ? WHERE id = ?', note, item.id);
        if (ansId) run('UPDATE checklist_answers SET note = ? WHERE id = ?', note, ansId);
      }
      if (n) taskHistory(t.id, ctx.user.id, 'Foto anexada a item do check-list', `${label} · ${n} foto(s)${behalf ? ` · ${behalf}` : ''}`);
      if (note !== undefined && note !== item.note) {
        taskHistory(t.id, ctx.user.id, 'Observação de item registrada', `${label}${note ? `: ${note}` : ' (removida)'}${behalf ? ` · ${behalf}` : ''}`);
      }
    }
    autoStart(ctx, t);
  });
}

export function removeItemFile(ctx, taskId, itemId, fileId) {
  const t = loadChecklistTask(ctx, taskId);
  const item = loadItem(t, itemId);
  const f = one('SELECT * FROM checklist_files WHERE id = ? AND item_id = ?', fileId, item.id);
  if (!f) throw notFound('Foto não encontrada.');
  if (f.kind === 'referencia') {
    if (!canManageItems(ctx, t)) throw forbidden('Você não pode alterar a foto de entrada deste item.');
    if (t.photo_rule === 'obrigatoria' && one(`SELECT COUNT(*) AS n FROM checklist_files WHERE item_id = ? AND kind = 'referencia'`, item.id).n <= 1) {
      throw badRequest('A foto de entrada é obrigatória neste check-list. Inclua a nova foto antes de remover esta.');
    }
  } else if (!canAnswerItem(ctx, t, item)) throw forbidden('Você não pode alterar as fotos deste item.');
  const cur = currentAnswerId(item);
  if (cur && f.answer_id === cur && needsPhoto(t, item.result) && one('SELECT COUNT(*) AS n FROM checklist_files WHERE answer_id = ?', cur).n <= 1) {
    throw badRequest('A foto é obrigatória neste check-list. Anexe a nova foto antes de remover esta.');
  }
  tx(() => {
    run('DELETE FROM checklist_files WHERE id = ?', f.id);
    taskHistory(t.id, ctx.user.id, 'Foto removida de item do check-list', `${item.seq}. ${item.text}`);
  });
  deleteStored(f.stored_name);
}

// ---------- Manutenção dos itens (quem gerencia a tarefa e o responsável global, enquanto aberta/em andamento) ----------
function assertManage(ctx, t) {
  if (!isOpen(t)) throw badRequest('Os itens só podem ser alterados com o check-list aberto ou em andamento.');
  if (!canManageItems(ctx, t)) throw forbidden('Apenas o responsável global, quem criou o check-list, o gestor/coordenador ou o administrador alteram os itens.');
}

export function addItems(ctx, taskId, body) {
  const t = loadChecklistTask(ctx, taskId);
  assertManage(ctx, t);
  const items = readItems(body.items, t.project_id, { required: true, requirePhoto: t.photo_rule === 'obrigatoria' });
  const total = one('SELECT COUNT(*) AS n FROM checklist_items WHERE task_id = ?', t.id).n;
  if (total + items.length > MAX_ITEMS) throw badRequest(`O check-list aceita no máximo ${MAX_ITEMS} itens.`);
  tx(() => {
    insertItems(t.id, items, ctx.user.id);
    taskHistory(t.id, ctx.user.id, 'Itens adicionados ao check-list', `${items.length} item(ns)`);
    syncTaskDue(t, ctx.user.id);
  });
}

export function updateItem(ctx, taskId, itemId, body) {
  const t = loadChecklistTask(ctx, taskId);
  assertManage(ctx, t);
  const item = loadItem(t, itemId);
  const next = {};
  const changes = [];
  if ('text' in body) {
    const v = str(body.text, { max: 300, required: true, label: 'Texto do item' });
    if (v !== item.text) { next.text = v; changes.push(`texto: ${v}`); }
  }
  if ('group' in body) {
    const v = str(body.group, { max: 80, label: 'Grupo' }) || null;
    if (v !== item.group_name) { next.group_name = v; changes.push(`grupo: ${v || 'sem grupo'}`); }
  }
  if ('specialty' in body) {
    const v = str(body.specialty, { max: 80, label: 'Especialidade' }) || null;
    if (v !== (item.specialty || null)) { next.specialty = v; changes.push(`especialidade: ${v || 'sem especialidade'}`); }
  }
  if ('description' in body) {
    const v = str(body.description, { max: 2000, label: 'Descrição' }) || null;
    if (v !== item.description) { next.description = v; changes.push('descrição alterada'); }
  }
  if ('start_date' in body || 'duration_days' in body || 'due_date' in body) {
    const start = 'start_date' in body ? body.start_date : item.start_date;
    const d = 'due_date' in body
      ? readDeadline({ start_date: start, due_date: body.due_date }, 'item')
      : 'duration_days' in body ? readDeadline({ start_date: start, duration_days: body.duration_days }, 'item')
        : readDeadline({ start_date: start, due_date: item.due_date }, 'item');
    if (d.start_date !== item.start_date || d.due_date !== item.due_date) {
      Object.assign(next, d);
      changes.push(`prazo: ${d.due_date ? d.due_date.split('-').reverse().join('/') : 'sem prazo'}`);
    }
  }
  if ('assignee_id' in body) {
    const v = validateAssignee(intOrNull(body.assignee_id), t.project_id);
    if (v !== item.assignee_id) {
      next.assignee_id = v;
      const name = id => (id ? one('SELECT name FROM users WHERE id = ?', id)?.name : `${t.assignee_name || 'sem responsável'} (global)`);
      changes.push(`responsável: ${name(item.assignee_id)} → ${name(v)}`);
    }
  }
  // Equipe: o histórico mostra pessoas e dias, nunca valores (o histórico é visto por toda a equipe do projeto)
  let teamNext = null;
  if ('team' in body) {
    const current = all('SELECT worker_id, role, qty, days FROM checklist_item_team WHERE item_id = ? ORDER BY id', item.id);
    const v = readTeam(body.team, t.project_id, 'item', current);
    if (JSON.stringify(v) !== JSON.stringify(current)) { teamNext = v; changes.push(`equipe: ${teamText(v)}`); }
  }
  const fields = Object.keys(next);
  if (!fields.length && !teamNext) return;
  const endBefore = projectEndOf(t.project_id);
  const clDueBefore = checklistMaxDue(t.id) || t.due_date;
  tx(() => {
    const groupChanged = 'group_name' in next;
    const group = next.group_name;
    delete next.group_name;
    const rest = Object.keys(next);
    if (rest.length) run(`UPDATE checklist_items SET ${rest.map(f => `${f} = ?`).join(', ')} WHERE id = ?`, ...rest.map(f => next[f]), item.id);
    if (groupChanged) moveToGroup(t.id, item.id, group);
    if (teamNext) saveTeam(item.id, teamNext, item.result);
    taskHistory(t.id, ctx.user.id, 'Item do check-list alterado', `${item.seq}. ${item.text} · ${changes.join(' · ')}`);
    syncTaskDue(t, ctx.user.id);
    // Prazo do item adiado: empurra as sucessoras do item (e as do check-list, se o prazo dele também andou)
    if (next.due_date && (!item.due_date || next.due_date > item.due_date)) {
      const clDueAfter = checklistMaxDue(t.id) || t.due_date;
      applyShift({ userId: ctx.user.id, projectId: t.project_id, cause: { taskId: t.id, itemId: item.id, code: `${t.code}·${item.seq}`, title: item.text }, kind: 'prazo_item',
        causeOldDue: item.due_date, causeNewDue: next.due_date, projectEndBefore: endBefore,
        sources: [{ key: `i:${item.id}`, finish: next.due_date }, ...(clDueAfter && clDueAfter !== clDueBefore ? [{ key: `t:${t.id}`, finish: clDueAfter }] : [])] });
    }
    // Prazo do item antecipado com a opção marcada: puxa as sucessoras (do item e, se o prazo do check-list diminuiu, as dele)
    if ([true, 'true', '1', 'on', 1].includes(body.pull_successors) && next.due_date && item.due_date && next.due_date < item.due_date) {
      const clDueAfter = checklistMaxDue(t.id) || t.due_date;
      applyPull({ userId: ctx.user.id, cause: { taskId: t.id, itemId: item.id, code: `${t.code}·${item.seq}`, title: item.text },
        sources: [{ key: `i:${item.id}`, oldFinish: item.due_date, newFinish: next.due_date }, ...(clDueBefore && clDueAfter && clDueAfter < clDueBefore ? [{ key: `t:${t.id}`, oldFinish: clDueBefore, newFinish: clDueAfter }] : [])] });
    }
  });
}

// Fotos de entrada (referência) de um item já criado
export function addReferencePhotos(ctx, taskId, itemId, body) {
  const t = loadChecklistTask(ctx, taskId);
  assertManage(ctx, t);
  const item = loadItem(t, itemId);
  const images = readImages(body.images);
  if (!images.length) throw badRequest('Nenhuma foto enviada.');
  const refs = one(`SELECT COUNT(*) AS n FROM checklist_files WHERE item_id = ? AND kind = 'referencia'`, item.id).n;
  assertPhotoLimit(refs, images.length, 'não conformidade');
  tx(() => {
    const n = saveItemPhotos(ctx, item.id, images, null, 'referencia');
    taskHistory(t.id, ctx.user.id, 'Foto de entrada incluída no item', `${item.seq}. ${item.text} · ${n} foto(s)`);
  });
}

// Atribuir vários itens de uma vez (ex.: um grupo inteiro)
export function assignItems(ctx, taskId, body) {
  const t = loadChecklistTask(ctx, taskId);
  assertManage(ctx, t);
  const ids = [...new Set((Array.isArray(body.item_ids) ? body.item_ids : []).map(intOrNull).filter(Boolean))];
  if (!ids.length) throw badRequest('Selecione os itens.');
  const aid = validateAssignee(intOrNull(body.assignee_id), t.project_id);
  const valid = all(`SELECT id FROM checklist_items WHERE task_id = ? AND id IN (${ids.map(() => '?').join(',')})`, t.id, ...ids).map(r => r.id);
  if (valid.length !== ids.length) throw badRequest('Item inválido.');
  const name = aid ? one('SELECT name FROM users WHERE id = ?', aid).name : `${t.assignee_name || 'sem responsável'} (global)`;
  tx(() => {
    run(`UPDATE checklist_items SET assignee_id = ? WHERE id IN (${ids.map(() => '?').join(',')})`, aid, ...ids);
    taskHistory(t.id, ctx.user.id, 'Responsável de itens do check-list alterado', `${ids.length} item(ns) → ${name}`);
  });
}

// Equipe de vários itens de uma vez. Adicionar: mantém o que há e atualiza quem já estava; substituir: troca a equipe inteira.
// Item Conforme fica de fora: a diária dele já está fechada no custo executado. Tudo ou nada, com uma linha só no histórico.
export function setItemsTeam(ctx, taskId, body) {
  const t = loadChecklistTask(ctx, taskId);
  assertManage(ctx, t);
  const ids = [...new Set((Array.isArray(body.item_ids) ? body.item_ids : []).map(intOrNull).filter(Boolean))];
  if (!ids.length) throw badRequest('Selecione os itens.');
  const mode = oneOf(body.mode, ['add', 'replace'], 'Como aplicar a equipe');
  const items = all(`SELECT id, seq, text, result FROM checklist_items WHERE task_id = ? AND id IN (${ids.map(() => '?').join(',')}) ORDER BY seq`, t.id, ...ids);
  if (items.length !== ids.length) throw badRequest('Item inválido.');
  const incoming = readTeam(body.team, t.project_id, 'equipe');
  if (mode === 'add' && !incoming.length) throw badRequest('Escolha quem entra na equipe.');
  const targets = items.filter(i => i.result !== 'conforme');
  if (!targets.length) throw badRequest('Os itens escolhidos estão Conforme: a diária deles já está fechada.');
  const keyOf = e => (e.worker_id ? `w${e.worker_id}` : `r${String(e.role).toLowerCase()}`);
  const writes = [];
  for (const i of targets) {
    const current = all('SELECT worker_id, role, qty, days FROM checklist_item_team WHERE item_id = ? ORDER BY id', i.id);
    let next = incoming;
    if (mode === 'add') {
      const novo = new Map(incoming.map(e => [keyOf(e), e]));
      const kept = current.map(e => { const n = novo.get(keyOf(e)); if (n) novo.delete(keyOf(e)); return n || e; });
      next = [...kept, ...novo.values()];
    }
    if (next.length > MAX_TEAM) throw badRequest(`A equipe aceita no máximo ${MAX_TEAM} linhas (item ${i.seq}).`);
    if (JSON.stringify(next) !== JSON.stringify(current)) writes.push({ item: i, next });
  }
  if (writes.length) tx(() => {
    for (const w of writes) saveTeam(w.item.id, w.next, w.item.result);
    const seqs = writes.map(w => w.item.seq);
    taskHistory(t.id, ctx.user.id, 'Equipe de itens do check-list alterada', `Itens ${seqs.slice(0, 40).join(', ')}${seqs.length > 40 ? ` e mais ${seqs.length - 40}` : ''} · ${mode === 'add' ? 'adicionado' : 'equipe trocada por'}: ${teamText(incoming)}`);
  });
  return { updated: writes.length, unchanged: targets.length - writes.length, skipped: items.length - targets.length };
}

export function deleteItem(ctx, taskId, itemId) {
  const t = loadChecklistTask(ctx, taskId);
  assertManage(ctx, t);
  const item = loadItem(t, itemId);
  if (item.result || one('SELECT 1 FROM checklist_answers WHERE item_id = ? LIMIT 1', item.id)) throw badRequest('Item já respondido não pode ser excluído.');
  if (one('SELECT COUNT(*) AS n FROM checklist_items WHERE task_id = ?', t.id).n <= 1) throw badRequest('O check-list precisa ter ao menos um item.');
  const files = all('SELECT stored_name FROM checklist_files WHERE item_id = ?', item.id);
  tx(() => {
    run('DELETE FROM checklist_items WHERE id = ?', item.id);
    renumber(t.id);
    taskHistory(t.id, ctx.user.id, 'Item excluído do check-list', `${item.seq}. ${item.text}`);
    syncTaskDue(t, ctx.user.id);
  });
  for (const f of files) deleteStored(f.stored_name);
}

// Foto de item: só para quem vê o check-list
export function checklistFileForUser(ctx, fileId) {
  const f = one('SELECT f.*, ci.task_id FROM checklist_files f JOIN checklist_items ci ON ci.id = f.item_id WHERE f.id = ?', fileId);
  if (!f) throw notFound('Arquivo não encontrado.');
  loadVisible(ctx, f.task_id);
  return f;
}

export function checklistStoredFiles(taskId) {
  return all('SELECT f.stored_name FROM checklist_files f JOIN checklist_items ci ON ci.id = f.item_id WHERE ci.task_id = ?', taskId);
}

export const answeredCount = taskId => one('SELECT COUNT(*) AS n FROM checklist_answers a JOIN checklist_items ci ON ci.id = a.item_id WHERE ci.task_id = ?', taskId).n;

// Itens pendentes atribuídos ao usuário (ou a terceirizados sem acesso liderados por ele), por check-list
export function myPendingItems(ctx) {
  const uid = ctx.user.id;
  return all(`SELECT t.id, t.code, t.title, t.due_date, p.code AS project_code, p.name AS project_name, COUNT(*) AS pending
    FROM checklist_items ci JOIN tasks t ON t.id = ci.task_id JOIN projects p ON p.id = t.project_id
    LEFT JOIN users u ON u.id = ci.assignee_id
    WHERE t.cancelled_at IS NULL AND t.status IN ('aberta','em_andamento') AND (ci.result IS NULL OR ci.result = 'nao_conforme')
      AND (ci.assignee_id = ? OR (u.is_external = 1 AND u.login_enabled = 0 AND u.manager_id = ?))
    GROUP BY t.id ORDER BY t.due_date IS NULL, t.due_date`, uid, uid);
}

// ---------- Indicadores: itens do check-list contados como subtarefas ----------
// Conforme/N/A = concluída (entregue na data da resposta); Não conforme = em andamento; sem resposta = aberta.
// Prazo do item (ou do check-list); responsável do item (ou o global). Fica atrasada se o prazo passou sem resolver.
export function checklistItemsAsSubtasks(tasks) {
  const lists = tasks.filter(t => t.task_type === 'checklist' && !t.cancelled_at);
  if (!lists.length) return [];
  const byId = new Map(lists.map(t => [t.id, t]));
  const ref = today();
  const ids = lists.map(t => t.id);
  const rows = all(`SELECT ci.id, ci.task_id, ci.seq, ci.text, ci.group_name, ci.assignee_id, ci.result, ci.answered_at, ci.due_date, ci.created_at,
      u.name AS assignee_name, (SELECT COUNT(*) FROM checklist_answers a WHERE a.item_id = ci.id) AS answers,
      (SELECT COUNT(*) FROM checklist_files f WHERE f.item_id = ci.id AND f.kind = 'referencia') AS refs
    FROM checklist_items ci LEFT JOIN users u ON u.id = ci.assignee_id WHERE ci.task_id IN (${ids.map(() => '?').join(',')})`, ...ids);
  return rows.map(i => {
    const t = byId.get(i.task_id);
    const resolved = isResolved(i.result);
    const status = resolved ? 'concluida' : 'em_andamento'; // não conformidade em aberto desde o cadastro
    return decorate({
      id: `cl-${i.id}`, checklist_item: true, task_type: 'checklist_item', parent_id: t.id, parent_code: t.code,
      code: `${t.code}·${i.seq}`, title: i.text, stage_name: i.group_name,
      project_id: t.project_id, project_code: t.project_code, project_name: t.project_name, project_kind: t.project_kind, project_restricted: t.project_restricted,
      assignee_id: i.assignee_id || t.assignee_id, assignee_name: i.assignee_name || t.assignee_name,
      creator_id: null, assigned_by_id: t.creator_id,
      status, due_date: i.due_date || t.due_date, original_due: null, reschedule_count: 0,
      delivered_at: resolved ? i.answered_at : null, completed_at: resolved ? i.answered_at : null,
      created_at: i.created_at, cancelled_at: null,
    }, ref, [], 3);
  });
}

// ---------- Dashboard: situação de cada check-list ----------
// userId: inclui os itens daquela pessoa (atribuídos a ela ou, sem responsável próprio, quando ela é a responsável global)
export function checklistDashboard(tasks, { userId = null, ctx = null } = {}) {
  let lists = tasks.filter(t => t.task_type === 'checklist' && !t.cancelled_at);
  const mine = new Map();
  if (userId && lists.length) {
    const ids0 = lists.map(t => t.id);
    for (const r of all(`SELECT ci.task_id, COUNT(*) AS total, SUM(ci.result IS NULL OR ci.result = 'nao_conforme') AS open
        FROM checklist_items ci JOIN tasks t ON t.id = ci.task_id
        WHERE ci.task_id IN (${ids0.map(() => '?').join(',')}) AND (ci.assignee_id = ? OR (ci.assignee_id IS NULL AND t.assignee_id = ?))
        GROUP BY ci.task_id`, ...ids0, userId, userId)) mine.set(r.task_id, r);
    // Check-lists em que a pessoa é a responsável global ou tem itens
    lists = lists.filter(t => t.assignee_id === userId || mine.has(t.id));
  }
  if (!lists.length) return [];
  const ids = lists.map(t => t.id);
  const ref = today();
  const stats = new Map(all(`SELECT ci.task_id,
      COUNT(*) AS total,
      SUM(ci.result IN ('conforme','na')) AS resolved,
      SUM(ci.result IS NULL OR ci.result = 'nao_conforme') AS nc_open,
      SUM(ci.result IN ('conforme','na')) AS nc_resolved,
      SUM(ci.result IS NULL) AS pending,
      SUM(ci.result IS NOT 'conforme' AND ci.result IS NOT 'na' AND ci.due_date IS NOT NULL AND ci.due_date < ?) AS overdue
    FROM checklist_items ci WHERE ci.task_id IN (${ids.map(() => '?').join(',')}) GROUP BY ci.task_id`, ref, ...ids).map(r => [r.task_id, r]));
  // Equipe do cartão (itens N/A ficam de fora). Pessoas: cada profissional conta uma vez e cada função conta pela maior
  // quantidade pedida num item (Pedreiro ×2 em dois itens = 2 pessoas). Valor: só para a seção Folha de Campo.
  const money = !!ctx && canSeeCost(ctx);
  const teams = new Map();
  for (const e of all(`${TEAM_SQL} ${TEAM_ITEM} WHERE ci.task_id IN (${ids.map(() => '?').join(',')}) AND ci.result IS NOT 'na'`, ...ids)) {
    if (!teams.has(e.task_id)) teams.set(e.task_id, { workers: new Set(), roles: new Map(), cost: 0, missing: false });
    const g = teams.get(e.task_id);
    if (e.worker_id) g.workers.add(e.worker_id);
    else g.roles.set(e.role.toLowerCase(), Math.max(g.roles.get(e.role.toLowerCase()) || 0, e.qty));
    g.cost += e.qty * e.days * e.rate;
    if (!e.rate) g.missing = true;
  }
  const RANK = { atrasada: 0, em_andamento: 1, aberta: 1, aguardando_conferencia: 2, concluida: 3 };
  return lists.map(t => {
    const g = teams.get(t.id);
    const s = stats.get(t.id) || { total: 0, resolved: 0, nc_open: 0, nc_resolved: 0, pending: 0, overdue: 0 };
    return {
      id: t.id, code: t.code, title: t.title, project_code: t.project_code, project_name: t.project_name,
      assignee_name: t.assignee_name, due_date: t.due_date, eff_status: t.eff_status, status: t.status, days_late: t.days_late, days_to_due: t.days_to_due, photo_rule: t.photo_rule,
      total: s.total, resolved: s.resolved || 0, nc_open: s.nc_open || 0, nc_resolved: s.nc_resolved || 0, pending: s.pending || 0, overdue: s.overdue || 0,
      pct: s.total ? Math.round(((s.resolved || 0) / s.total) * 100) : 0,
      people: g ? g.workers.size + [...g.roles.values()].reduce((n, q) => n + q, 0) : 0,
      ...(money ? { cost: r2(g?.cost), cost_missing: !!g?.missing } : {}),
      ...(userId ? { user_items: mine.get(t.id)?.total || 0, user_open: mine.get(t.id)?.open || 0, user_global: t.assignee_id === userId } : {}),
    };
  }).sort((a, b) => RANK[a.eff_status] - RANK[b.eff_status] || b.nc_open + b.overdue - (a.nc_open + a.overdue) || (a.due_date || '9999').localeCompare(b.due_date || '9999'));
}
