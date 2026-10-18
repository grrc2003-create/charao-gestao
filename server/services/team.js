// Gestão da Equipe: organograma (hierarquia por gestor/líder) e Cadastro da Equipe (função, responsabilidades,
// setor e admissão). Pessoas sem acesso ao sistema também entram (cadastradas aqui, sem login).
import { all, one, run, tx } from '../db.js';
import { badRequest, forbidden, notFound, str, date, intOrNull } from '../lib/http.js';
import { isAdmin, requireSection, hasSection, teamIds } from '../lib/permissions.js';
import { audit } from './audit.js';
import { today } from './metrics.js';
import { NO_LOGIN, placeholderEmail, isPlaceholderEmail, assertNoManagerCycle } from './users.js';
import { vacationSummary } from './vacations.js';

export const requireTeam = ctx => requireSection(ctx.user, 'equipe');
const missingFunction = u => !String(u.job_title || '').trim() || !String(u.responsibilities || '').trim();

// Tarefas em aberto / atrasadas / em conferência por responsável (todas as áreas)
function taskLoad() {
  const ref = today();
  const rows = all(`SELECT assignee_id,
      SUM(CASE WHEN status IN ('aberta','em_andamento') THEN 1 ELSE 0 END) AS open,
      SUM(CASE WHEN status IN ('aberta','em_andamento') AND due_date IS NOT NULL AND due_date < ? THEN 1 ELSE 0 END) AS late,
      SUM(CASE WHEN status = 'aguardando_conferencia' THEN 1 ELSE 0 END) AS review
    FROM tasks WHERE cancelled_at IS NULL AND assignee_id IS NOT NULL GROUP BY assignee_id`, ref);
  return new Map(rows.map(r => [r.assignee_id, r]));
}

function person(u, load, vac, ctx) {
  const l = load.get(u.id) || { open: 0, late: 0, review: 0 };
  return {
    id: u.id, name: u.name, job_title: u.job_title, department: u.department, responsibilities: u.responsibilities, role: u.role,
    is_external: u.is_external, company: u.company, login_enabled: u.login_enabled, active: u.active, manager_id: u.manager_id,
    admission_date: u.admission_date, vacation_since: u.vacation_since, phone: hasSection(ctx.user, 'equipe') ? u.phone : null,
    email: isPlaceholderEmail(u.email) ? null : u.email,
    missing_function: missingFunction(u),
    load: { open: l.open || 0, late: l.late || 0, review: l.review || 0 },
    vacation: vac.get(u.id) || null,
  };
}

// Férias no organograma: de férias hoje / próximas (30 dias)
function vacationFlags() {
  const ref = today();
  const in30 = new Date(Date.parse(ref) + 30 * 86400e3).toISOString().slice(0, 10);
  const map = new Map();
  for (const v of all(`SELECT user_id, start_date, end_date FROM vacations WHERE status = 'aprovada' AND end_date >= ? AND start_date <= ? ORDER BY start_date`, ref, in30)) {
    if (map.has(v.user_id)) continue;
    map.set(v.user_id, { now: v.start_date <= ref, start_date: v.start_date, end_date: v.end_date });
  }
  return map;
}

export function orgChart(ctx, { inactive = false } = {}) {
  requireTeam(ctx);
  const users = all(`SELECT * FROM users ${inactive ? '' : 'WHERE active = 1'} ORDER BY name`);
  const load = taskLoad();
  const vac = vacationFlags();
  const people = users.map(u => person(u, load, vac, ctx));
  const ids = new Set(people.map(p => p.id));
  for (const p of people) {
    if (p.manager_id && !ids.has(p.manager_id)) p.manager_id = null; // gestor inativo/oculto: sobe para a raiz
    p.team_size = teamIds(p.id).size;
  }
  return {
    people,
    can_move: true,
    can_edit_users: hasSection(ctx.user, 'cadastro_usuarios'),
    summary: {
      total: people.length,
      internal: people.filter(p => !p.is_external).length,
      external: people.filter(p => p.is_external).length,
      no_login: people.filter(p => !p.login_enabled).length,
      missing_function: people.filter(p => p.missing_function).length,
      no_manager: people.filter(p => !p.manager_id).length,
      on_vacation: people.filter(p => p.vacation?.now).length,
    },
  };
}

// Arrastar no organograma: muda o gestor (ou líder do terceirizado)
export function moveManager(ctx, id, body, ip) {
  requireTeam(ctx);
  const u = one('SELECT * FROM users WHERE id = ?', id);
  if (!u || !u.active) throw notFound('Pessoa não encontrada.');
  const managerId = intOrNull(body.manager_id);
  if (!isAdmin(ctx.user) && u.role === 'admin') throw forbidden('Somente administradores alteram a posição de administradores.');
  if (managerId) {
    const m = one('SELECT * FROM users WHERE id = ?', managerId);
    if (!m || !m.active) throw badRequest('Gestor inválido.');
    if (m.is_external) throw badRequest('Um terceirizado não pode ser gestor ou líder de outra pessoa.');
  } else if (u.is_external) {
    throw badRequest('Terceirizado precisa de um líder interno.');
  }
  assertNoManagerCycle(id, managerId);
  const before = u.manager_id ? one('SELECT name FROM users WHERE id = ?', u.manager_id)?.name : null;
  const after = managerId ? one('SELECT name FROM users WHERE id = ?', managerId).name : null;
  run(`UPDATE users SET manager_id = ?, updated_at = datetime('now') WHERE id = ?`, managerId, id);
  audit(ctx.user.id, 'user', id, 'Gestor alterado no organograma', { pessoa: u.name, de: before || 'sem gestor', para: after || 'sem gestor' }, ip);
  return orgChart(ctx);
}

