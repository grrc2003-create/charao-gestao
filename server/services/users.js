// Regras de negócio de usuários, equipes e permissões.
import { all, one, run, tx } from '../db.js';
import { impactOfAssignee } from './dependencies.js';
import { badRequest, forbidden, notFound, str, oneOf, intOrNull } from '../lib/http.js';
import { canSeeUser, canSeePersonalData, requireAdmin, teamIds, isAdmin, canCreateTaskIn, userHasProjectAccess, SECTIONS, sectionsOf, requireSection } from '../lib/permissions.js';
import { hashPassword, verifyPassword, validatePasswordStrength, destroyUserSessions } from '../lib/auth.js';
import { userStats, summarize, monthlyTrend } from './metrics.js';
import { listVisible, execWorkDaysAvg } from './tasks.js';
import { audit } from './audit.js';
import { getSetting } from './settings.js';
import { checklistDashboard } from './checklist.js';

export const ROLES = ['admin', 'gestor', 'coordenador', 'colaborador'];
export const SCOPES = ['total', 'projetos', 'proprias'];

const PUBLIC_FIELDS = 'id, name, email, role, access_scope, manager_id, job_title, phone, active, must_change_password, last_login_at, created_at, is_external, company, login_enabled, can_contracts, can_finance, sections, home';

export function publicUser(ctx, u) {
  const out = { ...u, section_list: [...sectionsOf(u)] };
  delete out.sections;
  delete out.password_hash;
  if (isPlaceholderEmail(out.email)) out.email = null;
  if (!canSeePersonalData(ctx, u.id)) { delete out.email; delete out.phone; }
  return out;
}

export function me(user) {
  const { password_hash, ...rest } = user;
  return rest;
}

function usersMap() {
  return new Map(all(`SELECT ${PUBLIC_FIELDS} FROM users`).map(u => [u.id, u]));
}

const withExec = (st, tasks, userId) => ({ ...st, exec_work_days_avg: execWorkDaysAvg(tasks.filter(t => t.assignee_id === userId)) });

export function listUsers(ctx, tasks = listVisible(ctx)) {
  const map = usersMap();
  const rows = [...map.values()].filter(u => canSeeUser(ctx, u.id));
  return rows.map(u => ({
    ...publicUser(ctx, u),
    manager_name: map.get(u.manager_id)?.name || null,
    team_size: teamIds(u.id).size,
    stats: withExec(userStats(u, tasks, map), tasks, u.id),
  })).sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
}

export function getUser(ctx, id) {
  if (!canSeeUser(ctx, id)) throw notFound('Usuário não encontrado.');
  const map = usersMap();
  const u = map.get(id);
  if (!u) throw notFound('Usuário não encontrado.');
  const tasks = listVisible(ctx);
  const own = tasks.filter(t => t.assignee_id === id);
  const team = teamIds(id);
  const teamMembers = [...team].map(tid => map.get(tid)).filter(Boolean).filter(m => canSeeUser(ctx, m.id))
    .map(m => ({ id: m.id, name: m.name, job_title: m.job_title, role: m.role, stats: withExec(userStats(m, tasks, map), tasks, m.id) }));
  const teamTasks = tasks.filter(t => team.has(t.assignee_id));
  const projects = all('SELECT project_id FROM user_project_access WHERE user_id = ?', id).map(r => r.project_id);
  return {
    user: { ...publicUser(ctx, u), manager_name: map.get(u.manager_id)?.name || null, project_ids: projects },
    stats: withExec(userStats(u, tasks, map), tasks, id),
    trend: monthlyTrend(own),
    chronic_min: getSetting('chronic_reschedule_threshold'),
    checklists: checklistDashboard(tasks, { userId: id }),
    impact: impactOfAssignee(id),
    tasks: own,
    created_tasks: tasks.filter(t => t.creator_id === id && t.assignee_id !== id),
    team: teamMembers,
    team_summary: team.size ? summarize(teamTasks) : null,
    team_tasks: teamTasks,
    can_edit: isAdmin(ctx.user),
    // Planejamento da semana: projetos em que quem está vendo pode criar tarefas e que a pessoa da tela pode receber
    plan_projects: u.active ? all(`SELECT id, code, name FROM projects WHERE status NOT IN ('concluido','cancelado') ORDER BY kind = 'interno', code`)
      .filter(p => canCreateTaskIn(ctx, p.id) && userHasProjectAccess(id, p.id)) : [],
  };
}

