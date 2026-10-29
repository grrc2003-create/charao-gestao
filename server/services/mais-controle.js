// Financeiro › Mais Controle (API para Relatórios, rotina "pagamentos", CSV com login e senha da API).
// O Mais Controle é a fonte do realizado: cada busca guarda a foto dos pagamentos (2024 em diante) e a sincronização
// recalcula o realizado de cada tarefa e mês — correções feitas lá se refletem sozinhas:
//  - só contas bancárias cadastradas (custo em outra conta vira alerta: cadastre a conta para trazer);
//  - centro de custo Empresa → tarefa financeira de mesmo nome da categoria (a tarefa É a categoria; sem tarefa vira alerta);
//  - demais centros de custo → "Custos de Projetos pagos pela Empresa" (uma linha por centro de custo, total do mês);
//  - previsto: primeiro ano = o próprio realizado; demais anos = realizado do mesmo mês no ano anterior;
//  - conferência de alocação: despesa do mês numa categoria diferente da habitual do fornecedor (OK / errado).
// Toda semana (segunda, 8h) busca e sincroniza sozinho. Credenciais só nas variáveis de ambiente do servidor.
import crypto from 'node:crypto';
import { all, one, run, tx } from '../db.js';
import { badRequest, notFound, str, intOrNull, date } from '../lib/http.js';
import { usersWithProjectAccess } from '../lib/permissions.js';
import { insertTask, validateAssignee } from './tasks.js';
import { readXlsxSheets, serialToDate } from '../lib/xlsx.js';
import { audit, taskHistory } from './audit.js';
import { today } from './metrics.js';
import { requireFinance, monthsOf, ensureItemInternal, coverage, markState, syncZero, controlStart } from './finance.js';

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
// Dois formatos: a API ("data_vencimento", "valor_pago", "id_lancamento"…) e o arquivo exportado da tela
// ("Data de Vencimento", "Valor Total Pago"…). Os nomes são comparados sem acento, espaço ou "_".
const COLS = {
  due: ['datadevencimento', 'datavencimento'], paid: ['datadepagamento', 'datapagamento'],
  total: ['valortotalpago'], paidPart: ['valorpagodaparcela', 'valorpago'], fees: ['jurosmultas', 'valorjurosemulta'], discount: ['descontos', 'valordesconto'],
  category: ['categoria'], supplier: ['fornecedor'], desc: ['descricao'], costCenter: ['centrodecusto'], account: ['contabancaria'], payer: ['quempaga'], plan: ['planodecontas', 'planodeconta'],
  id: ['idlancamento'], installment: ['numeroparcela'],
};
function toPayments(grid) {
  const hi = grid.findIndex(r => r.some(v => COLS.due.includes(hkey(v))) && r.some(v => hkey(v) === 'categoria'));
  if (hi < 0) {
    const first = (grid.find(r => r.some(v => String(v ?? '').trim())) || []).filter(v => String(v ?? '').trim()).slice(0, 12).join(', ');
    throw badRequest(`Não reconheci o formato de Pagamentos do Mais Controle (faltam as colunas de vencimento e categoria).${first ? ` Colunas recebidas: ${first}.` : ''}`);
  }
  const H = grid[hi].map(hkey);
  const at = (r, ks) => { for (const k of ks) { const i = H.indexOf(k); if (i >= 0 && r[i] !== null && r[i] !== undefined && String(r[i]).trim() !== '') return r[i]; } return null; };
  const out = [];
  for (const r of grid.slice(hi + 1)) {
    const due = dateOf(at(r, COLS.due)), paid = dateOf(at(r, COLS.paid));
    if (!due && !paid) continue;
    // Valor pago: o total pago (com juros/multa e descontos); na API vem separado (valor pago + juros − desconto)
    let amount = numOf(at(r, COLS.total));
    if (amount === null) {
      const part = numOf(at(r, COLS.paidPart));
      amount = part === null ? null : part + (numOf(at(r, COLS.fees)) || 0) - (numOf(at(r, COLS.discount)) || 0);
    }
    const id = String(at(r, COLS.id) ?? '').trim();
    out.push({
      id: id ? `${id}:${String(at(r, COLS.installment) ?? '1').trim()}` : null,
      due, paid, amount: amount === null ? null : r2(amount),
      category: String(at(r, COLS.category) ?? '').trim(), supplier: String(at(r, COLS.supplier) ?? '').trim(),
      desc: String(at(r, COLS.desc) ?? '').trim().slice(0, 200),
      cost_center: String(at(r, COLS.costCenter) ?? '').trim(), account: String(at(r, COLS.account) ?? '').trim(), payer: String(at(r, COLS.payer) ?? '').trim(),
      plan: String(at(r, COLS.plan) ?? '').trim(),
    });
  }
  return out;
}
// Chave do pagamento (o Mais Controle não traz um id fixo): vencimento, pagamento, valor, fornecedor e descrição +
// ordem entre pagamentos idênticos. A categoria fica de fora: corrigida no Mais Controle, é o mesmo pagamento.
function withKeys(pays) {
  const seen = new Map();
  return pays.map(p => {
    if (p.id) return { ...p, key: `id:${p.id}` }; // API: identificador do lançamento + parcela (fixo)
    const base = crypto.createHash('sha1').update([p.due, p.paid, p.amount, hkey(p.supplier), hkey(p.desc)].join('|')).digest('hex').slice(0, 24);
    const n = (seen.get(base) || 0) + 1; seen.set(base, n);
    return { ...p, key: `${base}#${n}` };
  });
}
const actorId = ctx => ctx.user?.id || null;

