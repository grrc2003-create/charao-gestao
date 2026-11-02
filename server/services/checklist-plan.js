// Programação do profissional no check-list: pelo cargo do profissional aparecem as pendências da função, com os dias.
// Vincular um item põe o profissional na equipe do item (no lugar de uma vaga da função), liga o item ao anterior da
// sequência e, com período escolhido, define início e prazo em dias úteis. O período é um limite: o que não cabe é recusado.
// Sem período não há limite e as datas não mudam. Cada item ocupa dias inteiros (0,5 dia ocupa 1 dia da agenda).
// Equipe e datas passam por updateItem e a ordem por addDependency: histórico, permissões e ajustes são os mesmos da tela do item.
import { all, one, run, tx } from '../db.js';
import { badRequest, notFound, date, intOrNull } from '../lib/http.js';
import { hasSection, canSeeTask } from '../lib/permissions.js';
import { workingDaysList } from './calendar.js';
import { addDependency, removeDependency, alignToPredecessors } from './dependencies.js';
import { canManageItems, isResolved, loadChecklistTask, updateItem } from './checklist.js';

const r2 = v => Math.round((Number(v) || 0) * 100) / 100;
const slots = days => Math.ceil(Number(days) || 0);
const sameRole = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();

const WORKERS_SQL = `SELECT id, name, role, daily_rate FROM field_workers w WHERE active = 1 AND kind = 'diarista'
  AND (NOT EXISTS (SELECT 1 FROM field_worker_projects x WHERE x.worker_id = w.id) OR EXISTS (SELECT 1 FROM field_worker_projects x WHERE x.worker_id = w.id AND x.project_id = ?))
  ORDER BY name`;

function loadWorker(t, workerId) {
  const w = all(WORKERS_SQL, t.project_id).find(x => x.id === workerId);
  if (!w) throw badRequest('Profissional não disponível para esta obra.');
  return w;
}

function readPeriod(start, end) {
  const s = date(start || null, 'Início do período'), e = date(end || null, 'Fim do período');
  if (!s || !e) return null;
  if (e < s) throw badRequest('O fim do período não pode ser antes do início.');
  return { start: s, end: e };
}

// Sequência do profissional neste check-list: na ordem dos vínculos; quem entrou pela edição do item vem depois
const sequenceOf = (t, workerId) => all(`SELECT ci.id, ci.seq, ci.text, ci.group_name, ci.specialty, ci.start_date, ci.due_date, ci.result, e.days
    FROM checklist_item_team e JOIN checklist_items ci ON ci.id = e.item_id LEFT JOIN checklist_plan p ON p.item_id = ci.id AND p.worker_id = e.worker_id
    WHERE ci.task_id = ? AND e.worker_id = ? ORDER BY p.seq IS NULL, p.seq, e.id`, t.id, workerId);

// Compromissos em outros check-lists da mesma obra (item em aberto de check-list não cancelado)
const othersOf = (t, workerId) => all(`SELECT ci.id, ci.seq, ci.text, ci.start_date, ci.due_date, e.days, ot.id AS task_id, ot.code, ot.assignee_id, ot.creator_id, ot.project_id
    FROM checklist_item_team e JOIN checklist_items ci ON ci.id = e.item_id JOIN tasks ot ON ot.id = ci.task_id
    WHERE e.worker_id = ? AND ot.project_id = ? AND ot.id <> ? AND ot.cancelled_at IS NULL AND (ci.result IS NULL OR ci.result = 'nao_conforme') ORDER BY ci.due_date IS NULL, ci.due_date`, workerId, t.project_id, t.id);

// Dias da agenda que um item com datas ocupa: os primeiros dias úteis a partir do início, conforme os dias da equipe
const occupied = (projectId, row) => {
  if (!row.due_date) return [];
  return row.start_date ? workingDaysList(projectId, row.start_date, row.due_date).slice(0, slots(row.days)) : [row.due_date];
};

// Agenda do período: dias livres depois do último item da sequência; itens sem data da sequência entram primeiro.
// redo: itens da sequência a recolocar (depois de tirar um item do meio)
function agenda(t, workerId, period, seq, others, redo = new Set()) {
  if (!period) return null;
  const open = seq.filter(i => !isResolved(i.result));
  const days = workingDaysList(t.project_id, period.start, period.end);
  const inPeriod = new Set(days);
  const otherBusy = new Set(others.flatMap(o => occupied(t.project_id, o)).filter(d => inPeriod.has(d)));
  const fixed = open.filter(i => i.due_date && !redo.has(i.id));
  const hereBusy = new Set(fixed.flatMap(i => occupied(t.project_id, i)));
  const last = fixed.map(i => i.due_date).filter(d => inPeriod.has(d)).sort().at(-1) || null;
  const free = days.filter(d => !otherBusy.has(d) && !hereBusy.has(d) && (!last || d > last));
  const unplaced = open.filter(i => !i.due_date || redo.has(i.id));
  const reserved = unplaced.reduce((n, i) => n + slots(i.days), 0);
  return { days, free, unplaced, reserved, remaining: Math.max(0, free.length - reserved), others: otherBusy.size, over: reserved - free.length > 0 };
}