// Terceirizado: sem login (senha inutilizável), e-mail opcional (só contato), líder interno obrigatório.
const NO_LOGIN = '!sem-login';
const placeholderEmail = () => `terceirizado-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}@sem-login.charao`;
export const isPlaceholderEmail = e => /@sem-login\.charao$/.test(e || '');

// login: acesso ao sistema (regras de Colaborador). Sem login: e-mail opcional, líder conduz as tarefas.
function readExternalBody(body, current) {
  const login = body.login_enabled === true || body.login_enabled === 1 || body.login_enabled === 'on' || body.login_enabled === '1';
  let email = str(body.email, { max: 160, label: 'E-mail' })?.toLowerCase();
  if (email && isPlaceholderEmail(email)) email = null;
  if (login && !email) throw badRequest('Para dar acesso ao sistema, informe o e-mail (login) do terceirizado.');
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw badRequest('E-mail inválido.');
  const d = {
    name: str(body.name, { max: 120, required: true, label: 'Nome' }),
    email: email || (current && isPlaceholderEmail(current.email) ? current.email : placeholderEmail()),
    role: 'colaborador',
    access_scope: login ? oneOf(body.access_scope, SCOPES, 'Escopo de acesso', 'projetos') : 'projetos',
    manager_id: intOrNull(body.manager_id),
    job_title: str(body.job_title, { max: 120, label: 'Função' }),
    phone: str(body.phone, { max: 40, label: 'Telefone' }),
    company: str(body.company, { max: 160, label: 'Empresa terceirizada' }),
    login_enabled: login ? 1 : 0,
  };
  if (!d.manager_id) throw badRequest('Informe o líder do terceirizado (colaborador, coordenador, gestor ou administrador).');
  const leader = one('SELECT * FROM users WHERE id = ?', d.manager_id);
  if (!leader || !leader.active || leader.is_external) throw badRequest('O líder deve ser um usuário interno ativo (colaborador, coordenador, gestor ou administrador).');
  const projectIds = [...new Set((Array.isArray(body.project_ids) ? body.project_ids : []).map(intOrNull).filter(Boolean))];
  for (const p of projectIds) if (!one('SELECT id FROM projects WHERE id = ?', p)) throw badRequest('Projeto inválido na lista de acesso.');
  // O terceirizado só aparece nos projetos liberados a ele
  if (body.project_ids !== undefined && d.access_scope !== 'total' && !projectIds.length) throw badRequest('Marque ao menos um projeto liberado para o terceirizado.');
  return { d, projectIds };
}

function readUserBody(body, { creating }) {
  const d = {
    name: str(body.name, { max: 120, required: true, label: 'Nome' }),
    email: str(body.email, { max: 160, required: true, label: 'E-mail' })?.toLowerCase(),
    role: oneOf(body.role, ROLES, 'Perfil'),
    access_scope: oneOf(body.access_scope, SCOPES, 'Escopo de acesso', 'projetos'),
    manager_id: intOrNull(body.manager_id),
    job_title: str(body.job_title, { max: 120, label: 'Cargo' }),
    phone: str(body.phone, { max: 40, label: 'Telefone' }),
    // Liberação da seção Contratos (e das tarefas da área restrita)
    can_contracts: body.can_contracts === true || body.can_contracts === 1 || body.can_contracts === '1' || body.can_contracts === 'on' ? 1 : 0,
    can_finance: body.can_finance === true || body.can_finance === 1 || body.can_finance === '1' || body.can_finance === 'on' ? 1 : 0,
    sections: Array.isArray(body.sections) ? JSON.stringify([...new Set(body.sections.filter(x => SECTIONS.includes(x)))]) : (body.sections ?? null),
    home: body.home === 'pessoal' || body.home === 'empresa' ? body.home : null,
  };
  if (Array.isArray(body.sections)) {
    d.can_contracts = body.sections.includes('contratos') ? 1 : 0;
    d.can_finance = body.sections.includes('financeiro') ? 1 : 0;
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(d.email)) throw badRequest('E-mail inválido.');
  if (d.role === 'admin') d.access_scope = 'total';
  const projectIds = [...new Set((Array.isArray(body.project_ids) ? body.project_ids : []).map(intOrNull).filter(Boolean))];
  for (const p of projectIds) if (!one('SELECT id FROM projects WHERE id = ?', p)) throw badRequest('Projeto inválido na lista de acesso.');
  if (creating) validatePasswordStrength(body.password);
  return { d, projectIds };
}

