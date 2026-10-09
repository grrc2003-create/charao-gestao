// Dependências entre tarefas, subtarefas e itens de check-list do mesmo projeto (Término → Início + folga).
// Ponta = "t:<id>" (tarefa ou subtarefa) ou "i:<id>" (item de check-list).
// Cadastro, consulta e situação "Aguardando"; empurrar as sucessoras quando a predecessora atrasa (reagendamento ou
// término atrasado) sem penalizá-las, e o indicador de impacto do atraso (registrado na causa).
import { all, one, run, tx } from '../db.js';
import { badRequest, forbidden, notFound, intOrNull } from '../lib/http.js';
import { canSeeTask, canManageTask } from '../lib/permissions.js';
import { taskHistory } from './audit.js';
import { loadVisible, checklistMaxDue } from './tasks.js';
import { addDays, daysBetween, today } from './metrics.js';

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

// ===================== Empurrar as sucessoras =====================
// Término → Início: a sucessora não pode começar antes de (término da predecessora + 1 + folga).
// Só empurra para frente; sucessoras concluídas/canceladas ou sem datas ficam como estão. Início e prazo andam juntos
// (a duração é mantida). Em check-list cujos itens têm prazo, quem anda são os itens em aberto (o prazo do
// check-list acompanha o maior prazo dos itens).
const succEdges = key => {
  const n = parseKey(key);
  return all(`SELECT succ_task_id, succ_item_id, lag_days FROM dependencies WHERE ${n.kind === 't' ? 'pred_task_id' : 'pred_item_id'} = ?`, n.id)
    .map(r => ({ key: r.succ_task_id ? `t:${r.succ_task_id}` : `i:${r.succ_item_id}`, lag: r.lag_days }));
};
const datesOf = n => {
  if (n.kind === 'item') {
    const i = one('SELECT start_date, due_date FROM checklist_items WHERE id = ?', n.id);
    return { start: i.start_date, due: i.due_date };
  }
  const t = n.owner;
  return { start: t.start_date, due: t.task_type === 'checklist' ? (checklistMaxDue(t.id) || t.due_date) : t.due_date };
};
const projectEnd = projectId => one('SELECT MAX(due_date) AS d FROM tasks WHERE project_id = ? AND cancelled_at IS NULL', projectId)?.d || null;
const fresh = key => {
  const n = node(key);
  const d = datesOf(n);
  return { node: n, oldStart: d.start, oldDue: d.due, newStart: d.start, newDue: d.due };
};

// Plano: o que muda (sem gravar). sources: [{ key, finish }] — término (novo) de quem atrasou
export function planShift(sources) {
  const planned = new Map();
  const queue = [...sources];
  let guard = 0;
  while (queue.length && guard++ < 5000) {
    const { key, finish } = queue.shift();
    if (!finish) continue;
    for (const e of succEdges(key)) {
      const n = node(e.key);
      if (n.done || n.cancelled) continue;
      const cur = planned.get(n.key) || fresh(n.key);
      const anchor = cur.newStart || cur.newDue;
      if (!anchor) continue;
      const req = addDays(finish, 1 + e.lag);
      if (anchor >= req) continue;
      const delta = daysBetween(anchor, req);
      cur.newStart = cur.newStart ? addDays(cur.newStart, delta) : null;
      cur.newDue = cur.newDue ? addDays(cur.newDue, delta) : null;
      planned.set(n.key, cur);
      queue.push({ key: n.key, finish: cur.newDue || cur.newStart });
      // Item empurrado pode empurrar o próprio check-list (prazo = maior prazo dos itens) e as sucessoras dele
      if (n.kind === 'item' && cur.newDue) {
        const ok = `t:${n.task_id}`;
        const owner = planned.get(ok) || fresh(ok);
        if (!owner.newDue || cur.newDue > owner.newDue) {
          owner.newDue = cur.newDue;
          owner.derived = true;
          planned.set(ok, owner);
          queue.push({ key: ok, finish: owner.newDue });
        }
      }
    }
  }
  return [...planned.values()].map(p => ({ ...p, days: daysBetween(p.oldDue || p.oldStart, p.newDue || p.newStart) })).filter(p => p.days > 0);
}

