// Aplicação: sessão, layout (shell) e roteamento por hash.
import { api, html, icon, avatar, setAvatars, ROLE, brandMark } from './core.js';
import { toast } from './ui.js';
import './required.js';
import { trackRoute, updateCurrent, setCurrentTitle, clearNav } from './navhist.js';
import * as Login from './views/login.js';
import * as Dashboard from './views/dashboard.js';
import * as MyPanel from './views/my-panel.js';
import * as Records from './views/records.js';
import * as Team from './views/team.js';
import * as TeamVacations from './views/team-vacations.js';
import * as ReportAta from './views/report-ata.js';
import * as ReportHistory from './views/report-history.js';
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
import * as Receipts from './views/receipts.js';
import * as Finance from './views/finance.js';
import * as ReportMeasurement from './views/report-measurement.js';
import * as Processes from './views/processes.js';
import * as ProcessesPrint from './views/processes-print.js';
import * as ProcessMap from './views/process-map.js';
import * as Payroll from './views/payroll.js';
import * as PayrollPrint from './views/payroll-print.js';
import * as Reimb from './views/reimb-ui.js';

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
  ['/', () => ({ html: '' })],
  ['/painel', MyPanel.view],
  ['/painel/desempenho', User.myPerformance],
  ['/painel/reembolsos', Reimb.history],
  ['/empresa', Dashboard.view],
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
  ['/imprimir/ata/:id', ReportAta.view, { print: true }],
  ['/imprimir/organograma', TeamVacations.printOrg, { print: true }],
  ['/processos', Processes.list],
  ['/processos/novo', Processes.form],
  ['/processos/mapa', ProcessMap.view],
  ['/processos/:id', Processes.view],
  ['/processos/:id/editar', Processes.form],
  ['/imprimir/processos', ProcessesPrint.manual, { print: true }],
  ['/imprimir/processo/:id', ProcessesPrint.one, { print: true }],
  ['/equipe/organograma', Team.org],
  ['/equipe/ferias', TeamVacations.view],
  ['/equipe/cadastro', Team.list],
  ['/equipe/cadastro/novo', Team.form],
  ['/equipe/cadastro/:id', Team.form],
  ['/imprimir/historia/:id', ReportHistory.view, { print: true }],
  ['/projetos/:id/registros', Records.list],
  ['/projetos/:id/registros/novo', Records.form],
  ['/projetos/:id/registros/:rid', Records.detail],
  ['/projetos/:id/registros/:rid/editar', Records.form],
  ['/contratos', Contracts.list],
  ['/contratos/novo', Contracts.form],
  ['/contratos/importar', Receipts.importPage],
  ['/contratos/outras-entradas', Receipts.others],
  ['/contratos/:id', Contracts.view],
  ['/contratos/:id/editar', Contracts.form],
  ['/medicoes/:id', Contracts.measurement],
  ['/folha', Payroll.list],
  ['/folha/pessoas', Payroll.people],
  ['/folha/pessoas/nova', Payroll.personForm],
  ['/folha/pessoas/:id', Payroll.personForm],
  ['/folha/:id', Payroll.month],
  ['/imprimir/folha/:id', PayrollPrint.view, { print: true }],
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
  ['/painel', 'Meu painel', 'user', null],
  ['/empresa', 'Visão da empresa', 'dashboard', 'dashboard'],
  ['/projetos', 'Projetos', 'projects', 'projetos'],
  ['/tarefas', 'Tarefas', 'tasks', 'tarefas'],
  ['/relatorios', 'Relatórios', 'reports', 'relatorios'],
];
const USERS_NAV = ['/usuarios', 'Usuários', 'users', 'usuarios|cadastro_usuarios'];
// Com a Gestão da Equipe liberada, as pessoas são acessadas pelo Cadastro da Equipe (Usuários sai do menu)
const showUsersNav = () => false;
const rosterOk = () => sec('equipe') || sec('cadastro_usuarios');
// Menu: só as seções liberadas para o usuário
const sec = k => !k || !state.meta?.can.sections || k.split('|').some(x => state.meta.can.sections.includes(x));
const navItems = () => ALL_NAV.filter(n => sec(n[3]));
// Tela de entrada: Meu painel ou Visão da empresa (definido no cadastro do usuário)
const homePath = () => (state.meta?.can.home === 'empresa' && sec('dashboard') ? '/empresa' : '/painel');
// Seção de cada tela (null = sempre liberada)
function sectionOfPath(path) {
  if (path === '/' || path === '/painel') return null;
  if (path === '/empresa') return 'dashboard';
  if (path.startsWith('/projetos') || path.startsWith('/imprimir/ata') || path.startsWith('/imprimir/historia')) return 'projetos';
  if (path === '/tarefas' || path === '/tarefas/nova' || path.startsWith('/recorrencias')) return 'tarefas';
  if (/^\/usuarios\/\d+$/.test(path)) return Number(path.split('/')[2]) === state.user?.id ? null : 'usuarios|cadastro_usuarios';
  if (path === '/usuarios/novo' || /^\/usuarios\/\d+\/editar$/.test(path)) return 'cadastro_usuarios';
  if (path.startsWith('/usuarios')) return 'usuarios|cadastro_usuarios';
  if (path.startsWith('/relatorios') || path.startsWith('/imprimir/relatorio') || path.startsWith('/imprimir/campo')) return 'relatorios';
  if (path.startsWith('/contratos') || path.startsWith('/medicoes') || path.startsWith('/imprimir/medicao')) return 'contratos';
  if (path.startsWith('/financeiro')) return 'financeiro';
  if (path.startsWith('/folha') || path.startsWith('/imprimir/folha')) return 'folha';
  if (path.startsWith('/equipe/cadastro')) return 'equipe|cadastro_usuarios';
  if (path.startsWith('/equipe') || path.startsWith('/imprimir/organograma')) return 'equipe';
  if (path === '/processos/novo' || /^\/processos\/\d+\/editar$/.test(path)) return 'processos';
  if (path === '/auditoria') return 'auditoria';
  if (path === '/configuracoes') return 'configuracoes';
  return null;
}
const SECTION_NAME = { 'equipe|cadastro_usuarios': 'Cadastro da Equipe', equipe: 'Organograma e Férias', 'usuarios|cadastro_usuarios': 'Desempenho das pessoas', cadastro_usuarios: 'Cadastro da Equipe', dashboard: 'Visão da empresa', projetos: 'Projetos', tarefas: 'Tarefas', usuarios: 'Desempenho das pessoas', relatorios: 'Relatórios', contratos: 'Contratos', financeiro: 'Tarefas financeiras', folha: 'Folha (Administrativa)', processos: 'Processos da Empresa (edição)', auditoria: 'Auditoria', configuracoes: 'Configurações' };

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
  setAvatars(state.meta.avatars);
  return state.meta;
}

