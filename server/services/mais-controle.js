// Tarefas financeiras › Mais Controle (API para Relatórios, rotina "pagamentos", CSV com login e senha da API).
// O Mais Controle é a fonte do realizado: cada busca guarda a foto dos pagamentos (2024 em diante) e a sincronização
// recalcula o realizado de cada tarefa e mês — correções feitas lá se refletem sozinhas:
//  - só contas bancárias cadastradas (custo em outra conta vira alerta: cadastre a conta para trazer);
//  - centro de custo Empresa → tarefa financeira de mesmo nome da categoria (a tarefa É a categoria; sem tarefa vira alerta);
//  - demais centros de custo → "Custos destinados a Projetos" (uma linha por centro de custo, total do mês);
//  - previsto: primeiro ano = o próprio realizado; demais anos = realizado do mesmo mês no ano anterior;
//  - conferência de alocação: despesa do mês numa categoria diferente da habitual do fornecedor (OK / errado).
// Toda semana (segunda, 8h) busca e sincroniza sozinho. Credenciais só nas variáveis de ambiente do servidor.
import crypto from 'node:crypto';
import { all, one, run, tx } from '../db.js';
import { badRequest, notFound, str, intOrNull } from '../lib/http.js';
import { readXlsxSheets, serialToDate } from '../lib/xlsx.js';
import { audit, taskHistory } from './audit.js';
import { today } from './metrics.js';
import { requireFinance, monthsOf, ensureItemInternal, coverage, markState, syncZero } from './finance.js';

const SOURCE = 'maiscontrole';
const API_URL = () => process.env.MAISCONTROLE_URL || 'https://api-clientes.maiscontroleerp.com.br/data-exports/pagamentos';
const PLAN_HOURS = { semanal: 24 * 7, diario: 24, horario: 1 };
const plan = () => (PLAN_HOURS[process.env.MAISCONTROLE_PLANO] ? process.env.MAISCONTROLE_PLANO : 'semanal');
const configured = () => !!(process.env.MAISCONTROLE_USUARIO && process.env.MAISCONTROLE_SENHA);
const norm = s => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
const hkey = s => norm(s).replace(/[^a-z0-9]/g, '');
const r2 = v => Math.round((Number(v) || 0) * 100) / 100;
const brl = v => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(Number(v) || 0);
const isEmpresa = cc => !cc || hkey(cc) === 'empresa';