// Busca guardada + foto atual dos pagamentos. API (completa): substitui a foto inteira. Arquivo exportado: substitui só
// os meses que o arquivo cobre (o resto do histórico fica).
function saveFetch(ctx, origin, fileName, pays, raw = null) {
  const until = origin === 'arquivo' ? today() : new Date(Date.parse(today()) - 86400e3).toISOString().slice(0, 10);
  return tx(() => {
    const id = Number(run('INSERT INTO ext_fetches (source, origin, file_name, rows_json, row_count, data_until, fetched_by, raw) VALUES (?,?,?,?,?,?,?,?)',
      SOURCE, origin, fileName, JSON.stringify(pays), pays.length, until, actorId(ctx), raw).lastInsertRowid);
    const rows = withKeys(pays).map(p => ({ ...p, ym: (p.due || p.paid).slice(0, 7) }));
    if (origin === 'arquivo') {
      const ms = rows.map(r => r.ym).sort();
      if (ms.length) run('DELETE FROM ext_payments WHERE source = ? AND ref_month BETWEEN ? AND ?', SOURCE, ms[0], ms.at(-1));
    } else run('DELETE FROM ext_payments WHERE source = ?', SOURCE);
    for (const p of rows) {
      run(`INSERT OR REPLACE INTO ext_payments (source, ext_key, due_date, paid_date, ref_month, amount, category, supplier, supplier_key, description, account, account_key, cost_center, fetch_id, payer, plan_account)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, SOURCE, p.key, p.due, p.paid, p.ym, p.amount ?? 0, p.category, p.supplier, hkey(p.supplier), p.desc, p.account, hkey(p.account), p.cost_center || 'Empresa', id, p.payer || null, p.plan || null);
    }
    refreshAccounts();
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
  const f = one('SELECT id, origin, file_name, row_count, data_until, fetched_at FROM ext_fetches WHERE source = ? AND row_count > 0 ORDER BY id DESC LIMIT 1', SOURCE);
  const span = one(`SELECT COUNT(*) AS n, MIN(ref_month) AS desde, MAX(ref_month) AS ate FROM ext_payments WHERE source = ?`, SOURCE);
  const pending = one(`SELECT id, fetched_at, error FROM ext_fetches WHERE source = ? AND origin IN ('api', 'auto') AND row_count = 0 AND raw IS NOT NULL ORDER BY id DESC LIMIT 1`, SOURCE);
  return { configured: configured(), plan: plan(), next_allowed: nextAllowed(), last_fetch: f || null, auto: process.env.MAISCONTROLE_AUTO !== '0', snapshot: span, pending: pending || null };
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
  return res.text();
}
// Resposta da API guardada antes de ler: se a leitura falhar, fica registrada (conta na cota) e pode ser reprocessada
function storeRaw(ctx, origin, raw) {
  return Number(run(`INSERT INTO ext_fetches (source, origin, file_name, rows_json, row_count, raw, fetched_by) VALUES (?,?,?,'[]',0,?,?)`,
    SOURCE, origin, origin === 'auto' ? 'API · pagamentos (automático)' : 'API · pagamentos', raw, actorId(ctx)).lastInsertRowid);
}
function parseRaw(ctx, fetchId) {
  const f = one('SELECT * FROM ext_fetches WHERE id = ?', fetchId);
  let pays;
  try { pays = toPayments(parseCsv(f.raw || '')); }
  catch (e) {
    run('UPDATE ext_fetches SET error = ? WHERE id = ?', e.message, fetchId);
    const head = String(f.raw || '').replace(/^\uFEFF/, '').split(/\r?\n/, 1)[0].slice(0, 400);
    console.warn(`[mais-controle] formato não reconhecido; cabeçalho recebido: ${head}`);
    throw e;
  }
  run('DELETE FROM ext_fetches WHERE id = ?', fetchId); // vira a busca definitiva (com a foto) logo abaixo
  return saveFetch(ctx, f.origin, f.file_name, pays, f.raw);
}
// Última resposta da API que não foi lida (ex.: formato mudou) — reprocessa sem nova consulta
export function reprocess(ctx) {
  requireFinance(ctx.user);
  const f = one(`SELECT * FROM ext_fetches WHERE source = ? AND origin IN ('api', 'auto') AND row_count = 0 AND raw IS NOT NULL ORDER BY id DESC LIMIT 1`, SOURCE);
  if (!f) throw notFound('Não há resposta da API pendente de leitura.');
  const id = parseRaw(ctx, f.id);
  return { fetch_id: id, rows: one('SELECT row_count FROM ext_fetches WHERE id = ?', id).row_count };
}
export async function fetchFromApi(ctx) {
  requireFinance(ctx.user);
  if (!configured()) throw badRequest('Integração não configurada: cadastre MAISCONTROLE_USUARIO e MAISCONTROLE_SENHA nas variáveis de ambiente do servidor.');
  const na = nextAllowed();
  if (na) throw badRequest(`Pelo plano ${plan()} da API, a próxima busca fica liberada em ${new Date(na).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}. Use a última busca ou envie o arquivo exportado.`);
  const id = parseRaw(ctx, storeRaw(ctx, 'api', await callApi()));
  return { fetch_id: id, rows: one('SELECT row_count FROM ext_fetches WHERE id = ?', id).row_count };
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
    parseRaw(ctx, storeRaw(ctx, 'auto', await callApi()));
    return sync(ctx, null);
  } catch (e) {
    audit(null, 'finance', null, 'Falha na sincronização automática com o Mais Controle', { erro: e.message }, null);
    return null;
  } finally { autoRunning = false; }
}

// ---------- Tarefa de ajuste no Mais Controle: projeto interno INT-001, classificação "Mais Controle" ----------
const ADJ_STAGE = 'Mais Controle';
const internalProject = () => one(`SELECT * FROM projects WHERE code = 'INT-001'`) || one(`SELECT * FROM projects WHERE kind = 'interno' AND COALESCE(restricted, 0) = 0 ORDER BY id LIMIT 1`);
const dmyOf = d => String(d || '').split('-').reverse().join('/');
export function adjustInfo(ctx) {
  requireFinance(ctx.user);
  const p = internalProject();
  if (!p) return { project: null, assignees: [] };
  return { project: { id: p.id, code: p.code, name: p.name }, stage: ADJ_STAGE,
    assignees: usersWithProjectAccess(p.id).map(u => ({ id: u.id, name: u.name, job_title: u.job_title, is_external: !!u.is_external, company: u.company })) };
}
// Cria a tarefa (dentro da transação de quem chama); sem pedido de tarefa, devolve null
function adjustTask(ctx, t, title, description) {
  if (!t) return null;
  const p = internalProject();
  if (!p) throw badRequest('Projeto interno INT-001 não encontrado para criar a tarefa.');
  const due = date(t.due_date, 'Prazo');
  if (!due) throw badRequest('Informe até que dia o ajuste deve ser feito.');
  const assignee = validateAssignee(intOrNull(t.assignee_id), p.id);
  if (!assignee) throw badRequest('Escolha quem vai fazer o ajuste no Mais Controle.');
  let stage = one('SELECT id FROM project_stages WHERE project_id = ? AND name = ? COLLATE NOCASE', p.id, ADJ_STAGE)?.id;
  if (!stage) {
    const n = one('SELECT COALESCE(MAX(sort_order), 0) AS n FROM project_stages WHERE project_id = ?', p.id).n;
    stage = Number(run('INSERT INTO project_stages (project_id, name, sort_order) VALUES (?,?,?)', p.id, ADJ_STAGE, n + 1).lastInsertRowid);
  }
  const notes = str(t.notes, { max: 1000, label: 'Observação' });
  const start = today() <= due ? today() : due;
  const id = insertTask({ project: p, stageInput: stage, creatorId: ctx.user.id, ctx,
    data: { task_type: 'tarefa', title: title.slice(0, 200), description: [description, notes ? `Observação: ${notes}` : ''].filter(Boolean).join('\n'),
      field_summary: null, notes: null, due_date: due, start_date: start, priority: 'media', proof_type: 'nenhuma', assignee_id: assignee } });
  audit(ctx.user.id, 'finance', null, 'Mais Controle: tarefa de ajuste criada', { tarefa: one('SELECT code FROM tasks WHERE id = ?', id)?.code, titulo: title }, null);
  return id;
}
// ---------- Solicitar alteração de um lançamento (tarefa para alterar no Mais Controle) ----------
export const CHANGE_WHAT = { conta: 'Conta bancária', centro_custo: 'Centro de custo / obra', categoria: 'Categoria', valor_data: 'Valor ou data', fornecedor: 'Fornecedor ou descrição', outro: 'Outro' };
function lastRequests() {
  const m = new Map();
  try { for (const r of all('SELECT * FROM ext_change_requests WHERE source = ? ORDER BY id', SOURCE)) m.set(r.ext_key, r); } catch { /* antes da migração */ }
  return m;
}
const requestOf = (reqs, key) => { const r = reqs.get(key); return r ? { what: CHANGE_WHAT[r.what] || r.what, details: r.details, created_at: r.created_at, task: taskInfo(r.task_id) } : null; };
export function requestChange(ctx, body, ip) {
  requireFinance(ctx.user);
  const p = one('SELECT * FROM ext_payments WHERE source = ? AND ext_key = ?', SOURCE, String(body.key || ''));
  if (!p) throw notFound('Lançamento não encontrado na última atualização do Mais Controle.');
  const what = Object.hasOwn(CHANGE_WHAT, body.what) ? body.what : null;
  if (!what) throw badRequest('Escolha o que deve ser alterado.');
  const details = str(body.details, { max: 1000, required: true, label: 'Como deve ficar' });
  if (details.length < 5) throw badRequest('Descreva como o lançamento deve ficar.');
  if (!body.task) throw badRequest('Escolha quem vai alterar e até que dia.');
  const taskId = tx(() => {
    const id = adjustTask(ctx, body.task, `Alterar no Mais Controle: ${CHANGE_WHAT[what].toLowerCase()} · ${p.supplier || '(sem fornecedor)'} · ${brl(p.amount)} · ${dmyOf(p.paid_date || p.due_date)}`,
      [`Alteração solicitada por ${ctx.user.name}: ${CHANGE_WHAT[what]}.`, `Como deve ficar: ${details}`, '',
        'Lançamento no Mais Controle:',
        `Fornecedor: ${p.supplier || '(sem fornecedor)'} · Valor: ${brl(p.amount)} · Vencimento ${dmyOf(p.due_date)}${p.paid_date ? ` · Pago em ${dmyOf(p.paid_date)}` : ''}`,
        `Categoria: ${p.category || '(sem categoria)'} · Conta: ${p.account || '(sem conta)'} · Centro de custo: ${p.cost_center || 'Empresa'}${p.description ? ` · ${p.description}` : ''}`,
        'Depois de alterar no Mais Controle, a próxima atualização traz o lançamento corrigido.'].join('\n'));
    run('INSERT INTO ext_change_requests (source, ext_key, what, details, task_id, created_by) VALUES (?,?,?,?,?,?)', SOURCE, p.ext_key, what, details, id, ctx.user.id);
    return id;
  });
  audit(ctx.user.id, 'finance', null, 'Mais Controle: alteração de lançamento solicitada', { lancamento: `${p.supplier || '(sem fornecedor)'} · ${brl(p.amount)}`, alterar: CHANGE_WHAT[what], como: details }, ip);
  return { request: requestOf(lastRequests(), p.ext_key), task: taskInfo(taskId) };
}
const taskInfo = id => (id ? one(`SELECT t.id, t.code, t.due_date, t.status, t.cancelled_at, u.name AS assignee FROM tasks t LEFT JOIN users u ON u.id = t.assignee_id WHERE t.id = ?`, id) || null : null);

// ---------- Cadastro: contas bancárias ----------
// Todas as contas bancárias do Mais Controle; o tipo vem do "Quem Paga" dos lançamentos da conta (Empresa ou Cliente).
// A escolha manual (kind) só existe quando o operador muda o que o Mais Controle informa.
export function refreshAccounts() {
  try {
    run(`INSERT OR IGNORE INTO ext_accounts (source, ext_key, label, active)
      SELECT source, account_key, COALESCE(NULLIF(MAX(account), ''), '(sem conta)'), 0 FROM ext_payments WHERE source = ? GROUP BY account_key`, SOURCE);
    for (const a of all(`SELECT account_key, SUM(lower(payer) = 'cliente') AS c, SUM(lower(payer) = 'empresa') AS e FROM ext_payments WHERE source = ? GROUP BY account_key`, SOURCE)) {
      const auto = a.c > a.e ? 'cliente' : a.e > a.c ? 'empresa' : null;
      run('UPDATE ext_accounts SET auto_kind = ? WHERE source = ? AND ext_key = ?', auto, SOURCE, a.account_key);
    }
    run(`UPDATE ext_accounts SET active = CASE WHEN COALESCE(kind, auto_kind) = 'empresa' THEN 1 ELSE 0 END WHERE source = ?`, SOURCE);
  } catch { /* antes da migração */ }
}
// Plano de Contas e "Quem Paga" da foto atual a partir da última resposta guardada da API (sem nova consulta)
export function backfillFromRaw() {
  try {
    if (!one('SELECT 1 FROM ext_payments WHERE source = ? AND (plan_account IS NULL OR payer IS NULL) LIMIT 1', SOURCE)) return;
    const f = one(`SELECT * FROM ext_fetches WHERE source = ? AND origin IN ('api', 'auto') AND row_count > 0 AND raw IS NOT NULL ORDER BY id DESC LIMIT 1`, SOURCE);
    if (!f) return;
    const pays = withKeys(toPayments(parseCsv(f.raw)));
    tx(() => { for (const p of pays) run('UPDATE ext_payments SET plan_account = COALESCE(plan_account, ?), payer = COALESCE(payer, ?) WHERE source = ? AND ext_key = ?', p.plan || null, p.payer || null, SOURCE, p.key); });
  } catch (e) { console.warn(`[mais-controle] plano de contas: ${e.message}`); }
  refreshAccounts();
}
// Tipo manual: empresa ou cliente; vazio = seguir o Mais Controle
export function setAccount(ctx, body) {
  requireFinance(ctx.user);
  const key = hkey(body.key ?? body.label), label = str(body.label, { max: 160, label: 'Conta' }) || '(sem conta)';
  const kind = 'kind' in body ? (['empresa', 'cliente'].includes(body.kind) ? body.kind : null) : body.active ? 'empresa' : null;
  run(`INSERT INTO ext_accounts (source, ext_key, label, active, kind, updated_by) VALUES (?,?,?,?,?,?)
    ON CONFLICT(source, ext_key) DO UPDATE SET label = excluded.label, kind = excluded.kind, updated_by = excluded.updated_by, updated_at = datetime('now')`,
    SOURCE, key, label, kind === 'empresa' ? 1 : 0, kind, ctx.user.id);
  refreshAccounts();
  audit(ctx.user.id, 'finance', null, { empresa: 'Conta bancária do Mais Controle: conta da empresa (manual)', cliente: 'Conta bancária do Mais Controle: conta de cliente (manual)' }[kind] || 'Conta bancária do Mais Controle: segue o Mais Controle', { conta: label }, null);
  return { ok: true };
}

// ---------- Custos que não entram (pagamento, fornecedor ou categoria) ----------
function exclusions() {
  const ex = { pagamento: new Set(), fornecedor: new Set(), categoria: new Set() };
  try { for (const e of all('SELECT kind, ext_key FROM ext_exclusions WHERE source = ?', SOURCE)) ex[e.kind]?.add(e.ext_key); } catch { /* antes da migração */ }
  return ex;
}
const excluded = (ex, p) => ex.pagamento.has(p.ext_key) || (p.supplier_key && ex.fornecedor.has(p.supplier_key)) || ex.categoria.has(hkey(p.category));
export function listExclusions(ctx) {
  requireFinance(ctx.user);
  return all('SELECT e.*, u.name AS by_name FROM ext_exclusions e LEFT JOIN users u ON u.id = e.created_by WHERE e.source = ? ORDER BY e.created_at DESC', SOURCE);
}
export function addExclusion(ctx, body, ip) {
  requireFinance(ctx.user);
  const kind = ['pagamento', 'fornecedor', 'categoria'].includes(body.kind) ? body.kind : null;
  if (!kind) throw badRequest('Informe o que não deve entrar (pagamento, fornecedor ou categoria).');
  let key, label, detail = null;
  if (kind === 'pagamento') {
    const p = one('SELECT * FROM ext_payments WHERE source = ? AND ext_key = ?', SOURCE, String(body.key || ''));
    if (!p) throw notFound('Pagamento não encontrado na última atualização do Mais Controle.');
    key = p.ext_key; label = `${p.supplier || '(sem fornecedor)'} · ${brl(p.amount)} · ${String(p.due_date || '').split('-').reverse().join('/')}`; detail = [p.category, p.description].filter(Boolean).join(' · ');
  } else {
    label = str(body.label, { max: 160, required: true, label: kind === 'fornecedor' ? 'Fornecedor' : 'Categoria' });
    key = hkey(label);
  }
  run(`INSERT OR REPLACE INTO ext_exclusions (source, kind, ext_key, label, detail, created_by) VALUES (?,?,?,?,?,?)`, SOURCE, kind, key, label, detail, ctx.user.id);
  audit(ctx.user.id, 'finance', null, `Mais Controle: ${kind} não entra mais`, { [kind]: label, detalhe: detail }, ip);
  return sync(ctx, ip);
}
export function removeExclusion(ctx, body, ip) {
  requireFinance(ctx.user);
  const e = one('SELECT * FROM ext_exclusions WHERE source = ? AND kind = ? AND ext_key = ?', SOURCE, String(body.kind || ''), String(body.key || ''));
  if (!e) throw notFound('Exclusão não encontrada.');
  run('DELETE FROM ext_exclusions WHERE source = ? AND kind = ? AND ext_key = ?', SOURCE, e.kind, e.ext_key);
  audit(ctx.user.id, 'finance', null, `Mais Controle: ${e.kind} volta a entrar`, { [e.kind]: e.label }, ip);
  return sync(ctx, ip);
}
// Pagamentos que formam o realizado de uma tarefa no mês (para conferir e, se for o caso, não trazer)
export function monthPayments(ctx, obligationId, ym) {
  requireFinance(ctx.user);
  const o = one('SELECT * FROM finance_obligations WHERE id = ?', obligationId);
  if (!o || !/^\d{4}-\d{2}$/.test(String(ym || ''))) throw notFound('Tarefa ou mês não encontrado.');
  const ex = exclusions(), dec = decisions();
  const rules = categoryRules();
  const catOf = p => effectiveCategory(p, dec, rules);
  const reqs = lastRequests();
  return all(`SELECT p.* FROM ext_payments p JOIN ext_accounts a ON a.source = p.source AND a.ext_key = p.account_key AND a.active = 1
    WHERE p.source = ? AND p.ref_month = ? AND p.paid_date IS NOT NULL AND p.amount > 0 AND (p.cost_center IS NULL OR lower(p.cost_center) = 'empresa')`, SOURCE, ym)
    .filter(p => hkey(catOf(p)) === hkey(o.title) || (hkey(p.category) === hkey(o.title) && dec.get(p.ext_key)?.decision === 'standby'))
    .map(p => { const d = dec.get(p.ext_key); return { key: p.ext_key, supplier: p.supplier, supplier_key: p.supplier_key, description: p.description, amount: p.amount, due_date: p.due_date, paid_date: p.paid_date, category: p.category,
      excluded: excluded(ex, p), fixed_from: catOf(p) !== p.category ? p.category : null, standby: d?.decision === 'standby' && hkey(p.category) === hkey(d.category), request: requestOf(reqs, p.ext_key) }; });
}

// Lançamentos do mês que formam os quadros "Custos de Projetos pagos pela Empresa" (contas da empresa, centro de custo da obra)
// e "Gastos dos clientes por obra" (conta do cliente; uma obra ou todas)
export function costPayments(ctx, q) {
  requireFinance(ctx.user);
  const ym = String(q.mes || '');
  if (!/^\d{4}-\d{2}$/.test(ym)) throw notFound('Mês não encontrado.');
  const cc = q.cc ? String(q.cc) : null;
  const base = `p.source = ? AND p.ref_month = ? AND p.paid_date IS NOT NULL AND p.amount > 0 AND COALESCE(p.cost_center, '') <> '' AND lower(p.cost_center) <> 'empresa'`;
  let rows;
  if (q.tipo === 'cliente') {
    const conta = q.conta ? String(q.conta) : null;
    if (!conta && !cc) throw notFound('Obra ou conta não informada.');
    rows = all(`SELECT p.* FROM ext_payments p JOIN ext_accounts a ON a.source = p.source AND a.ext_key = p.account_key AND COALESCE(a.kind, a.auto_kind) = 'cliente'
      WHERE ${base}${conta ? ' AND p.account_key = ?' : ''}${cc ? ' AND p.cost_center = ?' : ''} ORDER BY p.paid_date, p.supplier`, ...[SOURCE, ym, ...(conta ? [conta] : []), ...(cc ? [cc] : [])]);
  } else {
    if (!cc) throw notFound('Centro de custo não informado.');
    rows = all(`SELECT p.* FROM ext_payments p JOIN ext_accounts a ON a.source = p.source AND a.ext_key = p.account_key AND a.active = 1
      WHERE ${base} AND p.cost_center = ? ORDER BY p.paid_date, p.supplier`, SOURCE, ym, cc);
  }
  const reqs = lastRequests();
  return rows.map(p => ({ key: p.ext_key, supplier: p.supplier, description: p.description, amount: p.amount, paid_date: p.paid_date, category: p.category, cost_center: p.cost_center, account: p.account, request: requestOf(reqs, p.ext_key) }));
}

// ---------- Regras por categoria: enviar para outra tarefa ou ajustar no Mais Controle ----------
function categoryRules() {
  const m = new Map();
  try {
    for (const r of all(`SELECT r.*, o.title AS target FROM ext_category_rules r LEFT JOIN finance_obligations o ON o.id = r.obligation_id WHERE r.source = ?`, SOURCE)) m.set(r.cat_key, r);
  } catch { /* antes da migração */ }
  return m;
}
// Categoria efetiva de um pagamento: correção da despesa (conferência) > regra da categoria > categoria do Mais Controle
function effectiveCategory(p, dec, rules) {
  const d = dec.get(p.ext_key);
  if (d?.decision === 'corrigido' && d.fix_category && hkey(p.category) === hkey(d.category)) return d.fix_category;
  const r = rules.get(hkey(p.category));
  if (r?.action === 'mapear' && r.target) return r.target;
  return p.category;
}
export function setCategoryRule(ctx, body, ip) {
  requireFinance(ctx.user);
  const label = str(body.label, { max: 160, required: true, label: 'Categoria' });
  const key = hkey(label);
  if (body.action === 'remover') {
    run('DELETE FROM ext_category_rules WHERE source = ? AND cat_key = ?', SOURCE, key);
    audit(ctx.user.id, 'finance', null, 'Mais Controle: regra da categoria desfeita', { categoria: label }, ip);
    return sync(ctx, ip);
  }
  const action = body.action === 'mapear' ? 'mapear' : body.action === 'ajustar' ? 'ajustar' : null;
  if (!action) throw badRequest('Escolha: enviar para outra tarefa ou ajustar no Mais Controle.');
  let oid = null;
  if (action === 'mapear') {
    const o = one('SELECT * FROM finance_obligations WHERE id = ?', intOrNull(body.obligation_id));
    if (!o) throw badRequest('Escolha a tarefa para onde a categoria vai.');
    oid = o.id;
  }
  tx(() => {
    let taskId = null;
    if (action === 'ajustar') {
      const s = one(`SELECT COUNT(*) AS n, COALESCE(SUM(amount), 0) AS t, MIN(paid_date) AS de, MAX(paid_date) AS ate FROM ext_payments
        WHERE source = ? AND paid_date IS NOT NULL AND amount > 0 AND (cost_center IS NULL OR lower(cost_center) = 'empresa') AND category = ? COLLATE NOCASE`, SOURCE, label);
      taskId = adjustTask(ctx, body.task, `Ajustar no Mais Controle: recategorizar “${label}”`,
        [`Categoria “${label}” marcada para ajuste no Mais Controle: ${s.n} pagamento(s) · ${brl(s.t)}${s.n ? ` · de ${dmyOf(s.de)} a ${dmyOf(s.ate)}` : ''}.`,
          'O que fazer no Mais Controle: mudar os pagamentos desta categoria para a categoria correta.',
          'Enquanto houver pagamentos nesta categoria, eles ficam fora do realizado; quando não houver mais, a regra se resolve sozinha.'].join('\n'));
    }
    run(`INSERT INTO ext_category_rules (source, cat_key, label, action, obligation_id, created_by, task_id) VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(source, cat_key) DO UPDATE SET label = excluded.label, action = excluded.action, obligation_id = excluded.obligation_id, created_by = excluded.created_by, task_id = excluded.task_id, created_at = datetime('now')`,
      SOURCE, key, label, action, oid, ctx.user.id, taskId);
  });
  audit(ctx.user.id, 'finance', null, action === 'mapear' ? 'Mais Controle: categoria enviada para outra tarefa' : 'Mais Controle: categoria para ajustar no Mais Controle', { categoria: label, tarefa: oid }, ip);
  return sync(ctx, ip);
}

// ---------- Ajustar no Mais Controle: lançamentos no centro de custo Empresa que não são custo da empresa ----------
//  - pago pelo cliente (Quem Paga = Cliente) no centro de custo Empresa;
//  - conta bancária de cliente pagando despesa do centro de custo Empresa (verificador);
//  - conta bancária não classificada no centro de custo Empresa.
// Ficam fora do realizado; saem da lista quando forem ajustados lá (ou quando a conta for classificada como da empresa).
function issueMarks() {
  const m = new Map();
  try { for (const r of all('SELECT k.*, u.name AS by_name FROM ext_issue_marks k LEFT JOIN users u ON u.id = k.marked_by WHERE k.source = ?', SOURCE)) m.set(r.ext_key, r); } catch { /* antes da migração */ }
  return m;
}
export function issues() {
  const ex = exclusions();
  const marks = issueMarks();
  const rows = all(`SELECT p.*, a.active AS acc_active, COALESCE(a.kind, a.auto_kind) AS acc_kind FROM ext_payments p LEFT JOIN ext_accounts a ON a.source = p.source AND a.ext_key = p.account_key
    WHERE p.source = ? AND p.paid_date IS NOT NULL AND p.amount > 0 AND (p.cost_center IS NULL OR lower(p.cost_center) = 'empresa') ORDER BY p.paid_date DESC`, SOURCE);
  const out = [];
  for (const p of rows) {
    if (excluded(ex, p)) continue;
    const kind = p.acc_kind === 'cliente' ? 'conta_cliente' : hkey(p.payer) === 'cliente' ? 'cliente' : !p.acc_active ? 'conta' : null;
    if (!kind) continue;
    const mk = marks.get(p.ext_key);
    out.push({ key: p.ext_key, kind, supplier: p.supplier, description: p.description, amount: p.amount, paid_date: p.paid_date, due_date: p.due_date, category: p.category, account: p.account || '(sem conta)', payer: p.payer,
      marked_at: mk?.marked_at || null, marked_by: mk?.by_name || null, task: taskInfo(mk?.task_id) });
  }
  return out;
}
// Decisão do operador no verificador: "vou ajustar no Mais Controle" (fica registrado até o lançamento sair da lista) ou desfazer
export function markIssue(ctx, body, ip) {
  requireFinance(ctx.user);
  const p = one('SELECT * FROM ext_payments WHERE source = ? AND ext_key = ?', SOURCE, String(body.key || ''));
  if (!p) throw notFound('Lançamento não encontrado na última atualização do Mais Controle.');
  const label = `${p.supplier || '(sem fornecedor)'} · ${brl(p.amount)} · conta ${p.account || '(sem conta)'}`;
  if (body.action === 'reabrir') {
    run('DELETE FROM ext_issue_marks WHERE source = ? AND ext_key = ?', SOURCE, p.ext_key);
    audit(ctx.user.id, 'finance', null, 'Mais Controle: aviso de ajuste desfeito', { lancamento: label }, ip);
  } else {
    tx(() => {
      const taskId = adjustTask(ctx, body.task, `Ajustar no Mais Controle: ${p.supplier || '(sem fornecedor)'} · ${brl(p.amount)} · ${dmyOf(p.paid_date)}`,
        [`Lançamento do centro de custo ${p.cost_center || 'Empresa'} pago pela conta de cliente “${p.account || '(sem conta)'}”.`,
          `Fornecedor: ${p.supplier || '(sem fornecedor)'} · Valor: ${brl(p.amount)} · Pago em ${dmyOf(p.paid_date)} · Categoria: ${p.category || '(sem categoria)'}${p.description ? ` · ${p.description}` : ''}`,
          'O que fazer no Mais Controle: trocar a conta bancária (para uma conta da empresa) ou o centro de custo (para a obra do cliente).',
          'Depois do ajuste, o lançamento sai do verificador na próxima atualização do Mais Controle.'].join('\n'));
      run(`INSERT OR REPLACE INTO ext_issue_marks (source, ext_key, marked_by, task_id) VALUES (?,?,?,?)`, SOURCE, p.ext_key, ctx.user.id, taskId);
    });
    audit(ctx.user.id, 'finance', null, 'Mais Controle: lançamento para ajustar no Mais Controle', { lancamento: label, centro_de_custo: p.cost_center || 'Empresa' }, ip);
  }
  return { ok: true };
}

// ---------- Alocação: a partir da foto atual ----------
// Empresa + conta cadastrada → tarefa de mesmo nome da categoria (realizado por tarefa e mês do vencimento)
function allocation() {
  refreshAccounts();
  const rows = all(`SELECT p.*, a.active AS acc_active, COALESCE(a.kind, a.auto_kind) AS acc_kind, a.label AS acc_label FROM ext_payments p
    LEFT JOIN ext_accounts a ON a.source = p.source AND a.ext_key = p.account_key WHERE p.source = ?`, SOURCE);
  const obs = all('SELECT * FROM finance_obligations ORDER BY active DESC, id');
  const byName = new Map();
  for (const o of obs) if (!byName.has(hkey(o.title))) byName.set(hkey(o.title), o);
  const real = new Map(), noTask = new Map(), otherAcc = new Map(), projects = new Map(), accounts = new Map(), clients = new Map();
  const ex = exclusions();
  const fixes = decisions();
  const rules = categoryRules();
  const adjust = new Map();
  let firstYear = null, unpaid = 0, excludedN = 0, excludedTotal = 0, standbyN = 0, standbyTotal = 0;
  for (const p of rows) {
    if (!p.paid_date || !(p.amount > 0)) { unpaid++; continue; }
    if (excluded(ex, p)) { excludedN++; excludedTotal = r2(excludedTotal + p.amount); continue; }
    if (p.acc_kind !== 'cliente' && hkey(p.payer) === 'cliente' && isEmpresa(p.cost_center)) continue; // ajustar no Mais Controle (lista de ajustes)
    const ak = p.account_key || '';
    if (!accounts.has(ak)) accounts.set(ak, { key: ak, label: p.account || '(sem conta)', active: !!p.acc_active, kind: p.acc_kind || null, count: 0, total: 0, categories: new Map() });
    const acc = accounts.get(ak); acc.count++; acc.total = r2(acc.total + p.amount);
    // Conta de cliente: gastos do cliente por obra; no centro de custo Empresa vai para o verificador
    if (p.acc_kind === 'cliente') {
      if (isEmpresa(p.cost_center)) continue;
      const k = `${ak}|${p.cost_center}|${p.ref_month}`;
      if (!clients.has(k)) clients.set(k, { client: acc.label, cost_center: p.cost_center, ym: p.ref_month, amount: 0, count: 0 });
      const g = clients.get(k); g.amount = r2(g.amount + p.amount); g.count++;
      continue;
    }
    if (!p.acc_active) { acc.categories.set(p.category || '(sem categoria)', r2((acc.categories.get(p.category || '(sem categoria)') || 0) + p.amount)); continue; }
    if (!isEmpresa(p.cost_center)) {
      const k = `${p.cost_center}|${p.ref_month}`;
      if (!projects.has(k)) projects.set(k, { cost_center: p.cost_center, ym: p.ref_month, amount: 0, count: 0 });
      const g = projects.get(k); g.amount = r2(g.amount + p.amount); g.count++;
      continue;
    }
    const y = Number(p.ref_month.slice(0, 4));
    if (!firstYear || y < firstYear) firstYear = y;
    const d = fixes.get(p.ext_key);
    // Stand by: fora do realizado enquanto o Mais Controle mandar a mesma categoria (corrigida lá → entra sozinha)
    if (d?.decision === 'standby' && hkey(p.category) === hkey(d.category)) { standbyN++; standbyTotal = r2(standbyTotal + p.amount); continue; }
    // Corrigida no sistema: vai para a tarefa escolhida (se o Mais Controle não mudou a categoria desde então)
    const rule = rules.get(hkey(p.category));
    if (rule?.action === 'ajustar' && !(d?.decision === 'corrigido' && hkey(p.category) === hkey(d.category))) {
      const a = adjust.get(rule.cat_key) || { label: rule.label, count: 0, total: 0, last: null, since: rule.created_at };
      a.count++; a.total = r2(a.total + p.amount); if (!a.last || p.ref_month > a.last) a.last = p.ref_month;
      adjust.set(rule.cat_key, a);
      continue;
    }
    p.category = effectiveCategory(p, fixes, rules);
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
  // Todas as contas bancárias do Mais Controle (inclusive só com lançamentos em aberto ou fora do realizado)
  for (const a of all('SELECT * FROM ext_accounts WHERE source = ?', SOURCE)) {
    if (!accounts.has(a.ext_key)) accounts.set(a.ext_key, { key: a.ext_key, label: a.label, active: !!a.active, count: 0, total: 0, categories: [] });
    Object.assign(accounts.get(a.ext_key), { kind: a.kind || a.auto_kind || null, manual_kind: a.kind || null, auto_kind: a.auto_kind || null });
  }
  return { real, noTask, projects, clients, accounts, firstYear, unpaid, obs, excludedN, excludedTotal, standbyN, standbyTotal, adjust, rules };
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

// ---------- Conferência de alocação: despesa numa categoria diferente da habitual do fornecedor ----------
// Decisões por pagamento: ok (fornecedor passa a valer nesta categoria), corrigido (vai para outra tarefa no sistema)
// ou standby (fora do realizado até vir corrigido do Mais Controle).
function decisions() {
  const m = new Map();
  try { for (const r of all('SELECT * FROM ext_reviews WHERE source = ?', SOURCE)) m.set(r.ext_key, { ...r, decision: r.decision === 'errado' ? 'standby' : r.decision }); } catch { /* antes da migração */ }
  return m;
}
export function reviews() {
  const cur = today().slice(0, 7);
  const rows = all(`SELECT p.* FROM ext_payments p JOIN ext_accounts a ON a.source = p.source AND a.ext_key = p.account_key AND a.active = 1
    WHERE p.source = ? AND p.paid_date IS NOT NULL AND p.amount > 0 AND (p.cost_center IS NULL OR lower(p.cost_center) = 'empresa') AND p.supplier_key <> ''`, SOURCE);
  const ex = exclusions();
  for (let i = rows.length - 1; i >= 0; i--) if (excluded(ex, rows[i])) rows.splice(i, 1);
  const decided = decisions();
  const rulesR = categoryRules();
  // Categoria habitual: a última aceita ("Está OK") para o fornecedor, senão a mais frequente nos meses anteriores
  const accepted = new Map();
  for (const r of [...decided.values()].filter(x => x.decision === 'ok').sort((a, b) => String(a.decided_at).localeCompare(String(b.decided_at)))) accepted.set(r.supplier_key, r.category);
  const hist = new Map();
  // Período conferido a cada atualização: mês atual e o anterior
  const [cy, cm] = cur.split('-').map(Number);
  const prevM = cm === 1 ? `${cy - 1}-12` : `${cy}-${String(cm - 1).padStart(2, '0')}`;
  const firstOf = new Map();
  for (const p of rows) if (!firstOf.has(p.supplier_key) || p.ref_month < firstOf.get(p.supplier_key)) firstOf.set(p.supplier_key, p.ref_month);
  for (const p of rows) if (p.ref_month < prevM) {
    const d = decided.get(p.ext_key);
    const cat = effectiveCategory(p, decided, rulesR);
    const m = hist.get(p.supplier_key) || new Map();
    m.set(cat, (m.get(cat) || 0) + 1); hist.set(p.supplier_key, m);
  }
  const usualOf = sk => accepted.get(sk) ?? (hist.get(sk) ? [...hist.get(sk)].sort((a, b) => b[1] - a[1])[0][0] : null);
  const out = [];
  for (const p of rows) {
    const d = decided.get(p.ext_key);
    const base = { key: p.ext_key, supplier: p.supplier, description: p.description, amount: p.amount, due_date: p.due_date, category: p.category };
    // Stand by: aparece até o Mais Controle mandar a categoria corrigida (qualquer mês)
    if (d?.decision === 'standby') { if (hkey(p.category) === hkey(d.category)) out.push({ ...base, usual: d.usual, state: 'standby', marked_at: d.decided_at, task: taskInfo(d.task_id) }); continue; }
    if (d && hkey(p.category) === hkey(d.category)) continue; // ok ou corrigido (enquanto a categoria não mudar lá)
    if (p.ref_month < prevM) continue;
    // Despesa nova: o fornecedor não tem pagamento em meses anteriores
    if (firstOf.get(p.supplier_key) >= p.ref_month && !hist.has(p.supplier_key)) { out.push({ ...base, usual: null, state: 'nova' }); continue; }
    const usual = usualOf(p.supplier_key);
    if (!usual || hkey(usual) === hkey(p.category)) continue;
    out.push({ ...base, usual, state: 'conferir' });
  }
  const ord = { standby: 0, conferir: 1, nova: 2 };
  return out.sort((a, b) => ord[a.state] - ord[b.state] || String(a.supplier).localeCompare(String(b.supplier), 'pt-BR'));
}
export function decideReview(ctx, body, ip) {
  requireFinance(ctx.user);
  const decision = { ok: 'ok', corrigido: 'corrigido', standby: 'standby', errado: 'standby', reabrir: 'reabrir' }[body.decision];
  if (!decision) throw badRequest('Informe a decisão: está OK, corrigir a categoria ou stand by.');
  const p = one('SELECT * FROM ext_payments WHERE source = ? AND ext_key = ?', SOURCE, String(body.key || ''));
  if (!p) throw notFound('Pagamento não encontrado na última atualização do Mais Controle.');
  if (decision === 'reabrir') {
    run('DELETE FROM ext_reviews WHERE source = ? AND ext_key = ?', SOURCE, p.ext_key);
    audit(ctx.user.id, 'finance', null, 'Alocação: decisão desfeita', { fornecedor: p.supplier, categoria: p.category, valor: p.amount }, ip);
    return sync(ctx, ip);
  }
  let fix = null;
  if (decision === 'corrigido') {
    const o = one('SELECT * FROM finance_obligations WHERE id = ?', intOrNull(body.obligation_id));
    if (!o) throw badRequest('Escolha a tarefa (categoria) correta.');
    if (hkey(o.title) === hkey(p.category)) throw badRequest('A despesa já está nesta categoria.');
    fix = o.title;
  }
  const usual = str(body.usual, { max: 160, label: 'Categoria habitual' }) || null;
  tx(() => {
    const taskId = decision === 'standby' ? adjustTask(ctx, body.task, `Ajustar no Mais Controle: categoria de ${p.supplier || '(sem fornecedor)'} · ${brl(p.amount)} · ${dmyOf(p.paid_date)}`,
      [`Despesa em stand by: a categoria no Mais Controle está errada.`,
        `Fornecedor: ${p.supplier || '(sem fornecedor)'} · Valor: ${brl(p.amount)} · Pago em ${dmyOf(p.paid_date)}${p.description ? ` · ${p.description}` : ''}`,
        `Categoria no Mais Controle: ${p.category || '(sem categoria)'}${usual ? ` · costuma ser: ${usual}` : ''}`,
        'O que fazer no Mais Controle: corrigir a categoria do lançamento. Quando vier corrigida, a despesa entra sozinha no realizado.'].join('\n')) : null;
    run(`INSERT INTO ext_reviews (source, ext_key, supplier_key, decision, category, usual, fix_category, decided_by, task_id) VALUES (?,?,?,?,?,?,?,?,?)
      ON CONFLICT(source, ext_key) DO UPDATE SET decision = excluded.decision, category = excluded.category, usual = excluded.usual, fix_category = excluded.fix_category, decided_by = excluded.decided_by, task_id = excluded.task_id, decided_at = datetime('now')`,
      SOURCE, p.ext_key, p.supplier_key, decision, p.category, usual, fix, ctx.user.id, taskId);
  });
  audit(ctx.user.id, 'finance', null, { ok: 'Alocação conferida: OK (fornecedor passa a valer nesta categoria)', corrigido: 'Alocação corrigida no sistema', standby: 'Alocação em stand by (ajustar no Mais Controle)' }[decision],
    { fornecedor: p.supplier, categoria: p.category, para: fix, valor: p.amount }, ip);
  return sync(ctx, ip);
}

// ---------- Prévia ----------
export function preview(ctx) {
  requireFinance(ctx.user);
  const f = one('SELECT * FROM ext_fetches WHERE source = ? AND row_count > 0 ORDER BY id DESC LIMIT 1', SOURCE);
  const al = allocation();
  const ch = changes(al);
  const projList = [...al.projects.values()].sort((a, b) => a.cost_center.localeCompare(b.cost_center, 'pt-BR') || a.ym.localeCompare(b.ym));
  const noTask = [...al.noTask.values()].sort((a, b) => b.total - a.total);
  const ord = { empresa: 0, cliente: 1 };
  const accounts = [...al.accounts.values()].sort((a, b) => (ord[a.kind] ?? 2) - (ord[b.kind] ?? 2) || b.total - a.total || a.label.localeCompare(b.label, 'pt-BR'));
  const otherAcc = accounts.filter(a => !a.kind && a.count);
  const cliList = [...al.clients.values()].sort((a, b) => a.client.localeCompare(b.client, 'pt-BR') || a.cost_center.localeCompare(b.cost_center, 'pt-BR') || a.ym.localeCompare(b.ym));
  const cnt = k => ch.filter(c => c.kind === k).length;
  return {
    fetch: f ? { id: f.id, origin: f.origin, file_name: f.file_name, fetched_at: f.fetched_at, rows: f.row_count, data_until: f.data_until } : null,
    first_year: al.firstYear, accounts, categories: noTask, changes: ch, projects: projList.slice(-24), reviews: reviews(), exclusions: listExclusions(ctx),
    issues: issues(),
    clients: cliList.slice(-48),
    category_rules: [...al.rules.values()].map(r => ({ label: r.label, action: r.action, target: r.target || null, created_at: r.created_at, pending: al.adjust.get(r.cat_key) || null, task: taskInfo(r.task_id) }))
      .sort((a, b) => a.label.localeCompare(b.label, 'pt-BR')),
    tasks: al.obs.filter(o => o.active).map(o => ({ id: o.id, title: o.title })).sort((a, b) => a.title.localeCompare(b.title, 'pt-BR')),
    totals: {
      novo: cnt('novo'), alterado: cnt('alterado'), removido: cnt('removido'), manual: cnt('manual'),
      novo_total: r2(ch.filter(c => c.kind === 'novo').reduce((s, c) => s + c.amount, 0)),
      unmapped: noTask.reduce((s, c) => s + c.count, 0), unmapped_total: r2(noTask.reduce((s, c) => s + c.total, 0)),
      other_account: otherAcc.reduce((s, a) => s + a.count, 0), other_account_total: r2(otherAcc.reduce((s, a) => s + a.total, 0)),
      projects: projList.reduce((s, g) => s + g.count, 0), projects_total: r2(projList.reduce((s, g) => s + g.amount, 0)), unpaid: al.unpaid,
      clients: cliList.reduce((s, g) => s + g.count, 0), clients_total: r2(cliList.reduce((s, g) => s + g.amount, 0)),
      excluded: al.excludedN, excluded_total: al.excludedTotal, standby: al.standbyN, standby_total: al.standbyTotal,
      adjust: [...al.adjust.values()].reduce((s, a) => s + a.count, 0), adjust_total: r2([...al.adjust.values()].reduce((s, a) => s + a.total, 0)),
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
        // Cancelada pela pessoa: fica cancelada (só a do "previsto R$ 0,00", cancelada pelo sistema, volta e conclui)
        if (!wasPaid) run(`UPDATE tasks SET status = 'concluida', cancelled_at = NULL, cancelled_by = NULL, cancel_reason = NULL, started_at = COALESCE(started_at, ?), delivered_at = ?, completed_at = ?, review_status = 'aprovada', reviewed_by = ?, reviewed_at = ?, progress_pct = 100, updated_at = ? WHERE id = ?
          AND (cancelled_at IS NULL OR cancel_reason = 'Sem previsão no mês (previsto R$ 0,00)')`,
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
        // Primeiro ano da categoria (mês do primeiro pagamento no Mais Controle): previsto = o próprio realizado; os meses
        // desse ano que ainda não aconteceram usam a média mensal do que já foi pago nele (do 1º pagamento até o último)
        const startYm = o.mc_start || [...al.real.values()].filter(g => g.o.id === oid).map(g => g.ym).sort()[0];
        const catFirst = Number(startYm.slice(0, 4));
        const lastPaid = [...al.real.values()].filter(g => g.o.id === oid && g.ym.startsWith(`${catFirst}-`)).map(g => g.ym).sort().at(-1) || startYm;
        const firstMonths = monthsOf(o, lastPaid).filter(m => m >= startYm && m.startsWith(`${catFirst}-`));
        const firstAvg = firstMonths.length ? r2(firstMonths.reduce((s, m) => s + realOf(oid, m), 0) / firstMonths.length) : 0;
        for (const ym of monthsOf(o, lastYm)) {
          if (ym < startYm || manual.has(ym)) continue;
          // Regra da tarefa: sempre zero; zero no primeiro ano da categoria; senão realizado do ano anterior
          const yr = Number(ym.slice(0, 4));
          const planned = o.plan_zero === 1 || (o.plan_zero === 2 && yr === catFirst) ? 0
            : yr === catFirst ? (ym >= cur && !realOf(oid, ym) ? firstAvg : realOf(oid, ym))
            : realOf(oid, prevYm(ym));
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
    WHERE i.status = 'pendente' AND i.amount_expected > 0 AND o.active = 1 AND i.due_date BETWEEN ? AND ? AND i.ref_month >= ? ORDER BY i.due_date, o.title`, from, end, controlStart() || '0000-00')
    .map(i => {
      const days = Math.round((Date.parse(i.due_date) - Date.parse(ref)) / 86400e3);
      const state = i.marked_paid_at ? markState(i, cov) : cov && cov.data_until >= i.due_date ? 'justificar' : days < 0 ? 'atrasada' : days === 0 ? 'hoje' : 'a_pagar';
      return { ...i, days, state };
    });
  let alerts = { accounts: [], categories: [], reviews: 0 };
  try {
    const pv = preview(ctx);
    alerts = {
      accounts: pv.accounts.filter(a => !a.kind && a.count).map(a => ({ label: a.label, count: a.count, total: a.total, categories: a.categories.slice(0, 4) })),
      categories: pv.categories.map(c => ({ label: c.label, count: c.count, total: c.total })),
      reviews: pv.reviews.length,
      issues: pv.issues.filter(i => i.kind !== 'conta_cliente').length,
      client_issues: pv.issues.filter(i => i.kind === 'conta_cliente' && !i.marked_at).length,
    };
  } catch { /* sem dados ainda */ }
  return { today: ref, week_end: end, data_until: cov?.data_until || null, items, alerts };
}

// Compatibilidade com o "Desfazer última importação" (a sincronização é refeita a partir do Mais Controle; nada a desfazer)
export const undoBatch = () => {};
export const somaItems = () => [];
export const batchExtCount = () => 0;
