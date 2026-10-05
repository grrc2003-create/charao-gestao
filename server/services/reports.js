// Montagem de dados para relatórios (A4) e listas de campo. Sempre respeita as permissões do solicitante.
import { all, one } from '../db.js';
import { badRequest, notFound, oneOf, intOrNull, date } from '../lib/http.js';
import { canAccessProject, canSeeUser, teamIds } from '../lib/permissions.js';
import { summarize, userStats, today, monthlyTrend, localDate, PERIODS, groupByPeriod, periodKey, periodLabel, byDue } from './metrics.js';
import { listVisible } from './tasks.js';
import { getSetting } from './settings.js';

export const REPORT_TYPES = ['projeto', 'usuario', 'equipe', 'geral'];
export const LEVELS = ['resumo', 'detalhado', 'completo'];
export const GROUPINGS = ['nenhum', 'classificacao', ...PERIODS];

// Ordenação por classificação: projeto → ordem da classificação ("Geral" primeiro) → prazo
const byStage = (a, b) => a.project_code.localeCompare(b.project_code)
  || (b.stage_default || 0) - (a.stage_default || 0) || (a.stage_order || 0) - (b.stage_order || 0)
  || (a.stage_name || '').localeCompare(b.stage_name || '') || (a.due_date || '9999').localeCompare(b.due_date || '9999');

function groupByStage(tasks, multiProject) {
  const m = new Map();
  for (const t of [...tasks].sort(byStage)) {
    const k = t.stage_id || 0;
    if (!m.has(k)) m.set(k, { key: k, label: multiProject ? `${t.project_code} · ${t.stage_name || 'Geral'}` : (t.stage_name || 'Geral'), tasks: [] });
    m.get(k).tasks.push(t);
  }
  return [...m.values()].map(g => ({ key: g.key, label: g.label, summary: summarize(g.tasks) }));
}

// Dados mínimos para o cronograma (Gantt)
const ganttRow = t => ({
  id: t.id, code: t.code, title: t.title, parent_code: t.parent_code, assignee_name: t.assignee_name,
  project_code: t.project_code, stage_id: t.stage_id, stage_name: t.stage_name,
  start_date: t.start_date, started_at: t.started_at, created_at: t.created_at, due_date: t.due_date,
  original_due: t.original_due, reschedule_count: t.reschedule_count,
  completed_at: t.completed_at, delivered_date: t.delivered_date, eff_status: t.eff_status, days_late: t.days_late,
});

function usersMap() {
  return new Map(all('SELECT id, name, role, manager_id, job_title FROM users').map(u => [u.id, u]));
}

function filterPeriod(tasks, from, to) {
  if (!from && !to) return tasks;
  return tasks.filter(t => (!from || (t.due_date && t.due_date >= from)) && (!to || (t.due_date && t.due_date <= to)));
}

function groupBy(tasks, keyFn, labelFn) {
  const m = new Map();
  for (const t of tasks) {
    const k = keyFn(t);
    if (!m.has(k)) m.set(k, { key: k, label: labelFn(t), tasks: [] });
    m.get(k).tasks.push(t);
  }
  return [...m.values()].map(g => ({ key: g.key, label: g.label, summary: summarize(g.tasks) }))
    .sort((a, b) => b.summary.total - a.summary.total);
}

function attachEvidence(tasks) {
  if (!tasks.length) return tasks;
  const ids = tasks.map(t => t.id);
  const ph = ids.map(() => '?').join(',');
  const files = all(`SELECT id, task_id, kind, caption, created_at FROM task_files WHERE task_id IN (${ph}) ORDER BY id`, ...ids);
  const hist = all(`SELECT h.task_id, h.action, h.details, h.created_at, u.name AS user_name FROM task_history h
    LEFT JOIN users u ON u.id = h.user_id WHERE h.task_id IN (${ph}) ORDER BY h.id`, ...ids);
  return tasks.map(t => ({
    ...t,
    files: files.filter(f => f.task_id === t.id),
    history: hist.filter(h => h.task_id === t.id),
  }));
}

