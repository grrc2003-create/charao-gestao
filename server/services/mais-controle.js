// Tarefas financeiras › Mais Controle (API para Relatórios, rotina "pagamentos", CSV com login e senha da API).
// Toda semana os pagamentos são buscados e lançados:
//  - só de contas bancárias cadastradas (custo em outra conta vira alerta: cadastre a conta para trazer);
//  - centro de custo Empresa → real da tarefa financeira vinculada à categoria (categoria sem tarefa vira alerta);
//  - demais centros de custo → "Custos destinados a Projetos" (uma linha por centro de custo, total do mês).
// Depois de cada busca o sistema confere o "Paguei" (não achou → alerta) e pede justificativa da despesa prevista que
// venceu sem pagamento. Credenciais só nas variáveis de ambiente do servidor (MAISCONTROLE_USUARIO / MAISCONTROLE_SENHA).
import crypto from 'node:crypto';
import { all, one, run, tx } from '../db.js';
import { badRequest, notFound, str, intOrNull } from '../lib/http.js';
import { readXlsxSheets, serialToDate } from '../lib/xlsx.js';
import { audit, taskHistory } from './audit.js';
import { today } from './metrics.js';
import { requireFinance, monthsOf, ensureItem, payItem, coverage, markState } from './finance.js';

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
// Lote/ações na auditoria: as mesmas da importação de planilha, para o "Desfazer última importação" valer aqui também
export const BATCH = 'Tarefas financeiras importadas de planilha', PAY = 'Pagamento importado de planilha', SOMA = 'Pagamento somado (Mais Controle)';

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
// Chave do pagamento (o Mais Controle não traz um id fixo): dados do pagamento + ordem entre pagamentos idênticos
function withKeys(pays) {
  const seen = new Map();
  return pays.map(p => {
    const base = crypto.createHash('sha1').update([p.due, p.paid, p.amount, hkey(p.supplier), hkey(p.desc), hkey(p.category)].join('|')).digest('hex').slice(0, 24);
    const n = (seen.get(base) || 0) + 1; seen.set(base, n);
    return { ...p, key: `${base}#${n}` };
  });
}
const actorId = ctx => ctx.user?.id || null;
function saveFetch(ctx, origin, fileName, pays) {
  // Até que dia os dados valem: a API (plano semanal) traz a foto do domingo; o arquivo exportado vale até hoje
  const until = origin === 'arquivo' ? today() : new Date(Date.parse(today()) - 86400e3).toISOString().slice(0, 10);
  const id = Number(run('INSERT INTO ext_fetches (source, origin, file_name, rows_json, row_count, data_until, fetched_by) VALUES (?,?,?,?,?,?,?)',
    SOURCE, origin, fileName, JSON.stringify(pays), pays.length, until, actorId(ctx)).lastInsertRowid);
  audit(actorId(ctx), 'finance', null, origin === 'arquivo' ? 'Pagamentos do Mais Controle enviados por arquivo' : 'Pagamentos buscados no Mais Controle (API)', { arquivo: fileName, pagamentos: pays.length }, null);
  return id;
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
  return {
    configured: configured(), plan: plan(), next_allowed: nextAllowed(), last_fetch: f || null, auto: process.env.MAISCONTROLE_AUTO !== '0',
    synced: one('SELECT COUNT(*) AS n, MAX(created_at) AS at FROM ext_payments WHERE source = ?', SOURCE),
  };
}

