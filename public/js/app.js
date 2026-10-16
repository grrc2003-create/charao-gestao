// Aplicação: sessão, layout (shell) e roteamento por hash.
import { api, html, icon, avatar, ROLE, brandMark } from './core.js';
import { toast } from './ui.js';
import './required.js';
import { trackRoute, updateCurrent, setCurrentTitle, clearNav } from './navhist.js';
import * as Login from './views/login.js';
import * as Dashboard from './views/dashboard.js';
import * as Projects from './views/projects.js';
import * as Project from './views/project.js';
import * as Tasks from './views/tasks.js';
import * as Task from './views/task.js';
import * as TaskForm from './views/task-form.js';
import * as Users from './views/users.js';
import * as User from './views/user.js';
import * as Reports from './views/reports.js';
import * as ReportDoc from './views/report-doc.js';
import * as FieldList from './views/field-list.js';
import * as ReportChecklist from './views/report-checklist.js';
import * as Account from './views/account.js';
import * as Audit from './views/audit.js';
import * as Settings from './views/settings.js';
import * as Recurrences from './views/recurrences.js';
import * as Contracts from './views/contracts.js';
import * as Finance from './views/finance.js';
import * as ReportMeasurement from './views/report-measurement.js';

const state = { user: null, meta: null, demo: false, version: null };

// Detecta nova versão publicada e recarrega a página (evita usar código antigo após atualização)
let lastVersionCheck = 0;
async function ensureLatestVersion() {
  if (Date.now() - lastVersionCheck < 30000) return false;
  lastVersionCheck = Date.now();
  try {
    const { version } = await fetch('/api/config', { cache: 'no-store' }).then(r => r.json());
    if (state.version && version && version !== state.version) {
      location.reload();
      return true;
    }
    state.version = state.version || version;
  } catch { /* sem conexão: segue com a versão atual */ }
  return false;
}

const routes = [
  ['/', Dashboard.view],
  ['/projetos', Projects.list],
  ['/projetos/novo', Projects.form],
  ['/projetos/:id', Project.view],
  ['/projetos/:id/editar', Projects.form],
  ['/tarefas', Tasks.view],
  ['/tarefas/nova', TaskForm.view],
  ['/tarefas/:id', Task.view],
  ['/tarefas/:id/editar', TaskForm.view],
  ['/usuarios', Users.list],
  ['/usuarios/novo', Users.form],
  ['/usuarios/:id', User.view],
  ['/usuarios/:id/editar', Users.form],
  ['/relatorios', Reports.view],
  ['/imprimir/relatorio', ReportDoc.view, { print: true }],
  ['/imprimir/campo', FieldList.view, { print: true }],
  ['/imprimir/checklist/:id', ReportChecklist.view, { print: true }],
  ['/imprimir/medicao/:id', ReportMeasurement.view, { print: true }],
  ['/contratos', Contracts.list],
  ['/contratos/novo', Contracts.form],
  ['/contratos/:id', Contracts.view],
  ['/contratos/:id/editar', Contracts.form],
  ['/medicoes/:id', Contracts.measurement],
  ['/financeiro', Finance.view],
  ['/financeiro/analise', Finance.analysis],
  ['/financeiro/obrigacoes', Finance.obligations],
  ['/financeiro/obrigacoes/nova', Finance.form],
  ['/financeiro/obrigacoes/:id/editar', Finance.form],
  ['/conta', Account.view],
  ['/auditoria', Audit.view],
  ['/configuracoes', Settings.view],
  ['/recorrencias', Recurrences.list],
  ['/recorrencias/:id', Recurrences.view],
  ['/recorrencias/:id/editar', Recurrences.edit],
].map(([pattern, view, opts = {}]) => {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  return { re, keys, view, opts };
});