function assertNoManagerCycle(userId, managerId) {
  if (!managerId) return;
  if (managerId === userId) throw badRequest('Um usuário não pode ser gestor de si mesmo.');
  if (!one('SELECT id FROM users WHERE id = ?', managerId)) throw badRequest('Gestor inválido.');
  if (userId && teamIds(userId).has(managerId)) throw badRequest('Hierarquia inválida: o gestor escolhido é subordinado deste usuário.');
}

// Cadastro de usuários: seção própria (administradores sempre). Quem não é administrador não cria nem edita
// administradores e só libera seções que ele mesmo tem.
function requireCadastro(ctx, target = null, body = {}) {
  requireSection(ctx.user, 'cadastro_usuarios');
  if (isAdmin(ctx.user)) return;
  if (target && target.role === 'admin') throw forbidden('Somente administradores alteram administradores.');
  if (body.role === 'admin') throw forbidden('Somente administradores criam administradores.');
  if (Array.isArray(body.sections)) {
    const mine = sectionsOf(ctx.user);
    const extra = body.sections.filter(s => !mine.has(s) && !(target && sectionsOf(target).has(s)));
    if (extra.length) throw forbidden('Você só pode liberar as seções que você mesmo tem.');
  }
}

export function createUser(ctx, body, ip) {
  requireCadastro(ctx, null, body);
  if (body.role === 'terceirizado') {
    const { d, projectIds } = readExternalBody(body);
    if (d.login_enabled) validatePasswordStrength(body.password);
    if (one('SELECT id FROM users WHERE email = ?', d.email)) throw badRequest('Já existe um usuário com este e-mail.');
    return tx(() => {
      const r = run(`INSERT INTO users (name, email, password_hash, role, access_scope, manager_id, job_title, phone, is_external, company, login_enabled, must_change_password)
        VALUES (?,?,?,?,?,?,?,?,1,?,?,?)`, d.name, d.email, d.login_enabled ? hashPassword(body.password) : NO_LOGIN, d.role, d.access_scope,
        d.manager_id, d.job_title, d.phone, d.company, d.login_enabled, d.login_enabled);
      const id = Number(r.lastInsertRowid);
      for (const p of projectIds) run('INSERT INTO user_project_access (user_id, project_id) VALUES (?,?)', id, p);
      audit(ctx.user.id, 'user', id, d.login_enabled ? 'Terceirizado cadastrado (com acesso ao sistema)' : 'Terceirizado cadastrado (sem login)',
        { nome: d.name, empresa: d.company || '—', lider: one('SELECT name FROM users WHERE id = ?', d.manager_id).name, projetos: projectIds }, ip);
      return id;
    });
  }
  const { d, projectIds } = readUserBody(body, { creating: true });
  if (one('SELECT id FROM users WHERE email = ?', d.email)) throw badRequest('Já existe um usuário com este e-mail.');
  assertNoManagerCycle(null, d.manager_id);
  if (d.manager_id && one('SELECT is_external FROM users WHERE id = ?', d.manager_id)?.is_external) throw badRequest('Um terceirizado não pode ser gestor de outro usuário.');
  return tx(() => {
    const r = run(`INSERT INTO users (name, email, password_hash, role, access_scope, manager_id, job_title, phone, can_contracts, can_finance, sections, home, must_change_password)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1)`, d.name, d.email, hashPassword(body.password), d.role, d.access_scope, d.manager_id, d.job_title, d.phone, d.can_contracts, d.can_finance, Array.isArray(body.sections) ? d.sections : null, d.home);
    const id = Number(r.lastInsertRowid);
    for (const p of projectIds) run('INSERT INTO user_project_access (user_id, project_id) VALUES (?,?)', id, p);
    audit(ctx.user.id, 'user', id, 'Usuário criado', { email: d.email, perfil: d.role, escopo: d.access_scope, projetos: projectIds, contratos: !!d.can_contracts, financeiro: !!d.can_finance }, ip);
    return id;
  });
}

