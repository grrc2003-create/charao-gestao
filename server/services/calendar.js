// Calendário de trabalho de cada obra: fins de semana (Configurações), feriados nacionais (calculados), estaduais e
// municipais (base aberta "feriados-brasil" no GitHub, buscada na internet pelo código IBGE da cidade), dias não
// trabalhados da empresa (Configurações) e ajustes manuais por obra. Dias úteis = dias fora desse calendário.
import { all, one, run, tx } from '../db.js';
import { badRequest, forbidden, notFound, str, date as readDate, intOrNull } from '../lib/http.js';
import { canAccessProject, canManageProject, requireSettingsManager } from '../lib/permissions.js';
import { audit } from './audit.js';

const DATA_BASE = 'https://raw.githubusercontent.com/joaopbini/feriados-brasil/master/dados/feriados';
const IBGE_UF = 'https://servicodados.ibge.gov.br/api/v1/localidades/estados';
export const UFS = ['AC', 'AL', 'AP', 'AM', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA', 'MT', 'MS', 'MG', 'PA', 'PB', 'PR', 'PE', 'PI', 'RJ', 'RN', 'RS', 'RO', 'RR', 'SC', 'SP', 'SE', 'TO'];

const ms = d => Date.parse(`${d}T00:00:00Z`);
const iso = t => new Date(t).toISOString().slice(0, 10);
export const addDaysISO = (d, n) => iso(ms(d) + n * 86400e3);
const dow = d => new Date(ms(d)).getUTCDay();

// ---------- Configurações ----------
const setting = (k, def) => { const r = one('SELECT value FROM app_settings WHERE key = ?', k); return r ? r.value === '1' : def; };
export function calendarSettings() {
  return {
    work_saturday: setting('work_saturday', false), work_sunday: setting('work_sunday', false),
    carnaval_off: setting('carnaval_off', true), corpus_off: setting('corpus_off', true),
    company_days: all('SELECT id, date, name FROM calendar_days WHERE project_id IS NULL ORDER BY date'),
  };
}
export function saveCalendarSettings(ctx, body, ip) {
  requireSettingsManager(ctx.user);
  const flags = ['work_saturday', 'work_sunday', 'carnaval_off', 'corpus_off'];
  const days = Array.isArray(body.company_days) ? body.company_days : null;
  const clean = days?.map((d, i) => {
    const dt = readDate(d?.date, `Data do dia ${i + 1}`);
    if (!dt) throw badRequest(`Informe a data do dia ${i + 1}.`);
    return { date: dt, name: str(d?.name, { max: 120, required: true, label: `Motivo do dia ${dt.split('-').reverse().join('/')}` }) };
  });
  tx(() => {
    for (const k of flags) if (k in body) {
      run(`INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`, k, body[k] ? '1' : '0');
    }
    if (clean) {
      run('DELETE FROM calendar_days WHERE project_id IS NULL');
      for (const d of clean) run(`INSERT INTO calendar_days (project_id, date, name, scope, source, created_by) VALUES (NULL, ?, ?, 'empresa', 'manual', ?)`, d.date, d.name, ctx.user.id);
    }
    audit(ctx.user.id, 'settings', null, 'Calendário de trabalho alterado', { ...Object.fromEntries(flags.filter(k => k in body).map(k => [k, !!body[k]])), ...(clean ? { dias_empresa: clean.length } : {}) }, ip);
  });
  return calendarSettings();
}

// ---------- Feriados nacionais (calculados) ----------
function easter(y) {
  const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1;
  return `${y}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}
export function nationalHolidays(y) {
  const e = easter(y);
  const fixed = [['01-01', 'Confraternização Universal'], ['04-21', 'Tiradentes'], ['05-01', 'Dia do Trabalho'], ['09-07', 'Independência do Brasil'],
    ['10-12', 'Nossa Senhora Aparecida'], ['11-02', 'Finados'], ['11-15', 'Proclamação da República'], ['12-25', 'Natal']];
  if (y >= 2024) fixed.push(['11-20', 'Dia Nacional de Zumbi e da Consciência Negra']);
  return [
    ...fixed.map(([md, name]) => ({ date: `${y}-${md}`, name, scope: 'nacional' })),
    { date: addDaysISO(e, -2), name: 'Sexta-feira Santa', scope: 'nacional' },
    { date: addDaysISO(e, -48), name: 'Carnaval (segunda)', scope: 'nacional', optional: 'carnaval_off' },
    { date: addDaysISO(e, -47), name: 'Carnaval (terça)', scope: 'nacional', optional: 'carnaval_off' },
    { date: addDaysISO(e, 60), name: 'Corpus Christi', scope: 'nacional', optional: 'corpus_off' },
  ];
}

// ---------- Internet: municípios (IBGE) e feriados estaduais/municipais (base aberta) ----------
const cache = new Map();
// HOLIDAYS_OFFLINE=1 (testes): respostas fixas no lugar da internet
const OFFLINE = {
  [`${IBGE_UF}/RS/municipios`]: [{ id: 4304606, nome: 'Canoas' }, { id: 4314902, nome: 'Porto Alegre' }],
  estadual: [{ data: '20/09/YYYY', nome: 'Proc. República Rio Grandense', uf: 'RS', codigo_ibge: null }],
  municipal: [{ data: '02/02/YYYY', nome: 'Nossa Senhora dos Navegantes', uf: 'RS', codigo_ibge: 4304606 }, { data: '27/06/YYYY', nome: 'Dia do Município', uf: 'RS', codigo_ibge: 4304606 }],
};
async function getJSON(url) {
  if (process.env.HOLIDAYS_OFFLINE === '1') {
    if (OFFLINE[url]) return OFFLINE[url];
    const m = /\/(estadual|municipal)\/json\/(\d{4})\.json$/.exec(url);
    if (m) return OFFLINE[m[1]].map(h => ({ ...h, data: h.data.replace('YYYY', m[2]) }));
    throw Object.assign(new Error('offline'), { status: 404 });
  }
  if (cache.has(url)) return cache.get(url);
  const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) { const err = new Error(`HTTP ${res.status}`); err.status = res.status; throw err; }
  // Alguns arquivos da base não estão em UTF-8: se aparecer caractere inválido, lê como Latin-1
  const buf = Buffer.from(await res.arrayBuffer());
  let text = buf.toString('utf8');
  if (text.includes('�')) text = buf.toString('latin1');
  const data = JSON.parse(text);
  cache.set(url, data);
  return data;
}

export async function municipios(uf) {
  if (!UFS.includes(uf)) throw badRequest('Estado inválido.');
  try {
    const list = await getJSON(`${IBGE_UF}/${uf}/municipios`);
    return list.map(m => ({ id: m.id, nome: m.nome })).sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
  } catch {
    throw badRequest('Não foi possível buscar os municípios no IBGE agora. Tente novamente em instantes.');
  }
}

// Feriados de um ano para a UF/cidade. Se a base ainda não tem o ano, repete os de data fixa do ano mais recente.
async function datasetYear(kind, year) {
  for (let y = year; y >= year - 3; y--) {
    try { return { year: y, list: await getJSON(`${DATA_BASE}/${kind}/json/${y}.json`) }; } catch (e) { if (e.status !== 404) throw e; }
  }
  return { year, list: [] };
}
const toISO = (br, year) => { const [d, m] = br.split('/'); return `${year}-${m}-${d}`; };

export async function fetchLocalHolidays(uf, ibge, year) {
  const nat = new Set(nationalHolidays(year).map(h => h.date));
  const out = [];
  const [est, mun] = await Promise.all([datasetYear('estadual', year), ibge ? datasetYear('municipal', year) : Promise.resolve({ year, list: [] })]);
  const add = (h, scope, src) => {
    const d = toISO(h.data, year); // ano projetado quando a base ainda não tem o ano pedido
    if (src.year !== year && /pascoa|páscoa|carnaval|corpus|santa|paix/i.test(h.nome)) return; // móveis: não dá para repetir a data
    if (nat.has(d)) return; // já é feriado nacional
    out.push({ date: d, name: h.nome && h.nome !== 'Feriado Municipal' ? h.nome : (scope === 'municipal' ? 'Feriado municipal' : 'Feriado estadual'), scope, projected: src.year !== year });
  };
  for (const h of est.list) if (h.uf === uf) add(h, 'estadual', est);
  for (const h of mun.list) if (Number(h.codigo_ibge) === Number(ibge)) add(h, 'municipal', mun);
  const seen = new Set();
  return { list: out.filter(h => !seen.has(h.date + h.scope) && seen.add(h.date + h.scope)), municipal_found: mun.list.some(h => Number(h.codigo_ibge) === Number(ibge)) };
}

// Busca e guarda os feriados estaduais/municipais da obra (ano atual e seguinte). Mantém os ajustes manuais.
export async function syncProjectHolidays(projectId, userId) {
  const p = one('SELECT * FROM projects WHERE id = ?', projectId);
  if (!p?.uf) return { ok: false, message: 'Informe o estado e o município da obra.' };
  const y = Number(new Date().toISOString().slice(0, 4));
  const results = [];
  let municipalFound = false;
  try {
    for (const year of [y, y + 1]) {
      const r = await fetchLocalHolidays(p.uf, p.ibge_code, year);
      municipalFound ||= r.municipal_found;
      results.push(...r.list);
    }
  } catch {
    return { ok: false, message: 'Não foi possível buscar os feriados na internet agora. Tente "Atualizar feriados" em instantes.' };
  }
  tx(() => {
    run(`DELETE FROM calendar_days WHERE project_id = ? AND source = 'auto'`, projectId);
    for (const h of results) {
      run(`INSERT INTO calendar_days (project_id, date, name, scope, source, created_by) VALUES (?, ?, ?, ?, 'auto', ?)`, projectId, h.date, h.name, h.scope, userId || null);
    }
    run('UPDATE projects SET holidays_synced_at = ? WHERE id = ?', new Date().toISOString(), projectId);
  });
  return { ok: true, count: results.length, municipal_found: municipalFound };
}

// ---------- Calendário efetivo e dias úteis ----------
// Dias não trabalhados de uma obra entre duas datas (com o motivo), já considerando os ajustes "a obra trabalha"
export function nonWorkingDays(projectId, from, to) {
  const s = calendarSettings();
  const map = new Map();
  const y1 = Number(from.slice(0, 4)), y2 = Number(to.slice(0, 4));
  for (let y = y1; y <= y2; y++) {
    for (const h of nationalHolidays(y)) if (!h.optional || s[h.optional]) map.set(h.date, { date: h.date, name: h.name, scope: 'nacional' });
  }
  for (const r of all(`SELECT * FROM calendar_days WHERE (project_id IS NULL OR project_id = ?) AND date BETWEEN ? AND ?`, projectId || 0, from, to)) {
    if (r.working) map.delete(r.date);
    else map.set(r.date, { date: r.date, name: r.name, scope: r.scope, id: r.id, source: r.source });
  }
  // "A obra trabalha" também vale para feriado nacional (registro de ajuste com working = 1)
  return map;
}
const weekendOff = (d, s) => (dow(d) === 6 && !s.work_saturday) || (dow(d) === 0 && !s.work_sunday);

// Cache simples por obra (o cálculo é chamado várias vezes por requisição)
function calendarFor(projectId, from, to) {
  const s = calendarSettings();
  const off = nonWorkingDays(projectId, from, to);
  return d => !weekendOff(d, s) && !off.has(d);
}
export function isWorkingDay(projectId, d) { return calendarFor(projectId, d, d)(d); }

// Dias úteis entre início e término (inclusive)
export function workingDaysBetween(projectId, start, end) {
  if (!start || !end || end < start) return null;
  const isWork = calendarFor(projectId, start, end);
  let n = 0;
  for (let d = start; d <= end; d = addDaysISO(d, 1)) if (isWork(d)) n++;
  return n;
}
// Próximo dia útil a partir de d (inclusive)
export function nextWorkingDay(projectId, d) {
  const isWork = calendarFor(projectId, d, addDaysISO(d, 400));
  let x = d;
  for (let i = 0; i < 400 && !isWork(x); i++) x = addDaysISO(x, 1);
  return x;
}
// Dia útil anterior ou igual a d
export function prevWorkingDay(projectId, d) {
  const isWork = calendarFor(projectId, addDaysISO(d, -400), d);
  let x = d;
  for (let i = 0; i < 400 && !isWork(x); i++) x = addDaysISO(x, -1);
  return x;
}
// Soma n dias úteis a d (n ≥ 0; com n = 0 devolve o próprio d se for útil, senão o próximo útil)
export function addWorkingDays(projectId, d, n) {
  const isWork = calendarFor(projectId, d, addDaysISO(d, n * 3 + 400));
  let x = d;
  if (n <= 0) { while (!isWork(x)) x = addDaysISO(x, 1); return x; }
  // Cada passo vai ao próximo dia útil (término num sábado: segunda já é o 1º dia útil seguinte)
  for (let k = 0; k < n; k++) { x = addDaysISO(x, 1); while (!isWork(x)) x = addDaysISO(x, 1); }
  return x;
}

// ---------- Calendário da obra (tela) ----------
export function projectCalendar(ctx, projectId, year) {
  const p = one('SELECT * FROM projects WHERE id = ?', projectId);
  if (!p || !canAccessProject(ctx.user, projectId, ctx.projects)) throw notFound('Projeto não encontrado.');
  const y = intOrNull(year) || Number(new Date().toISOString().slice(0, 4));
  const s = calendarSettings();
  const rows = all('SELECT * FROM calendar_days WHERE (project_id IS NULL OR project_id = ?) AND date BETWEEN ? AND ? ORDER BY date', projectId, `${y}-01-01`, `${y}-12-31`);
  const overrides = new Map(rows.filter(r => r.project_id && r.working).map(r => [r.date, r]));
  const days = [
    ...nationalHolidays(y).map(h => ({ date: h.date, name: h.name, scope: 'nacional', source: 'auto', optional: !!h.optional,
      off: (!h.optional || s[h.optional]) && !overrides.has(h.date), override_id: overrides.get(h.date)?.id || null })),
    ...rows.filter(r => !(r.project_id && r.working && r.scope === 'nacional')).map(r => ({ id: r.id, date: r.date, name: r.name, scope: r.scope, source: r.source, off: !r.working, company: !r.project_id })),
  ].sort((a, b) => a.date.localeCompare(b.date));
  return {
    year: y, uf: p.uf, municipio: p.municipio, ibge_code: p.ibge_code, synced_at: p.holidays_synced_at, settings: s, days,
    can_edit: canManageProject(ctx, projectId),
  };
}

function requireProjectManager(ctx, projectId) {
  const p = one('SELECT * FROM projects WHERE id = ?', projectId);
  if (!p || !canAccessProject(ctx.user, projectId, ctx.projects)) throw notFound('Projeto não encontrado.');
  if (!canManageProject(ctx, projectId)) throw forbidden('Você não pode alterar o calendário desta obra.');
  return p;
}
// Incluir um dia não trabalhado só desta obra
export function addProjectDay(ctx, projectId, body) {
  requireProjectManager(ctx, projectId);
  const d = readDate(body.date, 'Data');
  if (!d) throw badRequest('Informe a data.');
  const name = str(body.name, { max: 120, required: true, label: 'Motivo' });
  run(`INSERT INTO calendar_days (project_id, date, name, scope, source, created_by) VALUES (?, ?, ?, 'obra', 'manual', ?)`, projectId, d, name, ctx.user.id);
}
// A obra trabalha (ou volta a não trabalhar) num feriado
export function setProjectDayWorking(ctx, projectId, body) {
  requireProjectManager(ctx, projectId);
  const working = !!body.working;
  const id = intOrNull(body.id);
  if (id) {
    const r = one('SELECT * FROM calendar_days WHERE id = ? AND project_id = ?', id, projectId);
    if (!r) throw notFound('Dia não encontrado.');
    run('UPDATE calendar_days SET working = ? WHERE id = ?', working ? 1 : 0, id);
    return;
  }
  // Feriado nacional: registra (ou remove) o ajuste "a obra trabalha"
  const d = readDate(body.date, 'Data');
  if (!d) throw badRequest('Informe a data.');
  run(`DELETE FROM calendar_days WHERE project_id = ? AND date = ? AND scope = 'nacional' AND working = 1`, projectId, d);
  if (working) run(`INSERT INTO calendar_days (project_id, date, name, scope, source, working, created_by) VALUES (?, ?, ?, 'nacional', 'manual', 1, ?)`, projectId, d, str(body.name, { max: 120, label: 'Nome' }) || 'Feriado nacional', ctx.user.id);
}
export function removeProjectDay(ctx, projectId, id) {
  requireProjectManager(ctx, projectId);
  const r = one(`SELECT * FROM calendar_days WHERE id = ? AND project_id = ? AND source = 'manual'`, intOrNull(id), projectId);
  if (!r) throw notFound('Só é possível excluir dias incluídos manualmente.');
  run('DELETE FROM calendar_days WHERE id = ?', r.id);
}
