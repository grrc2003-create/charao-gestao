// Núcleo do frontend: templates seguros (escape automático), API, formatação e constantes de domínio.

// ---------- Templates com escape por padrão ----------
class Raw { constructor(s) { this.s = s; } toString() { return this.s; } }
export const raw = s => new Raw(String(s ?? ''));
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = s => String(s).replace(/[&<>"']/g, c => ESC[c]);
function renderVal(v) {
  if (v === null || v === undefined || v === false) return '';
  if (v instanceof Raw) return v.s;
  if (Array.isArray(v)) return v.map(renderVal).join('');
  return esc(v);
}
export function html(strings, ...vals) {
  let out = '';
  strings.forEach((s, i) => { out += s; if (i < vals.length) out += renderVal(vals[i]); });
  return new Raw(out);
}

// ---------- API ----------
export class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export async function api(path, { method = 'GET', body, query } = {}) {
  let url = '/api' + path;
  if (query) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      if (Array.isArray(v)) v.forEach(x => qs.append(k, x));
      else if (v !== undefined && v !== null && v !== '') qs.set(k, v);
    }
    const s = qs.toString();
    if (s) url += '?' + s;
  }
  const res = await fetch(url, {
    method,
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'charao-app' },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* sem corpo */ }
  if (!res.ok) {
    if (res.status === 401 && !path.startsWith('/auth/')) window.dispatchEvent(new CustomEvent('auth:expired'));
    throw new ApiError(res.status, data?.error || 'Falha na comunicação com o servidor.');
  }
  return data;
}

// ---------- Domínio ----------
export const STATUS = {
  aberta: { label: 'Aberta', icon: '○' },
  em_andamento: { label: 'Em andamento', icon: '◐' },
  aguardando_conferencia: { label: 'Aguardando conferência', short: 'Em conferência', icon: '◎' },
  atrasada: { label: 'Atrasada', icon: '!' },
  concluida: { label: 'Concluída', icon: '✓' },
};
export const STATUS_ORDER = ['aberta', 'em_andamento', 'aguardando_conferencia', 'atrasada', 'concluida'];
export const PRIORITY = { baixa: 'Baixa', media: 'Média', alta: 'Alta', urgente: 'Urgente' };
export const PROOF = {
  nenhuma: { label: 'Sem comprovação obrigatória', short: 'Nenhuma', icon: '—' },
  foto: { label: 'Somente foto', short: 'Foto', icon: '📷' },
  descricao: { label: 'Somente descrição', short: 'Descrição', icon: '✎' },
  foto_descricao: { label: 'Foto + descrição', short: 'Foto + descrição', icon: '📷✎' },
};
export const PROJECT_STATUS = {
  planejamento: 'Planejamento', em_andamento: 'Em andamento', pausado: 'Pausado', concluido: 'Concluído', cancelado: 'Cancelado',
};
export const ROLE = { admin: 'Administrador', gestor: 'Gestor', colaborador: 'Colaborador' };
export const SCOPE = {
  total: 'Acesso total (todos os projetos)',
  projetos: 'Limitado aos projetos liberados',
  proprias: 'Somente tarefas próprias nos projetos liberados',
};

