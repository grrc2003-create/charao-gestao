// Organização de tarefas por período (dia / semana / mês do prazo vigente) — telas e documentos.
import { html, todayISO } from '../core.js';

export const ORG_OPTIONS = [['', 'Lista'], ['dia', 'Dia'], ['semana', 'Semana'], ['mes', 'Mês']];
const MONTHS = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
const WEEKDAYS = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];
const ms = d => Date.parse(d + 'T00:00:00Z');
const addDays = (d, n) => new Date(ms(d) + n * 86400e3).toISOString().slice(0, 10);
const ddmm = d => `${d.slice(8, 10)}/${d.slice(5, 7)}`;

// Semana de segunda a domingo
export const weekStart = d => { const dow = new Date(ms(d)).getUTCDay(); return addDays(d, dow === 0 ? -6 : 1 - dow); };

export function periodKey(date, kind) {
  if (!date) return '9999';
  if (kind === 'dia') return date;
  if (kind === 'semana') return weekStart(date);
  return date.slice(0, 7);
}

export function periodInfo(key, kind, ref = todayISO()) {
  if (key === '9999') return { label: 'Sem prazo', hint: '', rel: 'none' };
  const cur = periodKey(ref, kind);
  const rel = key === cur ? 'current' : key < cur ? 'past' : 'future';
  if (kind === 'dia') {
    const dow = WEEKDAYS[new Date(ms(key)).getUTCDay()];
    const hint = key === ref ? 'Hoje' : key === addDays(ref, 1) ? 'Amanhã' : key === addDays(ref, -1) ? 'Ontem' : '';
    return { label: `${dow[0].toUpperCase() + dow.slice(1)}, ${ddmm(key)}/${key.slice(0, 4)}`, hint, rel };
  }
  if (kind === 'semana') {
    const end = addDays(key, 6);
    const hint = rel === 'current' ? 'Esta semana' : key === addDays(cur, 7) ? 'Próxima semana' : key === addDays(cur, -7) ? 'Semana passada' : '';
    return { label: `Semana de ${ddmm(key)} a ${ddmm(end)}/${end.slice(0, 4)}`, hint, rel };
  }
  const [y, m] = key.split('-').map(Number);
  return { label: `${MONTHS[m - 1][0].toUpperCase() + MONTHS[m - 1].slice(1)} de ${y}`, hint: rel === 'current' ? 'Este mês' : '', rel };
}

// Agrupa (ordem cronológica do prazo; "Sem prazo" por último)
export function groupTasks(tasks, kind) {
  const m = new Map();
  const sorted = [...tasks].sort((a, b) => (a.due_date || '9999').localeCompare(b.due_date || '9999') || a.code.localeCompare(b.code));
  for (const t of sorted) {
    const k = periodKey(t.due_date, kind);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(t);
  }
  return [...m].map(([key, items]) => ({ key, items, ...periodInfo(key, kind) }));
}

// Preferência do usuário (por aparelho), usada quando a URL não indica a organização
const STORE = 'charao.org';
export function readOrg(query) {
  const q = query.get('org');
  if (q !== null) return ORG_OPTIONS.some(([k]) => k === q) ? q : '';
  try { const v = localStorage.getItem(STORE) || ''; return ORG_OPTIONS.some(([k]) => k === v) ? v : ''; } catch { return ''; }
}
export function saveOrg(v) { try { localStorage.setItem(STORE, v); } catch { /* sem armazenamento */ } }

export const orgControl = current => html`<div class="org-control" role="group" aria-label="Organizar tarefas por">
  <span class="org-label">Organizar:</span>
  ${ORG_OPTIONS.map(([k, l]) => html`<button type="button" class="org-btn" data-org="${k}" aria-pressed="${current === k}">${l}</button>`)}
</div>`;