const planView = list => list.map(p => ({ key: p.node.key, type: p.node.type, code: p.node.code, title: p.node.title,
  old_due: p.oldDue, new_due: p.newDue, old_start: p.oldStart, new_start: p.newStart, days: p.days }));

// Prévia do reagendamento (para mostrar antes de confirmar)
export function previewReschedule(ctx, taskId, newDue) {
  const t = loadVisible(ctx, taskId);
  if (!newDue) return { impacted: [] };
  return { impacted: planView(planShift([{ key: `t:${t.id}`, finish: newDue }])) };
}

const WHY = { reagendamento: 'reagendamento', conclusao_atrasada: 'término com atraso', prazo_item: 'prazo do item alterado' };

// Grava o plano: ajusta as sucessoras (sem reagendamento), registra no histórico e o evento de impacto
export function applyShift({ userId, projectId, cause, kind, causeOldDue, causeNewDue, sources, projectEndBefore }) {
  const plan = planShift(sources);
  if (!plan.length) return null;
  const ev = Number(run(`INSERT INTO dependency_events (project_id, cause_task_id, cause_item_id, kind, cause_old_due, cause_new_due, project_end_old, created_by)
    VALUES (?,?,?,?,?,?,?,?)`, projectId, cause.taskId, cause.itemId || null, kind, causeOldDue || null, causeNewDue || null, projectEndBefore || null, userId).lastInsertRowid);
  const causeLabel = `${cause.code} · ${cause.title}`;
  const dd = n => `${n} dia${n > 1 ? 's' : ''}`;
  for (const p of plan) {
    const n = p.node;
    if (n.kind === 'item') {
      run('UPDATE checklist_items SET start_date = ?, due_date = ? WHERE id = ?', p.newStart, p.newDue, n.id);
      run('INSERT INTO dependency_shifts (event_id, target_item_id, old_start, old_due, new_start, new_due, days) VALUES (?,?,?,?,?,?,?)', ev, n.id, p.oldStart, p.oldDue, p.newStart, p.newDue, p.days);
      taskHistory(n.task_id, userId, 'Prazo ajustado por dependência', `Item ${n.code}: ${fmt(p.oldDue)} → ${fmt(p.newDue)} (+${dd(p.days)}) · causa: ${causeLabel} (${WHY[kind]})`);
      continue;
    }
    const t = one('SELECT * FROM tasks WHERE id = ?', n.id);
    const datedItems = t.task_type === 'checklist' && checklistMaxDue(t.id);
    if (datedItems && !p.derived) {
      // Check-list empurrado como sucessora: os itens em aberto andam juntos
      for (const i of all(`SELECT id, start_date, due_date FROM checklist_items WHERE task_id = ? AND (result IS NULL OR result = 'nao_conforme') AND (start_date IS NOT NULL OR due_date IS NOT NULL)`, t.id)) {
        run('UPDATE checklist_items SET start_date = ?, due_date = ? WHERE id = ?', i.start_date ? addDays(i.start_date, p.days) : null, i.due_date ? addDays(i.due_date, p.days) : null, i.id);
      }
    }
    const newDue = datedItems ? checklistMaxDue(t.id) : p.newDue;
    run('UPDATE tasks SET start_date = ?, due_date = ?, updated_at = ? WHERE id = ?', p.newStart, newDue, new Date().toISOString(), t.id);
    run('INSERT INTO dependency_shifts (event_id, target_task_id, old_start, old_due, new_start, new_due, days) VALUES (?,?,?,?,?,?,?)', ev, t.id, p.oldStart, p.oldDue, p.newStart, newDue, p.days);
    taskHistory(t.id, userId, 'Prazo ajustado por dependência', `${fmt(p.oldDue)} → ${fmt(newDue)} (+${dd(p.days)}) · causa: ${causeLabel} (${WHY[kind]}) · não conta como reagendamento desta tarefa`);
  }
  const endNew = projectEnd(projectId);
  run('UPDATE dependency_events SET project_end_new = ? WHERE id = ?', endNew, ev);
  const total = plan.reduce((s, p) => s + p.days, 0);
  const endDays = projectEndBefore && endNew && endNew > projectEndBefore ? daysBetween(projectEndBefore, endNew) : 0;
  taskHistory(cause.taskId, userId, 'Impacto em outras tarefas',
    `${cause.itemId ? `Item ${cause.code}: ` : ''}${plan.length} tarefa(s)/item(ns) empurrado(s) · ${total} dia(s)-tarefa${endDays ? ` · fim do projeto +${dd(endDays)}` : ''}`);
  return ev;
}