// ---------- Formatação ----------
const TZ = 'America/Sao_Paulo';
export const todayISO = () => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
export function fmtDate(d, opts) {
  if (!d) return '—';
  const [y, m, day] = d.slice(0, 10).split('-');
  if (opts === 'short') return `${day}/${m}`;
  return `${day}/${m}/${y}`;
}
export function fmtDateTime(ts) {
  if (!ts) return '—';
  const d = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(ts) ? ts : ts.replace(' ', 'T') + 'Z');
  return new Intl.DateTimeFormat('pt-BR', { timeZone: TZ, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(d);
}
export const fmtPct = v => (v === null || v === undefined ? '—' : `${String(v).replace('.', ',')}%`);
export const initials = name => (name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map(p => p[0]).join('').toUpperCase();
export function dueInfo(t) {
  if (!t.due_date) return { text: 'Sem prazo', cls: '' };
  if (t.status === 'concluida') return { text: fmtDate(t.due_date), cls: '' };
  if (t.eff_status === 'atrasada') return { text: `${fmtDate(t.due_date)} · ${t.days_late}d atraso`, cls: 'due-late' };
  if (t.days_to_due === 0) return { text: 'Hoje', cls: 'due-soon' };
  if (t.days_to_due === 1) return { text: 'Amanhã', cls: 'due-soon' };
  if (t.days_to_due !== null && t.days_to_due <= 3) return { text: `${fmtDate(t.due_date)} · ${t.days_to_due}d`, cls: 'due-soon' };
  return { text: fmtDate(t.due_date), cls: '' };
}
export const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// ---------- Componentes reutilizáveis ----------
export const statusBadge = (s, opts = {}) =>
  html`<span class="badge st-${s}" title="${STATUS[s].label}"><i aria-hidden="true">${STATUS[s].icon}</i>${opts.short && STATUS[s].short ? STATUS[s].short : STATUS[s].label}</span>`;
export const priorityTag = p => html`<span class="prio prio-${p}">${PRIORITY[p]}</span>`;
export const avatar = (name, size = '') => html`<span class="avatar ${size}" aria-hidden="true">${initials(name)}</span>`;
export const progress = (pct, label) =>
  html`<div class="progress" role="progressbar" aria-valuenow="${pct || 0}" aria-valuemin="0" aria-valuemax="100" aria-label="${label || 'Conclusão'}"><span style="width:${Math.max(0, Math.min(100, pct || 0))}%"></span></div>`;
export const icon = name => raw(ICONS[name] || '');

const svg = d => `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const ICONS = {
  dashboard: svg('<rect x="3" y="3" width="7" height="9" rx="1"/><rect x="14" y="3" width="7" height="5" rx="1"/><rect x="14" y="12" width="7" height="9" rx="1"/><rect x="3" y="16" width="7" height="5" rx="1"/>'),
  projects: svg('<path d="M3 21h18M5 21V8l7-5 7 5v13"/><path d="M9 21v-6h6v6"/>'),
  tasks: svg('<path d="M9 6h11M9 12h11M9 18h11"/><path d="m3 6 1.5 1.5L7 5M3 12l1.5 1.5L7 11M3 18l1.5 1.5L7 17"/>'),
  users: svg('<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.8-3.5 3.4-5.5 6.5-5.5s5.7 2 6.5 5.5"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18 14.8c1.8.7 3 2.5 3.5 5.2"/>'),
  reports: svg('<path d="M6 3h9l4 4v14H6z"/><path d="M14 3v5h5M9 13h7M9 17h5M9 9h3"/>'),
  plus: svg('<path d="M12 5v14M5 12h14"/>'),
  search: svg('<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2"/>'),
  filter: svg('<path d="M4 5h16l-6 7.5V19l-4-2v-4.5z"/>'),
  back: svg('<path d="M15 18 9 12l6-6"/>'),
  chevron: svg('<path d="m9 18 6-6-6-6"/>'),
  print: svg('<path d="M7 9V3h10v6"/><rect x="3" y="9" width="18" height="8" rx="1.5"/><path d="M7 14h10v7H7z"/>'),
  checklist: svg('<rect x="3" y="3" width="18" height="18" rx="2"/><path d="m7 9 2 2 4-4M7 16h10"/>'),
  camera: svg('<path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>'),
  edit: svg('<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="m13.5 6.5 4 4"/>'),
  note: svg('<path d="M5 4h14v12l-4 4H5z"/><path d="M15 20v-4h4M8 9h8M8 13h5"/>'),
  send: svg('<path d="M21 3 10 14M21 3l-7 18-4-7-7-4z"/>'),
  check: svg('<path d="m5 12 5 5L20 7"/>'),
  x: svg('<path d="M6 6l12 12M18 6 6 18"/>'),
  calendar: svg('<rect x="3" y="5" width="18" height="16" rx="1.5"/><path d="M3 10h18M8 3v4M16 3v4"/>'),
  user: svg('<circle cx="12" cy="8" r="4"/><path d="M4 21c1-4 4-6 8-6s7 2 8 6"/>'),
  clock: svg('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'),
  shield: svg('<path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6z"/><path d="m9 12 2 2 4-4"/>'),
  logout: svg('<path d="M15 4h4v16h-4M10 17l5-5-5-5M15 12H3"/>'),
  history: svg('<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5M12 7v5l3 2"/>'),
  image: svg('<rect x="3" y="4" width="18" height="16" rx="1.5"/><circle cx="9" cy="10" r="2"/><path d="m21 17-5-5-9 8"/>'),
  key: svg('<circle cx="8" cy="15" r="4"/><path d="m11 12 9-9M17 6l3 3M15 8l2 2"/>'),
  more: svg('<circle cx="5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="19" cy="12" r="1.3"/>'),
  team: svg('<circle cx="12" cy="7" r="3"/><circle cx="5" cy="10" r="2.3"/><circle cx="19" cy="10" r="2.3"/><path d="M7 20c.5-3.3 2.4-5 5-5s4.5 1.7 5 5M1.5 19c.3-2.2 1.6-3.5 3.5-3.5M22.5 19c-.3-2.2-1.6-3.5-3.5-3.5"/>'),
  alert: svg('<path d="M12 3 2 20h20z"/><path d="M12 10v4M12 17v.5"/>'),
  info: svg('<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.5"/>'),
  trash: svg('<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>'),
};

// Marca da Charão (símbolo) em SVG
export const brandMark = (size = 32) => raw(`<svg class="brand-mark" viewBox="0 0 420 400" width="${size}" height="${Math.round(size * 0.95)}" aria-hidden="true">
<path fill="#2A3D50" d="M208 0v58L55 270l153 65v60L0 295z"/><path fill="#2A3D50" opacity=".88" d="M208 102v62l-48 66 48 18v52L95 255z"/>
<path fill="#F26B21" d="M208 0l38 52v128l74-23 30 41-104 37v85l147-62 27 38-212 97z"/></svg>`);
