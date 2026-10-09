// Regras de negócio de projetos.
import { all, one, run, tx } from '../db.js';
import { badRequest, forbidden, notFound, str, oneOf, date, intOrNull } from '../lib/http.js';
import { canAccessProject, canManageProject, usersWithProjectAccess, isAdmin } from '../lib/permissions.js';
import { summarize, monthlyTrend } from './metrics.js';
import { listVisible, listCancelled } from './tasks.js';
import { audit } from './audit.js';
import { listStages, syncStages, defaultStageId } from './stages.js';
import { getSetting, validTemplateId } from './settings.js';
import { UFS } from './calendar.js';
import { listRecurrences } from './recurrences.js';
import { checklistDashboard } from './checklist.js';

export const PROJECT_STATUSES = ['planejamento', 'em_andamento', 'pausado', 'concluido', 'cancelado'];

const BASE = `SELECT p.*, l.name AS lead_name FROM projects p LEFT JOIN users l ON l.id = p.lead_id`;

// Equipe = usuários com o projeto liberado (mesma liberação de Usuários → Permissões)
function members(projectId) {
  return all(`SELECT u.id, u.name, u.job_title, u.is_external FROM users u
    WHERE EXISTS (SELECT 1 FROM project_members m WHERE m.project_id = ? AND m.user_id = u.id)
       OR EXISTS (SELECT 1 FROM user_project_access a WHERE a.project_id = ? AND a.user_id = u.id)
    ORDER BY u.is_external, u.name`, projectId, projectId);
}

// Marcar na equipe libera o projeto; desmarcar retira a liberação (admins e acesso total sempre têm acesso)
function syncTeam(projectId, memberIds, before = []) {
  const want = new Set(memberIds);
  const had = new Set(before);
  run('DELETE FROM project_members WHERE project_id = ?', projectId);
  for (const m of want) {
    run('INSERT OR IGNORE INTO project_members (project_id, user_id) VALUES (?,?)', projectId, m);
    const u = one('SELECT role, access_scope FROM users WHERE id = ?', m);
    if (u && u.role !== 'admin' && u.access_scope !== 'total') run('INSERT OR IGNORE INTO user_project_access (user_id, project_id) VALUES (?,?)', m, projectId);
  }
  const removed = [...had].filter(id => !want.has(id));
  for (const m of removed) run('DELETE FROM user_project_access WHERE user_id = ? AND project_id = ?', m, projectId);
  const name = id => one('SELECT name FROM users WHERE id = ?', id)?.name;
  const added = [...want].filter(id => !had.has(id));
  return added.length || removed.length ? { incluidos: added.map(name), removidos: removed.map(name) } : null;
}

export function listProjects(ctx, tasks = listVisible(ctx)) {
  const rows = all(`${BASE} ORDER BY p.kind = 'interno', p.code`).filter(p => canAccessProject(ctx.user, p.id, ctx.projects));
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
    checklists: checklistDashboard(tasks),
    tasks,
    people,
    can_edit: canManageProject(ctx, id),
    can_create_task: !['concluido', 'cancelado'].includes(p.status),
  };
}

function readProjectBody(body) {
  const kind = body.kind === 'interno' ? 'interno' : 'obra';
  const d = {
    name: str(body.name, { max: 160, required: true, label: kind === 'interno' ? 'Nome da área' : 'Nome do projeto' }),
    // Área interna: cliente é a própria empresa
    client: kind === 'interno' ? (str(body.client, { max: 160, label: 'Cliente' }) || COMPANY_NAME) : str(body.client, { max: 160, required: true, label: 'Cliente' }),
    location: str(body.location, { max: 200, label: 'Local' }),
    description: str(body.description, { max: 3000, label: 'Descrição' }),
    status: oneOf(body.status, PROJECT_STATUSES, 'Status', 'planejamento'),
    start_date: date(body.start_date, 'Data de início'),
    end_date: date(body.end_date, 'Previsão de término'),
    actual_end_date: date(body.actual_end_date, 'Término real'),
    lead_id: intOrNull(body.lead_id),
    // Modelo de especialidades do check-list (Configurações)
    specialty_template_id: validTemplateId(body.specialty_template_id),
    // Local da obra para o calendário (feriados estaduais e municipais)
    uf: body.uf ? oneOf(String(body.uf).toUpperCase(), UFS, 'Estado') : null,
    municipio: str(body.municipio, { max: 120, label: 'Município' }) || null,
    ibge_code: intOrNull(body.ibge_code),
  };
  if (d.start_date && d.end_date && d.end_date < d.start_date) throw badRequest('A previsão de término deve ser posterior ao início.');
  if (d.lead_id && !one('SELECT id FROM users WHERE id = ? AND active = 1 AND is_external = 0', d.lead_id)) throw badRequest('Responsável técnico deve ser um usuário interno ativo.');
  const memberIds = [...new Set((Array.isArray(body.member_ids) ? body.member_ids : []).map(intOrNull).filter(Boolean))];
  for (const m of memberIds) if (!one('SELECT id FROM users WHERE id = ?', m)) throw badRequest('Integrante da equipe inválido.');
  return { d, memberIds };
}

