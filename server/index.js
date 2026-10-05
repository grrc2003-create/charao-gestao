// Servidor HTTP — API REST + arquivos estáticos. Sem dependências externas (Node 22.5+).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { db, migrate, ROOT, one } from './db.js';
import { Router, HttpError, send, readJson, badRequest, forbidden, intOrNull, str } from './lib/http.js';
import {
  authenticate, createSession, destroySession, sessionCookie, verifyPassword, clientIp,
  checkLoginRate, registerLoginFailure, clearLoginFailures, hashPassword, validatePasswordStrength,
} from './lib/auth.js';
import { seedDemo } from './demo-data.js';
import { accessContext, canSeeUser, isAdmin, requireAdmin } from './lib/permissions.js';
import * as Tasks from './services/tasks.js';
import * as Projects from './services/projects.js';
import * as Users from './services/users.js';
import * as Reports from './services/reports.js';
import { readStored } from './services/files.js';
import { audit, listAudit } from './services/audit.js';
import { summarize, userStats, today, daysBetween } from './services/metrics.js';
import { all } from './db.js';

migrate();
bootstrap();

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = path.join(ROOT, 'public');
// Modo demonstração: ligado no ambiente local; em produção só com DEMO=1
const DEMO = process.env.DEMO === '1' || (process.env.NODE_ENV !== 'production' && process.env.DEMO !== '0');

// Primeiro início com banco vazio: cria o administrador inicial (ADMIN_EMAIL/ADMIN_PASSWORD)
// ou, se SEED_DEMO=1, carrega os dados de demonstração.
function bootstrap() {
  if (one('SELECT COUNT(*) AS n FROM users').n > 0) return;
  if (process.env.SEED_DEMO === '1') {
    const n = seedDemo();
    console.log(`[init] dados de demonstração carregados (${n.tasks} tarefas)`);
    return;
  }
  const email = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD || '';
  if (!email || !password) {
    console.warn('[init] banco vazio: defina ADMIN_EMAIL e ADMIN_PASSWORD para criar o primeiro administrador.');
    return;
  }
  validatePasswordStrength(password);
  db.prepare(`INSERT INTO users (name, email, password_hash, role, access_scope, job_title)
    VALUES (?, ?, ?, 'admin', 'total', 'Administrador do sistema')`).run(process.env.ADMIN_NAME || 'Administrador', email, hashPassword(password));
  audit(null, 'system', null, 'Administrador inicial criado', { email });
  console.log(`[init] administrador inicial criado: ${email}`);
}
const api = new Router();

// ---------- Autenticação ----------
api.post('/api/auth/login', async (req, res, { body }) => {
  const email = str(body.email, { max: 160, required: true, label: 'E-mail' }).toLowerCase();
  const password = String(body.password || '');
  const key = `${clientIp(req)}|${email}`;
  checkLoginRate(key);
  const u = one('SELECT * FROM users WHERE email = ?', email);
  if (!u || !u.active || !verifyPassword(password, u.password_hash)) {
    registerLoginFailure(key);
    audit(u?.id || null, 'auth', u?.id || null, 'Falha de login', { email }, clientIp(req));
    throw new HttpError(401, 'E-mail ou senha inválidos.');
  }
  clearLoginFailures(key);
  const token = createSession(u.id, req);
  db.prepare(`UPDATE users SET last_login_at = ? WHERE id = ?`).run(new Date().toISOString(), u.id);
  audit(u.id, 'auth', u.id, 'Login', null, clientIp(req));
  send(res, 200, { user: Users.me(u) }, { 'Set-Cookie': sessionCookie(token, req) });
}, { public: true });

api.post('/api/auth/logout', (req, res) => {
  destroySession(req);
  send(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie('', req, 0) });
}, { public: true });

api.get('/api/auth/me', (req, res, { user }) => send(res, 200, { user: Users.me(user), demo: DEMO }));
api.get('/api/health', (req, res) => send(res, 200, { ok: true }), { public: true });
api.get('/api/config', (req, res) => send(res, 200, { demo: DEMO }), { public: true });

api.post('/api/auth/password', (req, res, { user, body }) => {
  Users.changeOwnPassword(user, body, clientIp(req));
  send(res, 200, { ok: true });
});

