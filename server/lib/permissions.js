// Regras de autorização — TODA verificação de acesso do backend passa por aqui.
// Perfis: admin (controle total), gestor (gerencia projetos acessíveis e acompanha a equipe),
// coordenador (igual ao gestor e também confere as próprias tarefas),
// colaborador (executa e cria tarefas nos projetos acessíveis).
// Escopo de acesso: total | projetos (lista liberada) | proprias (só tarefas próprias nos projetos liberados).
import { all, one } from '../db.js';
import { forbidden } from './http.js';

export const isAdmin = u => u.role === 'admin';
// Gestor e Coordenador têm as mesmas permissões de gestão
export const isManagerRole = u => u.role === 'gestor' || u.role === 'coordenador';

// null = todos os projetos; Set = apenas os ids listados
export function accessibleProjectIds(user) {
  if (isAdmin(user) || user.access_scope === 'total') return null;
  const ids = new Set(all('SELECT project_id FROM user_project_access WHERE user_id = ?', user.id).map(r => r.project_id));
  for (const r of all('SELECT id FROM projects WHERE lead_id = ?', user.id)) ids.add(r.id);
  return ids;
}

export function canAccessProject(user, projectId, ids = accessibleProjectIds(user)) {
  return ids === null || ids.has(projectId);
}

// Subordinados diretos e indiretos
export function teamIds(userId) {
  const rows = all('SELECT id, manager_id FROM users');
  const byMgr = new Map();
  for (const r of rows) {
    if (!r.manager_id) continue;
    if (!byMgr.has(r.manager_id)) byMgr.set(r.manager_id, []);
    byMgr.get(r.manager_id).push(r.id);
  }
  const out = new Set();
  const stack = [...(byMgr.get(userId) || [])];
  while (stack.length) {
    const id = stack.pop();
    if (out.has(id) || id === userId) continue;
    out.add(id);
    stack.push(...(byMgr.get(id) || []));
  }
  return out;
}

// Contexto de acesso calculado uma vez por requisição
export function accessContext(user) {
  return { user, projects: accessibleProjectIds(user), team: teamIds(user.id) };
}

export function canSeeTask(ctx, t) {
  const { user } = ctx;
  if (isAdmin(user)) return true;
  if (t.assignee_id === user.id || t.creator_id === user.id) return true;
  if (t.assignee_id && ctx.team.has(t.assignee_id)) return true; // gestor acompanha a equipe
  if (!canAccessProject(user, t.project_id, ctx.projects)) return false;
  return user.access_scope !== 'proprias';
}

// Editar dados da solicitação (título, prazo, responsável, prioridade...)
export function canManageTask(ctx, t) {
  const { user } = ctx;
  if (isAdmin(user)) return true;
  if (t.creator_id === user.id) return true;
  if (isManagerRole(user)) {
    if (t.assignee_id && ctx.team.has(t.assignee_id)) return true;
    return canAccessProject(user, t.project_id, ctx.projects) && user.access_scope !== 'proprias';
  }
  return false;
}

// Conferir (aprovar/devolver), salvo admin o responsável não confere a própria entrega.
// Terceirizado sem acesso ao sistema: a tarefa é conduzida pelo líder (registra e confere a execução)
export const isLeaderOfNoLogin = (ctx, t) => !!t.assignee_external && !t.assignee_login && t.assignee_leader_id === ctx.user.id;

// O responsável não confere a própria entrega. O líder de um terceirizado sem acesso confere a entrega dele.
// Coordenador confere as tarefas da equipe e também as próprias.
export function canReviewTask(ctx, t) {
  if (isLeaderOfNoLogin(ctx, t)) return true;
  if (!canManageTask(ctx, t)) return false;
  return isAdmin(ctx.user) || ctx.user.role === 'coordenador' || t.assignee_id !== ctx.user.id;
}

// Somente o responsável registra a execução (gestores/admin podem concluir diretamente)
// Terceirizado sem acesso ao sistema: o líder registra a execução em seu nome
export function canExecuteTask(ctx, t) {
  return t.assignee_id === ctx.user.id || isLeaderOfNoLogin(ctx, t);
}

// Alocar (trocar o responsável): qualquer pessoa liberada no projeto que veja a tarefa, enquanto ela não foi entregue
export function canReassignTask(ctx, t) {
  if (t.cancelled_at || !['aberta', 'em_andamento'].includes(t.status)) return false;
  return canManageTask(ctx, t) || (canSeeTask(ctx, t) && canAccessProject(ctx.user, t.project_id, ctx.projects));
}

export function canCreateTaskIn(ctx, projectId) {
  return canAccessProject(ctx.user, projectId, ctx.projects);
}

export function canManageProject(ctx, projectId) {
  const { user } = ctx;
  if (isAdmin(user)) return true;
  if (!isManagerRole(user)) return false;
  return projectId == null || canAccessProject(user, projectId, ctx.projects);
}

export function canSeeUser(ctx, userId) {
  const { user } = ctx;
  return isAdmin(user) || user.id === userId || ctx.team.has(userId);
}

// Dados pessoais (e-mail, telefone) só para admin, o próprio e o gestor direto/indireto
export function canSeePersonalData(ctx, userId) {
  return canSeeUser(ctx, userId);
}

// Configurações gerais (ex.: justificativas de reagendamento): Gestor e Administrador
export const canManageSettings = user => isAdmin(user) || isManagerRole(user);
export function requireSettingsManager(user) {
  if (!canManageSettings(user)) throw forbidden('Apenas gestores e administradores alteram as configurações.');
}

export function requireAdmin(user) {
  if (!isAdmin(user)) throw forbidden('Apenas administradores podem realizar esta ação.');
}

// Usuários que podem ser responsáveis no projeto (terceirizados: somente se o projeto estiver liberado a eles)
export function usersWithProjectAccess(projectId) {
  return all(`SELECT u.id, u.name, u.job_title, u.role, u.is_external, u.company FROM users u
    WHERE u.active = 1 AND (u.role = 'admin' OR u.access_scope = 'total'
      OR EXISTS (SELECT 1 FROM user_project_access a WHERE a.user_id = u.id AND a.project_id = ?)
      OR EXISTS (SELECT 1 FROM projects p WHERE p.id = ? AND p.lead_id = u.id))
    ORDER BY u.is_external, u.name`, projectId, projectId);
}

export function userHasProjectAccess(userId, projectId) {
  const u = one('SELECT * FROM users WHERE id = ? AND active = 1', userId);
  if (!u) return false;
  return canAccessProject(u, projectId);
}