// Celular: barra inferior com até 5 botões de rótulo curto; o restante fica em "Mais"
const SHORT = { 'Meu painel': 'Painel', 'Visão da empresa': 'Empresa', 'Tarefas financeiras': 'Financeiro', 'Folha (Administrativa)': 'Folha', 'Processos da Empresa': 'Processos', 'Configurações': 'Ajustes' };
function mobileNav() {
  const c = state.meta?.can || {};
  const all = [...navItems(),
    ...(showUsersNav() ? [USERS_NAV] : []),
    ...(c.contracts ? [['/contratos', 'Contratos', 'contract']] : []),
    ...(c.finance ? [['/financeiro', 'Tarefas financeiras', 'wallet']] : []),
    ...(sec('folha') ? [['/folha', 'Folha (Administrativa)', 'users']] : []),
    ['/processos', 'Processos da Empresa', 'checklist'],
    ...(sec('equipe') ? [['/equipe/organograma', 'Organograma', 'team'], ['/equipe/ferias', 'Férias', 'calendar']] : []),
    ...(rosterOk() ? [['/equipe/cadastro', 'Cadastro da Equipe', 'user']] : []),
    ...(c.view_audit ? [['/auditoria', 'Auditoria', 'shield']] : []),
    ...(c.manage_settings ? [['/configuracoes', 'Configurações', 'settings']] : [])];
  return all.length <= 5 ? { bar: all, more: [] } : { bar: all.slice(0, 4), more: all.slice(4) };
}
function openMoreMenu(items) {
  const wrap = document.createElement('div');
  wrap.className = 'sheet-backdrop';
  wrap.innerHTML = html`<div class="sheet more-sheet" role="dialog" aria-modal="true" aria-label="Mais opções">
    <div class="sheet-grip" aria-hidden="true"></div>
    <header class="sheet-head"><h2>Mais</h2><button type="button" class="icon-btn" data-close aria-label="Fechar">✕</button></header>
    <nav class="more-list">${items.map(([href, label, ic]) => html`<a href="#${href}">${icon(ic)}<span>${label}</span>${icon('chevron')}</a>`)}</nav></div>`.toString();
  document.body.appendChild(wrap);
  document.body.classList.add('no-scroll');
  const close = () => { wrap.classList.add('closing'); document.body.classList.remove('no-scroll'); setTimeout(() => wrap.remove(), 180); };
  wrap.addEventListener('click', e => { if (e.target === wrap || e.target.closest('[data-close]') || e.target.closest('a')) close(); });
}

