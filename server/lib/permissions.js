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

// Áreas internas restritas: 1 = Contratos (liberação can_contracts), 2 = Financeiro (liberação can_finance)
const RESTRICTED_FLAG = { 1: 'can_contracts', 2: 'can_finance' };
const restrictedRows = () => all('SELECT id, restricted FROM projects WHERE restricted > 0');
const allowed = (user, r) => !!user?.[RESTRICTED_FLAG[r.restricted]];
export const restrictedProjectIds = () => new Set(restrictedRows().map(r => r.id));
export const hiddenProjectIds = user => new Set(restrictedRows().filter(r => !allowed(user, r)).map(r => r.id));

// null = todos os projetos; Set = apenas os ids listados
export function accessibleProjectIds(user) {
  const restricted = restrictedRows();
  const hidden = new Set(restricted.filter(r => !allowed(user, r)).map(r => r.id));
  if (isAdmin(user) || user.access_scope === 'total') {
    if (!hidden.size) return null;
    return new Set(all('SELECT id FROM projects').map(r => r.id).filter(id => !hidden.has(id)));
  }
  const ids = new Set(all('SELECT project_id FROM user_project_access WHERE user_id = ?', user.id).map(r => r.project_id));
  for (const r of all('SELECT id FROM projects WHERE lead_id = ?', user.id)) ids.add(r.id);
  // Liberado: acessa a área restrita correspondente; sem liberação, nunca
  for (const r of restricted) { if (hidden.has(r.id)) ids.delete(r.id); else ids.add(r.id); }
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
  // Check-lists em que o usuário (ou um terceirizado sem acesso liderado por ele) é responsável por algum item
  const checklist = new Set(all(`SELECT DISTINCT ci.task_id FROM checklist_items ci LEFT JOIN users u ON u.id = ci.assignee_id
    WHERE ci.assignee_id = ? OR (u.is_external = 1 AND u.login_enabled = 0 AND u.manager_id = ?)`, user.id, user.id).map(r => r.task_id));
  return { user, projects: accessibleProjectIds(user), team: teamIds(user.id), checklist, hidden: hiddenProjectIds(user) };
}

export function canSeeTask(ctx, t) {
  const { user } = ctx;
  // Tarefas da área restrita (Contratos): somente liberados, inclusive administradores
  if ((ctx.hidden || hiddenProjectIds(user)).has(t.project_id)) return false;
  if (isAdmin(user)) return true;
  if (t.assignee_id === user.id || t.creator_id === user.id) return true;
  if (t.assignee_id && ctx.team.has(t.assignee_id)) return true; // gestor acompanha a equipe
  if (ctx.checklist?.has(t.id)) return true; // responsável por itens do check-list
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
  return isAdmin(user) || user.id === userId || ctx.team.has(userId) || hasSection(user, 'cadastro_usuarios');
}

// Dados pessoais (e-mail, telefone) só para admin, o próprio e o gestor direto/indireto
export function canSeePersonalData(ctx, userId) {
  return canSeeUser(ctx, userId);
}

// ---------- Seções liberadas por usuário ----------
// Gestão de Obras · Gestão da Empresa · Administração. Sem lista salva, vale o padrão do perfil.
export const SECTIONS = ['dashboard', 'projetos', 'tarefas', 'usuarios', 'relatorios', 'contratos', 'financeiro', 'equipe', 'cadastro_usuarios', 'processos', 'folha', 'auditoria', 'configuracoes'];
export const SECTION_LABEL = { dashboard: 'Visão da empresa', projetos: 'Projetos', tarefas: 'Tarefas', usuarios: 'Desempenho das pessoas', relatorios: 'Relatórios',
  contratos: 'Contratos', financeiro: 'Tarefas financeiras', equipe: 'Organograma e Férias', cadastro_usuarios: 'Cadastro da Equipe', processos: 'Processos da Empresa (edição)', folha: 'Folha (Administrativa)', auditoria: 'Auditoria', configuracoes: 'Configurações' };
export function defaultSections(u) {
  const s = ['dashboard', 'projetos', 'tarefas', 'usuarios', 'relatorios'];
  if (u.can_contracts) s.push('contratos');
  if (u.can_finance) s.push('financeiro');
  if (isAdmin(u)) s.push('equipe', 'cadastro_usuarios', 'processos', 'folha', 'auditoria');
  if (isAdmin(u) || isManagerRole(u)) s.push('configuracoes');
  if (isManagerRole(u)) s.push('processos'); // gestor e coordenador criam processos (publicação: administrador)
  return s;
}
export function sectionsOf(u) {
  if (!u) return new Set();
  let list = null;
  try { list = u.sections ? JSON.parse(u.sections) : null; } catch { list = null; }
  const set = new Set(Array.isArray(list) ? list.filter(x => SECTIONS.includes(x)) : defaultSections(u));
  // Contratos e Financeiro acompanham as liberações das áreas restritas
  if (u.can_contracts) set.add('contratos'); else set.delete('contratos');
  if (u.can_finance) set.add('financeiro'); else set.delete('financeiro');
  if (isAdmin(u)) set.add('cadastro_usuarios'); // administrador nunca perde o cadastro de usuários
  return set;
}
export const hasSection = (u, k) => sectionsOf(u).has(k);
export function requireSection(u, k) {
  if (!hasSection(u, k)) throw forbidden(`A seção ${SECTION_LABEL[k]} não está liberada para o seu usuário.`);
}

// Configurações gerais: seção Configurações (padrão: Gestor e Administrador)
export const canManageSettings = user => hasSection(user, 'configuracoes');
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