const ALL_NAV = [
  ['/', 'Dashboard', 'dashboard', 'dashboard'],
  ['/projetos', 'Projetos', 'projects', 'projetos'],
  ['/tarefas', 'Tarefas', 'tasks', 'tarefas'],
  ['/usuarios', 'Usuários', 'users', 'usuarios'],
  ['/relatorios', 'Relatórios', 'reports', 'relatorios'],
];
// Menu: só as seções liberadas para o usuário
const sec = k => !state.meta?.can.sections || state.meta.can.sections.includes(k);
const navItems = () => {
  const list = ALL_NAV.filter(n => sec(n[3]));
  // Sem Dashboard: o início passa a ser a própria tela do usuário (planejamento da semana)
  if (!sec('dashboard') && state.user) list.unshift([`/usuarios/${state.user.id}`, 'Minha semana', 'calendar', null]);
  return list;
};
// Seção de cada tela (null = sempre liberada)
function sectionOfPath(path) {
  if (path === '/') return 'dashboard';
  if (path.startsWith('/projetos')) return 'projetos';
  if (path === '/tarefas' || path === '/tarefas/nova' || path.startsWith('/recorrencias')) return 'tarefas';
  if (/^\/usuarios\/\d+$/.test(path)) return Number(path.split('/')[2]) === state.user?.id ? null : 'usuarios';
  if (path.startsWith('/usuarios')) return 'usuarios';
  if (path.startsWith('/relatorios') || path.startsWith('/imprimir/relatorio') || path.startsWith('/imprimir/campo')) return 'relatorios';
  if (path.startsWith('/contratos') || path.startsWith('/medicoes') || path.startsWith('/imprimir/medicao')) return 'contratos';
  if (path.startsWith('/financeiro')) return 'financeiro';
  if (path === '/auditoria') return 'auditoria';
  if (path === '/configuracoes') return 'configuracoes';
  return null;
}
const SECTION_NAME = { dashboard: 'Dashboard', projetos: 'Projetos', tarefas: 'Tarefas', usuarios: 'Usuários', relatorios: 'Relatórios', contratos: 'Contratos', financeiro: 'Tarefas financeiras', auditoria: 'Auditoria', configuracoes: 'Configurações' };

export function navigate(path, { replace = false } = {}) {
  const h = '#' + path;
  if (replace) history.replaceState(null, '', h); else location.hash = h;
  if (replace || location.hash === h) render();
}

export function parseHash() {
  const raw = location.hash.slice(1) || '/';
  const [path, qs = ''] = raw.split('?');
  return { path: path || '/', query: new URLSearchParams(qs) };
}

export const setQuery = obj => {
  const { path } = parseHash();
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(obj)) {
    if (Array.isArray(v)) v.forEach(x => qs.append(k, x));
    else if (v) qs.set(k, v);
  }
  const s = qs.toString();
  history.replaceState(null, '', '#' + path + (s ? '?' + s : ''));
  updateCurrent('#' + path + (s ? '?' + s : ''));
};

export async function reloadMeta() {
  state.meta = await api('/meta');
  return state.meta;
}

function shell() {
  const u = state.user;
  const app = document.getElementById('app');
  app.innerHTML = html`
    <aside class="sidebar" aria-label="Navegação principal">
      <a href="#/" class="sidebar-brand" aria-label="Charão — início"><img src="/assets/logo.webp" alt="Charão Engenharia & Construção"></a>
      <div class="sidebar-tag">Gestão de Obras</div>
      <nav>${navItems().map(([href, label, ic]) => html`<a href="#${href}" data-nav="${href}">${icon(ic)}<span>${label}</span></a>`)}
        ${state.meta?.can.contracts || state.meta?.can.finance ? html`<div class="sidebar-tag sidebar-group">Gestão da Empresa</div>` : ''}
        ${state.meta?.can.contracts ? html`<a href="#/contratos" data-nav="/contratos">${icon('contract')}<span>Contratos</span></a>` : ''}
        ${state.meta?.can.finance ? html`<a href="#/financeiro" data-nav="/financeiro">${icon('wallet')}<span>Tarefas financeiras</span></a>` : ''}
        ${state.meta?.can.view_audit || state.meta?.can.manage_settings ? html`<hr class="sidebar-sep">` : ''}
        ${state.meta?.can.view_audit ? html`<a href="#/auditoria" data-nav="/auditoria">${icon('shield')}<span>Auditoria</span></a>` : ''}
        ${state.meta?.can.manage_settings ? html`<a href="#/configuracoes" data-nav="/configuracoes">${icon('settings')}<span>Configurações</span></a>` : ''}
      </nav>
      <a href="#/conta" class="sidebar-user">${avatar(u.name)}<span><b>${u.name}</b><small>${ROLE[u.role]}</small></span></a>
      ${state.demo ? html`<div class="demo-flag" title="Os dados exibidos são fictícios para testes">Ambiente de demonstração</div>` : ''}
    </aside>
    <header class="topbar">
      <a href="#/" class="topbar-brand" aria-label="Início">${brandMark(30)}<span><b>CHARÃO</b><small>Gestão de Obras</small></span></a>
      <a href="#/conta" class="topbar-user" aria-label="Minha conta">${avatar(u.name, 'sm')}</a>
    </header>
    <main id="view" tabindex="-1"></main>
    <nav class="bottombar" aria-label="Navegação">
      ${navItems().map(([href, label, ic]) => html`<a href="#${href}" data-nav="${href}">${icon(ic)}<span>${label}</span></a>`)}
    </nav>`.toString();
}