// ---------- Dashboard e metadados ----------
api.get('/api/dashboard', (req, res, { ctx }) => {
  const tasks = Tasks.listVisible(ctx);
  const projects = Projects.listProjects(ctx, tasks);
  const users = Users.listUsers(ctx, tasks).filter(u => u.active && u.stats.assigned > 0);
  const ref = today();
  const upcoming = tasks.filter(t => !t.delivered && t.due_date && t.due_date >= ref && daysBetween(ref, t.due_date) <= 7).slice(0, 8);
  const late = tasks.filter(t => t.eff_status === 'atrasada').sort((a, b) => b.days_late - a.days_late).slice(0, 8);
  const visibleIds = new Set(tasks.map(t => t.id));
  const activity = all(`SELECT h.task_id, h.action, h.details, h.created_at, u.name AS user_name, t.code, t.title
    FROM task_history h JOIN tasks t ON t.id = h.task_id LEFT JOIN users u ON u.id = h.user_id ORDER BY h.id DESC LIMIT 200`)
    .filter(h => visibleIds.has(h.task_id)).slice(0, 10);
  const map = new Map(all('SELECT id, name, role, manager_id FROM users').map(u => [u.id, u]));
  const team = [...ctx.team];
  send(res, 200, {
    summary: summarize(tasks),
    projects: projects.filter(p => p.status !== 'cancelado'),
    users,
    upcoming,
    late,
    activity,
    me: userStats(ctx.user, tasks, map),
    team_summary: team.length ? summarize(tasks.filter(t => ctx.team.has(t.assignee_id))) : null,
    team_size: team.length,
  });
});

api.get('/api/meta', (req, res, { ctx }) => {
  const projects = all('SELECT id, code, name, status FROM projects ORDER BY code')
    .filter(p => ctx.projects === null || ctx.projects.has(p.id));
  const users = all(`SELECT id, name, role, job_title, active, manager_id FROM users ORDER BY name`).filter(u => canSeeUser(ctx, u.id));
  // Para filtros de tarefas também listamos responsáveis visíveis nas tarefas (sem dados pessoais)
  const assignees = new Map();
  for (const t of Tasks.listVisible(ctx)) if (t.assignee_id) assignees.set(t.assignee_id, { id: t.assignee_id, name: t.assignee_name });
  send(res, 200, {
    projects, users,
    assignees: [...assignees.values()].sort((a, b) => a.name.localeCompare(b.name, 'pt-BR')),
    managers: users.filter(u => all('SELECT 1 FROM users WHERE manager_id = ? LIMIT 1', u.id).length),
    can: {
      manage_users: isAdmin(ctx.user),
      manage_projects: isAdmin(ctx.user) || ctx.user.role === 'gestor',
      view_audit: isAdmin(ctx.user),
    },
  });
});

// ---------- Projetos ----------
api.get('/api/projects', (req, res, { ctx }) => send(res, 200, Projects.listProjects(ctx)));
api.post('/api/projects', (req, res, { ctx, body }) => send(res, 201, { id: Projects.createProject(ctx, body, clientIp(req)) }));
api.get('/api/projects/:id', (req, res, { ctx, params }) => send(res, 200, Projects.getProject(ctx, intOrNull(params.id))));
api.put('/api/projects/:id', (req, res, { ctx, params, body }) => {
  Projects.updateProject(ctx, intOrNull(params.id), body, clientIp(req));
  send(res, 200, { ok: true });
});
api.get('/api/projects/:id/assignees', (req, res, { ctx, params }) => send(res, 200, Projects.projectAssignees(ctx, intOrNull(params.id))));

// ---------- Tarefas ----------
api.get('/api/tasks', (req, res, { ctx, query }) => {
  let tasks = Tasks.listVisible(ctx);
  const q = (query.get('q') || '').trim().toLowerCase();
  const status = query.getAll('status').filter(Boolean);
  const project = intOrNull(query.get('project'));
  const assignee = query.get('assignee');
  const priority = query.getAll('priority').filter(Boolean);
  const due = query.get('due');
  const ref = today();
  if (q) tasks = tasks.filter(t => [t.code, t.title, t.description, t.project_name, t.assignee_name].some(v => v && v.toLowerCase().includes(q)));
  if (status.length) tasks = tasks.filter(t => status.includes(t.eff_status));
  if (project) tasks = tasks.filter(t => t.project_id === project);
  if (assignee === 'none') tasks = tasks.filter(t => !t.assignee_id);
  else if (assignee === 'me') tasks = tasks.filter(t => t.assignee_id === ctx.user.id);
  else if (assignee) tasks = tasks.filter(t => t.assignee_id === intOrNull(assignee));
  if (priority.length) tasks = tasks.filter(t => priority.includes(t.priority));
  if (due) {
    const open = t => t.status !== 'concluida';
    const within = n => t => open(t) && t.due_date && t.due_date >= ref && daysBetween(ref, t.due_date) <= n;
    const f = {
      vencidas: t => t.eff_status === 'atrasada',
      hoje: t => open(t) && t.due_date === ref,
      '7d': within(7),
      '30d': within(30),
      sem_prazo: t => !t.due_date,
    }[due];
    if (f) tasks = tasks.filter(f);
  }
  send(res, 200, tasks);
});
api.post('/api/tasks', (req, res, { ctx, body }) => send(res, 201, { id: Tasks.createTask(ctx, body) }));
api.get('/api/tasks/:id', (req, res, { ctx, params }) => send(res, 200, Tasks.getTask(ctx, intOrNull(params.id))));
api.patch('/api/tasks/:id', (req, res, { ctx, params, body }) => {
  Tasks.updateTask(ctx, intOrNull(params.id), body);
  send(res, 200, Tasks.getTask(ctx, intOrNull(params.id)));
});
api.patch('/api/tasks/:id/execution', (req, res, { ctx, params, body }) => {
  Tasks.updateExecution(ctx, intOrNull(params.id), body);
  send(res, 200, Tasks.getTask(ctx, intOrNull(params.id)));
});
api.post('/api/tasks/:id/files', (req, res, { ctx, params, body }) => {
  Tasks.addFiles(ctx, intOrNull(params.id), body);
  send(res, 200, Tasks.getTask(ctx, intOrNull(params.id)));
});
api.delete('/api/tasks/:id/files/:fid', (req, res, { ctx, params }) => {
  Tasks.removeFile(ctx, intOrNull(params.id), intOrNull(params.fid));
  send(res, 200, Tasks.getTask(ctx, intOrNull(params.id)));
});
api.post('/api/tasks/:id/actions/:action', (req, res, { ctx, params, body }) => {
  Tasks.transition(ctx, intOrNull(params.id), params.action, body);
  send(res, 200, Tasks.getTask(ctx, intOrNull(params.id)));
});