// ---------- Leitura (CSV da API ou arquivo .xlsx/.csv exportado) ----------
function parseCsv(text) {
  const t = String(text).replace(/^﻿/, '');
  const first = t.split(/\r?\n/, 1)[0] || '';
  const cnt = ch => (first.match(new RegExp(ch, 'g')) || []).length;
  const sep = cnt(';') > cnt(',') ? ';' : cnt('\t') > cnt(',') ? '\t' : ',';
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (q) { if (c === '"') { if (t[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; continue; }
    if (c === '"') q = true;
    else if (c === sep) { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && t[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.filter(r => r.some(x => String(x).trim() !== ''));
}
function dateOf(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return v > 20000 && v < 80000 ? serialToDate(v) : null;
  const s = String(v).trim();
  let m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(s);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}
function numOf(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return v;
  const s = String(v).trim().replace(/^R\$\s*/i, '');
  const n = Number(/,\d{1,2}$/.test(s) ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}
// Linhas → pagamentos normalizados (só o necessário; sem dados bancários do fornecedor)
function toPayments(grid) {
  const hi = grid.findIndex(r => r.some(v => hkey(v) === 'datadevencimento') && r.some(v => hkey(v) === 'categoria'));
  if (hi < 0) throw badRequest('Não reconheci o formato de Pagamentos do Mais Controle (faltam as colunas "Data de Vencimento" e "Categoria").');
  const H = grid[hi].map(hkey);
  const at = (r, ...ks) => { for (const k of ks) { const i = H.indexOf(k); if (i >= 0 && r[i] !== null && r[i] !== undefined && String(r[i]).trim() !== '') return r[i]; } return null; };
  const out = [];
  for (const r of grid.slice(hi + 1)) {
    const due = dateOf(at(r, 'datadevencimento')), paid = dateOf(at(r, 'datadepagamento'));
    if (!due && !paid) continue;
    const amount = numOf(at(r, 'valortotalpago', 'valorpagodaparcela'));
    out.push({
      due, paid, amount: amount === null ? null : r2(amount),
      category: String(at(r, 'categoria') ?? '').trim(), supplier: String(at(r, 'fornecedor') ?? '').trim(),
      desc: String(at(r, 'descricao') ?? '').trim().slice(0, 200),
      cost_center: String(at(r, 'centrodecusto') ?? '').trim(), account: String(at(r, 'contabancaria') ?? '').trim(),
      obra: String(at(r, 'obra') ?? '').trim().replace(/^-$/, ''),
    });
  }
  return out;
}
// Chave do pagamento (o Mais Controle não traz um id fixo): vencimento, pagamento, valor, fornecedor e descrição +
// ordem entre pagamentos idênticos. A categoria fica de fora: corrigida no Mais Controle, é o mesmo pagamento.
function withKeys(pays) {
  const seen = new Map();
  return pays.map(p => {
    const base = crypto.createHash('sha1').update([p.due, p.paid, p.amount, hkey(p.supplier), hkey(p.desc)].join('|')).digest('hex').slice(0, 24);
    const n = (seen.get(base) || 0) + 1; seen.set(base, n);
    return { ...p, key: `${base}#${n}` };
  });
}
const actorId = ctx => ctx.user?.id || null;

// Busca guardada + foto atual dos pagamentos. API (completa): substitui a foto inteira. Arquivo exportado: substitui só
// os meses que o arquivo cobre (o resto do histórico fica).
function saveFetch(ctx, origin, fileName, pays) {
  const until = origin === 'arquivo' ? today() : new Date(Date.parse(today()) - 86400e3).toISOString().slice(0, 10);
  return tx(() => {
    const id = Number(run('INSERT INTO ext_fetches (source, origin, file_name, rows_json, row_count, data_until, fetched_by) VALUES (?,?,?,?,?,?,?)',
      SOURCE, origin, fileName, JSON.stringify(pays), pays.length, until, actorId(ctx)).lastInsertRowid);
    const rows = withKeys(pays).map(p => ({ ...p, ym: (p.due || p.paid).slice(0, 7) }));
    if (origin === 'arquivo') {
      const ms = rows.map(r => r.ym).sort();
      if (ms.length) run('DELETE FROM ext_payments WHERE source = ? AND ref_month BETWEEN ? AND ?', SOURCE, ms[0], ms.at(-1));
    } else run('DELETE FROM ext_payments WHERE source = ?', SOURCE);
    for (const p of rows) {
      run(`INSERT OR REPLACE INTO ext_payments (source, ext_key, due_date, paid_date, ref_month, amount, category, supplier, supplier_key, description, account, account_key, cost_center, fetch_id)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, SOURCE, p.key, p.due, p.paid, p.ym, p.amount ?? 0, p.category, p.supplier, hkey(p.supplier), p.desc, p.account, hkey(p.account), p.cost_center || 'Empresa', id);
    }
    audit(actorId(ctx), 'finance', null, origin === 'arquivo' ? 'Pagamentos do Mais Controle enviados por arquivo' : 'Pagamentos buscados no Mais Controle (API)', { arquivo: fileName, pagamentos: pays.length }, null);
    return id;
  });
}

// ---------- Situação: configuração e cota ----------
const lastApiFetch = () => one(`SELECT * FROM ext_fetches WHERE source = ? AND origin IN ('api', 'auto') ORDER BY id DESC LIMIT 1`, SOURCE);
const tsOf = s => Date.parse(/Z$|T/.test(s) ? s : `${s.replace(' ', 'T')}Z`);
function nextAllowed() {
  const l = lastApiFetch();
  if (!l) return null;
  const t = tsOf(l.fetched_at) + PLAN_HOURS[plan()] * 3600e3;
  return t > Date.now() ? new Date(t).toISOString() : null;
}
export function status(ctx) {
  requireFinance(ctx.user);
  const f = one('SELECT id, origin, file_name, row_count, data_until, fetched_at FROM ext_fetches WHERE source = ? ORDER BY id DESC LIMIT 1', SOURCE);
  const span = one(`SELECT COUNT(*) AS n, MIN(ref_month) AS desde, MAX(ref_month) AS ate FROM ext_payments WHERE source = ?`, SOURCE);
  return { configured: configured(), plan: plan(), next_allowed: nextAllowed(), last_fetch: f || null, auto: process.env.MAISCONTROLE_AUTO !== '0', snapshot: span };
}

// ---------- Buscar ----------
async function callApi() {
  let res;
  try {
    res = await fetch(API_URL(), {
      headers: { Authorization: `Basic ${Buffer.from(`${process.env.MAISCONTROLE_USUARIO}:${process.env.MAISCONTROLE_SENHA}`).toString('base64')}`, Accept: 'text/csv' },
      signal: AbortSignal.timeout(120000),
    });
  } catch (e) { throw badRequest(`Não consegui falar com o Mais Controle (${e.name === 'TimeoutError' ? 'tempo esgotado' : e.message}).`); }
  if (res.status === 401) throw badRequest('O Mais Controle recusou o acesso (401): confira o usuário e a senha da API nas variáveis de ambiente.');
  if (res.status === 429) throw badRequest('O Mais Controle informou que a cota de consultas do plano já foi usada (429): tente depois da renovação ou envie o arquivo exportado.');
  if (!res.ok) throw badRequest(`O Mais Controle respondeu com erro ${res.status}.`);
  return toPayments(parseCsv(await res.text()));
}
export async function fetchFromApi(ctx) {
  requireFinance(ctx.user);
  if (!configured()) throw badRequest('Integração não configurada: cadastre MAISCONTROLE_USUARIO e MAISCONTROLE_SENHA nas variáveis de ambiente do servidor.');
  const na = nextAllowed();
  if (na) throw badRequest(`Pelo plano ${plan()} da API, a próxima busca fica liberada em ${new Date(na).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}. Use a última busca ou envie o arquivo exportado.`);
  const pays = await callApi();
  return { fetch_id: saveFetch(ctx, 'api', 'API · pagamentos', pays), rows: pays.length };
}
export function uploadFile(ctx, body) {
  requireFinance(ctx.user);
  const f = body?.file;
  if (!f?.data) throw badRequest('Envie o arquivo de Pagamentos exportado do Mais Controle (.xlsx ou .csv).');
  const name = str(f.name, { max: 200, label: 'Nome do arquivo' }) || 'pagamentos';
  const buf = Buffer.from(String(f.data).replace(/^data:[^,]*,/, ''), 'base64');
  let grid;
  try { grid = buf.slice(0, 2).toString() === 'PK' ? readXlsxSheets(buf)[0].rows : parseCsv(buf.toString('utf8')); }
  catch (e) { throw badRequest(`${name}: não foi possível ler o arquivo (${e.message}).`); }
  const pays = toPayments(grid);
  if (!pays.length) throw badRequest('O arquivo não tem pagamentos.');
  return { fetch_id: saveFetch(ctx, 'arquivo', name, pays), rows: pays.length };
}

// Sincronização automática semanal: segunda-feira a partir das 8h (depois da atualização de domingo da API), uma vez
let autoRunning = false;
export async function autoSync() {
  if (autoRunning || !configured() || process.env.MAISCONTROLE_AUTO === '0') return null;
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
  const monday = new Date(now); monday.setHours(8, 0, 0, 0); monday.setDate(now.getDate() - ((now.getDay() + 6) % 7));
  if (now < monday) monday.setDate(monday.getDate() - 7);
  const l = lastApiFetch();
  const lastLocal = l ? new Date(new Date(tsOf(l.fetched_at)).toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' })) : null;
  if ((lastLocal && lastLocal >= monday) || nextAllowed()) return null;
  autoRunning = true;
  const ctx = { user: { id: null, can_finance: 1, role: 'admin', name: 'Sincronização automática' } };
  try {
    const pays = await callApi();
    saveFetch(ctx, 'auto', 'API · pagamentos (automático)', pays);
    return sync(ctx, null);
  } catch (e) {
    audit(null, 'finance', null, 'Falha na sincronização automática com o Mais Controle', { erro: e.message }, null);
    return null;
  } finally { autoRunning = false; }
}

// ---------- Cadastro: contas bancárias ----------
export function setAccount(ctx, body) {
  requireFinance(ctx.user);
  const key = hkey(body.key ?? body.label), label = str(body.label, { max: 160, label: 'Conta' }) || '(sem conta)';
  run(`INSERT INTO ext_accounts (source, ext_key, label, active, updated_by) VALUES (?,?,?,?,?)
    ON CONFLICT(source, ext_key) DO UPDATE SET label = excluded.label, active = excluded.active, updated_by = excluded.updated_by, updated_at = datetime('now')`,
    SOURCE, key, label, body.active ? 1 : 0, ctx.user.id);
  audit(ctx.user.id, 'finance', null, body.active ? 'Conta bancária do Mais Controle cadastrada' : 'Conta bancária do Mais Controle desativada', { conta: label }, null);
  return { ok: true };
}

// ---------- Alocação: a partir da foto atual ----------
// Empresa + conta cadastrada → tarefa de mesmo nome da categoria (realizado por tarefa e mês do vencimento)
function allocation() {
  const rows = all(`SELECT p.*, a.active AS acc_active, a.label AS acc_label FROM ext_payments p
    LEFT JOIN ext_accounts a ON a.source = p.source AND a.ext_key = p.account_key WHERE p.source = ?`, SOURCE);
  const obs = all('SELECT * FROM finance_obligations ORDER BY active DESC, id');
  const byName = new Map();
  for (const o of obs) if (!byName.has(hkey(o.title))) byName.set(hkey(o.title), o);
  const real = new Map(), noTask = new Map(), otherAcc = new Map(), projects = new Map(), accounts = new Map();
  let firstYear = null, unpaid = 0;
  for (const p of rows) {
    if (!p.paid_date || !(p.amount > 0)) { unpaid++; continue; }
    const ak = p.account_key || '';
    if (!accounts.has(ak)) accounts.set(ak, { key: ak, label: p.account || '(sem conta)', active: !!p.acc_active, count: 0, total: 0, categories: new Map() });
    const acc = accounts.get(ak); acc.count++; acc.total = r2(acc.total + p.amount);
    if (!p.acc_active) { acc.categories.set(p.category || '(sem categoria)', r2((acc.categories.get(p.category || '(sem categoria)') || 0) + p.amount)); continue; }
    if (!isEmpresa(p.cost_center)) {
      const k = `${p.cost_center}|${p.ref_month}`;
      if (!projects.has(k)) projects.set(k, { cost_center: p.cost_center, ym: p.ref_month, amount: 0, count: 0 });
      const g = projects.get(k); g.amount = r2(g.amount + p.amount); g.count++;
      continue;
    }
    const y = Number(p.ref_month.slice(0, 4));
    if (!firstYear || y < firstYear) firstYear = y;
    const o = byName.get(hkey(p.category));
    if (!o) {
      const c = noTask.get(hkey(p.category)) || { label: p.category || '(sem categoria)', count: 0, total: 0, last: null };
      c.count++; c.total = r2(c.total + p.amount); if (!c.last || p.ref_month > c.last) c.last = p.ref_month;
      noTask.set(hkey(p.category), c);
      continue;
    }
    const k = `${o.id}|${p.ref_month}`;
    if (!real.has(k)) real.set(k, { o, ym: p.ref_month, amount: 0, count: 0, paid_date: null });
    const g = real.get(k); g.amount = r2(g.amount + p.amount); g.count++;
    if (!g.paid_date || p.paid_date > g.paid_date) g.paid_date = p.paid_date;
  }
  for (const a of accounts.values()) a.categories = [...a.categories].map(([label, total]) => ({ label, total })).sort((x, y) => y.total - x.total);
  for (const a of all('SELECT * FROM ext_accounts WHERE source = ?', SOURCE)) if (!accounts.has(a.ext_key)) accounts.set(a.ext_key, { key: a.ext_key, label: a.label, active: !!a.active, count: 0, total: 0, categories: [] });
  return { real, noTask, projects, accounts, firstYear, unpaid, obs };
}

// O que a sincronização muda nas parcelas (novo / alterado / removido / pago à mão)
function changes(al) {
  const out = [];
  const items = all(`SELECT i.*, o.title FROM finance_items i JOIN finance_obligations o ON o.id = i.obligation_id`);
  const byKey = new Map(items.map(i => [`${i.obligation_id}|${i.ref_month}`, i]));
  for (const [k, g] of al.real) {
    const it = byKey.get(k);
    if (it?.status === 'paga' && it.source !== SOURCE && r2(it.paid_amount) !== 0) { if (r2(it.paid_amount) !== g.amount) out.push({ kind: 'manual', title: g.o.title, ym: g.ym, amount: g.amount, before: it.paid_amount }); continue; }
    if (it?.status === 'paga' && it.source === SOURCE) { if (r2(it.paid_amount) !== g.amount) out.push({ kind: 'alterado', title: g.o.title, ym: g.ym, amount: g.amount, before: it.paid_amount, count: g.count }); continue; }
    out.push({ kind: 'novo', title: g.o.title, ym: g.ym, amount: g.amount, count: g.count });
  }
  for (const it of items) if (it.status === 'paga' && it.source === SOURCE && !al.real.has(`${it.obligation_id}|${it.ref_month}`)) out.push({ kind: 'removido', title: it.title, ym: it.ref_month, amount: 0, before: it.paid_amount });
  return out.sort((a, b) => a.title.localeCompare(b.title, 'pt-BR') || a.ym.localeCompare(b.ym));
}

// ---------- Conferência de alocação: despesa do mês atual numa categoria diferente da habitual do fornecedor ----------
export function reviews() {
  const cur = today().slice(0, 7);
  const rows = all(`SELECT p.* FROM ext_payments p JOIN ext_accounts a ON a.source = p.source AND a.ext_key = p.account_key AND a.active = 1
    WHERE p.source = ? AND p.paid_date IS NOT NULL AND p.amount > 0 AND (p.cost_center IS NULL OR lower(p.cost_center) = 'empresa') AND p.supplier_key <> ''`, SOURCE);
  const decided = new Map(all('SELECT * FROM ext_reviews WHERE source = ?', SOURCE).map(r => [r.ext_key, r]));
  // Categoria habitual: a última aceita ("Está OK") para o fornecedor, senão a mais frequente nos meses anteriores
  const accepted = new Map();
  for (const r of all(`SELECT supplier_key, category FROM ext_reviews WHERE source = ? AND decision = 'ok' ORDER BY decided_at`, SOURCE)) accepted.set(r.supplier_key, r.category);
  const hist = new Map();
  for (const p of rows) if (p.ref_month < cur) {
    const m = hist.get(p.supplier_key) || new Map();
    m.set(p.category, (m.get(p.category) || 0) + 1); hist.set(p.supplier_key, m);
  }
  const usualOf = sk => accepted.get(sk) ?? (hist.get(sk) ? [...hist.get(sk)].sort((a, b) => b[1] - a[1])[0][0] : null);
  const out = [];
  for (const p of rows.filter(x => x.ref_month === cur)) {
    const usual = usualOf(p.supplier_key);
    const d = decided.get(p.ext_key);
    if (d?.decision === 'ok') continue;
    if (d?.decision === 'errado') {
      // Marcado como errado: conferido de novo a cada atualização; corrigido no Mais Controle → sai da lista
      if (hkey(p.category) !== hkey(d.category)) continue;
      out.push({ key: p.ext_key, supplier: p.supplier, description: p.description, amount: p.amount, due_date: p.due_date, category: p.category, usual: d.usual || usual, state: 'nao_ajustado', marked_at: d.decided_at });
      continue;
    }
    if (!usual || hkey(usual) === hkey(p.category)) continue;
    out.push({ key: p.ext_key, supplier: p.supplier, description: p.description, amount: p.amount, due_date: p.due_date, category: p.category, usual, state: 'conferir' });
  }
  return out.sort((a, b) => (a.state === 'nao_ajustado' ? -1 : 1) - (b.state === 'nao_ajustado' ? -1 : 1) || String(a.supplier).localeCompare(String(b.supplier), 'pt-BR'));
}
export function decideReview(ctx, body) {
  requireFinance(ctx.user);
  const decision = body.decision === 'ok' ? 'ok' : body.decision === 'errado' ? 'errado' : null;
  if (!decision) throw badRequest('Informe se está OK ou errado.');
  const p = one('SELECT * FROM ext_payments WHERE source = ? AND ext_key = ?', SOURCE, String(body.key || ''));
  if (!p) throw notFound('Pagamento não encontrado na última atualização do Mais Controle.');
  const usual = str(body.usual, { max: 160, label: 'Categoria habitual' });
  run(`INSERT INTO ext_reviews (source, ext_key, supplier_key, decision, category, usual, decided_by) VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(source, ext_key) DO UPDATE SET decision = excluded.decision, category = excluded.category, usual = excluded.usual, decided_by = excluded.decided_by, decided_at = datetime('now')`,
    SOURCE, p.ext_key, p.supplier_key, decision, p.category, usual, ctx.user.id);
  audit(ctx.user.id, 'finance', null, decision === 'ok' ? 'Alocação conferida: OK (fornecedor passa a valer nesta categoria)' : 'Alocação conferida: errada (ajustar no Mais Controle)',
    { fornecedor: p.supplier, categoria: p.category, habitual: usual, valor: p.amount }, null);
  return { ok: true };
}

// ---------- Prévia ----------
export function preview(ctx) {
  requireFinance(ctx.user);
  const f = one('SELECT * FROM ext_fetches WHERE source = ? ORDER BY id DESC LIMIT 1', SOURCE);
  const al = allocation();
  const ch = changes(al);
  const projList = [...al.projects.values()].sort((a, b) => a.cost_center.localeCompare(b.cost_center, 'pt-BR') || a.ym.localeCompare(b.ym));
  const noTask = [...al.noTask.values()].sort((a, b) => b.total - a.total);
  const accounts = [...al.accounts.values()].sort((a, b) => Number(b.active) - Number(a.active) || b.total - a.total);
  const otherAcc = accounts.filter(a => !a.active && a.count);
  const cnt = k => ch.filter(c => c.kind === k).length;
  return {
    fetch: f ? { id: f.id, origin: f.origin, file_name: f.file_name, fetched_at: f.fetched_at, rows: f.row_count, data_until: f.data_until } : null,
    first_year: al.firstYear, accounts, categories: noTask, changes: ch, projects: projList.slice(-24), reviews: reviews(),
    totals: {
      novo: cnt('novo'), alterado: cnt('alterado'), removido: cnt('removido'), manual: cnt('manual'),
      novo_total: r2(ch.filter(c => c.kind === 'novo').reduce((s, c) => s + c.amount, 0)),
      unmapped: noTask.reduce((s, c) => s + c.count, 0), unmapped_total: r2(noTask.reduce((s, c) => s + c.total, 0)),
      other_account: otherAcc.reduce((s, a) => s + a.count, 0), other_account_total: r2(otherAcc.reduce((s, a) => s + a.total, 0)),
      projects: projList.reduce((s, g) => s + g.count, 0), projects_total: r2(projList.reduce((s, g) => s + g.amount, 0)), unpaid: al.unpaid,
    },
  };
}

// ---------- Sincronizar: realizado e previsto a partir da foto atual ----------
const prevYm = ym => `${Number(ym.slice(0, 4)) - 1}${ym.slice(4)}`;
export function sync(ctx, ip, { resetManualPlans = false } = {}) {
  requireFinance(ctx.user);
  const al = allocation();
  const uid = actorId(ctx);
  const cur = today().slice(0, 7);
  const now = new Date().toISOString();
  const stats = { pagos: 0, alterados: 0, removidos: 0, previstos: 0, manual: 0 };
  tx(() => {
    // Histórico: a tarefa passa a ter os meses desde o primeiro pagamento no Mais Controle
    const first = new Map();
    for (const g of al.real.values()) if (!first.has(g.o.id) || g.ym < first.get(g.o.id)) first.set(g.o.id, g.ym);
    for (const [oid, ym] of first) run('UPDATE finance_obligations SET mc_start = ? WHERE id = ? AND (mc_start IS NULL OR mc_start <> ?)', ym, oid, ym);
    const fresh = id => one('SELECT * FROM finance_obligations WHERE id = ?', id);
    // Realizado: soma do mês por tarefa (o Mais Controle manda; pagamento lançado à mão não é mexido)
    for (const g of al.real.values()) {
      const o = fresh(g.o.id);
      if (!monthsOf(o, g.ym).includes(g.ym)) continue;
      const it = ensureItemInternal(o, g.ym, uid);
      if (it.status === 'paga' && it.source !== SOURCE && r2(it.paid_amount) !== 0) { stats.manual++; continue; }
      if (it.status === 'paga' && it.source === SOURCE && r2(it.paid_amount) === g.amount) continue;
      const pd = g.paid_date > today() ? today() : g.paid_date;
      const wasPaid = it.status === 'paga';
      run(`UPDATE finance_items SET status = 'paga', paid_amount = ?, paid_date = ?, paid_by = ?, source = ?, estimated = 0, marked_paid_at = NULL, marked_amount = NULL WHERE id = ?`, g.amount, pd, uid, SOURCE, it.id);
      if (it.task_id) {
        if (!wasPaid) run(`UPDATE tasks SET status = 'concluida', cancelled_at = NULL, cancelled_by = NULL, cancel_reason = NULL, started_at = COALESCE(started_at, ?), delivered_at = ?, completed_at = ?, review_status = 'aprovada', reviewed_by = ?, reviewed_at = ?, progress_pct = 100, updated_at = ? WHERE id = ?`,
          now, `${pd}T15:00:00.000Z`, now, uid, now, now, it.task_id);
        taskHistory(it.task_id, uid, wasPaid ? 'Pagamento atualizado' : 'Pagamento registrado', `Mais Controle: ${brl(g.amount)} (${g.count} pagamento(s)) · pago em ${pd.split('-').reverse().join('/')}`);
      }
      if (wasPaid) stats.alterados++; else stats.pagos++;
    }
    // Pagamento que sumiu do Mais Controle (ex.: categoria corrigida para outra tarefa): parcela volta a pendente
    for (const it of all(`SELECT * FROM finance_items WHERE status = 'paga' AND source = ?`, SOURCE)) {
      if (al.real.has(`${it.obligation_id}|${it.ref_month}`)) continue;
      run(`UPDATE finance_items SET status = 'pendente', paid_amount = NULL, paid_date = NULL, paid_by = NULL, source = NULL WHERE id = ?`, it.id);
      if (it.task_id) {
        run(`UPDATE tasks SET status = 'aberta', delivered_at = NULL, completed_at = NULL, review_status = NULL, reviewed_by = NULL, reviewed_at = NULL, progress_pct = NULL, updated_at = ? WHERE id = ?`, now, it.task_id);
        taskHistory(it.task_id, uid, 'Pagamento retirado', 'O pagamento não aparece mais nesta categoria no Mais Controle');
      }
      stats.removidos++;
    }
    // Previsto: primeiro ano = o próprio realizado; demais anos = realizado do mesmo mês no ano anterior.
    // Ajuste manual (planejamento/planilha) fica por cima, a não ser que se peça para recalcular tudo.
    if (al.firstYear) {
      // Realizado = o que está pago na parcela (Mais Controle ou lançado à mão; "não ocorreu" = 0)
      const paidMap = new Map(all(`SELECT obligation_id, ref_month, paid_amount FROM finance_items WHERE status = 'paga'`).map(i => [`${i.obligation_id}|${i.ref_month}`, i.paid_amount || 0]));
      const realOf = (oid, ym) => paidMap.get(`${oid}|${ym}`) ?? al.real.get(`${oid}|${ym}`)?.amount ?? 0;
      const lastYm = `${cur.slice(0, 4)}-12`;
      for (const oid of new Set([...al.real.values()].map(g => g.o.id))) {
        const o = fresh(oid);
        if (resetManualPlans) run('DELETE FROM finance_plan WHERE obligation_id = ? AND auto = 0', oid);
        const manual = new Set(all('SELECT ref_month FROM finance_plan WHERE obligation_id = ? AND auto = 0', oid).map(r => r.ref_month));
        for (const ym of monthsOf(o, lastYm)) {
          if (ym < `${al.firstYear}-01` || manual.has(ym)) continue;
          const planned = Number(ym.slice(0, 4)) === al.firstYear ? realOf(oid, ym) : realOf(oid, prevYm(ym));
          const it = one('SELECT * FROM finance_items WHERE obligation_id = ? AND ref_month = ?', oid, ym);
          if (it) {
            if (r2(it.amount_expected) === r2(planned)) continue;
            run('UPDATE finance_items SET amount_expected = ?, estimated = 0 WHERE id = ?', r2(planned), it.id);
            if (it.task_id && it.status !== 'paga') syncZero(it.task_id, r2(planned), uid);
          } else {
            run(`INSERT INTO finance_plan (obligation_id, ref_month, amount, updated_by, auto) VALUES (?,?,?,?,1)
              ON CONFLICT(obligation_id, ref_month) DO UPDATE SET amount = excluded.amount, auto = 1, updated_at = datetime('now') WHERE finance_plan.auto = 1`, oid, ym, r2(planned), uid);
          }
          stats.previstos++;
        }
      }
    }
    audit(uid, 'finance', null, 'Sincronização com o Mais Controle', { ...stats, recalculou_previsto: resetManualPlans || undefined }, ip);
  });
  return stats;
}

// ---------- Contas da semana (lembretes) + alertas do Mais Controle ----------
export function financeWeek(ctx) {
  requireFinance(ctx.user);
  const ref = today();
  const d = new Date(`${ref}T12:00:00Z`);
  const end = new Date(d.getTime() + ((7 - d.getUTCDay()) % 7) * 86400e3).toISOString().slice(0, 10); // domingo
  // Alertas só do mês passado em diante (meses mais antigos são histórico: o Mais Controle é que vale)
  const [yy, mm] = ref.slice(0, 7).split('-').map(Number);
  const from = `${mm === 1 ? yy - 1 : yy}-${String(mm === 1 ? 12 : mm - 1).padStart(2, '0')}-01`;
  const cov = coverage();
  const items = all(`SELECT i.id, i.obligation_id, i.ref_month, i.due_date, i.amount_expected, i.marked_paid_at, i.marked_amount, i.justify_kind, i.justify_reason, o.title, o.category
    FROM finance_items i JOIN finance_obligations o ON o.id = i.obligation_id
    WHERE i.status = 'pendente' AND i.amount_expected > 0 AND o.active = 1 AND i.due_date BETWEEN ? AND ? ORDER BY i.due_date, o.title`, from, end)
    .map(i => {
      const days = Math.round((Date.parse(i.due_date) - Date.parse(ref)) / 86400e3);
      const state = i.marked_paid_at ? markState(i, cov) : cov && cov.data_until >= i.due_date ? 'justificar' : days < 0 ? 'atrasada' : days === 0 ? 'hoje' : 'a_pagar';
      return { ...i, days, state };
    });
  let alerts = { accounts: [], categories: [], reviews: 0 };
  try {
    const pv = preview(ctx);
    alerts = {
      accounts: pv.accounts.filter(a => !a.active && a.count).map(a => ({ label: a.label, count: a.count, total: a.total, categories: a.categories.slice(0, 4) })),
      categories: pv.categories.map(c => ({ label: c.label, count: c.count, total: c.total })),
      reviews: pv.reviews.length,
    };
  } catch { /* sem dados ainda */ }
  return { today: ref, week_end: end, data_until: cov?.data_until || null, items, alerts };
}

// Compatibilidade com o "Desfazer última importação" (a sincronização é refeita a partir do Mais Controle; nada a desfazer)
export const undoBatch = () => {};
export const somaItems = () => [];
export const batchExtCount = () => 0;
