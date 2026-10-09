// Dependências entre tarefas, subtarefas e itens de check-list do mesmo projeto (Término → Início + folga).
// Ponta = "t:<id>" (tarefa ou subtarefa) ou "i:<id>" (item de check-list).
// Etapa 1: cadastro, consulta e situação "Aguardando". (Empurrar prazos e o indicador de impacto vêm na etapa 2.)
import { all, one, run, tx } from '../db.js';
import { badRequest, forbidden, notFound, intOrNull } from '../lib/http.js';
import { canSeeTask, canManageTask } from '../lib/permissions.js';
import { taskHistory } from './audit.js';
import { loadVisible } from './tasks.js';

const fmt = d => (d ? d.split('-').reverse().join('/') : 'sem prazo');
const parseKey = k => {
  const m = /^([ti]):(\d+)$/.exec(String(k || ''));
  if (!m) throw badRequest('Escolha a tarefa ou o item.');
  return { kind: m[1], id: Number(m[2]) };
};

// Dados de uma ponta (tarefa/subtarefa ou item) + a tarefa "dona" (para permissões e histórico)
function node(key) {
  const { kind, id } = typeof key === 'string' ? parseKey(key) : key;
  if (kind === 't') {
    const t = one(`SELECT t.*, p.code AS project_code FROM tasks t JOIN projects p ON p.id = t.project_id WHERE t.id = ?`, id);
    if (!t) throw notFound('Tarefa não encontrada.');
    return { key: `t:${t.id}`, kind: 'tarefa', type: t.parent_id ? 'subtarefa' : t.task_type === 'checklist' ? 'checklist' : 'tarefa', id: t.id,
      code: t.code, title: t.title, project_id: t.project_id, due_date: t.due_date, start_date: t.start_date,
      done: t.status === 'concluida', cancelled: !!t.cancelled_at, owner: t, parent_id: t.parent_id };
  }
  const i = one('SELECT * FROM checklist_items WHERE id = ?', id);
  if (!i) throw notFound('Item não encontrado.');
  const t = one('SELECT * FROM tasks WHERE id = ?', i.task_id);
  return { key: `i:${i.id}`, kind: 'item', type: 'item', id: i.id, code: `${t.code}·${i.seq}`, title: i.text, project_id: t.project_id,
    due_date: i.due_date || t.due_date, start_date: i.start_date, done: i.result === 'conforme' || i.result === 'na', cancelled: !!t.cancelled_at,
    owner: t, task_id: t.id };
}
const cols = n => (n.kind === 'item' ? { task: null, item: n.id } : { task: n.id, item: null });
const label = n => `${n.code} · ${n.title}`;

// Ligações de uma ponta (predecessoras e sucessoras), com a situação de cada uma
function edges(n, ctx) {
  const c = cols(n);
  const view = (row, otherKey) => {
    const o = node(otherKey);
    const visible = canSeeTask(ctx, o.owner);
    return { id: row.id, lag_days: row.lag_days, key: o.key, type: o.type, code: o.code, title: visible ? o.title : 'Tarefa restrita',
      due_date: o.due_date, done: o.done, cancelled: o.cancelled, link: visible ? `#/tarefas/${o.kind === 'item' ? o.task_id : o.id}` : null };
  };
  const preds = all(`SELECT * FROM dependencies WHERE ${c.task ? 'succ_task_id = ?' : 'succ_item_id = ?'} ORDER BY id`, c.task || c.item)
    .map(r => view(r, r.pred_task_id ? `t:${r.pred_task_id}` : `i:${r.pred_item_id}`));
  const succs = all(`SELECT * FROM dependencies WHERE ${c.task ? 'pred_task_id = ?' : 'pred_item_id = ?'} ORDER BY id`, c.task || c.item)
    .map(r => view(r, r.succ_task_id ? `t:${r.succ_task_id}` : `i:${r.succ_item_id}`));
  // Aguardando = alguma predecessora ainda não terminou (canceladas não seguram)
  const waiting = preds.filter(p => !p.done && !p.cancelled);
  return { predecessors: preds, successors: succs, waiting };
}

export function taskDependencies(ctx, taskId) {
  return edges(node(`t:${taskId}`), ctx);
}

// Dependências de todos os itens de um check-list (para a tela do check-list)
export function itemDependencies(ctx, taskId) {
  const out = {};
  for (const i of all('SELECT id FROM checklist_items WHERE task_id = ?', taskId)) {
    const e = edges(node(`i:${i.id}`), ctx);
    if (e.predecessors.length || e.successors.length) out[i.id] = e;
  }
  return out;
}

// Opções para escolher a outra ponta: tarefas, subtarefas e itens de check-list do projeto (visíveis e não canceladas)
export function projectNodes(ctx, projectId) {
  const tasks = all(`SELECT id, code, title, parent_id, task_type, due_date, assignee_id, creator_id, project_id FROM tasks
    WHERE project_id = ? AND cancelled_at IS NULL ORDER BY seq, id`, projectId).filter(t => canSeeTask(ctx, t));
  const ids = new Set(tasks.map(t => t.id));
  const items = all(`SELECT ci.id, ci.seq, ci.text, ci.task_id, ci.due_date, t.code FROM checklist_items ci JOIN tasks t ON t.id = ci.task_id
    WHERE t.project_id = ? AND t.cancelled_at IS NULL ORDER BY t.seq, ci.seq`, projectId).filter(i => ids.has(i.task_id));
  return [
    ...tasks.map(t => ({ key: `t:${t.id}`, type: t.parent_id ? 'subtarefa' : t.task_type === 'checklist' ? 'checklist' : 'tarefa', code: t.code, title: t.title, due_date: t.due_date })),
    ...items.map(i => ({ key: `i:${i.id}`, type: 'item', code: `${i.code}·${i.seq}`, title: i.text, due_date: i.due_date })),
  ];
}