api.get('/api/files/:id', (req, res, { ctx, params }) => {
  const f = Tasks.fileForUser(ctx, intOrNull(params.id));
  const buf = readStored(f.stored_name);
  if (!buf) throw new HttpError(404, 'Arquivo indisponível.');
  send(res, 200, buf, {
    'Content-Type': f.mime,
    'Cache-Control': 'private, max-age=86400',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
    'X-Content-Type-Options': 'nosniff',
  });
});

// ---------- Usuários ----------
api.get('/api/users', (req, res, { ctx }) => send(res, 200, Users.listUsers(ctx)));
api.post('/api/users', (req, res, { ctx, body }) => send(res, 201, { id: Users.createUser(ctx, body, clientIp(req)) }));
// Diretório mínimo (nome/cargo) para seleção de responsáveis/equipe — sem dados pessoais
api.get('/api/users/directory', (req, res, { ctx }) => {
  if (!isAdmin(ctx.user) && ctx.user.role !== 'gestor') throw forbidden();
  send(res, 200, all(`SELECT id, name, job_title, role, active FROM users WHERE active = 1 ORDER BY name`));
});
api.get('/api/users/:id', (req, res, { ctx, params }) => send(res, 200, Users.getUser(ctx, intOrNull(params.id))));
api.put('/api/users/:id', (req, res, { ctx, params, body }) => {
  Users.updateUser(ctx, intOrNull(params.id), body, clientIp(req));
  send(res, 200, { ok: true });
});
api.post('/api/users/:id/password', (req, res, { ctx, params, body }) => {
  Users.resetPassword(ctx, intOrNull(params.id), body, clientIp(req));
  send(res, 200, { ok: true });
});
api.get('/api/audit', (req, res, { user }) => {
  requireAdmin(user);
  send(res, 200, listAudit());
});

// ---------- Relatórios ----------
api.get('/api/reports', (req, res, { ctx, query }) => send(res, 200, Reports.buildReport(ctx, Object.fromEntries(query))));
api.get('/api/field-list', (req, res, { ctx, query }) => send(res, 200, Reports.fieldList(ctx, Object.fromEntries(query))));

// ---------- Infra ----------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.ico': 'image/x-icon', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
};
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(self), geolocation=()',
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};

function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || !path.extname(rel)) rel = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    return send(res, 404, 'Não encontrado', SECURITY_HEADERS);
  }
  res.writeHead(200, {
    ...SECURITY_HEADERS,
    'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
    'Cache-Control': rel === '/index.html' ? 'no-cache' : 'no-cache',
  });
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (!url.pathname.startsWith('/api/')) return serveStatic(req, res, url.pathname);
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
    const m = api.match(req.method, url.pathname);
    if (!m) throw new HttpError(404, 'Rota inexistente.');
    const [handler, opts = {}] = m.handlers;
    // Proteção CSRF: mutações exigem cabeçalho customizado (não enviável por formulários de outros sites) + cookie SameSite=Strict
    if (req.method !== 'GET' && req.headers['x-requested-with'] !== 'charao-app') throw forbidden('Requisição não autorizada.');
    const body = await readJson(req);
    let user = null, ctx = null;
    if (!opts.public) {
      user = authenticate(req);
      if (!user) throw new HttpError(401, 'Sessão expirada. Faça login novamente.');
      ctx = accessContext(user);
    }
    await handler(req, res, { user, ctx, body, params: m.params, query: url.searchParams });
  } catch (e) {
    if (e instanceof HttpError) return send(res, e.status, { error: e.message, details: e.details });
    if (String(e.message).includes('UNIQUE')) return send(res, 409, { error: 'Registro duplicado.' });
    console.error(e);
    send(res, 500, { error: 'Erro interno. Tente novamente.' });
  }
});

server.listen(PORT, () => console.log(`Charão Gestão rodando em http://localhost:${PORT}${DEMO ? ' (modo demonstração)' : ''}`));
