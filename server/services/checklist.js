// Check-list: tarefa cujos "passos" são itens simples (sem tela própria). Cada item tem responsável opcional
// (sem responsável = o responsável global da tarefa), resposta Conforme / Não conforme / N/A, observação e fotos.
// A regra de fotos é do check-list inteiro: obrigatória em todos os itens respondidos (exceto N/A) ou livre escolha.
import { all, one, run, tx } from '../db.js';
import { badRequest, forbidden, notFound, str, oneOf, intOrNull } from '../lib/http.js';
import { canExecuteTask, canManageTask } from '../lib/permissions.js';
import { taskHistory } from './audit.js';
import { saveImageFromDataUrl, deleteStored, isPdf } from './files.js';
import { loadVisible, validateAssignee, autoStart } from './tasks.js';

export const PHOTO_RULES = ['obrigatoria', 'livre'];
export const PHOTO_RULE_LABEL = { obrigatoria: 'Foto obrigatória em todos os itens', livre: 'Foto opcional (livre escolha)' };
export const RESULTS = ['conforme', 'nao_conforme', 'na'];
export const RESULT_LABEL = { conforme: 'Conforme', nao_conforme: 'Não conforme', na: 'N/A' };
const MAX_ITEMS = 500;
const MAX_PHOTOS_PER_SEND = 5;

const nowIso = () => new Date().toISOString();
const isOpen = t => !t.cancelled_at && ['aberta', 'em_andamento'].includes(t.status);
const needsPhoto = (t, result) => t.photo_rule === 'obrigatoria' && (result === 'conforme' || result === 'nao_conforme');