function shell() {
  const u = state.user;
  const app = document.getElementById('app');
  const mob = mobileNav();
  app.innerHTML = html`
    <aside class="sidebar" aria-label="Navegação principal">
      <a href="#/" class="sidebar-brand" aria-label="Charão — início"><img src="/assets/logo.webp" alt="Charão Engenharia & Construção"></a>
      <div class="sidebar-tag">Gestão de Obras</div>
      <nav>${navItems().map(([href, label, ic]) => html`<a href="#${href}" data-nav="${href}">${icon(ic)}<span>${label}</span></a>`)}
        <div class="sidebar-tag sidebar-group">Gestão da Empresa</div>
        ${state.meta?.can.contracts ? html`<a href="#/contratos" data-nav="/contratos">${icon('contract')}<span>Contratos</span></a>` : ''}
        ${state.meta?.can.finance ? html`<a href="#/financeiro" data-nav="/financeiro">${icon('wallet')}<span>Tarefas financeiras</span></a>` : ''}
        ${sec('folha') ? html`<a href="#/folha" data-nav="/folha">${icon('users')}<span>Folha (Administrativa)</span></a>` : ''}
        <a href="#/processos" data-nav="/processos">${icon('checklist')}<span>Processos da Empresa</span></a>
        ${rosterOk() ? html`<div class="sidebar-tag sidebar-group">Gestão da Equipe</div>
          ${sec('equipe') ? html`<a href="#/equipe/organograma" data-nav="/equipe/organograma">${icon('team')}<span>Organograma</span></a>
          <a href="#/equipe/ferias" data-nav="/equipe/ferias">${icon('calendar')}<span>Férias</span></a>` : ''}
          <a href="#/equipe/cadastro" data-nav="/equipe/cadastro">${icon('user')}<span>Cadastro da Equipe</span></a>` : ''}
        ${showUsersNav() || state.meta?.can.view_audit || state.meta?.can.manage_settings ? html`<hr class="sidebar-sep">` : ''}
        ${showUsersNav() ? html`<a href="#/usuarios" data-nav="/usuarios">${icon('users')}<span>Usuários</span></a>` : ''}
        ${state.meta?.can.view_audit ? html`<a href="#/auditoria" data-nav="/auditoria">${icon('shield')}<span>Auditoria</span></a>` : ''}
        ${state.meta?.can.manage_settings ? html`<a href="#/configuracoes" data-nav="/configuracoes">${icon('settings')}<span>Configurações</span></a>` : ''}
      </nav>
      <a href="#/conta" class="sidebar-user">${avatar(u.name, '', u.id)}<span><b>${u.name}</b><small>${ROLE[u.role]}</small></span></a>
      ${state.demo ? html`<div class="demo-flag" title="Os dados exibidos são fictícios para testes">Ambiente de demonstração</div>` : ''}
    </aside>
    <header class="topbar">
      <a href="#/" class="topbar-brand" aria-label="Início">${brandMark(30)}<span><b>CHARÃO</b><small>Gestão de Obras</small></span></a>
      <a href="#/conta" class="topbar-user" aria-label="Minha conta">${avatar(u.name, 'sm', u.id)}</a>
    </header>
    <main id="view" tabindex="-1"></main>
    <nav class="bottombar" aria-label="Navegação">
      ${mob.bar.map(([href, label, ic]) => html`<a href="#${href}" data-nav="${href}">${icon(ic)}<span>${SHORT[label] || label}</span></a>`)}
      ${mob.more.length ? html`<a href="#" data-more data-more-paths="${mob.more.map(m => m[0]).join(' ')}" role="button">${icon('more')}<span>Mais</span></a>` : ''}
    </nav>`.toString();
  app.querySelector('[data-more]')?.addEventListener('click', e => { e.preventDefault(); openMoreMenu(mob.more); });
  fitSidebar();
  // Logo, foto e fontes carregam depois: refaz o ajuste quando mudam de tamanho
  if (window.ResizeObserver) {
    const ro = new ResizeObserver(() => { cancelAnimationFrame(fitFrame); fitFrame = requestAnimationFrame(fitSidebar); });
    app.querySelectorAll('.sidebar-brand, .sidebar-user').forEach(el => ro.observe(el));
  }
}
let fitFrame;

// Menu lateral sem rolagem: compacta (níveis 0 a 4) até todos os itens caberem na altura da janela
function fitSidebar() {
  const sb = document.querySelector('.sidebar');
  const nav = sb?.querySelector('nav');
  if (!nav || getComputedStyle(sb).display === 'none') return;
  for (let d = 0; d <= 4; d++) {
    sb.dataset.density = d;
    if (nav.scrollHeight <= nav.clientHeight + 1) break;
  }
}
let fitTimer;
window.addEventListener('resize', () => { clearTimeout(fitTimer); fitTimer = setTimeout(fitSidebar, 80); });
document.fonts?.ready.then(fitSidebar);

function markNav(path) {
  document.querySelectorAll('[data-nav]').forEach(a => {
    const n = a.dataset.nav;
    const active = n === '/' ? path === '/' : path === n || path.startsWith(n + '/');
    a.classList.toggle('active', active);
    if (active) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
  const more = document.querySelector('[data-more]');
  if (more) more.classList.toggle('active', more.dataset.morePaths.split(' ').some(n => path === n || path.startsWith(n + '/')));
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
  if (path === '/') return navigate(homePath(), { replace: true });
  const needs = sectionOfPath(path);
  if (needs && !sec(needs)) {
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
    setAvatars(meta.avatars);
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