export const projectEndOf = projectEnd;

// ===================== Indicador de impacto =====================
const endDaysOf = ev => ev.reduce((n, e) => n + (e.project_end_old && e.project_end_new && e.project_end_new > e.project_end_old ? daysBetween(e.project_end_old, e.project_end_new) : 0), 0);

// Causa: quantas tarefas/itens empurrou, quantos dias-tarefa e quanto mexeu no fim do projeto
export function impactOfTask(taskId) {
  const ev = all('SELECT * FROM dependency_events WHERE cause_task_id = ? ORDER BY id', taskId);
  if (!ev.length) return null;
  const ids = ev.map(e => e.id);
  const shifts = all(`SELECT s.*, t.code AS t_code, t.title AS t_title, ci.seq AS i_seq, ci.text AS i_text, it.code AS it_code, it.id AS it_id
    FROM dependency_shifts s LEFT JOIN tasks t ON t.id = s.target_task_id LEFT JOIN checklist_items ci ON ci.id = s.target_item_id LEFT JOIN tasks it ON it.id = ci.task_id
    WHERE s.event_id IN (${ids.map(() => '?').join(',')}) ORDER BY s.id`, ...ids);
  const targets = new Set(shifts.map(s => (s.target_task_id ? `t:${s.target_task_id}` : `i:${s.target_item_id}`)));
  return {
    events: ev.length, tasks: targets.size, days: shifts.reduce((n, s) => n + s.days, 0), project_end_days: endDaysOf(ev),
    shifts: shifts.map(s => ({ code: s.target_task_id ? s.t_code : `${s.it_code}·${s.i_seq}`, title: s.target_task_id ? s.t_title : s.i_text,
      link: `#/tarefas/${s.target_task_id || s.it_id}`, old_due: s.old_due, new_due: s.new_due, days: s.days })),
  };
}

// Sucessora: quanto o prazo foi ajustado por dependências (não conta como reagendamento)
export function shiftedOfTask(taskId) {
  const r = one('SELECT COUNT(*) AS n, COALESCE(SUM(days), 0) AS days FROM dependency_shifts WHERE target_task_id = ?', taskId);
  if (!r.n) return null;
  const last = one(`SELECT e.cause_task_id, t.code FROM dependency_shifts s JOIN dependency_events e ON e.id = s.event_id JOIN tasks t ON t.id = e.cause_task_id
    WHERE s.target_task_id = ? ORDER BY s.id DESC LIMIT 1`, taskId);
  return { times: r.n, days: r.days, last_cause: last?.code || null, last_cause_id: last?.cause_task_id || null };
}

// Ranking "Atrasos com maior impacto" (tarefas visíveis; opcionalmente de um projeto)
export function impactRanking(ctx, { projectId = null, limit = 10 } = {}) {
  const rows = all(`SELECT e.cause_task_id AS id, COUNT(DISTINCT e.id) AS events, SUM(s.days) AS days,
      COUNT(DISTINCT COALESCE('t' || s.target_task_id, 'i' || s.target_item_id)) AS tasks
    FROM dependency_events e JOIN dependency_shifts s ON s.event_id = e.id
    ${projectId ? 'WHERE e.project_id = ?' : ''} GROUP BY e.cause_task_id ORDER BY days DESC, tasks DESC`, ...(projectId ? [projectId] : []));
  const out = [];
  for (const r of rows) {
    const t = one(`SELECT t.*, u.name AS assignee_name, p.code AS project_code FROM tasks t JOIN projects p ON p.id = t.project_id LEFT JOIN users u ON u.id = t.assignee_id WHERE t.id = ?`, r.id);
    if (!t || !canSeeTask(ctx, t)) continue;
    out.push({ id: t.id, code: t.code, title: t.title, project_code: t.project_code, assignee_name: t.assignee_name, tasks: r.tasks, days: r.days, events: r.events,
      project_end_days: endDaysOf(all('SELECT project_end_old, project_end_new FROM dependency_events WHERE cause_task_id = ?', r.id)) });
    if (out.length >= limit) break;
  }
  return out;
}

export const todayISO = today;