// Obras: PRJ-001… · Áreas internas da empresa: INT-001…
export const COMPANY_NAME = 'Charão Engenharia e Construção';
function nextCode(kind = 'obra') {
  const prefix = kind === 'interno' ? 'INT' : 'PRJ';
  const r = one(`SELECT MAX(CAST(SUBSTR(code, 5) AS INTEGER)) AS n FROM projects WHERE code LIKE '${prefix}-%'`);
  return `${prefix}-${String((r?.n || 0) + 1).padStart(3, '0')}`;
}

// Cria uma única vez a área interna padrão, com departamentos como classificações e acesso para gestores
export function ensureInternalArea() {
  if (one(`SELECT value FROM app_settings WHERE key = 'internal_area_created'`)) return null;
  return tx(() => {
    const now = new Date().toISOString();
    const r = run(`INSERT INTO projects (code, name, client, description, status, kind, created_at, updated_at) VALUES (?,?,?,?, 'em_andamento', 'interno', ?, ?)`,
      nextCode('interno'), 'Charão — Interno', COMPANY_NAME, 'Tarefas internas da empresa, não vinculadas a obras. Use as classificações como departamentos.', now, now);
    const id = Number(r.lastInsertRowid);
    defaultStageId(id);
    ['Administrativo', 'Comercial', 'Financeiro', 'Equipamentos e manutenção', 'Pessoas (RH)', 'Segurança do trabalho']
      .forEach((n, i) => run('INSERT INTO project_stages (project_id, name, sort_order) VALUES (?,?,?)', id, n, i + 1));
    for (const g of all(`SELECT id FROM users WHERE role IN ('gestor','coordenador') AND access_scope <> 'total'`)) {
      run('INSERT OR IGNORE INTO user_project_access (user_id, project_id) VALUES (?,?)', g.id, id);
    }
    run(`INSERT INTO app_settings (key, value) VALUES ('internal_area_created', ?)`, String(id));
    audit(null, 'project', id, 'Área interna padrão criada', { nome: 'Charão — Interno', acesso: 'Administradores e Gestores' });
    return id;
  });
}

export function createProject(ctx, body, ip) {
  if (!canManageProject(ctx, null)) throw forbidden('Apenas administradores e gestores podem cadastrar projetos.');
  const { d, memberIds } = readProjectBody(body);
  const kind = body.kind === 'interno' ? 'interno' : 'obra';
  return tx(() => {
    const code = nextCode(kind);
    const now = new Date().toISOString();
    const r = run(`INSERT INTO projects (code, name, client, location, description, status, start_date, end_date, actual_end_date,
      lead_id, specialty_template_id, uf, municipio, ibge_code, kind, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      code, d.name, d.client, d.location, d.description, d.status, d.start_date, d.end_date, d.actual_end_date, d.lead_id, d.specialty_template_id,
      d.uf, d.municipio, d.ibge_code, kind, ctx.user.id, now, now);
    const id = Number(r.lastInsertRowid);
    const teamLog = syncTeam(id, memberIds);
    defaultStageId(id);
    const stagesLog = syncStages(id, body.stages);
    // Quem cria um projeto (sem acesso total) recebe acesso a ele
    if (!isAdmin(ctx.user) && ctx.user.access_scope !== 'total') {
      run('INSERT OR IGNORE INTO user_project_access (user_id, project_id) VALUES (?,?)', ctx.user.id, id);
    }
    audit(ctx.user.id, 'project', id, 'Projeto criado', { code, name: d.name, classificacoes: stagesLog?.criadas || [], equipe: teamLog?.incluidos || [] }, ip);
    return id;
  });
}

export function updateProject(ctx, id, body, ip) {
  const p = one('SELECT * FROM projects WHERE id = ?', id);
  if (!p || !canAccessProject(ctx.user, id, ctx.projects)) throw notFound('Projeto não encontrado.');
  if (!canManageProject(ctx, id)) throw forbidden('Você não pode editar este projeto.');
  const { d, memberIds } = readProjectBody({ ...p, ...body, kind: p.kind, member_ids: body.member_ids ?? members(id).map(m => m.id) });
  tx(() => {
    run(`UPDATE projects SET name=?, client=?, location=?, description=?, status=?, start_date=?, end_date=?, actual_end_date=?,
      lead_id=?, specialty_template_id=?, uf=?, municipio=?, ibge_code=?, updated_at=? WHERE id=?`,
      d.name, d.client, d.location, d.description, d.status, d.start_date, d.end_date, d.actual_end_date, d.lead_id, d.specialty_template_id,
      d.uf, d.municipio, d.ibge_code, new Date().toISOString(), id);
    const teamLog = body.member_ids !== undefined ? syncTeam(id, memberIds, members(id).map(m => m.id)) : null;
    const changed = Object.keys(d).filter(k => (d[k] ?? null) !== (p[k] ?? null));
    const stagesLog = syncStages(id, body.stages);
    audit(ctx.user.id, 'project', id, 'Projeto atualizado', { campos: changed, ...(stagesLog ? { classificacoes: stagesLog } : {}), ...(teamLog ? { equipe_e_acesso: teamLog } : {}) }, ip);
  });
}

export function projectAssignees(ctx, id) {
  if (!canAccessProject(ctx.user, id, ctx.projects)) throw notFound('Projeto não encontrado.');
  return usersWithProjectAccess(id);
}