// ---------- Buscar ----------
async function callApi() {
  let res;
  try {
    res = await fetch(API_URL(), {
      headers: { Authorization: `Basic ${Buffer.from(`${process.env.MAISCONTROLE_USUARIO}:${process.env.MAISCONTROLE_SENHA}`).toString('base64')}`, Accept: 'text/csv' },
      signal: AbortSignal.timeout(60000),
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
    try { return apply(ctx, null); } catch { return null; } // nada novo para lançar
  } catch (e) {
    audit(null, 'finance', null, 'Falha na sincronização automática com o Mais Controle', { erro: e.message }, null);
    return null;
  } finally { autoRunning = false; }
}

// ---------- Cadastros: contas bancárias e vínculo categoria → tarefa ----------
export function setAccount(ctx, body) {
  requireFinance(ctx.user);
  const key = hkey(body.key ?? body.label), label = str(body.label, { max: 160, label: 'Conta' }) || '(sem conta)';
  run(`INSERT INTO ext_accounts (source, ext_key, label, active, updated_by) VALUES (?,?,?,?,?)
    ON CONFLICT(source, ext_key) DO UPDATE SET label = excluded.label, active = excluded.active, updated_by = excluded.updated_by, updated_at = datetime('now')`,
    SOURCE, key, label, body.active ? 1 : 0, ctx.user.id);
  audit(ctx.user.id, 'finance', null, body.active ? 'Conta bancária do Mais Controle cadastrada' : 'Conta bancária do Mais Controle desativada', { conta: label }, null);
  return { ok: true };
}
export function setMapping(ctx, body) {
  requireFinance(ctx.user);
  const key = body.key !== undefined ? hkey(body.key) : hkey(body.category), label = str(body.label || body.category, { max: 160, label: 'Categoria' }) || '(sem categoria)';
  const oid = intOrNull(body.obligation_id), ignored = body.ignored ? 1 : 0;
  if (oid && !one('SELECT id FROM finance_obligations WHERE id = ?', oid)) throw notFound('Tarefa financeira não encontrada.');
  if (!oid && !ignored) { run('DELETE FROM ext_category_map WHERE source = ? AND ext_category = ?', SOURCE, key); return { ok: true }; }
  run(`INSERT INTO ext_category_map (source, ext_category, label, obligation_id, ignored, updated_by) VALUES (?,?,?,?,?,?)
    ON CONFLICT(source, ext_category) DO UPDATE SET label = excluded.label, obligation_id = excluded.obligation_id, ignored = excluded.ignored, updated_by = excluded.updated_by, updated_at = datetime('now')`,
    SOURCE, key, label, ignored ? null : oid, ignored, ctx.user.id);
  return { ok: true };
}
function suggest(label, obs) {
  const k = hkey(label);
  if (!k) return null;
  return obs.find(o => hkey(o.title) === k) || obs.find(o => k.length >= 4 && (hkey(o.title).startsWith(k) || k.startsWith(hkey(o.title)))) || null;
}

// ---------- Prévia ----------
export function preview(ctx) {
  requireFinance(ctx.user);
  const f = one('SELECT * FROM ext_fetches WHERE source = ? ORDER BY id DESC LIMIT 1', SOURCE);
  const accRows = all('SELECT * FROM ext_accounts WHERE source = ? ORDER BY label', SOURCE);
  if (!f) return { fetch: null, accounts: accRows.map(a => ({ key: a.ext_key, label: a.label, active: !!a.active, count: 0, total: 0 })), categories: [], groups: [], projects: [], totals: null };
  const pays = withKeys(JSON.parse(f.rows_json));
  const done = new Set(all('SELECT ext_key FROM ext_payments WHERE source = ?', SOURCE).map(r => r.ext_key));
  const obs = all('SELECT * FROM finance_obligations ORDER BY active DESC, title');
  const byId = new Map(obs.map(o => [o.id, o]));
  const maps = new Map(all('SELECT * FROM ext_category_map WHERE source = ?', SOURCE).map(m => [m.ext_category, m]));
  const accs = new Map(accRows.map(a => [a.ext_key, a]));
  const syncedItems = new Set(all('SELECT DISTINCT item_id FROM ext_payments WHERE source = ? AND item_id IS NOT NULL', SOURCE).map(r => r.item_id));
  const cur = today();
  const accounts = new Map(), cats = new Map(), groups = new Map(), projects = new Map();
  let already = 0, unpaid = 0, ignoredN = 0, otherAccount = 0, otherAccountTotal = 0;
  for (const p of pays) {
    if (!p.paid || !p.amount || p.amount <= 0) { unpaid++; continue; }
    const ak = hkey(p.account);
    if (!accounts.has(ak)) accounts.set(ak, { key: ak, label: p.account || '(sem conta)', count: 0, total: 0, categories: new Map() });
    if (done.has(p.key)) { already++; continue; }
    const acc = accounts.get(ak);
    acc.count++; acc.total = r2(acc.total + p.amount);
    if (!accs.get(ak)?.active) {
      // Conta não cadastrada: só alerta (o custo fica de fora)
      otherAccount++; otherAccountTotal = r2(otherAccountTotal + p.amount);
      const ck = p.category || '(sem categoria)';
      acc.categories.set(ck, r2((acc.categories.get(ck) || 0) + p.amount));
      continue;
    }
    const ym = (p.due || p.paid).slice(0, 7);
    if (!isEmpresa(p.cost_center)) {
      const pk = `${hkey(p.cost_center)}|${ym}`;
      if (!projects.has(pk)) projects.set(pk, { cost_center: p.cost_center, ym, amount: 0, count: 0, keys: [], rows: [] });
      const g = projects.get(pk); g.amount = r2(g.amount + p.amount); g.count++; g.keys.push(p.key); g.rows.push(p);
      continue;
    }
    const ck = hkey(p.category);
    if (!cats.has(ck)) cats.set(ck, { key: ck, label: p.category || '(sem categoria)', count: 0, total: 0 });
    const c = cats.get(ck); c.count++; c.total = r2(c.total + p.amount);
    const m = maps.get(ck);
    if (m?.ignored) { ignoredN++; continue; }
    const o = m?.obligation_id && byId.get(m.obligation_id);
    if (!o) continue;
    const gk = `${o.id}|${ym}`;
    if (!groups.has(gk)) groups.set(gk, { obligation_id: o.id, title: o.title, ym, amount: 0, count: 0, paid_date: null, keys: [], categories: new Set(), rows: [] });
    const g = groups.get(gk);
    g.amount = r2(g.amount + p.amount); g.count++; g.keys.push(p.key); g.categories.add(p.category); g.rows.push(p);
    if (!g.paid_date || p.paid > g.paid_date) g.paid_date = p.paid;
  }
  const outGroups = [...groups.values()].map(g => {
    const o = byId.get(g.obligation_id);
    const it = one('SELECT id, status, paid_amount, marked_paid_at FROM finance_items WHERE obligation_id = ? AND ref_month = ?', o.id, g.ym);
    let st = 'ok', note = it?.marked_paid_at && it.status !== 'paga' ? 'confirma o "Paguei"' : null;
    if (!monthsOf(o, g.ym).includes(g.ym)) { st = 'erro'; note = 'a tarefa não vence neste mês (ajuste o início/término ou o vínculo)'; }
    else if (it?.status === 'paga' && syncedItems.has(it.id)) { st = 'soma'; note = `soma ao já lançado pelo Mais Controle (${brl(it.paid_amount)})`; }
    else if (it?.status === 'paga') { st = 'conflito'; note = `já tem pagamento lançado à mão (${brl(it.paid_amount)}): não muda`; }
    return { ...g, categories: [...g.categories], paid_date: g.paid_date > cur ? cur : g.paid_date, status: st, note };
  }).sort((a, b) => a.title.localeCompare(b.title, 'pt-BR') || a.ym.localeCompare(b.ym));
  const categories = [...cats.values()].map(c => {
    const m = maps.get(c.key);
    const o = m?.obligation_id && byId.get(m.obligation_id);
    const s = !m ? suggest(c.label, obs.filter(x => x.active)) : null;
    return { ...c, obligation_id: o ? o.id : null, obligation_title: o ? o.title : null, ignored: !!m?.ignored, suggestion: s ? { id: s.id, title: s.title } : null };
  }).sort((a, b) => (a.obligation_id || a.ignored ? 1 : 0) - (b.obligation_id || b.ignored ? 1 : 0) || b.total - a.total);
  const accountList = [...new Map([...accRows.map(a => [a.ext_key, { key: a.ext_key, label: a.label, count: 0, total: 0, categories: [] }]), ...[...accounts.values()].map(a => [a.key, { ...a, categories: [...a.categories].map(([label, total]) => ({ label, total })).sort((x, y) => y.total - x.total) }])]).values()]
    .map(a => ({ ...a, active: !!accs.get(a.key)?.active })).sort((a, b) => Number(b.active) - Number(a.active) || b.total - a.total);
  const ready = outGroups.filter(g => g.status === 'ok' || g.status === 'soma');
  const projList = [...projects.values()].sort((a, b) => a.cost_center.localeCompare(b.cost_center, 'pt-BR') || a.ym.localeCompare(b.ym));
  return {
    fetch: { id: f.id, origin: f.origin, file_name: f.file_name, fetched_at: f.fetched_at, rows: f.row_count, data_until: f.data_until },
    accounts: accountList, categories, groups: outGroups.map(({ rows, ...g }) => g), projects: projList.map(({ rows, ...g }) => g),
    obligations: obs.map(o => ({ id: o.id, title: o.title, category: o.category, active: !!o.active })),
    totals: {
      payments: pays.length, already, unpaid, ignored: ignoredN, other_account: otherAccount, other_account_total: otherAccountTotal,
      unmapped: categories.filter(c => !c.obligation_id && !c.ignored).reduce((s, c) => s + c.count, 0),
      ready_months: ready.length, ready_payments: ready.reduce((s, g) => s + g.count, 0), ready_total: r2(ready.reduce((s, g) => s + g.amount, 0)),
      projects: projList.reduce((s, g) => s + g.count, 0), projects_total: r2(projList.reduce((s, g) => s + g.amount, 0)),
      conflicts: outGroups.filter(g => g.status === 'conflito').length, errors: outGroups.filter(g => g.status === 'erro').length,
    },
    _groups: outGroups, _projects: projList,
  };
}

// ---------- Lançar ----------
export function apply(ctx, ip) {
  const pv = preview(ctx);
  if (!pv.fetch) throw badRequest('Busque os pagamentos primeiro.');
  const todo = pv._groups.filter(g => g.status === 'ok' || g.status === 'soma');
  if (!todo.length && !pv._projects.length) throw badRequest('Nada para lançar: cadastre as contas bancárias e vincule as categorias às tarefas financeiras.');
  let paid = 0, total = 0;
  const uid = actorId(ctx);
  tx(() => {
    const rows = [];
    for (const g of todo) {
      const it = ensureItem(ctx, g.obligation_id, g.ym);
      if (g.status === 'ok' && it.status !== 'paga') {
        payItem(ctx, it.id, { paid_date: g.paid_date, paid_amount: g.amount, notes: `Mais Controle: ${g.count} pagamento(s) · ${g.categories.join(', ')}` }, ip);
        audit(uid, 'finance', it.id, PAY, { parcela: `${g.title} ${g.ym}`, valor: g.amount, origem: 'Mais Controle' }, ip);
      } else {
        const now = one('SELECT * FROM finance_items WHERE id = ?', it.id);
        const novo = r2((now.paid_amount || 0) + g.amount);
        run('UPDATE finance_items SET paid_amount = ?, paid_date = MAX(COALESCE(paid_date, ?), ?) WHERE id = ?', novo, g.paid_date, g.paid_date, it.id);
        if (now.task_id) taskHistory(now.task_id, uid, 'Pagamento atualizado', `Mais Controle: + ${brl(g.amount)} (${g.count} pagamento(s)) → total ${brl(novo)}`);
        audit(uid, 'finance', it.id, SOMA, { parcela: `${g.title} ${g.ym}`, somado: g.amount, antes: now.paid_amount }, ip);
      }
      for (const p of g.rows) rows.push({ p, kind: 'empresa', obligation_id: g.obligation_id, item_id: it.id, ym: g.ym });
      paid += g.count; total = r2(total + g.amount);
    }
    for (const g of pv._projects) for (const p of g.rows) rows.push({ p, kind: 'projeto', obligation_id: null, item_id: null, ym: g.ym });
    const proj = pv._projects.reduce((s, g) => s + g.count, 0), projTotal = r2(pv._projects.reduce((s, g) => s + g.amount, 0));
    const batch = Number(run('INSERT INTO audit_log (actor_id, entity, entity_id, action, details, ip, created_at) VALUES (?,?,?,?,?,?,?)',
      uid, 'finance', null, BATCH, JSON.stringify({ arquivo: `Mais Controle · ${pv.fetch.file_name || 'pagamentos'}`, importadas: 0, pagamentos: paid, valor_pago: total, custos_projetos: proj, valor_projetos: projTotal }), ip, new Date().toISOString()).lastInsertRowid);
    for (const r of rows) {
      run('INSERT OR IGNORE INTO ext_payments (source, ext_key, kind, obligation_id, item_id, cost_center, account, ref_month, paid_date, amount, category, fetch_id, batch_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
        SOURCE, r.p.key, r.kind, r.obligation_id, r.item_id, r.p.cost_center || 'Empresa', r.p.account, r.ym, r.p.paid, r.p.amount, r.p.category, pv.fetch.id, batch);
    }
  });
  return { months: todo.length, payments: paid, total, projects: pv._projects.reduce((s, g) => s + g.count, 0) };
}

// Desfazer (chamado pelo "Desfazer última importação"): tira as somas e libera os pagamentos para nova sincronização
export function undoBatch(ctx, batchId, ip, { unpaidIds = new Set() } = {}) {
  const prev = one(`SELECT MAX(id) AS id FROM audit_log WHERE entity = 'finance' AND action = ? AND id < ?`, BATCH, batchId)?.id || 0;
  for (const a of all(`SELECT entity_id, details FROM audit_log WHERE entity = 'finance' AND action = ? AND id > ? AND id < ?`, SOMA, prev, batchId)) {
    let d; try { d = JSON.parse(a.details); } catch { continue; }
    if (unpaidIds.has(a.entity_id)) continue;
    run('UPDATE finance_items SET paid_amount = ? WHERE id = ? AND status = ?', d.antes, a.entity_id, 'paga');
  }
  run('DELETE FROM ext_payments WHERE source = ? AND batch_id = ?', SOURCE, batchId);
}
export const somaItems = (prev, batchId) => all(`SELECT entity_id FROM audit_log WHERE entity = 'finance' AND action = ? AND id > ? AND id < ?`, SOMA, prev, batchId).map(r => r.entity_id);
export const batchExtCount = batchId => one('SELECT COUNT(*) AS n FROM ext_payments WHERE source = ? AND batch_id = ?', SOURCE, batchId).n;

// ---------- Contas da semana (lembretes) + alertas do Mais Controle ----------
export function financeWeek(ctx) {
  requireFinance(ctx.user);
  const ref = today();
  const d = new Date(`${ref}T12:00:00Z`);
  const end = new Date(d.getTime() + ((7 - d.getUTCDay()) % 7) * 86400e3).toISOString().slice(0, 10); // domingo
  const cov = coverage();
  const items = all(`SELECT i.id, i.obligation_id, i.ref_month, i.due_date, i.amount_expected, i.marked_paid_at, i.marked_amount, i.justify_kind, i.justify_reason, o.title, o.category
    FROM finance_items i JOIN finance_obligations o ON o.id = i.obligation_id
    WHERE i.status = 'pendente' AND i.amount_expected > 0 AND o.active = 1 AND i.due_date <= ? ORDER BY i.due_date, o.title`, end)
    .map(i => {
      const days = Math.round((Date.parse(i.due_date) - Date.parse(ref)) / 86400e3);
      const state = i.marked_paid_at ? markState(i, cov) : cov && cov.data_until >= i.due_date ? 'justificar' : days < 0 ? 'atrasada' : days === 0 ? 'hoje' : 'a_pagar';
      return { ...i, days, state };
    });
  let alerts = { accounts: [], categories: [] };
  try {
    const pv = preview(ctx);
    alerts = {
      accounts: pv.accounts.filter(a => !a.active && a.count).map(a => ({ label: a.label, count: a.count, total: a.total, categories: a.categories.slice(0, 4) })),
      categories: pv.categories.filter(c => !c.obligation_id && !c.ignored).map(c => ({ label: c.label, count: c.count, total: c.total })),
    };
  } catch { /* sem busca ainda */ }
  return { today: ref, week_end: end, data_until: cov?.data_until || null, items, alerts };
}