export function buildReport(ctx, q) {
  const type = oneOf(q.type, REPORT_TYPES, 'Tipo de relatório');
  const level = oneOf(q.level, LEVELS, 'Nível de detalhe', 'resumo');
  const from = date(q.from, 'Data inicial');
  const to = date(q.to, 'Data final');
  const includeDone = q.include_done !== '0';
  const group = oneOf(q.group, GROUPINGS, 'Agrupamento', 'nenhum');
  const withGantt = q.gantt !== '0';
  const stageFilter = String(q.stage || '').split(',').map(intOrNull).filter(Boolean);
  const id = intOrNull(q.id);
  const all_ = listVisible(ctx);
  const map = usersMap();
  let tasks, scope, extra = {};

  if (type === 'projeto') {
    if (!id) throw badRequest('Selecione o projeto.');
    const p = one('SELECT p.*, l.name AS lead_name FROM projects p LEFT JOIN users l ON l.id = p.lead_id WHERE p.id = ?', id);
    if (!p || !canAccessProject(ctx.user, id, ctx.projects)) throw notFound('Projeto não encontrado.');
    tasks = all_.filter(t => t.project_id === id);
    scope = { label: `${p.code} · ${p.name}`, subtitle: `Cliente: ${p.client}${p.location ? ` · ${p.location}` : ''}`, project: p };
  } else if (type === 'usuario') {
    if (!id) throw badRequest('Selecione o usuário.');
    if (!canSeeUser(ctx, id) || !map.get(id)) throw notFound('Usuário não encontrado.');
    const u = map.get(id);
    tasks = all_.filter(t => t.assignee_id === id);
    scope = { label: u.name, subtitle: u.job_title || '', user: u };
    extra.user_stats = userStats(u, all_, map);
  } else if (type === 'equipe') {
    if (!id) throw badRequest('Selecione o gestor.');
    if (!canSeeUser(ctx, id) || !map.get(id)) throw notFound('Gestor não encontrado.');
    const u = map.get(id);
    const team = teamIds(id);
    tasks = all_.filter(t => team.has(t.assignee_id) || t.assignee_id === id);
    scope = { label: `Equipe de ${u.name}`, subtitle: `${team.size} integrante(s) sob gestão`, user: u };
    extra.manager_stats = userStats(u, all_, map);
  } else {
    tasks = all_;
    scope = { label: 'Visão geral da operação', subtitle: 'Todos os projetos acessíveis ao emissor' };
  }

  if (q.kind === 'obra' || q.kind === 'interno') tasks = tasks.filter(t => t.project_kind === q.kind);
  tasks = filterPeriod(tasks, from, to);
  if (!includeDone) tasks = tasks.filter(t => t.status !== 'concluida');
  let stageNames = [];
  if (stageFilter.length) {
    tasks = tasks.filter(t => stageFilter.includes(t.stage_id));
    stageNames = [...new Set(tasks.map(t => t.stage_name))];
    if (!stageNames.length) stageNames = all(`SELECT name FROM project_stages WHERE id IN (${stageFilter.map(() => '?').join(',')})`, ...stageFilter).map(r => r.name);
  }
  const byPeriod = PERIODS.includes(group);
  if (group === 'classificacao') tasks = [...tasks].sort(byStage);
  else if (byPeriod) tasks = [...tasks].sort(byDue);

  const summary = summarize(tasks);
  const byProject = groupBy(tasks, t => t.project_id, t => `${t.project_code} · ${t.project_name}`);
  const byPerson = groupBy(tasks, t => t.assignee_id || 0, t => t.assignee_name || 'Sem responsável').map(g => {
    const u = map.get(g.key);
    return { ...g, job_title: u?.job_title || null };
  });
  // Reagendamentos do escopo: motivos e tarefas reagendadas (com o histórico de cada uma)
  const resched = tasks.filter(t => t.reschedule_count > 0);
  let rescheduleRows = [];
  if (resched.length) {
    const ids = resched.map(t => t.id);
    rescheduleRows = all(`SELECT r.task_id, r.old_due, r.new_due, r.reason_name, r.note, r.created_at, u.name AS user_name
      FROM task_reschedules r LEFT JOIN users u ON u.id = r.user_id WHERE r.task_id IN (${ids.map(() => '?').join(',')}) ORDER BY r.id`, ...ids);
  }
  const reasonCount = new Map();
  for (const r of rescheduleRows) reasonCount.set(r.reason_name, (reasonCount.get(r.reason_name) || 0) + 1);
  const rescheduleSummary = {
    reasons: [...reasonCount].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count),
    tasks: resched.sort((a, b) => b.reschedule_count - a.reschedule_count).map(t => ({
      id: t.id, code: t.code, title: t.title, assignee_name: t.assignee_name, original_due: t.original_due, due_date: t.due_date,
      eff_status: t.eff_status, reschedule_count: t.reschedule_count, late_episodes: t.late_episodes, chronic: t.chronic,
      entries: rescheduleRows.filter(r => r.task_id === t.id)
        .map(e => ({ ...e, kind: e.old_due && localDate(e.created_at) > e.old_due ? 'corretiva' : 'preventiva' })),
    })),
  };
  const critical = tasks.filter(t => t.eff_status === 'atrasada').sort((a, b) => b.days_late - a.days_late).slice(0, 10);

  return {
    type, level, from, to, include_done: includeDone, kind: q.kind === 'obra' || q.kind === 'interno' ? q.kind : '', group, gantt: withGantt, stage_filter: stageNames,
    by_stage: groupByStage(tasks, type !== 'projeto'),
    by_period: byPeriod ? groupByPeriod(tasks, group) : [],
    reschedules: rescheduleSummary,
    trend: monthlyTrend(tasks, today(), 6),
    chronic_min: getSetting('chronic_reschedule_threshold'),
    gantt_tasks: withGantt ? (group === 'classificacao' || byPeriod ? tasks : [...tasks].sort(byStage)).map(ganttRow) : [],
    issued_at: new Date().toISOString(),
    issued_by: ctx.user.name,
    reference_date: today(),
    scope,
    summary,
    by_project: byProject,
    by_person: byPerson,
    critical,
    tasks: level === 'resumo' ? [] : level === 'completo' ? attachEvidence(tasks) : tasks,
    ...extra,
  };
}