// Sucessoras diretas de uma ponta (para checar ciclos)
const nextOf = key => {
  const n = parseKey(key);
  return all(`SELECT succ_task_id, succ_item_id FROM dependencies WHERE ${n.kind === 't' ? 'pred_task_id' : 'pred_item_id'} = ?`, n.id)
    .map(r => (r.succ_task_id ? `t:${r.succ_task_id}` : `i:${r.succ_item_id}`));
};

export function addDependency(ctx, body) {
  const pred = node(body.pred);
  const succ = node(body.succ);
  // Quem pode editar uma das tarefas envolvidas (a de onde a ligação está sendo feita)
  loadVisible(ctx, pred.kind === 'item' ? pred.task_id : pred.id);
  loadVisible(ctx, succ.kind === 'item' ? succ.task_id : succ.id);
  if (!canManageTask(ctx, pred.owner) && !canManageTask(ctx, succ.owner)) throw forbidden('Você não pode criar dependências nestas tarefas.');
  if (pred.key === succ.key) throw badRequest('Uma tarefa não pode depender dela mesma.');
  if (pred.project_id !== succ.project_id) throw badRequest('As dependências só ligam tarefas do mesmo projeto.');
  if (pred.cancelled || succ.cancelled) throw badRequest('Tarefa cancelada não recebe dependências.');
  // Tarefa e suas subtarefas / check-list e seus itens já fazem parte do mesmo conjunto
  const ownerId = n => (n.kind === 'item' ? n.task_id : n.id);
  // (itens do mesmo check-list podem depender entre si; item ↔ o próprio check-list e subtarefa ↔ a própria tarefa principal, não)
  const itemOfOwnList = (a, b) => a.kind === 'item' && b.kind === 'tarefa' && a.task_id === b.id;
  const subOfOwnParent = (a, b) => a.kind === 'tarefa' && b.kind === 'tarefa' && (a.parent_id === b.id || b.parent_id === a.id);
  if (itemOfOwnList(pred, succ) || itemOfOwnList(succ, pred) || subOfOwnParent(pred, succ)) {
    throw badRequest('Subtarefas e itens já fazem parte da tarefa principal: ligue tarefas diferentes.');
  }
  const lag = body.lag_days === '' || body.lag_days === undefined || body.lag_days === null ? 0 : Number(body.lag_days);
  if (!Number.isInteger(lag) || lag < 0 || lag > 365) throw badRequest('Folga inválida: informe de 0 a 365 dias.');
  // Ciclo: a predecessora não pode estar "depois" da sucessora
  const seen = new Set();
  const stack = [succ.key];
  while (stack.length) {
    const k = stack.pop();
    if (k === pred.key) throw badRequest(`Ligação circular: ${label(pred)} já depende (direta ou indiretamente) de ${label(succ)}.`);
    if (seen.has(k)) continue;
    seen.add(k);
    stack.push(...nextOf(k));
  }
  const p = cols(pred), s = cols(succ);
  if (one(`SELECT 1 FROM dependencies WHERE COALESCE(pred_task_id,0) = ? AND COALESCE(pred_item_id,0) = ? AND COALESCE(succ_task_id,0) = ? AND COALESCE(succ_item_id,0) = ?`,
    p.task || 0, p.item || 0, s.task || 0, s.item || 0)) throw badRequest('Esta dependência já existe.');
  return tx(() => {
    const id = Number(run(`INSERT INTO dependencies (project_id, pred_task_id, pred_item_id, succ_task_id, succ_item_id, lag_days, created_by) VALUES (?,?,?,?,?,?,?)`,
      pred.project_id, p.task, p.item, s.task, s.item, lag, ctx.user.id).lastInsertRowid);
    const folga = lag ? ` (folga de ${lag} dia${lag > 1 ? 's' : ''})` : '';
    taskHistory(ownerId(succ), ctx.user.id, 'Dependência adicionada', `${succ.kind === 'item' ? `Item ${succ.code} ` : ''}depende de ${label(pred)}${folga}`);
    if (ownerId(pred) !== ownerId(succ)) taskHistory(ownerId(pred), ctx.user.id, 'Dependência adicionada', `${pred.kind === 'item' ? `Item ${pred.code} ` : ''}libera ${label(succ)}${folga}`);
    return id;
  });
}

export function removeDependency(ctx, id) {
  const d = one('SELECT * FROM dependencies WHERE id = ?', intOrNull(id));
  if (!d) throw notFound('Dependência não encontrada.');
  const pred = node(d.pred_task_id ? `t:${d.pred_task_id}` : `i:${d.pred_item_id}`);
  const succ = node(d.succ_task_id ? `t:${d.succ_task_id}` : `i:${d.succ_item_id}`);
  if (!canManageTask(ctx, pred.owner) && !canManageTask(ctx, succ.owner)) throw forbidden('Você não pode remover esta dependência.');
  const ownerId = n => (n.kind === 'item' ? n.task_id : n.id);
  tx(() => {
    run('DELETE FROM dependencies WHERE id = ?', d.id);
    taskHistory(ownerId(succ), ctx.user.id, 'Dependência removida', `${succ.kind === 'item' ? `Item ${succ.code} ` : ''}não depende mais de ${label(pred)}`);
    if (ownerId(pred) !== ownerId(succ)) taskHistory(ownerId(pred), ctx.user.id, 'Dependência removida', `${pred.kind === 'item' ? `Item ${pred.code} ` : ''}não libera mais ${label(succ)}`);
  });
}

export { fmt as fmtDepDate };