export function planState(ctx, taskId, { worker, start, end }) {
  const t = loadChecklistTask(ctx, taskId);
  const money = hasSection(ctx.user, 'folha_campo');
  const workers = all(WORKERS_SQL, t.project_id).map(w => ({ id: w.id, name: w.name, role: w.role }));
  const base = { task: { id: t.id, code: t.code, title: t.title, project_id: t.project_id }, workers, can_manage: canManageItems(ctx, t), can_see_cost: money };
  const workerId = intOrNull(worker);
  if (!workerId) return base;
  const w = loadWorker(t, workerId);
  const period = readPeriod(start, end);
  const seq = sequenceOf(t, w.id);
  const others = othersOf(t, w.id);
  const ag = agenda(t, w.id, period, seq, others);
  const inSeq = new Set(seq.map(i => i.id));
  const pending = !w.role ? [] : all(`SELECT ci.id, ci.seq, ci.text, ci.group_name, ci.specialty, ci.start_date, ci.due_date, ci.result, e.days, e.qty, e.role
      FROM checklist_item_team e JOIN checklist_items ci ON ci.id = e.item_id WHERE ci.task_id = ? AND e.role = ? COLLATE NOCASE ORDER BY ci.seq`, t.id, w.role.trim())
    .filter(i => !isResolved(i.result) && !inSeq.has(i.id));
  const money2 = days => (money ? { value: r2(days * w.daily_rate) } : {});
  const view = i => ({ id: i.id, seq: i.seq, text: i.text, group: i.group_name, specialty: i.specialty, start_date: i.start_date, due_date: i.due_date, result: i.result, days: i.days, ...money2(i.days) });
  const without = one(`SELECT COUNT(*) AS n FROM checklist_items ci WHERE ci.task_id = ? AND (ci.result IS NULL OR ci.result = 'nao_conforme')
    AND NOT EXISTS (SELECT 1 FROM checklist_item_team e WHERE e.item_id = ci.id)`, t.id).n;
  const openSeq = seq.filter(i => !isResolved(i.result));
  return { ...base,
    worker: { id: w.id, name: w.name, role: w.role, ...(money ? { rate: w.daily_rate } : {}) },
    period,
    capacity: ag ? { available: ag.days.length, others: ag.others, here: Math.max(0, ag.days.length - ag.others - ag.remaining), remaining: ag.remaining } : null,
    pending: pending.map(i => ({ ...view(i), qty: i.qty, fits: !ag || slots(i.days) <= ag.remaining })),
    sequence: seq.map(i => ({ ...view(i), resolved: isResolved(i.result), outside: !!(period && i.due_date && (i.due_date > period.end || (i.start_date || i.due_date) < period.start)) })),
    others: others.map(o => {
      const visible = canSeeTask(ctx, o);
      return { id: o.id, code: `${o.code}·${o.seq}`, title: visible ? o.text : 'Tarefa restrita', link: visible ? `#/tarefas/${o.task_id}` : null, start_date: o.start_date, due_date: o.due_date, days: o.days };
    }),
    totals: { days: r2(openSeq.reduce((n, i) => n + i.days, 0)), ...(money ? { value: r2(openSeq.reduce((n, i) => n + i.days * w.daily_rate, 0)) } : {}) },
    items_without_team: without,
  };
}

const currentTeam = itemId => all('SELECT worker_id, role, qty, days FROM checklist_item_team WHERE item_id = ? ORDER BY id', itemId);
const depBetween = (a, b) => one('SELECT id FROM dependencies WHERE pred_item_id = ? AND succ_item_id = ?', a, b);

// Coloca os itens na agenda, em ordem, nos dias livres
function place(ctx, t, ag, list) {
  let c = 0;
  for (const i of list) {
    const n = slots(i.days);
    updateItem(ctx, t.id, i.id, { start_date: ag.free[c], due_date: ag.free[c + n - 1] });
    alignToPredecessors(`i:${i.id}`, ctx.user.id);
    c += n;
  }
}