// ---------- Cadastro da Equipe ----------
export function listTeam(ctx) {
  requireTeam(ctx);
  const users = all('SELECT * FROM users ORDER BY name');
  const byId = new Map(users.map(u => [u.id, u]));
  const load = taskLoad();
  const vac = vacationFlags();
  return {
    people: users.map(u => ({ ...person(u, load, vac, ctx), manager_name: byId.get(u.manager_id)?.name || null, vacation_summary: vacationSummary(u) })),
    departments: [...new Set(users.map(u => u.department).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'pt-BR')),
    managers: users.filter(u => u.active && !u.is_external).map(u => ({ id: u.id, name: u.name, job_title: u.job_title })),
  };
}

export function getMember(ctx, id) {
  requireTeam(ctx);
  const u = one('SELECT * FROM users WHERE id = ?', id);
  if (!u) throw notFound('Pessoa não encontrada.');
  return { ...person(u, taskLoad(), vacationFlags(), ctx), manager_name: u.manager_id ? one('SELECT name FROM users WHERE id = ?', u.manager_id)?.name : null };
}

function readMember(body, { creating, current }) {
  const d = {
    job_title: str(body.job_title, { max: 120, required: true, label: 'Função' }),
    responsibilities: str(body.responsibilities, { max: 4000, required: true, label: 'Responsabilidades' }),
    department: str(body.department, { max: 80, label: 'Setor' }),
    admission_date: date(body.admission_date, 'Data de admissão'),
    vacation_since: date(body.vacation_since, 'Férias controladas a partir de'),
    manager_id: intOrNull(body.manager_id),
  };
  if (d.responsibilities && d.responsibilities.length < 10) throw badRequest('Detalhe as responsabilidades (o que a pessoa faz na empresa).');
  if (d.admission_date && d.admission_date > today()) throw badRequest('A data de admissão não pode ser futura.');
  // Nome, telefone e situação: só de quem não tem acesso ao sistema (os demais são mantidos no Cadastro de usuários)
  if (creating || (current && !current.login_enabled)) {
    d.name = str(body.name, { max: 120, required: true, label: 'Nome' });
    d.phone = str(body.phone, { max: 40, label: 'Telefone' });
  }
  return d;
}

export function createMember(ctx, body, ip) {
  requireTeam(ctx);
  const d = readMember(body, { creating: true });
  if (d.manager_id) {
    const m = one('SELECT * FROM users WHERE id = ?', d.manager_id);
    if (!m || !m.active || m.is_external) throw badRequest('Gestor inválido.');
  }
  const id = tx(() => {
    const r = run(`INSERT INTO users (name, email, password_hash, role, access_scope, manager_id, job_title, phone, login_enabled, sections, responsibilities, department, admission_date, vacation_since)
      VALUES (?,?,?, 'colaborador', 'proprias', ?, ?, ?, 0, '[]', ?, ?, ?, ?)`, d.name, placeholderEmail(), NO_LOGIN, d.manager_id, d.job_title, d.phone, d.responsibilities, d.department, d.admission_date, d.vacation_since);
    const nid = Number(r.lastInsertRowid);
    audit(ctx.user.id, 'user', nid, 'Pessoa cadastrada na Gestão da Equipe (sem acesso ao sistema)', { nome: d.name, funcao: d.job_title }, ip);
    return nid;
  });
  return getMember(ctx, id);
}

export function updateMember(ctx, id, body, ip) {
  requireTeam(ctx);
  const u = one('SELECT * FROM users WHERE id = ?', id);
  if (!u) throw notFound('Pessoa não encontrada.');
  if (!isAdmin(ctx.user) && u.role === 'admin') throw forbidden('Somente administradores alteram o cadastro de administradores.');
  const d = readMember(body, { creating: false, current: u });
  if (u.is_external && !d.manager_id) throw badRequest('Terceirizado precisa de um líder interno.');
  if (d.manager_id) {
    const m = one('SELECT * FROM users WHERE id = ?', d.manager_id);
    if (!m || !m.active || m.is_external) throw badRequest('Gestor inválido.');
  }
  assertNoManagerCycle(id, d.manager_id);
  tx(() => {
    run(`UPDATE users SET job_title = ?, responsibilities = ?, department = ?, admission_date = ?, vacation_since = ?, manager_id = ?, updated_at = datetime('now') WHERE id = ?`,
      d.job_title, d.responsibilities, d.department, d.admission_date, d.vacation_since, d.manager_id, id);
    if (!u.login_enabled) {
      const active = body.active === undefined ? u.active : body.active ? 1 : 0;
      run('UPDATE users SET name = ?, phone = ?, active = ? WHERE id = ?', d.name, d.phone, active, id);
    }
    audit(ctx.user.id, 'user', id, 'Cadastro da equipe atualizado', { nome: d.name || u.name, funcao: d.job_title, setor: d.department, admissao: d.admission_date }, ip);
  });
  return getMember(ctx, id);
}