export function updateUser(ctx, id, body, ip) {
  requireCadastro(ctx, one('SELECT * FROM users WHERE id = ?', id), body);
  const u = one('SELECT * FROM users WHERE id = ?', id);
  if (!u) throw notFound('Usuário não encontrado.');
  if (u.is_external) return updateExternal(ctx, u, body, ip);
  if (body.role === 'terceirizado') throw badRequest('Um usuário interno não pode ser convertido em terceirizado. Cadastre um novo terceirizado.');
  if (body.manager_id && one('SELECT is_external FROM users WHERE id = ?', intOrNull(body.manager_id))?.is_external) throw badRequest('Um terceirizado não pode ser gestor de outro usuário.');
  const { d, projectIds } = readUserBody({ ...u, ...body }, { creating: false });
  const dup = one('SELECT id FROM users WHERE email = ? AND id <> ?', d.email, id);
  if (dup) throw badRequest('Já existe um usuário com este e-mail.');
  assertNoManagerCycle(id, d.manager_id);
  if (u.role === 'admin' && d.role !== 'admin') ensureAnotherAdmin(id);
  const active = body.active === undefined ? u.active : body.active ? 1 : 0;
  if (!active && id === ctx.user.id) throw badRequest('Você não pode desativar o próprio usuário.');
  if (u.role === 'admin' && !active) ensureAnotherAdmin(id);
  tx(() => {
    const secGiven = Array.isArray(body.sections);
    const newCt = secGiven || body.can_contracts !== undefined ? d.can_contracts : u.can_contracts;
    const newFin = secGiven || body.can_finance !== undefined ? d.can_finance : u.can_finance;
    const newSec = secGiven ? d.sections : u.sections;
    run(`UPDATE users SET name=?, email=?, role=?, access_scope=?, manager_id=?, job_title=?, phone=?, can_contracts=?, can_finance=?, sections=?, home=?, active=?, updated_at=datetime('now') WHERE id=?`,
      d.name, d.email, d.role, d.access_scope, d.manager_id, d.job_title, d.phone, newCt, newFin, newSec, d.home, active, id);
    const finChanged = !!u.can_finance !== !!newFin;
    const secChanged = secGiven && (u.sections || JSON.stringify([...sectionsOf(u)])) !== newSec;
    const ctChanged = finChanged || secChanged || !!u.can_contracts !== !!newCt;
    const before = all('SELECT project_id FROM user_project_access WHERE user_id = ?', id).map(r => r.project_id).sort();
    if (body.project_ids !== undefined) {
      run('DELETE FROM user_project_access WHERE user_id = ?', id);
      for (const p of projectIds) run('INSERT INTO user_project_access (user_id, project_id) VALUES (?,?)', id, p);
    }
    const permChanged = ctChanged || u.role !== d.role || u.access_scope !== d.access_scope || (body.project_ids !== undefined && before.join() !== [...projectIds].sort().join());
    audit(ctx.user.id, 'user', id, permChanged ? 'Permissões alteradas' : 'Usuário atualizado', {
      perfil: `${u.role} → ${d.role}`, escopo: `${u.access_scope} → ${d.access_scope}`, projetos: projectIds, ativo: !!active,
      ...(!!u.can_contracts !== !!newCt ? { contratos: newCt ? 'liberado' : 'retirado' } : {}),
      ...(secChanged ? { secoes: JSON.parse(newSec) } : {}),
      ...(finChanged ? { financeiro: newFin ? 'liberado' : 'retirado' } : {}),
      gestor: d.manager_id,
    }, ip);
    // Encerra sessões ao desativar ou ao reduzir permissões, forçando novo login
    if (!active || permChanged) destroyUserSessions(id);
  });
}