function markNav(path) {
  document.querySelectorAll('[data-nav]').forEach(a => {
    const n = a.dataset.nav;
    const active = n === '/' ? path === '/' : path === n || path.startsWith(n + '/');
    a.classList.toggle('active', active);
    if (active) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
}

let renderToken = 0;
export async function render() {
  if (await ensureLatestVersion()) return;
  const token = ++renderToken;
  if (!state.user) {
    document.body.className = 'login-mode';
    const app = document.getElementById('app');
    app.innerHTML = Login.render(state).toString();
    Login.mount(app, { onLogin: async user => { state.user = user; await boot(); } });
    return;
  }
  const { path, query } = parseHash();
  const route = routes.find(r => r.re.test(path));
  if (!route) return navigate('/', { replace: true });
  // Seção não liberada: o início vai para a primeira tela permitida; as demais mostram o aviso
  const needs = sectionOfPath(path);
  if (needs && !sec(needs)) {
    if (path === '/') return navigate(navItems()[0]?.[0] || `/usuarios/${state.user.id}`, { replace: true });
    if (!document.querySelector('.sidebar')) shell();
    markNav(path);
    document.getElementById('view').innerHTML = html`<div class="empty-state"><h2>Seção não liberada</h2><p>A seção <b>${SECTION_NAME[needs]}</b> não está liberada para o seu usuário. Fale com o administrador.</p><a class="btn btn-ghost" href="#${navItems()[0]?.[0] || '/'}">Ir para o início</a></div>`.toString();
    return;
  }
  const params = {};
  const m = route.re.exec(path);
  route.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));

  // Caminho entre as telas (para o "Voltar" levar à tela anterior)
  trackRoute(location.hash || '#/');
  const printMode = !!route.opts.print;
  document.body.className = printMode ? 'print-mode' : 'app-mode';
  if (printMode) {
    document.getElementById('app').innerHTML = '<main id="view"></main>';
  } else if (!document.querySelector('.sidebar')) {
    shell();
  }
  markNav(path);
  const root = document.getElementById('view');
  root.innerHTML = '<div class="loading" aria-busy="true"><span></span>Carregando…</div>';
  const ctx = { params, query, state, navigate, render, setQuery, reloadMeta, path };
  try {
    const v = await route.view(ctx);
    if (token !== renderToken) return;
    root.innerHTML = v.html.toString();
    if (v.title) { document.title = `${v.title} · Charão`; setCurrentTitle(v.title); }
    if (!printMode) window.scrollTo(0, 0);
    v.mount?.(root, ctx);
  } catch (e) {
    if (token !== renderToken) return;
    root.innerHTML = html`<div class="empty-state"><h2>Não foi possível abrir</h2><p>${e.message}</p><a class="btn btn-ghost" href="#/">Voltar ao início</a></div>`.toString();
  }
}

async function boot() {
  try {
    const [me, meta] = await Promise.all([api('/auth/me'), api('/meta')]);
    state.user = me.user;
    state.demo = me.demo;
    state.meta = meta;
  } catch {
    state.user = null;
    const cfg = await api('/config').catch(() => ({ demo: false }));
    state.demo = cfg.demo;
  }
  document.getElementById('app').innerHTML = '';
  render();
  if (state.user?.must_change_password && parseHash().path !== '/conta') {
    toast('Defina uma nova senha pessoal para continuar com segurança.', 'warn');
    navigate('/conta');
  }
}

export async function logout() {
  await api('/auth/logout', { method: 'POST' }).catch(() => {});
  state.user = null;
  state.meta = null;
  clearNav();
  location.hash = '#/';
  render();
}

window.addEventListener('hashchange', render);
window.addEventListener('auth:expired', () => {
  if (!state.user) return;
  state.user = null;
  toast('Sua sessão expirou. Entre novamente.', 'warn');
  render();
});
boot();