export function linkItem(ctx, taskId, body = {}) {
  const t = loadChecklistTask(ctx, taskId);
  const w = loadWorker(t, intOrNull(body.worker_id));
  const itemId = intOrNull(body.item_id);
  const item = one('SELECT * FROM checklist_items WHERE id = ? AND task_id = ?', itemId, t.id);
  if (!item) throw notFound('Item não encontrado.');
  if (isResolved(item.result)) throw badRequest('Este item já está resolvido.');
  const team = currentTeam(item.id);
  if (team.some(e => e.worker_id === w.id)) throw badRequest('Este profissional já está neste item.');
  const row = team.find(e => !e.worker_id && sameRole(e.role, w.role));
  if (!row) throw badRequest(`Este item não pede a função ${w.role || 'do profissional'}.`);
  const period = readPeriod(body.start, body.end);
  const seq = sequenceOf(t, w.id);
  const ag = agenda(t, w.id, period, seq, othersOf(t, w.id));
  const need = slots(row.days);
  if (ag && need > ag.remaining) {
    throw badRequest(`Ultrapassa o período: este item precisa de ${need} dia(s) e restam ${ag.remaining}.`);
  }
  const nextTeam = [...team.filter(e => e !== row), ...(row.qty > 1 ? [{ ...row, qty: row.qty - 1 }] : []), { worker_id: w.id, role: null, qty: 1, days: row.days }];
  const prev = seq.filter(i => !isResolved(i.result)).at(-1);
  tx(() => {
    updateItem(ctx, t.id, item.id, { team: nextTeam });
    const pos = one('SELECT COALESCE(MAX(p.seq), 0) + 1 AS n FROM checklist_plan p JOIN checklist_items ci ON ci.id = p.item_id WHERE p.worker_id = ? AND ci.task_id = ?', w.id, t.id).n;
    run('INSERT OR REPLACE INTO checklist_plan (worker_id, item_id, seq, created_by) VALUES (?,?,?,?)', w.id, item.id, pos, ctx.user.id);
    if (ag) place(ctx, t, ag, [...ag.unplaced, { id: item.id, days: row.days }]);
    if (prev && !depBetween(prev.id, item.id)) addDependency(ctx, { pred: `i:${prev.id}`, succ: `i:${item.id}` });
  });
  return planState(ctx, taskId, { worker: w.id, start: body.start, end: body.end });
}

export function unlinkItem(ctx, taskId, body = {}) {
  const t = loadChecklistTask(ctx, taskId);
  const w = one('SELECT * FROM field_workers WHERE id = ?', intOrNull(body.worker_id));
  if (!w) throw notFound('Profissional não encontrado.');
  const itemId = intOrNull(body.item_id);
  const seq = sequenceOf(t, w.id);
  const pos = seq.findIndex(i => i.id === itemId);
  if (pos < 0) throw notFound('Este item não está na sequência do profissional.');
  const item = seq[pos];
  if (isResolved(item.result)) throw badRequest('Item resolvido não sai da sequência.');
  const prev = seq[pos - 1], next = seq[pos + 1];
  const period = readPeriod(body.start, body.end);
  const followers = seq.slice(pos + 1).filter(i => !isResolved(i.result));
  // A vaga volta para a função (junta com a linha da função, se ainda houver)
  const team = currentTeam(item.id).filter(e => e.worker_id !== w.id);
  if (w.role) {
    const row = team.find(e => !e.worker_id && sameRole(e.role, w.role));
    if (row) row.qty += 1;
    else team.push({ worker_id: null, role: w.role.trim(), qty: 1, days: item.days });
  }
  tx(() => {
    if (w.role) run('INSERT OR IGNORE INTO field_roles (name) VALUES (?)', w.role.trim());
    updateItem(ctx, t.id, item.id, { team, ...(period ? { start_date: null, due_date: null } : {}) });
    run('DELETE FROM checklist_plan WHERE worker_id = ? AND item_id = ?', w.id, item.id);
    const before = prev && depBetween(prev.id, item.id), after = next && depBetween(item.id, next.id);
    if (before) removeDependency(ctx, before.id);
    if (after) removeDependency(ctx, after.id);
    // Com período, os itens seguintes sobem para ocupar o tempo liberado
    if (period && followers.length) {
      const rest = sequenceOf(t, w.id);
      const ag = agenda(t, w.id, period, rest, othersOf(t, w.id), new Set(followers.map(i => i.id)));
      if (ag.free.length >= followers.reduce((n, i) => n + slots(i.days), 0)) place(ctx, t, ag, followers);
    }
    if (before && after && !depBetween(prev.id, next.id)) addDependency(ctx, { pred: `i:${prev.id}`, succ: `i:${next.id}` });
  });
  return planState(ctx, taskId, { worker: w.id, start: body.start, end: body.end });
}