function ensureAnotherAdmin(exceptId) {
  const n = one(`SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND active = 1 AND id <> ?`, exceptId).n;
  if (!n) throw badRequest('É necessário manter pelo menos um administrador ativo.');
}

export function resetPassword(ctx, id, body, ip) {
  requireCadastro(ctx, one('SELECT * FROM users WHERE id = ?', id));
  const target = one('SELECT id, login_enabled FROM users WHERE id = ?', id);
  if (!target) throw notFound();
  if (!target.login_enabled) throw badRequest('Este terceirizado não tem acesso ao sistema.');
  validatePasswordStrength(body.password);
  run(`UPDATE users SET password_hash = ?, must_change_password = 1, updated_at = datetime('now') WHERE id = ?`, hashPassword(body.password), id);
  destroyUserSessions(id);
  audit(ctx.user.id, 'user', id, 'Senha redefinida pelo administrador', null, ip);
}

export function changeOwnPassword(user, body, ip) {
  if (!verifyPassword(String(body.current || ''), user.password_hash)) throw badRequest('Senha atual incorreta.');
  validatePasswordStrength(body.password);
  if (body.password === body.current) throw badRequest('A nova senha deve ser diferente da atual.');
  run(`UPDATE users SET password_hash = ?, must_change_password = 0, updated_at = datetime('now') WHERE id = ?`, hashPassword(body.password), user.id);
  audit(user.id, 'user', user.id, 'Senha alterada pelo próprio usuário', null, ip);
}

export function assertCanSeeUser(ctx, id) {
  if (!canSeeUser(ctx, id)) throw forbidden();
}

function updateExternal(ctx, u, body, ip) {
  const { d, projectIds } = readExternalBody({ ...u, project_ids: undefined, ...body, login_enabled: 'login_enabled' in body ? body.login_enabled : u.login_enabled }, u);
  const dup = one('SELECT id FROM users WHERE email = ? AND id <> ?', d.email, u.id);
  if (dup) throw badRequest('Já existe um usuário com este e-mail.');
  const enabling = d.login_enabled && !u.login_enabled;
  if (enabling) validatePasswordStrength(body.password);
  const active = body.active === undefined ? u.active : body.active ? 1 : 0;
  tx(() => {
    run(`UPDATE users SET name=?, email=?, manager_id=?, job_title=?, phone=?, company=?, access_scope=?, login_enabled=?, active=?, updated_at=datetime('now') WHERE id=?`,
      d.name, d.email, d.manager_id, d.job_title, d.phone, d.company, d.access_scope, d.login_enabled, active, u.id);
    if (enabling) run('UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ?', hashPassword(body.password), u.id);
    if (!d.login_enabled && u.login_enabled) run('UPDATE users SET password_hash = ? WHERE id = ?', NO_LOGIN, u.id);
    const before = all('SELECT project_id FROM user_project_access WHERE user_id = ?', u.id).map(r => r.project_id).sort().join();
    if (body.project_ids !== undefined) {
      run('DELETE FROM user_project_access WHERE user_id = ?', u.id);
      for (const p of projectIds) run('INSERT INTO user_project_access (user_id, project_id) VALUES (?,?)', u.id, p);
    }
    const permChanged = d.login_enabled !== u.login_enabled || d.access_scope !== u.access_scope || (body.project_ids !== undefined && before !== [...projectIds].sort().join());
    if (!active || permChanged) destroyUserSessions(u.id);
    audit(ctx.user.id, 'user', u.id, permChanged ? 'Terceirizado: acesso/permissões alterados' : 'Terceirizado atualizado', {
      nome: d.name, empresa: d.company || '—', lider: one('SELECT name FROM users WHERE id = ?', d.manager_id).name,
      acesso_ao_sistema: !!d.login_enabled, projetos: body.project_ids !== undefined ? projectIds : '(sem alteração)', ativo: !!active }, ip);
  });
}