// Lista de campo: várias tarefas compactas para imprimir e marcar à mão
export function fieldList(ctx, q) {
  const projectId = intOrNull(q.project);
  const userId = intOrNull(q.user);
  const includeDone = q.include_done === '1';
  const includeReview = q.include_review !== '0';
  let tasks = listVisible(ctx);
  let context;
  if (projectId) {
    const p = one('SELECT p.*, l.name AS lead_name FROM projects p LEFT JOIN users l ON l.id = p.lead_id WHERE p.id = ?', projectId);
    if (!p || !canAccessProject(ctx.user, projectId, ctx.projects)) throw notFound('Projeto não encontrado.');
    tasks = tasks.filter(t => t.project_id === projectId);
    context = { kind: 'projeto', title: `${p.code} · ${p.name}`, subtitle: `Cliente: ${p.client}${p.location ? ` · ${p.location}` : ''}`, show_project: false, show_assignee: true };
  } else if (userId) {
    const u = one('SELECT id, name, job_title FROM users WHERE id = ?', userId);
    if (!u || !canSeeUser(ctx, userId)) throw notFound('Usuário não encontrado.');
    tasks = tasks.filter(t => t.assignee_id === userId);
    context = { kind: 'usuario', title: u.name, subtitle: u.job_title || 'Responsável', show_project: true, show_assignee: false };
  } else {
    throw badRequest('Informe o projeto ou o usuário.');
  }
  const stageId = intOrNull(q.stage);
  if (stageId) {
    tasks = tasks.filter(t => t.stage_id === stageId);
    const s = one('SELECT name FROM project_stages WHERE id = ?', stageId);
    if (s) context.stage = s.name;
  }
  if (!includeDone) tasks = tasks.filter(t => t.status !== 'concluida');
  if (!includeReview) tasks = tasks.filter(t => t.status !== 'aguardando_conferencia');
  const org = PERIODS.includes(q.org) ? q.org : null;
  const order = { atrasada: 0, em_andamento: 1, aberta: 2, aguardando_conferencia: 3, concluida: 4 };
  const prio = { urgente: 0, alta: 1, media: 2, baixa: 3 };
  tasks.sort((a, b) => order[a.eff_status] - order[b.eff_status] || prio[a.priority] - prio[b.priority]
    || (a.due_date || '9999').localeCompare(b.due_date || '9999'));
  if (org) { tasks.sort(byDue); context.org = org; }
  return {
    context,
    issued_at: new Date().toISOString(),
    issued_by: ctx.user.name,
    summary: summarize(tasks),
    tasks: tasks.map(t => ({
      id: t.id, code: t.code, title: t.title, parent_code: t.parent_code,
      ...(org ? { period_key: periodKey(t.due_date, org), period_label: periodLabel(periodKey(t.due_date, org), org) } : {}), reschedule_count: t.reschedule_count, original_due: t.original_due,
      stage_id: t.stage_id, stage_name: t.stage_name, stage_order: t.stage_order, stage_default: t.stage_default,
      short: t.field_summary || shorten(t.description),
      project_code: t.project_code, project_name: t.project_name,
      assignee_name: t.assignee_name, due_date: t.due_date, eff_status: t.eff_status, priority: t.priority,
      notes: t.notes ? shorten(t.notes, 110) : null, late_episodes: t.late_episodes, chronic: t.chronic, proof_type: t.proof_type, days_late: t.days_late,
    })),
  };
}

function shorten(text, max = 150) {
  if (!text) return '';
  const clean = text.replace(/\s+/g, ' ').trim();
  const first = clean.split(/(?<=[.!?])\s/)[0];
  const base = first.length >= 40 && first.length <= max ? first : clean;
  return base.length > max ? base.slice(0, max - 1).replace(/\s+\S*$/, '') + '…' : base;
}
