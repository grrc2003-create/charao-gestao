// Regras de negócio de projetos.
import { all, one, run, tx } from '../db.js';
import { badRequest, forbidden, notFound, str, oneOf, date, intOrNull } from '../lib/http.js';
import { canAccessProject, canManageProject, usersWithProjectAccess, isAdmin } from '../lib/permissions.js';
import { summarize, monthlyTrend } from './metrics.js';
import { listVisible, listCancelled } from './tasks.js';
import { audit } from './audit.js';
import { listStages, syncStages, defaultStageId } from './stages.js';
import { getSetting } from './settings.js';
import { listRecurrences } from './recurrences.js';

export const PROJECT_STATUSES = ['planejamento', 'em_andamento', 'pausado', 'concluido', 'cancelado'];

const BASE = `SELECT p.*, l.name AS lead_name FROM projects p LEFT JOIN users l ON l.id = p.lead_id`;

function members(projectId) {
  return all(`SELECT u.id, u.name, u.job_title FROM project_members m JOIN users u ON u.id = m.user_id
    WHERE m.project_id = ? ORDER BY u.name`, projectId);
}

export function listProjects(ctx, tasks = listVisible(ctx)) {
  const rows = all(`${BASE} ORDER BY p.code`).filter(p => canAccessProject(ctx.user, p.id, ctx.projects));
  return rows.map(p => {
    const pt = tasks.filter(t => t.project_id === p.id);
    return { ...p, members: members(p.id), summary: summarize(pt), can_edit: canManageProject(ctx, p.id) };
  });
}

export function getProject(ctx, id) {
  const p = one(`${BASE} WHERE p.id = ?`, id);
  if (!p || !canAccessProject(ctx.user, p.id, ctx.projects)) throw notFound('Projeto não encontrado.');
  const tasks = listVisible(ctx, 'WHERE t.project_id = ?', id);
  // Desempenho por responsável dentro do projeto
  const byUser = new Map();
  for (const t of tasks) {
    const k = t.assignee_id || 0;
    if (!byUser.has(k)) byUser.set(k, { id: t.assignee_id, name: t.assignee_name || 'Sem responsável', tasks: [] });
    byUser.get(k).tasks.push(t);
  }
  const people = [...byUser.values()].map(u => ({ id: u.id, name: u.name, summary: summarize(u.tasks) }))
    .sort((a, b) => b.summary.total - a.summary.total);
  // Andamento por classificação (Grupo/Local/Etapa)
  const stages = listStages(id).map(s => ({ ...s, summary: summarize(tasks.filter(t => t.stage_id === s.id)) }));
  return {
    ...p,
    stages,
    trend: monthlyTrend(tasks),
    cancelled_count: listCancelled(ctx, 'WHERE t.project_id = ?', id).length,
    recurrences: listRecurrences(ctx, { project: id }),
    chronic_min: getSetting('chronic_reschedule_threshold'),
    members: members(id),
    summary: summarize(tasks),
    tasks,
    people,
    can_edit: canManageProject(ctx, id),
    can_create_task: !['concluido', 'cancelado'].includes(p.status),
  };
}

function readProjectBody(body) {
  const d = {
    name: str(body.name, { max: 160, required: true, label: 'Nome do projeto' }),
    client: str(body.client, { max: 160, required: true, label: 'Cliente' }),
    location: str(body.location, { max: 200, label: 'Local' }),
    description: str(body.description, { max: 3000, label: 'Descrição' }),
    status: oneOf(body.status, PROJECT_STATUSES, 'Status', 'planejamento'),
    start_date: date(body.start_date, 'Data de início'),
    end_date: date(body.end_date, 'Previsão de término'),
    actual_end_date: date(body.actual_end_date, 'Término real'),
    lead_id: intOrNull(body.lead_id),
  };
  if (d.start_date && d.end_date && d.end_date < d.start_date) throw badRequest('A previsão de término deve ser posterior ao início.');
  if (d.lead_id && !one('SELECT id FROM users WHERE id = ? AND active = 1', d.lead_id)) throw badRequest('Responsável inválido.');
  const memberIds = [...new Set((Array.isArray(body.member_ids) ? body.member_ids : []).map(intOrNull).filter(Boolean))];
  for (const m of memberIds) if (!one('SELECT id FROM users WHERE id = ?', m)) throw badRequest('Membro inválido.');
  return { d, memberIds };
}

function nextCode() {
  const r = one(`SELECT MAX(CAST(SUBSTR(code, 5) AS INTEGER)) AS n FROM projects WHERE code LIKE 'PRJ-%'`);
  return `PRJ-${String((r?.n || 0) + 1).padStart(3, '0')}`;
}

export function createProject(ctx, body, ip) {
  if (!canManageProject(ctx, null)) throw forbidden('Apenas administradores e gestores podem cadastrar projetos.');
  const { d, memberIds } = readProjectBody(body);
  return tx(() => {
    const code = nextCode();
    const now = new Date().toISOString();
    const r = run(`INSERT INTO projects (code, name, client, location, description, status, start_date, end_date, actual_end_date,
      lead_id, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      code, d.name, d.client, d.location, d.description, d.status, d.start_date, d.end_date, d.actual_end_date, d.lead_id, ctx.user.id, now, now);
    const id = Number(r.lastInsertRowid);
    for (const m of memberIds) run('INSERT INTO project_members (project_id, user_id) VALUES (?,?)', id, m);
    defaultStageId(id);
    const stagesLog = syncStages(id, body.stages);
    // Quem cria um projeto (sem acesso total) recebe acesso a ele
    if (!isAdmin(ctx.user) && ctx.user.access_scope !== 'total') {
      run('INSERT OR IGNORE INTO user_project_access (user_id, project_id) VALUES (?,?)', ctx.user.id, id);
    }
    audit(ctx.user.id, 'project', id, 'Projeto criado', { code, name: d.name, classificacoes: stagesLog?.criadas || [] }, ip);
    return id;
  });
}

export function updateProject(ctx, id, body, ip) {
  const p = one('SELECT * FROM projects WHERE id = ?', id);
  if (!p || !canAccessProject(ctx.user, id, ctx.projects)) throw notFound('Projeto não encontrado.');
  if (!canManageProject(ctx, id)) throw forbidden('Você não pode editar este projeto.');
  const { d, memberIds } = readProjectBody({ ...p, ...body, member_ids: body.member_ids ?? members(id).map(m => m.id) });
  tx(() => {
    run(`UPDATE projects SET name=?, client=?, location=?, description=?, status=?, start_date=?, end_date=?, actual_end_date=?,
      lead_id=?, updated_at=? WHERE id=?`,
      d.name, d.client, d.location, d.description, d.status, d.start_date, d.end_date, d.actual_end_date, d.lead_id, new Date().toISOString(), id);
    run('DELETE FROM project_members WHERE project_id = ?', id);
    for (const m of memberIds) run('INSERT INTO project_members (project_id, user_id) VALUES (?,?)', id, m);
    const changed = Object.keys(d).filter(k => (d[k] ?? null) !== (p[k] ?? null));
    const stagesLog = syncStages(id, body.stages);
    audit(ctx.user.id, 'project', id, 'Projeto atualizado', { campos: changed, ...(stagesLog ? { classificacoes: stagesLog } : {}) }, ip);
  });
}

export function projectAssignees(ctx, id) {
  if (!canAccessProject(ctx.user, id, ctx.projects)) throw notFound('Projeto não encontrado.');
  return usersWithProjectAccess(id);
}