// Itens enviados pelo formulário: [{ group, text, assignee_id }] (responsável validado contra a equipe do projeto)
export function readItems(list, projectId, { required = false } = {}) {
  const arr = Array.isArray(list) ? list : [];
  if (arr.length > MAX_ITEMS) throw badRequest(`O check-list aceita no máximo ${MAX_ITEMS} itens.`);
  const items = arr.map((it, i) => ({
    group: str(it?.group, { max: 80, label: 'Grupo' }) || null,
    text: str(it?.text, { max: 300, required: true, label: `Texto do item ${i + 1}` }),
    assignee_id: validateAssignee(intOrNull(it?.assignee_id), projectId),
  }));
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

export function insertItems(taskId, items) {
  for (const it of items) {
    run('INSERT INTO checklist_items (task_id, seq, group_name, text, assignee_id, created_at) VALUES (?,?,?,?,?,?)',
      taskId, slotFor(taskId, it.group), it.group, it.text, it.assignee_id, nowIso());
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

// Responde: o responsável global responde qualquer item; os demais, só os itens deles
export const canAnswerItem = (ctx, t, item) => isOpen(t) && (canExecuteTask(ctx, t) || isItemOwner(ctx, item));
// Itens (incluir, editar, atribuir, excluir): quem gerencia a tarefa e o responsável global, com o check-list aberto
export const canManageItems = (ctx, t) => isOpen(t) && (canManageTask(ctx, t) || canExecuteTask(ctx, t));
const isMine = (ctx, t, item) => isItemOwner(ctx, item) || (!item.assignee_id && t.assignee_id === ctx.user.id);

function filesByItem(taskId) {
  const m = new Map();
  for (const f of all(`SELECT f.id, f.item_id, f.mime, f.created_at FROM checklist_files f
      JOIN checklist_items ci ON ci.id = f.item_id WHERE ci.task_id = ? ORDER BY f.id`, taskId)) {
    if (!m.has(f.item_id)) m.set(f.item_id, []);
    m.get(f.item_id).push(f);
  }
  return m;
}

function check(t, items, files) {
  const unanswered = items.filter(i => !i.result).length;
  const noPhoto = items.filter(i => needsPhoto(t, i.result) && !(files.get(i.id) || []).length).length;
  const missing = [];
  if (unanswered) missing.push(`${unanswered} ${unanswered === 1 ? 'item sem resposta' : 'itens sem resposta'}`);
  if (noPhoto) missing.push(`${noPhoto} ${noPhoto === 1 ? 'item sem a foto obrigatória' : 'itens sem a foto obrigatória'}`);
  return { ok: items.length > 0 && !missing.length, missing: items.length ? missing : ['nenhum item cadastrado'] };
}

// Conferência antes de enviar/concluir
export function checklistCheck(t) {
  return check(t, all('SELECT id, result FROM checklist_items WHERE task_id = ?', t.id), filesByItem(t.id));
}

// Dados do check-list para a tela da tarefa e para o relatório PDF
export function checklistView(ctx, t) {
  const rows = all(`${ITEM_SQL} WHERE ci.task_id = ? ORDER BY ci.seq`, t.id);
  const files = filesByItem(t.id);
  const items = rows.map(i => ({
    id: i.id, seq: i.seq, group: i.group_name, text: i.text,
    assignee_id: i.assignee_id, assignee_name: i.assignee_name, assignee_external: !!i.a_external,
    responsible_name: i.assignee_name || t.assignee_name || 'Sem responsável',
    result: i.result, note: i.note, answered_by_name: i.answered_by_name, answered_at: i.answered_at,
    files: files.get(i.id) || [],
    can_answer: canAnswerItem(ctx, t, i),
    mine: isMine(ctx, t, i),
  }));
  const count = r => items.filter(i => i.result === r).length;
  const done = items.filter(i => i.result).length;
  return {
    photo_rule: t.photo_rule || 'livre',
    items,
    summary: {
      total: items.length, done, pct: items.length ? Math.round((done / items.length) * 100) : 0,
      conforme: count('conforme'), nao_conforme: count('nao_conforme'), na: count('na'),
      mine_pending: items.filter(i => i.mine && !i.result).length,
    },
    check: check(t, rows, files),
    can_manage_items: canManageItems(ctx, t),
  };
}

function loadChecklistTask(ctx, taskId) {
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

function saveItemPhotos(ctx, itemId, images) {
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
    run('INSERT INTO checklist_files (item_id, stored_name, mime, size, uploaded_by, created_at) VALUES (?,?,?,?,?,?)',
      itemId, f.stored_name, f.mime, f.size, ctx.user.id, nowIso());
  }
  return saved.length;
}

// Responder (ou trocar a resposta), registrar observação e anexar fotos — tudo numa chamada só
export function answerItem(ctx, taskId, itemId, body = {}) {
  const t = loadChecklistTask(ctx, taskId);
  const item = loadItem(t, itemId);
  if (!canAnswerItem(ctx, t, item)) {
    throw isOpen(t) ? forbidden('Este item é de outro responsável.') : badRequest('O check-list não pode ser alterado neste status.');
  }
  const hasResult = 'result' in body;
  const result = hasResult && body.result !== '' && body.result !== null ? oneOf(body.result, RESULTS, 'Resposta') : null;
  const note = 'note' in body ? str(body.note, { max: 1000, label: 'Observação' }) : undefined;
  const images = Array.isArray(body.images) ? body.images.slice(0, MAX_PHOTOS_PER_SEND) : [];
  const finalResult = hasResult ? result : item.result;
  const existing = one('SELECT COUNT(*) AS n FROM checklist_files WHERE item_id = ?', item.id).n;
  if (needsPhoto(t, finalResult) && existing + images.length === 0) {
    throw badRequest('Foto obrigatória: tire uma foto do item para responder.');
  }
  const changedResult = hasResult && result !== item.result;
  if (!changedResult && note === undefined && !images.length) return;
  const behalf = behalfText(ctx, t, item);
  const label = `${item.seq}. ${item.text}`;
  tx(() => {
    const n = images.length ? saveItemPhotos(ctx, item.id, images) : 0;
    const sets = [], vals = [];
    if (changedResult) { sets.push('result = ?', 'answered_by = ?', 'answered_at = ?'); vals.push(result, result ? ctx.user.id : null, result ? nowIso() : null); }
    if (note !== undefined) { sets.push('note = ?'); vals.push(note); }
    if (sets.length) run(`UPDATE checklist_items SET ${sets.join(', ')} WHERE id = ?`, ...vals, item.id);
    const extra = [n ? `${n} foto(s)` : '', note && note !== item.note ? `Obs.: ${note}` : '', behalf].filter(Boolean).join(' · ');
    if (changedResult) {
      const action = !result ? 'Resposta de item removida' : item.result ? 'Resposta de item alterada' : 'Item do check-list respondido';
      const what = item.result && result ? `${RESULT_LABEL[item.result]} → ${RESULT_LABEL[result]}` : RESULT_LABEL[result || item.result];
      taskHistory(t.id, ctx.user.id, action, `${label}: ${what}${extra ? ` · ${extra}` : ''}`);
    } else if (n) {
      taskHistory(t.id, ctx.user.id, 'Foto anexada a item do check-list', `${label}${extra ? ` · ${extra}` : ''}`);
    } else if (note !== undefined && note !== item.note) {
      taskHistory(t.id, ctx.user.id, 'Observação de item registrada', `${label}${note ? `: ${note}` : ' (removida)'}${behalf ? ` · ${behalf}` : ''}`);
    }
    autoStart(ctx, t);
  });
}

export function removeItemFile(ctx, taskId, itemId, fileId) {
  const t = loadChecklistTask(ctx, taskId);
  const item = loadItem(t, itemId);
  if (!canAnswerItem(ctx, t, item)) throw forbidden('Você não pode alterar as fotos deste item.');
  const f = one('SELECT * FROM checklist_files WHERE id = ? AND item_id = ?', fileId, item.id);
  if (!f) throw notFound('Foto não encontrada.');
  const count = one('SELECT COUNT(*) AS n FROM checklist_files WHERE item_id = ?', item.id).n;
  if (needsPhoto(t, item.result) && count <= 1) throw badRequest('A foto é obrigatória neste check-list. Anexe a nova foto antes de remover esta.');
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
  const items = readItems(body.items, t.project_id, { required: true });
  const total = one('SELECT COUNT(*) AS n FROM checklist_items WHERE task_id = ?', t.id).n;
  if (total + items.length > MAX_ITEMS) throw badRequest(`O check-list aceita no máximo ${MAX_ITEMS} itens.`);
  tx(() => {
    insertItems(t.id, items);
    taskHistory(t.id, ctx.user.id, 'Itens adicionados ao check-list', `${items.length} item(ns)`);
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
  if ('assignee_id' in body) {
    const v = validateAssignee(intOrNull(body.assignee_id), t.project_id);
    if (v !== item.assignee_id) {
      next.assignee_id = v;
      const name = id => (id ? one('SELECT name FROM users WHERE id = ?', id)?.name : `${t.assignee_name || 'sem responsável'} (global)`);
      changes.push(`responsável: ${name(item.assignee_id)} → ${name(v)}`);
    }
  }
  const fields = Object.keys(next);
  if (!fields.length) return;
  tx(() => {
    const groupChanged = 'group_name' in next;
    const group = next.group_name;
    delete next.group_name;
    const rest = Object.keys(next);
    if (rest.length) run(`UPDATE checklist_items SET ${rest.map(f => `${f} = ?`).join(', ')} WHERE id = ?`, ...rest.map(f => next[f]), item.id);
    if (groupChanged) moveToGroup(t.id, item.id, group);
    taskHistory(t.id, ctx.user.id, 'Item do check-list alterado', `${item.seq}. ${item.text} · ${changes.join(' · ')}`);
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

export function deleteItem(ctx, taskId, itemId) {
  const t = loadChecklistTask(ctx, taskId);
  assertManage(ctx, t);
  const item = loadItem(t, itemId);
  if (item.result) throw badRequest('Item já respondido não pode ser excluído.');
  if (one('SELECT COUNT(*) AS n FROM checklist_items WHERE task_id = ?', t.id).n <= 1) throw badRequest('O check-list precisa ter ao menos um item.');
  const files = all('SELECT stored_name FROM checklist_files WHERE item_id = ?', item.id);
  tx(() => {
    run('DELETE FROM checklist_items WHERE id = ?', item.id);
    renumber(t.id);
    taskHistory(t.id, ctx.user.id, 'Item excluído do check-list', `${item.seq}. ${item.text}`);
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

export const answeredCount = taskId => one('SELECT COUNT(*) AS n FROM checklist_items WHERE task_id = ? AND result IS NOT NULL', taskId).n;

// Itens pendentes atribuídos ao usuário (ou a terceirizados sem acesso liderados por ele), por check-list
export function myPendingItems(ctx) {
  const uid = ctx.user.id;
  return all(`SELECT t.id, t.code, t.title, t.due_date, p.code AS project_code, p.name AS project_name, COUNT(*) AS pending
    FROM checklist_items ci JOIN tasks t ON t.id = ci.task_id JOIN projects p ON p.id = t.project_id
    LEFT JOIN users u ON u.id = ci.assignee_id
    WHERE t.cancelled_at IS NULL AND t.status IN ('aberta','em_andamento') AND ci.result IS NULL
      AND (ci.assignee_id = ? OR (u.is_external = 1 AND u.login_enabled = 0 AND u.manager_id = ?))
    GROUP BY t.id ORDER BY t.due_date IS NULL, t.due_date`, uid, uid);
}
