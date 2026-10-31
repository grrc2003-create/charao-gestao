// Folha de Campo: medição da mão de obra própria (diárias) e das empreitadas por obra.
//  · Profissionais: diaristas (função e valor da diária) e empreiteiros. Documento e PIX só para a seção folha_campo.
//  · Empreitada: contrato com o empreiteiro na obra (serviço e valor total), medida em % a cada folha; mostra acumulado e saldo.
//  · Folha: período livre por obra; grade de diárias por dia (1, ½), serviço a apropriar, parte paga pelo cliente e ajuste.
//    Valor = diárias × diária + ajuste; a empresa paga o valor menos a parte do cliente.
//  · Preenchem: responsável do projeto, gestores/coordenadores do projeto e a seção folha_campo.
//    Valores, documento e PIX: somente a seção folha_campo, que fecha a folha (congela os valores e gera o pagamento no Financeiro).
import { all, one, run, tx } from '../db.js';
import { badRequest, notFound, forbidden, str, date, intOrNull } from '../lib/http.js';
import { hasSection, canAccessProject, canManageProject } from '../lib/permissions.js';
import { audit } from './audit.js';
import { createObligationInternal, obligationPaid, removeObligationInternal, payItemInternal, unpayItemInternal } from './finance.js';
import { today } from './metrics.js';
import { saveImageFromDataUrl, cleanFileName, deleteStored } from './files.js';

const r2 = v => Math.round((Number(v) || 0) * 100) / 100;
const pad = n => String(n).padStart(2, '0');
export const KINDS = { diarista: 'Diarista (mão de obra própria)', empreiteiro: 'Empreiteiro' };
export const PIX_TYPES = ['CPF', 'CNPJ', 'Telefone', 'E-mail', 'Aleatória'];
export const CONTRACT_STATUS = { andamento: 'Em andamento', paralisada: 'Paralisada', concluida: 'Concluída', cancelada: 'Cancelada' };
const MAX_DAYS = 31;

export const canFieldMoney = user => hasSection(user, 'folha_campo');
const requireMoney = ctx => { if (!canFieldMoney(ctx.user)) throw forbidden('Somente quem tem a seção Folha de Campo liberada vê valores e fecha a folha.'); };
const fcCode = seq => `FC-${pad(seq)}`;
const addDays = (d, n) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
export function daysOf(start, end) {
  const out = [];
  for (let d = start; d <= end && out.length <= MAX_DAYS; d = addDays(d, 1)) out.push(d);
  return out;
}
const num = (v, label, { min = 0, max = Infinity } = {}) => {
  if (v === undefined || v === null || v === '') return 0;
  const n = Number(String(v).replace(',', '.'));
  if (!Number.isFinite(n) || n < min || n > max) throw badRequest(`${label} inválido.`);
  return r2(n);
};

// ---------- Acesso por obra ----------
function canFill(ctx, p) {
  // Só obras com "Controle de folha de campo" marcado no cadastro do projeto
  if (!p || p.kind !== 'obra' || !p.field_control) return false;
  if (!canAccessProject(ctx.user, p.id, ctx.projects)) return false;
  return canFieldMoney(ctx.user) || p.lead_id === ctx.user.id || canManageProject(ctx, p.id);
}
export function fillableProjects(ctx) {
  return all(`SELECT id, code, name, client, status, lead_id, kind, field_control FROM projects WHERE kind = 'obra' AND field_control = 1 ORDER BY status = 'concluido', code`).filter(p => canFill(ctx, p))
    .map(({ id, code, name, client, status }) => ({ id, code, name, client, status }));
}
export const canUseField = ctx => canFieldMoney(ctx.user) || fillableProjects(ctx).length > 0;
function requireProject(ctx, projectId) {
  const p = one('SELECT * FROM projects WHERE id = ?', projectId);
  if (!p) throw notFound('Obra não encontrada.');
  if (!canFill(ctx, p)) throw forbidden('A Folha de Campo desta obra não está liberada para o seu usuário.');
  return p;
}

// ---------- Profissionais ----------
// Obras do profissional: onde ele aparece para entrar nas folhas e empreitadas (sem obra = todas)
const workerProjects = () => {
  const by = new Map();
  for (const r of all('SELECT wp.worker_id, p.id, p.code FROM field_worker_projects wp JOIN projects p ON p.id = wp.project_id ORDER BY p.code')) {
    if (!by.has(r.worker_id)) by.set(r.worker_id, []);
    by.get(r.worker_id).push({ id: r.id, code: r.code });
  }
  return by;
};
export const workerInProject = (workerId, projectId) => !one('SELECT 1 FROM field_worker_projects WHERE worker_id = ?', workerId)
  || !!one('SELECT 1 FROM field_worker_projects WHERE worker_id = ? AND project_id = ?', workerId, projectId);
const workerView = (w, money, wp = workerProjects()) => {
  const projects = wp.get(w.id) || [];
  const base = { id: w.id, name: w.name, kind: w.kind, role: w.role, active: w.active, leader_id: w.leader_id, leader_name: w.leader_name || null,
    leader_external: !!w.leader_external, project_ids: projects.map(p => p.id), projects };
  return money ? { ...base, daily_rate: w.daily_rate, doc: w.doc, pix: w.pix, pix_type: w.pix_type, phone: w.phone, notes: w.notes } : base;
};
const WORKER_SQL = 'SELECT w.*, l.name AS leader_name, l.is_external AS leader_external FROM field_workers w LEFT JOIN users l ON l.id = w.leader_id';
// Líder: pessoa ativa do organograma (equipe interna ou terceirizado); aparece com a equipe de campo dela
const leaderOptions = () => all('SELECT id, name, job_title, is_external FROM users WHERE active = 1 ORDER BY is_external, name');
export function listWorkers(ctx) {
  if (!canUseField(ctx)) throw forbidden('A Folha de Campo não está liberada para o seu usuário.');
  const money = canFieldMoney(ctx.user);
  const wp = workerProjects();
  return { workers: all(`${WORKER_SQL} ORDER BY w.active DESC, w.name`).map(w => workerView(w, money, wp)), kinds: KINDS, pix_types: PIX_TYPES, can_money: money,
    leaders: leaderOptions(), projects: fillableProjects(ctx) };
}
function readLeader(v, cur) {
  if (v === undefined) return cur ?? null;
  const id = intOrNull(v);
  if (!id) return null;
  if (id === cur) return id; // mantém o líder atual mesmo que tenha saído do organograma
  if (!one('SELECT id FROM users WHERE id = ? AND active = 1', id)) throw badRequest('Líder inválido: escolha uma pessoa ativa do organograma.');
  return id;
}
// Obras escolhidas (só as liberadas para quem cadastra); as demais obras já ligadas ao profissional são mantidas
function saveWorkerProjects(ctx, workerId, value) {
  if (value === undefined) return;
  if (!Array.isArray(value)) throw badRequest('Obras do profissional inválidas.');
  const allowed = new Set(fillableProjects(ctx).map(p => p.id));
  const chosen = new Set(value.map(intOrNull).filter(Boolean));
  for (const id of chosen) if (!allowed.has(id)) throw badRequest('Obra não liberada para a Folha de Campo do seu usuário.');
  const keep = all('SELECT project_id FROM field_worker_projects WHERE worker_id = ?', workerId).map(r => r.project_id).filter(id => !allowed.has(id));
  run('DELETE FROM field_worker_projects WHERE worker_id = ?', workerId);
  for (const id of new Set([...keep, ...chosen])) run('INSERT INTO field_worker_projects (worker_id, project_id) VALUES (?, ?)', workerId, id);
}
function readWorker(b, money, cur = {}) {
  const d = {
    name: str(b.name, { max: 120, required: true, label: 'Nome' }),
    kind: KINDS[b.kind] ? b.kind : cur.kind || 'diarista',
    role: str(b.role, { max: 60, label: 'Função' }),
    leader_id: readLeader(b.leader_id, cur.leader_id),
    active: b.active === false || b.active === 0 || b.active === '0' ? 0 : 1,
  };
  if (!money) return { ...d, daily_rate: cur.daily_rate || 0, doc: cur.doc ?? null, pix: cur.pix ?? null, pix_type: cur.pix_type ?? null, phone: cur.phone ?? null, notes: cur.notes ?? null };
  return {
    ...d,
    daily_rate: num(b.daily_rate, 'Valor da diária', { max: 100000 }),
    doc: str(b.doc, { max: 30, label: 'CPF/CNPJ' }),
    pix: str(b.pix, { max: 120, label: 'PIX' }),
    pix_type: PIX_TYPES.includes(b.pix_type) ? b.pix_type : null,
    phone: str(b.phone, { max: 30, label: 'Telefone' }),
    notes: str(b.notes, { max: 1000, label: 'Observações' }),
  };
}
export function createWorker(ctx, body, ip) {
  if (!canUseField(ctx)) throw forbidden('A Folha de Campo não está liberada para o seu usuário.');
  const money = canFieldMoney(ctx.user);
  const d = readWorker(body || {}, money);
  const id = tx(() => {
    const nid = Number(run(`INSERT INTO field_workers (name, kind, role, leader_id, daily_rate, doc, pix, pix_type, phone, notes, active, created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      d.name, d.kind, d.role, d.leader_id, d.daily_rate, d.doc, d.pix, d.pix_type, d.phone, d.notes, d.active, ctx.user.id).lastInsertRowid);
    saveWorkerProjects(ctx, nid, body?.project_ids);
    return nid;
  });
  audit(ctx.user.id, 'field', id, 'Profissional de campo cadastrado', { nome: d.name }, ip);
  return workerView(one(`${WORKER_SQL} WHERE w.id = ?`, id), money);
}
export function updateWorker(ctx, id, body, ip) {
  requireMoney(ctx);
  const cur = one('SELECT * FROM field_workers WHERE id = ?', id);
  if (!cur) throw notFound('Profissional não encontrado.');
  const d = readWorker(body || {}, true, cur);
  tx(() => {
    run(`UPDATE field_workers SET name=?, kind=?, role=?, leader_id=?, daily_rate=?, doc=?, pix=?, pix_type=?, phone=?, notes=?, active=?, updated_at=datetime('now') WHERE id=?`,
      d.name, d.kind, d.role, d.leader_id, d.daily_rate, d.doc, d.pix, d.pix_type, d.phone, d.notes, d.active, id);
    saveWorkerProjects(ctx, id, body?.project_ids);
  });
  audit(ctx.user.id, 'field', id, 'Profissional de campo atualizado', { nome: d.name }, ip);
  return workerView(one(`${WORKER_SQL} WHERE w.id = ?`, id), true);
}

// Organograma: equipe de campo ativa de cada líder, contada por função (sem nomes nem valores)
export function fieldTeams() {
  const by = new Map();
  for (const r of all(`SELECT leader_id, COALESCE(NULLIF(TRIM(role), ''), CASE kind WHEN 'empreiteiro' THEN 'Empreiteiro' ELSE 'Sem função' END) AS role, COUNT(*) AS n
    FROM field_workers WHERE active = 1 AND leader_id IS NOT NULL GROUP BY 1, 2 ORDER BY 1, n DESC, 2`)) {
    if (!by.has(r.leader_id)) by.set(r.leader_id, []);
    by.get(r.leader_id).push({ role: r.role, n: r.n });
  }
  return by;
}

// ---------- Empreitadas ----------
const measuredPct = (contractId, exceptSheet = 0) => r2(one('SELECT COALESCE(SUM(pct), 0) AS s FROM field_sheet_contracts WHERE contract_id = ? AND sheet_id <> ?', contractId, exceptSheet).s);
function contractView(c, money) {
  const pct = measuredPct(c.id);
  const base = { id: c.id, project_id: c.project_id, project_code: c.project_code, project_name: c.project_name, worker_id: c.worker_id, worker_name: c.worker_name,
    service: c.service, start_date: c.start_date, status: c.status, notes: c.notes, measured_pct: pct, balance_pct: r2(100 - pct) };
  return money ? { ...base, total: c.total, measured: r2(c.total * pct / 100), balance: r2(c.total - c.total * pct / 100) } : base;
}
const CONTRACT_SQL = `SELECT c.*, w.name AS worker_name, p.code AS project_code, p.name AS project_name FROM field_contracts c
  JOIN field_workers w ON w.id = c.worker_id JOIN projects p ON p.id = c.project_id`;
export function listContracts(ctx, projectId) {
  const allowed = new Set(fillableProjects(ctx).map(p => p.id));
  if (!allowed.size && !canFieldMoney(ctx.user)) throw forbidden('A Folha de Campo não está liberada para o seu usuário.');
  const money = canFieldMoney(ctx.user);
  return all(`${CONTRACT_SQL} ORDER BY CASE c.status WHEN 'andamento' THEN 0 WHEN 'paralisada' THEN 1 WHEN 'concluida' THEN 2 ELSE 3 END, p.code, w.name`).filter(c => allowed.has(c.project_id) && (!projectId || c.project_id === projectId)).map(c => contractView(c, money));
}
function readContract(ctx, b, curWorker = null) {
  const projectId = intOrNull(b.project_id);
  if (!projectId) throw badRequest('Escolha a obra.');
  requireProject(ctx, projectId);
  const workerId = intOrNull(b.worker_id);
  if (!workerId || !one(`SELECT id FROM field_workers WHERE id = ? AND kind = 'empreiteiro'`, workerId)) throw badRequest('Escolha o empreiteiro (cadastre-o em Profissionais como Empreiteiro).');
  if (workerId !== curWorker && !workerInProject(workerId, projectId)) throw badRequest('Este empreiteiro não está ligado a esta obra. Inclua a obra no cadastro dele em Profissionais.');
  const total = num(b.total, 'Valor total da empreitada', { max: 1e9 });
  if (!total) throw badRequest('Informe o valor total da empreitada.');
  return {
    project_id: projectId, worker_id: workerId, total,
    service: str(b.service, { max: 200, required: true, label: 'Serviço' }),
    start_date: date(b.start_date, 'Início'),
    notes: str(b.notes, { max: 1000, label: 'Observações' }),
    status: CONTRACT_STATUS[b.status] ? b.status : 'andamento',
  };
}
export function createContract(ctx, body, ip) {
  requireMoney(ctx);
  const d = readContract(ctx, body || {});
  const id = Number(run('INSERT INTO field_contracts (project_id, worker_id, service, total, start_date, notes, status, created_by) VALUES (?,?,?,?,?,?,?,?)',
    d.project_id, d.worker_id, d.service, d.total, d.start_date, d.notes, d.status, ctx.user.id).lastInsertRowid);
  audit(ctx.user.id, 'field', id, 'Empreitada cadastrada', { servico: d.service, total: d.total }, ip);
  return contractView(one(`${CONTRACT_SQL} WHERE c.id = ?`, id), true);
}
export function updateContract(ctx, id, body, ip) {
  requireMoney(ctx);
  const cur = one('SELECT * FROM field_contracts WHERE id = ?', id);
  if (!cur) throw notFound('Empreitada não encontrada.');
  const d = readContract(ctx, { ...body, project_id: cur.project_id }, cur.worker_id);
  if (d.total < r2(cur.total * measuredPct(id) / 100) - 0.01) throw badRequest('O valor total não pode ser menor que o já medido.');
  run(`UPDATE field_contracts SET worker_id=?, service=?, total=?, start_date=?, notes=?, status=?, updated_at=datetime('now') WHERE id=?`, d.worker_id, d.service, d.total, d.start_date, d.notes, d.status, id);
  audit(ctx.user.id, 'field', id, 'Empreitada atualizada', { servico: d.service, total: d.total }, ip);
  return contractView(one(`${CONTRACT_SQL} WHERE c.id = ?`, id), true);
}

// ---------- Folhas ----------
const parseDays = s => { try { const o = JSON.parse(s || '{}'); return o && typeof o === 'object' ? o : {}; } catch { return {}; } };
const sumDays = days => r2(Object.values(days).reduce((s, v) => s + (Number(v) || 0), 0));
function loadSheet(ctx, id) {
  const s = one('SELECT * FROM field_sheets WHERE id = ?', id);
  if (!s) throw notFound('Folha não encontrada.');
  return { s, p: requireProject(ctx, s.project_id) };
}
const openOnly = s => { if (s.status !== 'aberta') throw badRequest('A folha está fechada. Reabra para alterar.'); };

// Pagamentos registrados por lançamento da folha (p<id>/c<id>): soma e lista (data, valor, observação, comprovantes)
function payInfo(sheetId) {
  const by = new Map();
  const rows = all(`SELECT p.line, p.amount, p.paid_date, p.batch_id, b.notes FROM field_payments p JOIN field_pay_batches b ON b.id = p.batch_id
    WHERE p.sheet_id = ? ORDER BY p.paid_date, p.id`, sheetId);
  const files = new Map();
  if (rows.length) {
    const ids = [...new Set(rows.map(r => r.batch_id))];
    for (const f of all(`SELECT id, batch_id, mime, original_name FROM field_pay_files WHERE batch_id IN (${ids.map(() => '?').join(',')}) ORDER BY id`, ...ids)) {
      if (!files.has(f.batch_id)) files.set(f.batch_id, []);
      files.get(f.batch_id).push({ id: f.id, mime: f.mime, original_name: f.original_name });
    }
  }
  for (const r of rows) {
    const x = by.get(r.line) || { sum: 0, list: [] };
    x.sum = r2(x.sum + r.amount);
    x.list.push({ batch_id: r.batch_id, amount: r.amount, paid_date: r.paid_date, notes: r.notes, files: files.get(r.batch_id) || [] });
    by.set(r.line, x);
  }
  return by;
}
// Quanto já foi pago do lançamento: pagamentos registrados; marcado como pago antes dos registros = valor inteiro
const linePaid = (pi, line, company, paidAt) => {
  const x = pi.get(line);
  return { paid_amount: x ? x.sum : paidAt ? Math.max(0, company) : 0, payments: x ? x.list : [] };
};

// Valores ao vivo (folha aberta) ou congelados (fechada)
function computeSheet(s) {
  const pi = payInfo(s.id);
  const snap = s.status === 'fechada' && s.snapshot ? JSON.parse(s.snapshot) : null;
  const people = all(`SELECT e.*, w.name, w.role, w.kind, w.daily_rate, w.pix, w.pix_type, w.doc FROM field_sheet_people e JOIN field_workers w ON w.id = e.worker_id WHERE e.sheet_id = ? ORDER BY w.name`, s.id).map(e => {
    const f = snap?.people?.[e.id] || {};
    const rate = f.rate ?? e.daily_rate;
    const days = parseDays(e.days);
    const diarias = sumDays(days);
    const gross = r2(diarias * rate);
    const total = r2(gross + e.adjust);
    return { id: e.id, worker_id: e.worker_id, name: f.name ?? e.name, role: f.role ?? e.role, pix: f.pix ?? e.pix, pix_type: f.pix_type ?? e.pix_type, doc: f.doc ?? e.doc,
      days, diarias, rate, gross, adjust: e.adjust, adjust_note: e.adjust_note, total, client_paid: e.client_paid, company: r2(total - e.client_paid), service: e.service, paid_at: e.paid_at,
      ...linePaid(pi, `p${e.id}`, r2(total - e.client_paid), e.paid_at) };
  });
  const contracts = all(`SELECT sc.*, c.service, c.total AS c_total, c.worker_id, w.name AS worker_name, w.pix, w.pix_type FROM field_sheet_contracts sc
    JOIN field_contracts c ON c.id = sc.contract_id JOIN field_workers w ON w.id = c.worker_id WHERE sc.sheet_id = ? ORDER BY w.name, c.service`, s.id).map(x => {
    const f = snap?.contracts?.[x.id] || {};
    const cTotal = f.total ?? x.c_total;
    const amount = r2(cTotal * x.pct / 100);
    const before = measuredBefore(x.contract_id, s);
    return { id: x.id, contract_id: x.contract_id, worker_id: x.worker_id, service: f.service ?? x.service, worker_name: f.worker_name ?? x.worker_name, pix: f.pix ?? x.pix, pix_type: f.pix_type ?? x.pix_type,
      contract_total: cTotal, pct: x.pct, before_pct: before, after_pct: r2(before + x.pct), balance_pct: r2(100 - before - x.pct), amount, client_paid: x.client_paid, company: r2(amount - x.client_paid), notes: x.notes, paid_at: x.paid_at,
      ...linePaid(pi, `c${x.id}`, r2(amount - x.client_paid), x.paid_at) };
  });
  const totals = {
    diarias: r2(people.reduce((a, e) => a + e.diarias, 0)),
    people: r2(people.reduce((a, e) => a + e.total, 0)),
    contracts: r2(contracts.reduce((a, c) => a + c.amount, 0)),
    client: r2(people.reduce((a, e) => a + e.client_paid, 0) + contracts.reduce((a, c) => a + c.client_paid, 0)),
  };
  totals.total = r2(totals.people + totals.contracts);
  totals.company = r2(totals.total - totals.client);
  return { people, contracts, totals };
}
// % medido da empreitada nas folhas anteriores (pela data de início; mesma data: pela ordem de criação)
const measuredBefore = (contractId, s) => r2(one(`SELECT COALESCE(SUM(sc.pct), 0) AS t FROM field_sheet_contracts sc JOIN field_sheets f ON f.id = sc.sheet_id
  WHERE sc.contract_id = ? AND sc.sheet_id <> ? AND (f.start_date < ? OR (f.start_date = ? AND f.id < ?))`, contractId, s.id, s.start_date, s.start_date, s.id).t);

const MONEY_PEOPLE = ['paid_at', 'rate', 'gross', 'adjust', 'adjust_note', 'total', 'client_paid', 'company', 'pix', 'pix_type', 'doc', 'paid_amount', 'payments'];
const MONEY_CONTRACT = ['paid_at', 'worker_id', 'contract_total', 'amount', 'client_paid', 'company', 'pix', 'pix_type', 'paid_amount', 'payments'];
const strip = (o, keys) => { const c = { ...o }; for (const k of keys) delete c[k]; return c; };

function paymentOf(s) {
  if (!s.obligation_id) return null;
  const it = one('SELECT id, status, due_date, amount_expected, paid_date FROM finance_items WHERE obligation_id = ? ORDER BY id LIMIT 1', s.obligation_id);
  return it ? { item_id: it.id, status: it.status, due_date: it.due_date, amount: it.amount_expected, paid_date: it.paid_date } : null;
}

export function listSheets(ctx, projectId) {
  const projects = fillableProjects(ctx);
  if (!projects.length && !canFieldMoney(ctx.user)) throw forbidden('A Folha de Campo não está liberada para o seu usuário.');
  const money = canFieldMoney(ctx.user);
  const ids = new Set(projects.map(p => p.id));
  const sheets = all(`SELECT f.*, p.code AS project_code, p.name AS project_name FROM field_sheets f JOIN projects p ON p.id = f.project_id ORDER BY f.start_date DESC, f.id DESC`)
    .filter(s => ids.has(s.project_id) && (!projectId || s.project_id === projectId))
    .map(s => {
      const c = computeSheet(s);
      const base = { id: s.id, code: fcCode(s.seq), project_id: s.project_id, project_code: s.project_code, project_name: s.project_name, start_date: s.start_date, end_date: s.end_date,
        status: s.status, people: c.people.length, contracts: c.contracts.length, diarias: c.totals.diarias };
      return money ? { ...base, totals: c.totals, payment: paymentOf(s) } : base;
    });
  // Resumo por obra: a Folha de Campo abre pela obra (cartões) e, dentro dela, o resumo e as folhas
  const wk = new Map(all(`SELECT wp.project_id, COUNT(*) AS n FROM field_worker_projects wp JOIN field_workers w ON w.id = wp.worker_id WHERE w.active = 1 GROUP BY 1`).map(r => [r.project_id, r.n]));
  const emp = new Map(all(`SELECT project_id, COUNT(*) AS n FROM field_contracts WHERE status = 'andamento' GROUP BY 1`).map(r => [r.project_id, r.n]));
  const overview = projects.filter(p => !projectId || p.id === projectId).map(p => {
    const list = sheets.filter(s => s.project_id === p.id);
    const o = { ...p, sheets: list.length, open: list.filter(s => s.status === 'aberta').length, last: list[0] ? { id: list[0].id, code: list[0].code, start_date: list[0].start_date, end_date: list[0].end_date, status: list[0].status } : null,
      diarias: r2(list.reduce((a, s) => a + s.diarias, 0)), workers: wk.get(p.id) || 0, contracts: emp.get(p.id) || 0 };
    if (!money) return o;
    o.debts = debtTotals(p.id);
    const pend = list.filter(s => s.payment && s.payment.status !== 'paga');
    return { ...o, total: r2(list.reduce((a, s) => a + s.totals.total, 0)), in_open: r2(list.filter(s => s.status === 'aberta').reduce((a, s) => a + s.totals.company, 0)),
      pending: r2(pend.reduce((a, s) => a + (s.payment.amount || 0), 0)), paid: r2(list.filter(s => s.payment?.status === 'paga').reduce((a, s) => a + (s.payment.amount || 0), 0)) };
  });
  return { sheets, projects, overview, can_money: money };
}

export function createSheet(ctx, body, ip) {
  const b = body || {};
  const projectId = intOrNull(b.project_id);
  if (!projectId) throw badRequest('Escolha a obra.');
  requireProject(ctx, projectId);
  const start = date(b.start_date, 'Início'), end = date(b.end_date, 'Fim');
  if (!start || !end) throw badRequest('Informe o início e o fim do período.');
  if (end < start) throw badRequest('O fim não pode ser antes do início.');
  if (daysOf(start, end).length > MAX_DAYS) throw badRequest(`O período da folha pode ter no máximo ${MAX_DAYS} dias.`);
  const id = tx(() => {
    const seq = (one('SELECT MAX(seq) AS m FROM field_sheets WHERE project_id = ?', projectId).m || 0) + 1;
    const nid = Number(run('INSERT INTO field_sheets (project_id, seq, start_date, end_date, created_by) VALUES (?,?,?,?,?)', projectId, seq, start, end, ctx.user.id).lastInsertRowid);
    // Começa com as pessoas (e o serviço a apropriar) da folha anterior da obra
    const prev = one('SELECT id FROM field_sheets WHERE project_id = ? AND id <> ? ORDER BY start_date DESC, id DESC LIMIT 1', projectId, nid);
    if (prev) for (const e of all('SELECT e.worker_id, e.service FROM field_sheet_people e JOIN field_workers w ON w.id = e.worker_id WHERE e.sheet_id = ? AND w.active = 1', prev.id))
      run('INSERT OR IGNORE INTO field_sheet_people (sheet_id, worker_id, service) VALUES (?,?,?)', nid, e.worker_id, e.service);
    return nid;
  });
  audit(ctx.user.id, 'field', id, 'Folha de campo criada', { obra: projectId, inicio: start, fim: end }, ip);
  return getSheet(ctx, id);
}

export function getSheet(ctx, id) {
  const { s, p } = loadSheet(ctx, id);
  const money = canFieldMoney(ctx.user);
  const c = computeSheet(s);
  const inSheet = new Set(c.people.map(e => e.worker_id));
  const inContracts = new Set(c.contracts.map(x => x.contract_id));
  const open = s.status === 'aberta';
  return {
    id: s.id, code: fcCode(s.seq), project: { id: p.id, code: p.code, name: p.name, client: p.client },
    start_date: s.start_date, end_date: s.end_date, days: daysOf(s.start_date, s.end_date), status: s.status, activities: s.activities,
    closed_at: s.closed_at, closed_by_name: s.closed_by ? one('SELECT name FROM users WHERE id = ?', s.closed_by)?.name : null,
    people: money ? c.people : c.people.map(e => strip(e, MONEY_PEOPLE)),
    contracts: money ? c.contracts : c.contracts.map(x => strip(x, MONEY_CONTRACT)),
    totals: money ? c.totals : { diarias: c.totals.diarias },
    pay_date: money ? s.pay_date : undefined,
    payment: money ? paymentOf(s) : undefined,
    // Profissionais ligados a esta obra (ou sem obra escolhida)
    available_workers: open ? all(`SELECT id, name, role, daily_rate AS rate FROM field_workers w WHERE active = 1 AND kind = 'diarista'
      AND (NOT EXISTS (SELECT 1 FROM field_worker_projects x WHERE x.worker_id = w.id) OR EXISTS (SELECT 1 FROM field_worker_projects x WHERE x.worker_id = w.id AND x.project_id = ?))
      ORDER BY name`, p.id).filter(w => !inSheet.has(w.id)).map(w => (money ? w : strip(w, ['rate']))) : [],
    available_contracts: open ? listContracts(ctx, p.id).filter(x => x.status === 'andamento' && !inContracts.has(x.id) && x.balance_pct > 0) : [],
    services: [...new Set([...all('SELECT name FROM project_stages WHERE project_id = ? ORDER BY sort_order, name', p.id).map(r => r.name),
      ...all('SELECT DISTINCT e.service FROM field_sheet_people e JOIN field_sheets f ON f.id = e.sheet_id WHERE f.project_id = ? AND e.service IS NOT NULL', p.id).map(r => r.service)])],
    can: { money, edit: open, close: money && open, reopen: money && !open, delete: open },
  };
}

// Salva a folha inteira (grade de diárias, serviços, empreitadas e atividades). Sem a seção, valores ficam como estão.
export function saveSheet(ctx, id, body, ip) {
  const { s } = loadSheet(ctx, id);
  openOnly(s);
  const money = canFieldMoney(ctx.user);
  const b = body || {};
  const valid = new Set(daysOf(s.start_date, s.end_date));
  const people = Array.isArray(b.people) ? b.people : null;
  const contracts = Array.isArray(b.contracts) ? b.contracts : null;
  tx(() => {
    if (b.activities !== undefined) run('UPDATE field_sheets SET activities = ? WHERE id = ?', str(b.activities, { max: 5000, label: 'Atividades desenvolvidas' }), s.id);
    if (money && b.pay_date !== undefined) run('UPDATE field_sheets SET pay_date = ? WHERE id = ?', date(b.pay_date, 'Data do pagamento'), s.id);
    if (people) {
      const keep = new Set();
      for (const x of people) {
        const wid = intOrNull(x.worker_id);
        const w = wid && one('SELECT * FROM field_workers WHERE id = ?', wid);
        if (!w) throw badRequest('Profissional inválido.');
        const days = {};
        for (const [d, v] of Object.entries(x.days || {})) {
          if (!valid.has(d)) throw badRequest('Dia fora do período da folha.');
          const n = num(v, `Diária de ${w.name}`, { max: 2 });
          if (n) days[d] = n;
        }
        const cur = one('SELECT * FROM field_sheet_people WHERE sheet_id = ? AND worker_id = ?', s.id, wid);
        const service = str(x.service, { max: 120, label: 'Serviço a apropriar' });
        const clientPaid = money ? num(x.client_paid, `Pago pelo cliente (${w.name})`, { max: 1e9 }) : cur?.client_paid || 0;
        const adjust = money ? num(x.adjust, `Ajuste (${w.name})`, { min: -1e9, max: 1e9 }) : cur?.adjust || 0;
        const adjustNote = money ? str(x.adjust_note, { max: 200, label: 'Motivo do ajuste' }) : cur?.adjust_note ?? null;
        if (cur) run('UPDATE field_sheet_people SET days=?, service=?, client_paid=?, adjust=?, adjust_note=? WHERE id=?', JSON.stringify(days), service, clientPaid, adjust, adjustNote, cur.id);
        else run('INSERT INTO field_sheet_people (sheet_id, worker_id, days, service, client_paid, adjust, adjust_note) VALUES (?,?,?,?,?,?,?)', s.id, wid, JSON.stringify(days), service, clientPaid, adjust, adjustNote);
        keep.add(wid);
      }
      for (const e of all('SELECT id, worker_id FROM field_sheet_people WHERE sheet_id = ?', s.id)) if (!keep.has(e.worker_id)) run('DELETE FROM field_sheet_people WHERE id = ?', e.id);
    }
    if (contracts) {
      const keep = new Set();
      for (const x of contracts) {
        const cid = intOrNull(x.contract_id);
        const c = cid && one('SELECT * FROM field_contracts WHERE id = ? AND project_id = ?', cid, s.project_id);
        if (!c) throw badRequest('Empreitada inválida para esta obra.');
        const pct = num(x.pct, `% medido (${c.service})`, { max: 100 });
        if (r2(measuredPct(cid, s.id) + pct) > 100) throw badRequest(`A empreitada "${c.service}" passaria de 100% medido (já medido ${measuredPct(cid, s.id)}%).`);
        const cur = one('SELECT * FROM field_sheet_contracts WHERE sheet_id = ? AND contract_id = ?', s.id, cid);
        const clientPaid = money ? num(x.client_paid, `Pago pelo cliente (${c.service})`, { max: 1e9 }) : cur?.client_paid || 0;
        const notes = str(x.notes, { max: 300, label: 'Observação da empreitada' });
        if (cur) run('UPDATE field_sheet_contracts SET pct=?, client_paid=?, notes=? WHERE id=?', pct, clientPaid, notes, cur.id);
        else run('INSERT INTO field_sheet_contracts (sheet_id, contract_id, pct, client_paid, notes) VALUES (?,?,?,?,?)', s.id, cid, pct, clientPaid, notes);
        keep.add(cid);
      }
      for (const x of all('SELECT id, contract_id FROM field_sheet_contracts WHERE sheet_id = ?', s.id)) if (!keep.has(x.contract_id)) run('DELETE FROM field_sheet_contracts WHERE id = ?', x.id);
    }
    run(`UPDATE field_sheets SET updated_at = datetime('now') WHERE id = ?`, s.id);
  });
  audit(ctx.user.id, 'field', s.id, 'Folha de campo salva', { folha: fcCode(s.seq) }, ip);
  return getSheet(ctx, s.id);
}

export function deleteSheet(ctx, id, ip) {
  const { s } = loadSheet(ctx, id);
  openOnly(s);
  run('DELETE FROM field_sheets WHERE id = ?', s.id);
  audit(ctx.user.id, 'field', s.id, 'Folha de campo excluída', { folha: fcCode(s.seq), obra: s.project_id }, ip);
  return { ok: true };
}

const brl = v => (Number(v) || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const dm = d => `${d.slice(8, 10)}/${d.slice(5, 7)}`;
const pixText = x => (x.pix ? ` — PIX${x.pix_type ? ` (${x.pix_type})` : ''} ${x.pix}` : '');

// Fechar: congela diária, valores e PIX e gera o pagamento (parte da empresa) no Financeiro
export function closeSheet(ctx, id, body, ip) {
  requireMoney(ctx);
  const { s, p } = loadSheet(ctx, id);
  openOnly(s);
  const payDate = date(body?.pay_date, 'Data do pagamento') || s.pay_date || today();
  const c = computeSheet(s);
  if (!c.people.length && !c.contracts.length) throw badRequest('A folha não tem pessoas nem empreitadas.');
  const snap = {
    people: Object.fromEntries(c.people.map(e => [e.id, { name: e.name, role: e.role, rate: e.rate, pix: e.pix, pix_type: e.pix_type, doc: e.doc }])),
    contracts: Object.fromEntries(c.contracts.map(x => [x.id, { service: x.service, worker_name: x.worker_name, total: x.contract_total, pix: x.pix, pix_type: x.pix_type }])),
  };
  const lines = [...c.people.filter(e => e.company > 0).map(e => `· ${e.name} (${e.diarias} diária(s)): ${brl(e.company)}${pixText(e)}`),
    ...c.contracts.filter(x => x.company > 0).map(x => `· ${x.worker_name} — empreitada ${x.service} (${x.pct}%): ${brl(x.company)}${pixText(x)}`)];
  const amount = r2(c.people.reduce((a, e) => a + Math.max(0, e.company), 0) + c.contracts.reduce((a, x) => a + Math.max(0, x.company), 0));
  const title = `Folha de Campo ${p.code} ${fcCode(s.seq)} — ${dm(s.start_date)} a ${dm(s.end_date)}`;
  tx(() => {
    let obligation = null;
    if (amount > 0) {
      obligation = createObligationInternal(ctx.user.id, {
        title, category: 'Folha de pagamento', payee: `Mão de obra — ${p.name}`, amount, due_day: Number(payDate.slice(8, 10)), month: payDate.slice(0, 7), assignee_id: ctx.user.id,
        notes: [`${p.code} · ${p.name} · período ${dm(s.start_date)} a ${dm(s.end_date)}`, 'Pagamentos (parte da empresa):', ...lines,
          c.totals.client ? `Pago pelo cliente (fora deste pagamento): ${brl(c.totals.client)}` : ''].filter(Boolean).join('\n'),
      });
      run('UPDATE finance_items SET due_date = ? WHERE obligation_id = ?', payDate, obligation);
      run('UPDATE tasks SET due_date = ?, start_date = ? WHERE id IN (SELECT task_id FROM finance_items WHERE obligation_id = ?)', payDate, payDate, obligation);
    }
    run(`UPDATE field_sheets SET status = 'fechada', snapshot = ?, pay_date = ?, obligation_id = ?, closed_at = ?, closed_by = ?, updated_at = datetime('now') WHERE id = ?`,
      JSON.stringify(snap), payDate, obligation, new Date().toISOString(), ctx.user.id, s.id);
  });
  audit(ctx.user.id, 'field', s.id, 'Folha de campo fechada', { folha: `${p.code} ${fcCode(s.seq)}`, pagamento: amount }, ip);
  return { ...getSheet(ctx, s.id), generated: amount > 0 };
}

// Reabrir: só se o pagamento não foi registrado; remove o pagamento pendente gerado
export function reopenSheet(ctx, id, ip) {
  requireMoney(ctx);
  const { s, p } = loadSheet(ctx, id);
  if (s.status !== 'fechada') throw badRequest('A folha já está aberta.');
  if (s.obligation_id && obligationPaid(s.obligation_id)) throw badRequest('O pagamento desta folha já foi registrado no Financeiro. Desfaça o pagamento antes de reabrir.');
  if (linesPaid(s.id)) throw badRequest('Há pessoas marcadas como pagas nesta folha. Desfaça esses pagamentos antes de reabrir.');
  tx(() => {
    if (s.obligation_id) removeObligationInternal(s.obligation_id, ctx.user.id, `Folha de Campo ${p.code} ${fcCode(s.seq)} reaberta para correção`);
    run(`UPDATE field_sheets SET status = 'aberta', snapshot = NULL, obligation_id = NULL, closed_at = NULL, closed_by = NULL, updated_at = datetime('now') WHERE id = ?`, s.id);
  });
  audit(ctx.user.id, 'field', s.id, 'Folha de campo reaberta', { folha: `${p.code} ${fcCode(s.seq)}` }, ip);
  return getSheet(ctx, s.id);
}

// ---------- Consolidado da obra: por profissional e por empreitada ----------
export function summary(ctx, projectId) {
  requireMoney(ctx);
  const p = requireProject(ctx, projectId);
  const sheets = all('SELECT * FROM field_sheets WHERE project_id = ? ORDER BY start_date, id', p.id);
  const byWorker = new Map();
  let open = 0, pending = 0, paid = 0;
  for (const s of sheets) {
    const c = computeSheet(s);
    const pay = paymentOf(s);
    const state = s.status === 'aberta' ? 'aberta' : pay?.status === 'paga' ? 'paga' : pay ? 'pendente' : 'sem_pagamento';
    for (const e of c.people) {
      const w = byWorker.get(e.worker_id) || { worker_id: e.worker_id, name: e.name, role: e.role, sheets: 0, diarias: 0, total: 0, client: 0, company_paid: 0, company_pending: 0, open: 0 };
      w.sheets++; w.diarias = r2(w.diarias + e.diarias); w.total = r2(w.total + e.total); w.client = r2(w.client + e.client_paid);
      if (state === 'aberta') w.open = r2(w.open + e.company);
      else if (state === 'pendente' && !e.paid_at) w.company_pending = r2(w.company_pending + Math.max(0, e.company));
      else w.company_paid = r2(w.company_paid + Math.max(0, e.company));
      byWorker.set(e.worker_id, w);
    }
    const company = r2(c.totals.company);
    const paidLines = state === 'pendente' ? r2([...c.people, ...c.contracts].filter(x => x.paid_at && x.company > 0).reduce((t, x) => t + x.company, 0)) : 0;
    if (state === 'aberta') open = r2(open + company); else if (state === 'pendente') { pending = r2(pending + company - paidLines); paid = r2(paid + paidLines); } else paid = r2(paid + company);
  }
  const contracts = listContracts(ctx, p.id);
  return {
    project: { id: p.id, code: p.code, name: p.name },
    sheets: sheets.length,
    workers: [...byWorker.values()].sort((a, b) => b.total - a.total),
    contracts,
    totals: { open, pending, paid, contracts_total: r2(contracts.reduce((a, c) => a + c.total, 0)), contracts_measured: r2(contracts.reduce((a, c) => a + c.measured, 0)) },
  };
}

// ---------- Resumo por obra e análise (seção folha_campo) ----------
// Cada folha entra no mês do seu fim. Filtros: período (AAAA-MM a AAAA-MM) e obra.
const ymOk = v => (/^\d{4}-(0[1-9]|1[0-2])$/.test(v || '') ? v : null);
export function analysis(ctx, { from, to, obra } = {}) {
  requireMoney(ctx);
  const projects = fillableProjects(ctx);
  const ids = new Set(projects.map(p => p.id));
  const f = ymOk(from), t = ymOk(to);
  if (f && t && t < f) throw badRequest('O fim do período não pode ser antes do início.');
  const sheets = all('SELECT * FROM field_sheets ORDER BY end_date, id').filter(s => ids.has(s.project_id) && (!obra || s.project_id === obra)
    && (!f || s.end_date.slice(0, 7) >= f) && (!t || s.end_date.slice(0, 7) <= t));
  const byObra = new Map(), byMonth = new Map(), byService = new Map(), byRole = new Map(), byWorker = new Map();
  const add = (m, k, init) => { if (!m.has(k)) m.set(k, init()); return m.get(k); };
  const tot = { sheets: 0, diarias: 0, people: 0, contracts: 0, client: 0, company: 0, paid: 0, pending: 0, open: 0, workdays: 0 };
  for (const s of sheets) {
    const c = computeSheet(s);
    const pay = paymentOf(s);
    const state = s.status === 'aberta' ? 'open' : pay?.status === 'paga' || !pay ? 'paid' : 'pending';
    const p = projects.find(x => x.id === s.project_id);
    const o = add(byObra, s.project_id, () => ({ project_id: p.id, code: p.code, name: p.name, status: p.status, sheets: 0, diarias: 0, people: 0, contracts: 0, client: 0, company: 0, paid: 0, pending: 0, open: 0, workdays: 0, last_end: null, open_sheets: 0 }));
    // Já pago da folha pendente: pagamentos registrados (inclusive parciais) e quem foi marcado como pago
    const paidLines = state === 'pending' ? r2([...c.people, ...c.contracts].filter(x => x.company > 0).reduce((t, x) => t + Math.min(x.company, x.paid_amount || 0), 0)) : 0;
    const workdays = new Set(c.people.flatMap(e => Object.keys(e.days).filter(d => Number(e.days[d]) > 0))).size;
    const company = Math.max(0, c.totals.company);
    for (const x of [o, tot]) {
      x.sheets++; x.diarias = r2(x.diarias + c.totals.diarias); x.people = r2(x.people + c.totals.people); x.contracts = r2(x.contracts + c.totals.contracts);
      x.client = r2(x.client + c.totals.client); x.company = r2(x.company + company); x.workdays += workdays;
      if (state === 'pending') { x.pending = r2(x.pending + company - paidLines); x.paid = r2(x.paid + paidLines); } else x[state] = r2(x[state] + company);
    }
    o.last_end = s.end_date; if (s.status === 'aberta') o.open_sheets++;
    const mo = add(byMonth, s.end_date.slice(0, 7), () => ({ month: s.end_date.slice(0, 7), people: 0, contracts: 0, diarias: 0 }));
    mo.people = r2(mo.people + c.totals.people); mo.contracts = r2(mo.contracts + c.totals.contracts); mo.diarias = r2(mo.diarias + c.totals.diarias);
    for (const e of c.people) {
      const sv = add(byService, e.service || 'Sem apropriação', () => ({ name: e.service || 'Sem apropriação', people: 0, contracts: 0, diarias: 0 }));
      sv.people = r2(sv.people + e.total); sv.diarias = r2(sv.diarias + e.diarias);
      const rl = add(byRole, e.role || 'Sem função', () => ({ name: e.role || 'Sem função', diarias: 0, total: 0, workers: new Set() }));
      rl.diarias = r2(rl.diarias + e.diarias); rl.total = r2(rl.total + e.total); rl.workers.add(e.worker_id);
      const wk = add(byWorker, e.worker_id, () => ({ worker_id: e.worker_id, name: e.name, role: e.role, kind: 'diarista', diarias: 0, total: 0, obras: new Set() }));
      wk.diarias = r2(wk.diarias + e.diarias); wk.total = r2(wk.total + e.total); wk.obras.add(p.code);
    }
    for (const x of c.contracts) {
      const sv = add(byService, x.service, () => ({ name: x.service, people: 0, contracts: 0, diarias: 0 }));
      sv.contracts = r2(sv.contracts + x.amount);
      const wk = add(byWorker, `e${x.worker_name}`, () => ({ name: x.worker_name, role: 'Empreiteiro', kind: 'empreiteiro', diarias: 0, total: 0, obras: new Set() }));
      wk.total = r2(wk.total + x.amount); wk.obras.add(p.code);
    }
  }
  const fin = o => ({ ...o, total: r2(o.people + o.contracts), avg_daily: o.diarias ? r2(o.people / o.diarias) : 0, avg_team: o.workdays ? r2(o.diarias / o.workdays) : 0 });
  const months = [...byMonth.values()].sort((a, b) => a.month.localeCompare(b.month)).map(m => ({ ...m, total: r2(m.people + m.contracts) }));
  // Medição do terceiro e dívidas anteriores de cada obra (situação até hoje, não depende do período)
  const zeroMeas = () => ({ count: 0, measured: 0, covered: 0, paid_more: 0, prior: 0, left_over: 0, saldo: 0 });
  const zeroDebt = () => ({ empresa_deve: 0, profissional_deve: 0, pago_mais: 0 });
  const tm = zeroMeas(), td = zeroDebt();
  const obras = [...byObra.values()].map(fin).map(o => {
    const m = listMeasurements(ctx, o.project_id);
    const d = debtTotals(o.project_id);
    const meas = { count: m.measurements.length, measured: m.totals.measured, covered: m.totals.covered, paid_more: r2(m.totals.paid_more + m.totals.paid_more_prior),
      prior: m.totals.paid_more_prior, left_over: m.totals.left_over, saldo: r2(m.totals.diff - m.totals.paid_more_prior) };
    for (const k of Object.keys(tm)) tm[k] = r2(tm[k] + meas[k]);
    for (const k of Object.keys(td)) td[k] = r2(td[k] + d[k]);
    return { ...o, meas, debts: { empresa_deve: d.empresa_deve, profissional_deve: d.profissional_deve, pago_mais: d.pago_mais } };
  });
  return {
    filters: { from: f, to: t, obra: obra || null },
    projects,
    totals: { ...fin(tot), meas: tm, debts: td },
    obras: obras.sort((a, b) => b.total - a.total),
    months,
    services: [...byService.values()].map(x => ({ ...x, total: r2(x.people + x.contracts) })).sort((a, b) => b.total - a.total),
    roles: [...byRole.values()].map(x => ({ name: x.name, diarias: x.diarias, total: x.total, workers: x.workers.size, avg_daily: x.diarias ? r2(x.total / x.diarias) : 0 })).sort((a, b) => b.total - a.total),
    workers: [...byWorker.values()].map(x => ({ name: x.name, role: x.role, kind: x.kind, diarias: x.diarias, total: x.total, obras: [...x.obras] })).sort((a, b) => b.total - a.total).slice(0, 15),
    contracts: listContracts(ctx).filter(c => !obra || c.project_id === obra),
  };
}

// ---------- Pagamentos: quem recebe, quanto e o PIX (parte da empresa ainda não paga) ----------
// Folhas fechadas com pagamento pendente no Financeiro ("a pagar") e folhas abertas ("previsto").
export function payments(ctx, projectId, showPaid = false) {
  requireMoney(ctx);
  const ids = new Set(fillableProjects(ctx).map(p => p.id));
  const groups = new Map();
  const totals = { pending: 0, open: 0, paid: 0 };
  for (const s of all(`SELECT f.*, p.code AS project_code, p.name AS project_name FROM field_sheets f JOIN projects p ON p.id = f.project_id ORDER BY f.end_date, f.id`)) {
    if (!ids.has(s.project_id) || (projectId && s.project_id !== projectId)) continue;
    const pay = paymentOf(s);
    const sheetPaid = s.status === 'fechada' && (!pay || pay.status === 'paga');
    if (sheetPaid && !showPaid) continue;
    const c = computeSheet(s);
    const lines = [...c.people.map(e => ({ line: `p${e.id}`, paid_at: e.paid_at, worker_id: e.worker_id, name: e.name, role: e.role, pix: e.pix, pix_type: e.pix_type, doc: e.doc, amount: e.company, paid_amount: e.paid_amount, payments: e.payments, what: `${n2txt(e.diarias)} diária(s)${e.service ? ` · ${e.service}` : ''}` })),
      ...c.contracts.map(x => ({ line: `c${x.id}`, paid_at: x.paid_at, worker_id: x.worker_id, name: x.worker_name, role: 'Empreiteiro', pix: x.pix, pix_type: x.pix_type, doc: null, amount: x.company, paid_amount: x.paid_amount, payments: x.payments, what: `Empreitada ${x.service} (${n2txt(x.pct)}%)` }))];
    for (const l of lines) {
      if (!(l.amount > 0)) continue;
      const state = s.status === 'aberta' ? 'open' : l.paid_at || sheetPaid ? 'paid' : 'pending';
      if (state === 'paid' && !showPaid) continue;
      const g = groups.get(l.worker_id) || { worker_id: l.worker_id, name: l.name, role: l.role, pix: l.pix, pix_type: l.pix_type, doc: l.doc, pending: 0, open: 0, paid: 0, items: [] };
      if (!g.pix && l.pix) { g.pix = l.pix; g.pix_type = l.pix_type; }
      // Pago em parte: o já pago conta como pago e só o restante fica a pagar
      const partPaid = state === 'pending' ? Math.min(l.amount, l.paid_amount || 0) : 0;
      const rest = r2(l.amount - partPaid);
      g[state] = r2(g[state] + rest);
      if (partPaid) { g.paid = r2(g.paid + partPaid); totals.paid = r2(totals.paid + partPaid); }
      g.items.push({ sheet_id: s.id, line: l.line, code: `${s.project_code} ${fcCode(s.seq)}`, project_name: s.project_name, period: `${dm(s.start_date)} a ${dm(s.end_date)}`, state,
        paid_at: l.paid_at || (state === 'paid' ? pay?.paid_date || null : null), due_date: pay?.due_date || s.pay_date || null, amount: rest, total: r2(l.amount), paid_amount: partPaid,
        payments: l.payments || [], what: l.what });
      groups.set(l.worker_id, g);
      totals[state] = r2(totals[state] + rest);
    }
  }
  // Dívidas anteriores da pessoa: separadas das folhas (não entram no "Marcar pago"); a empresa deve = a receber (+),
  // o profissional deve = desconto (−). Quitadas só com "Mostrar pagos".
  totals.debt_owed = 0; totals.debt_due = 0;
  for (const d of all(`${DEBT_SQL} WHERE d.kind IN ('empresa_deve', 'profissional_deve') ORDER BY d.origin_date, d.id`)) {
    if (!ids.has(d.project_id) || (projectId && d.project_id !== projectId) || (d.status === 'quitada' && !showPaid)) continue;
    const w = one('SELECT id, name, role, pix, pix_type, doc FROM field_workers WHERE id = ?', d.worker_id);
    if (!w) continue;
    const g = groups.get(w.id) || { worker_id: w.id, name: w.name, role: w.role, pix: w.pix, pix_type: w.pix_type, doc: w.doc, pending: 0, open: 0, paid: 0, items: [] };
    const signed = d.kind === 'empresa_deve' ? d.amount : -d.amount;
    if (!g.debts) { g.debts = []; g.debt = 0; g.debt_owed = 0; g.debt_due = 0; }
    if (d.status === 'aberta') {
      g.debt = r2(g.debt + signed);
      // Separado: a empresa deve à pessoa (+) · a pessoa deve à empresa (adiantamento pendente)
      if (signed > 0) g.debt_owed = r2(g.debt_owed + signed); else g.debt_due = r2(g.debt_due - signed);
      if (signed > 0) totals.debt_owed = r2(totals.debt_owed + signed); else totals.debt_due = r2(totals.debt_due - signed);
    }
    const p = one('SELECT code, name FROM projects WHERE id = ?', d.project_id);
    g.debts.push({ id: d.id, kind: d.kind, kind_label: DEBT_KINDS[d.kind], amount: d.amount, signed, reason: d.reason, origin_date: d.origin_date, status: d.status,
      settled_date: d.settled_date, project_code: p?.code, project_name: p?.name, project_id: d.project_id });
    groups.set(w.id, g);
  }
  // PIX atual do cadastro quando a folha não tinha
  for (const g of groups.values()) if (!g.pix) { const w = one('SELECT pix, pix_type FROM field_workers WHERE id = ?', g.worker_id); if (w?.pix) { g.pix = w.pix; g.pix_type = w.pix_type; } }
  return {
    people: [...groups.values()].map(g => ({ ...g, debts: g.debts || [], debt: g.debt || 0, debt_owed: g.debt_owed || 0, debt_due: g.debt_due || 0, total: r2(g.pending + g.open) })).sort((a, b) => b.pending - a.pending || b.total - a.total || b.paid - a.paid || Math.abs(b.debt || 0) - Math.abs(a.debt || 0)),
    totals: { ...totals, total: r2(totals.pending + totals.open) },
    projects: fillableProjects(ctx),
  };
}
const n2txt = v => String(r2(v)).replace('.', ',');

// ---------- Marcar como pago (por pessoa / empreiteiro) ----------
// Só em folha fechada. Quando todos os valores da folha estão pagos, a parcela do Financeiro é baixada (e a tarefa concluída);
// ao desfazer, volta a pendente.
const linesPaid = sheetId => one(`SELECT (SELECT COUNT(*) FROM field_sheet_people WHERE sheet_id = ? AND paid_at IS NOT NULL) + (SELECT COUNT(*) FROM field_sheet_contracts WHERE sheet_id = ? AND paid_at IS NOT NULL)
  + (SELECT COUNT(*) FROM field_payments WHERE sheet_id = ?) AS n`, sheetId, sheetId, sheetId).n;
function lineRef(ref) {
  const m = /^([pc])(\d+)$/.exec(String(ref || ''));
  if (!m) throw badRequest('Lançamento inválido.');
  const table = m[1] === 'p' ? 'field_sheet_people' : 'field_sheet_contracts';
  const row = one(`SELECT * FROM ${table} WHERE id = ?`, Number(m[2]));
  if (!row) throw notFound('Lançamento não encontrado.');
  return { table, row };
}
function syncSheetPayment(s, userId) {
  const pay = paymentOf(s);
  if (!pay) return;
  const c = computeSheet(s);
  const due = [...c.people, ...c.contracts].filter(x => x.company > 0);
  const allPaid = due.length && due.every(x => x.paid_at);
  if (allPaid && pay.status !== 'paga') payItemInternal(pay.item_id, userId, due.map(x => x.paid_at).sort().pop(), 'todos marcados como pagos na Folha de Campo');
  if (!allPaid && pay.status === 'paga') unpayItemInternal(pay.item_id, userId, 'Pagamento desfeito na Folha de Campo');
}
// Pagar: registra o valor pago (um lançamento só: valor informado, pode ser parcial; vários: o que falta de cada um),
// a data, a observação e o comprovante (foto ou PDF). A pessoa fica paga quando a soma cobre o valor devido.
// Desfazer: apaga os pagamentos registrados do lançamento e volta a ficar a pagar.
const PAY_EPS = 0.005;
export function markPaid(ctx, body, ip) {
  requireMoney(ctx);
  const b = body || {};
  const refs = [...new Set(Array.isArray(b.lines) ? b.lines : [])];
  if (!refs.length) throw badRequest('Escolha quem foi pago.');
  const paid = b.paid !== false;
  const pd = paid ? date(b.paid_date, 'Data do pagamento') || today() : null;
  if (pd && pd > today()) throw badRequest('A data do pagamento não pode ser no futuro.');
  const files = paid && Array.isArray(b.files) ? b.files.slice(0, 10) : [];
  const sheets = new Map();
  let partial = 0, total = 0;
  tx(() => {
    let batch = null;
    if (paid) {
      batch = Number(run('INSERT INTO field_pay_batches (paid_date, total, notes, created_by) VALUES (?,?,?,?)', pd, 0, str(b.notes, { max: 500, label: 'Observação do pagamento' }), ctx.user.id).lastInsertRowid);
      for (const f of files) {
        const saved = saveImageFromDataUrl(f?.data);
        run('INSERT INTO field_pay_files (batch_id, stored_name, mime, size, original_name, uploaded_by) VALUES (?,?,?,?,?,?)', batch, saved.stored_name, saved.mime, saved.size, cleanFileName(f.name), ctx.user.id);
      }
    }
    const removed = new Set();
    for (const ref of refs) {
      const { table, row } = lineRef(ref);
      const { s } = loadSheet(ctx, row.sheet_id);
      if (s.status !== 'fechada') throw badRequest('Feche a folha antes de marcar pagamentos (os valores ainda podem mudar).');
      if (!paid) {
        const pay = paymentOf(s);
        if (!row.paid_at && pay?.status === 'paga') {
          // Pago direto no Financeiro: desfazer um vale para a folha toda (os demais ficam marcados como pagos)
          for (const t of ['field_sheet_people', 'field_sheet_contracts']) run(`UPDATE ${t} SET paid_at = ?, paid_by = ? WHERE sheet_id = ? AND paid_at IS NULL`, pay.paid_date || today(), ctx.user.id, s.id);
        }
        for (const r of all('SELECT DISTINCT batch_id FROM field_payments WHERE sheet_id = ? AND line = ?', s.id, ref)) removed.add(r.batch_id);
        run('DELETE FROM field_payments WHERE sheet_id = ? AND line = ?', s.id, ref);
        run(`UPDATE ${table} SET paid_at = NULL, paid_by = NULL WHERE id = ?`, row.id);
      } else {
        const c = computeSheet(s);
        const line = [...c.people.map(e => ({ ...e, ref: `p${e.id}` })), ...c.contracts.map(x => ({ ...x, ref: `c${x.id}` }))].find(x => x.ref === ref);
        const due = r2(Math.max(0, line.company) - line.paid_amount);
        if (due <= PAY_EPS && line.paid_at) throw badRequest(`${line.name || line.worker_name} já está pago nesta folha.`);
        const amount = refs.length === 1 && b.amount !== undefined && b.amount !== '' ? num(b.amount, 'Valor pago', { max: 1e9 }) : due;
        if (!(amount > 0)) throw badRequest('Informe o valor pago.');
        run('INSERT INTO field_payments (batch_id, sheet_id, line, amount, paid_date, created_by) VALUES (?,?,?,?,?,?)', batch, s.id, ref, amount, pd, ctx.user.id);
        total = r2(total + amount);
        if (amount + PAY_EPS >= due) run(`UPDATE ${table} SET paid_at = ?, paid_by = ? WHERE id = ?`, pd, ctx.user.id, row.id);
        else partial++;
      }
      sheets.set(s.id, s);
    }
    if (batch) run('UPDATE field_pay_batches SET total = ? WHERE id = ?', total, batch);
    // Lotes que ficaram sem pagamentos (desfeitos): apaga junto com os comprovantes
    for (const id of removed) {
      if (one('SELECT 1 FROM field_payments WHERE batch_id = ?', id)) continue;
      for (const f of all('SELECT stored_name FROM field_pay_files WHERE batch_id = ?', id)) deleteStored(f.stored_name);
      run('DELETE FROM field_pay_batches WHERE id = ?', id);
    }
    for (const s of sheets.values()) syncSheetPayment(s, ctx.user.id);
  });
  audit(ctx.user.id, 'field', null, paid ? (partial ? 'Pagamento parcial registrado (Folha de Campo)' : 'Pagamento marcado (Folha de Campo)') : 'Pagamento desfeito (Folha de Campo)',
    { lancamentos: refs.length, data: pd, valor: paid ? total : undefined, comprovantes: files.length || undefined }, ip);
  return { ok: true, count: refs.length, partial, total };
}
export function payFileForUser(ctx, fileId) {
  requireMoney(ctx);
  const f = one('SELECT * FROM field_pay_files WHERE id = ?', fileId);
  if (!f) throw notFound('Arquivo não encontrado.');
  const p = one('SELECT sheet_id FROM field_payments WHERE batch_id = ? LIMIT 1', f.batch_id);
  if (!p) throw notFound('Arquivo não encontrado.');
  loadSheet(ctx, p.sheet_id);
  return f;
}

// ---------- Medição do terceiro (BM) x folhas da obra ----------
// O terceiro mede o serviço (BM) e essa medição deveria cobrir as folhas da obra. Compara o valor medido com o total
// das folhas cobertas (mão de obra + empreitadas): folhas acima do medido = pago a mais; abaixo = pago a menos.
const MEAS_DIFF = 0.005;
function measurementView(m, sheetsById) {
  const ids = all('SELECT sheet_id FROM field_measurement_sheets WHERE measurement_id = ?', m.id).map(r => r.sheet_id);
  const list = ids.map(id => sheetsById.get(id)).filter(Boolean).sort((a, b) => a.start_date.localeCompare(b.start_date));
  const sheetsTotal = r2(list.reduce((a, s) => a + s.total, 0));
  const diff = r2(m.amount - sheetsTotal);
  return {
    id: m.id, project_id: m.project_id, supplier: m.supplier, ref_date: m.ref_date, amount: m.amount, notes: m.notes,
    sheets: list.map(s => ({ id: s.id, code: s.code, start_date: s.start_date, end_date: s.end_date, total: s.total, status: s.status })),
    sheets_total: sheetsTotal, diff,
    result: !list.length ? 'sem_folhas' : Math.abs(diff) < MEAS_DIFF ? 'igual' : diff > 0 ? 'pago_menos' : 'pago_mais',
    files: all('SELECT id, mime, size, original_name, created_at FROM field_measurement_files WHERE measurement_id = ? ORDER BY id', m.id),
  };
}
export function listMeasurements(ctx, projectId) {
  requireMoney(ctx);
  const p = requireProject(ctx, projectId);
  const link = new Map(all(`SELECT ms.sheet_id, ms.measurement_id FROM field_measurement_sheets ms JOIN field_measurements m ON m.id = ms.measurement_id WHERE m.project_id = ?`, p.id)
    .map(r => [r.sheet_id, r.measurement_id]));
  const sheets = all('SELECT * FROM field_sheets WHERE project_id = ? ORDER BY start_date, id', p.id).map(s => {
    const t = computeSheet(s).totals;
    return { id: s.id, code: fcCode(s.seq), start_date: s.start_date, end_date: s.end_date, status: s.status, total: t.total, company: t.company, measurement_id: link.get(s.id) || null };
  });
  const byId = new Map(sheets.map(s => [s.id, s]));
  const measurements = all('SELECT * FROM field_measurements WHERE project_id = ? ORDER BY ref_date DESC, id DESC', p.id).map(m => measurementView(m, byId));
  const measured = r2(measurements.reduce((a, m) => a + m.amount, 0));
  const covered = r2(measurements.reduce((a, m) => a + m.sheets_total, 0));
  const open = sheets.filter(s => !s.measurement_id);
  return {
    project: { id: p.id, code: p.code, name: p.name },
    measurements, sheets,
    suppliers: all(`SELECT DISTINCT supplier FROM field_measurements WHERE supplier IS NOT NULL AND supplier <> '' ORDER BY supplier`).map(r => r.supplier),
    // Saldo perante as medições: soma do que foi pago a mais (folhas acima do medido) e do que sobra (medido acima das folhas)
    totals: { measured, covered, diff: r2(measured - covered), uncovered_sheets: open.length, uncovered_total: r2(open.reduce((a, s) => a + s.total, 0)),
      paid_more: r2(measurements.filter(m => m.sheets.length && m.diff < 0).reduce((a, m) => a - m.diff, 0)),
      left_over: r2(measurements.filter(m => m.sheets.length && m.diff > 0).reduce((a, m) => a + m.diff, 0)),
      // Pago a mais anterior (dívidas em aberto do tipo pago_mais): somado ao pago a mais, discriminado
      paid_more_prior: debtTotals(p.id).pago_mais },
  };
}
function readMeasurement(b, projectId, currentId = 0) {
  const d = {
    supplier: str(b.supplier, { max: 120, label: 'Terceiro' }),
    ref_date: date(b.ref_date, 'Data da medição'),
    amount: num(b.amount, 'Valor da medição', { max: 1e9 }),
    notes: str(b.notes, { max: 1000, label: 'Observações' }),
  };
  if (!d.ref_date) throw badRequest('Informe a data da medição.');
  if (!d.amount) throw badRequest('Informe o valor da medição.');
  const ids = [...new Set((Array.isArray(b.sheet_ids) ? b.sheet_ids : []).map(intOrNull).filter(Boolean))];
  for (const id of ids) {
    const s = one('SELECT id, seq FROM field_sheets WHERE id = ? AND project_id = ?', id, projectId);
    if (!s) throw badRequest('Folha inválida para esta obra.');
    const other = one('SELECT measurement_id FROM field_measurement_sheets WHERE sheet_id = ? AND measurement_id <> ?', id, currentId);
    if (other) throw badRequest(`A folha ${fcCode(s.seq)} já está em outra medição.`);
  }
  return { ...d, sheet_ids: ids };
}
function addMeasurementFiles(ctx, id, files) {
  const list = Array.isArray(files) ? files.slice(0, 10) : [];
  // BM só em PDF (é unido ao PDF do relatório); o tipo é confirmado pelo conteúdo do arquivo
  if (list.some(f => !String(f?.data || '').startsWith('data:application/pdf;base64,'))) throw badRequest('O BM precisa ser um arquivo PDF.');
  for (const f of list) {
    const saved = saveImageFromDataUrl(f?.data);
    if (saved.mime !== 'application/pdf') { deleteStored(saved.stored_name); throw badRequest('O BM precisa ser um arquivo PDF.'); }
    run('INSERT INTO field_measurement_files (measurement_id, stored_name, mime, size, original_name, uploaded_by) VALUES (?,?,?,?,?,?)', id, saved.stored_name, saved.mime, saved.size, cleanFileName(f.name), ctx.user.id);
  }
  return list.length;
}
const setMeasurementSheets = (id, ids) => {
  run('DELETE FROM field_measurement_sheets WHERE measurement_id = ?', id);
  for (const s of ids) run('INSERT INTO field_measurement_sheets (measurement_id, sheet_id) VALUES (?, ?)', id, s);
};
function loadMeasurement(ctx, id) {
  requireMoney(ctx);
  const m = one('SELECT * FROM field_measurements WHERE id = ?', id);
  if (!m) throw notFound('Medição não encontrada.');
  requireProject(ctx, m.project_id);
  return m;
}
export function createMeasurement(ctx, body, ip) {
  requireMoney(ctx);
  const b = body || {};
  const projectId = intOrNull(b.project_id);
  if (!projectId) throw badRequest('Escolha a obra.');
  requireProject(ctx, projectId);
  const d = readMeasurement(b, projectId);
  const id = tx(() => {
    const nid = Number(run('INSERT INTO field_measurements (project_id, supplier, ref_date, amount, notes, created_by) VALUES (?,?,?,?,?,?)',
      projectId, d.supplier, d.ref_date, d.amount, d.notes, ctx.user.id).lastInsertRowid);
    setMeasurementSheets(nid, d.sheet_ids);
    addMeasurementFiles(ctx, nid, b.files);
    return nid;
  });
  audit(ctx.user.id, 'field', id, 'Medição do terceiro lançada', { obra: projectId, valor: d.amount, folhas: d.sheet_ids.length }, ip);
  return { id, ...listMeasurements(ctx, projectId) };
}
export function updateMeasurement(ctx, id, body, ip) {
  const m = loadMeasurement(ctx, id);
  const d = readMeasurement(body || {}, m.project_id, m.id);
  tx(() => {
    run(`UPDATE field_measurements SET supplier = ?, ref_date = ?, amount = ?, notes = ?, updated_at = datetime('now') WHERE id = ?`, d.supplier, d.ref_date, d.amount, d.notes, m.id);
    setMeasurementSheets(m.id, d.sheet_ids);
    addMeasurementFiles(ctx, m.id, body?.files);
  });
  audit(ctx.user.id, 'field', m.id, 'Medição do terceiro atualizada', { valor: d.amount, folhas: d.sheet_ids.length }, ip);
  return { id: m.id, ...listMeasurements(ctx, m.project_id) };
}
export function addMeasurementFilesApi(ctx, id, body, ip) {
  const m = loadMeasurement(ctx, id);
  const n = tx(() => addMeasurementFiles(ctx, m.id, body?.files));
  if (!n) throw badRequest('Nenhum arquivo enviado.');
  audit(ctx.user.id, 'field', m.id, 'BM anexado à medição do terceiro', { arquivos: n }, ip);
  return { id: m.id, ...listMeasurements(ctx, m.project_id) };
}
export function removeMeasurementFile(ctx, id, fileId, ip) {
  const m = loadMeasurement(ctx, id);
  const f = one('SELECT * FROM field_measurement_files WHERE id = ? AND measurement_id = ?', fileId, m.id);
  if (!f) throw notFound('Arquivo não encontrado.');
  run('DELETE FROM field_measurement_files WHERE id = ?', f.id);
  deleteStored(f.stored_name);
  audit(ctx.user.id, 'field', m.id, 'BM removido da medição do terceiro', { arquivo: f.original_name }, ip);
  return { id: m.id, ...listMeasurements(ctx, m.project_id) };
}
export function deleteMeasurement(ctx, id, ip) {
  const m = loadMeasurement(ctx, id);
  const files = all('SELECT stored_name FROM field_measurement_files WHERE measurement_id = ?', m.id);
  run('DELETE FROM field_measurements WHERE id = ?', m.id);
  for (const f of files) deleteStored(f.stored_name);
  audit(ctx.user.id, 'field', m.id, 'Medição do terceiro excluída', { valor: m.amount }, ip);
  return listMeasurements(ctx, m.project_id);
}
export function measurementFileForUser(ctx, fileId) {
  const f = one('SELECT * FROM field_measurement_files WHERE id = ?', fileId);
  if (!f) throw notFound('Arquivo não encontrado.');
  loadMeasurement(ctx, f.measurement_id);
  return f;
}
// ---------- Dívidas anteriores da obra ----------
// Dívidas de antes do sistema (ou fora das folhas), com o motivo e comprovante em PDF opcional. Baixa só marcando "quitada".
// empresa_deve / profissional_deve: ligadas a um profissional (aparecem em Pagamentos, separadas das folhas);
// pago_mais: entra no saldo perante a medição do terceiro ("dos quais anterior").
export const DEBT_KINDS = { empresa_deve: 'A empresa deve ao profissional', profissional_deve: 'O profissional deve à empresa', pago_mais: 'Pago a mais anterior (medição)' };
const DEBT_SQL = `SELECT d.*, w.name AS worker_name, w.role AS worker_role, u.name AS settled_by_name FROM field_debts d
  LEFT JOIN field_workers w ON w.id = d.worker_id LEFT JOIN users u ON u.id = d.settled_by`;
const debtView = d => ({
  id: d.id, project_id: d.project_id, kind: d.kind, kind_label: DEBT_KINDS[d.kind], worker_id: d.worker_id, worker_name: d.worker_name, worker_role: d.worker_role,
  origin_date: d.origin_date, amount: d.amount, reason: d.reason, status: d.status, settled_date: d.settled_date, settled_note: d.settled_note, settled_by_name: d.settled_by_name,
  files: all('SELECT id, mime, size, original_name, created_at FROM field_debt_files WHERE debt_id = ? ORDER BY id', d.id),
});
// Totais em aberto por tipo (usados no resumo, na medição e no relatório)
export function debtTotals(projectId) {
  const t = { empresa_deve: 0, profissional_deve: 0, pago_mais: 0, settled: 0, count_open: 0 };
  for (const d of all('SELECT kind, amount, status FROM field_debts WHERE project_id = ?', projectId)) {
    if (d.status === 'aberta') { t[d.kind] = r2(t[d.kind] + d.amount); t.count_open++; } else t.settled = r2(t.settled + d.amount);
  }
  return t;
}
export function listDebts(ctx, projectId) {
  requireMoney(ctx);
  const p = requireProject(ctx, projectId);
  const debts = all(`${DEBT_SQL} WHERE d.project_id = ? ORDER BY d.status = 'quitada', d.origin_date DESC, d.id DESC`, p.id).map(debtView);
  // Profissionais que podem ter dívida nesta obra: os ligados a ela (ou sem obra definida) e os já usados em dívidas
  const workers = all(`SELECT id, name, role, kind, active FROM field_workers w WHERE (NOT EXISTS (SELECT 1 FROM field_worker_projects x WHERE x.worker_id = w.id)
    OR EXISTS (SELECT 1 FROM field_worker_projects x WHERE x.worker_id = w.id AND x.project_id = ?) OR EXISTS (SELECT 1 FROM field_debts d WHERE d.worker_id = w.id AND d.project_id = ?))
    ORDER BY active DESC, name`, p.id, p.id);
  return { project: { id: p.id, code: p.code, name: p.name }, debts, workers, kinds: DEBT_KINDS, totals: debtTotals(p.id) };
}
function readDebt(b, projectId) {
  const kind = DEBT_KINDS[b.kind] ? b.kind : null;
  if (!kind) throw badRequest('Escolha o tipo da dívida.');
  const d = {
    kind,
    origin_date: date(b.origin_date, 'Data de origem'),
    amount: num(b.amount, 'Valor da dívida', { max: 1e9 }),
    reason: str(b.reason, { max: 1000, required: true, label: 'Motivo' }),
    worker_id: kind === 'pago_mais' ? null : intOrNull(b.worker_id),
  };
  if (!d.origin_date) throw badRequest('Informe a data de origem da dívida.');
  if (!d.amount) throw badRequest('Informe o valor da dívida.');
  if (kind !== 'pago_mais' && (!d.worker_id || !one('SELECT id FROM field_workers WHERE id = ?', d.worker_id))) throw badRequest('Escolha o profissional da dívida.');
  if (d.worker_id && !workerInProject(d.worker_id, projectId) && !one('SELECT 1 FROM field_debts WHERE worker_id = ? AND project_id = ?', d.worker_id, projectId)) {
    throw badRequest('Este profissional não está ligado a esta obra. Inclua a obra no cadastro dele em Profissionais.');
  }
  return d;
}
function addDebtFiles(ctx, id, files) {
  const list = Array.isArray(files) ? files.slice(0, 10) : [];
  if (list.some(f => !String(f?.data || '').startsWith('data:application/pdf;base64,'))) throw badRequest('O comprovante precisa ser um arquivo PDF.');
  for (const f of list) {
    const saved = saveImageFromDataUrl(f?.data);
    if (saved.mime !== 'application/pdf') { deleteStored(saved.stored_name); throw badRequest('O comprovante precisa ser um arquivo PDF.'); }
    run('INSERT INTO field_debt_files (debt_id, stored_name, mime, size, original_name, uploaded_by) VALUES (?,?,?,?,?,?)', id, saved.stored_name, saved.mime, saved.size, cleanFileName(f.name), ctx.user.id);
  }
  return list.length;
}
function loadDebt(ctx, id) {
  requireMoney(ctx);
  const d = one('SELECT * FROM field_debts WHERE id = ?', id);
  if (!d) throw notFound('Dívida não encontrada.');
  requireProject(ctx, d.project_id);
  return d;
}
export function createDebt(ctx, body, ip) {
  requireMoney(ctx);
  const b = body || {};
  const projectId = intOrNull(b.project_id);
  if (!projectId) throw badRequest('Escolha a obra.');
  requireProject(ctx, projectId);
  const d = readDebt(b, projectId);
  const id = tx(() => {
    const nid = Number(run('INSERT INTO field_debts (project_id, kind, worker_id, origin_date, amount, reason, created_by) VALUES (?,?,?,?,?,?,?)',
      projectId, d.kind, d.worker_id, d.origin_date, d.amount, d.reason, ctx.user.id).lastInsertRowid);
    addDebtFiles(ctx, nid, b.files);
    return nid;
  });
  audit(ctx.user.id, 'field', id, 'Dívida anterior lançada', { obra: projectId, tipo: d.kind, valor: d.amount }, ip);
  return { id, ...listDebts(ctx, projectId) };
}
export function updateDebt(ctx, id, body, ip) {
  const cur = loadDebt(ctx, id);
  const b = body || {};
  const d = readDebt(b, cur.project_id);
  tx(() => {
    run(`UPDATE field_debts SET kind = ?, worker_id = ?, origin_date = ?, amount = ?, reason = ?, updated_at = datetime('now') WHERE id = ?`, d.kind, d.worker_id, d.origin_date, d.amount, d.reason, cur.id);
    addDebtFiles(ctx, cur.id, b.files);
  });
  audit(ctx.user.id, 'field', cur.id, 'Dívida anterior atualizada', { tipo: d.kind, valor: d.amount }, ip);
  return { id: cur.id, ...listDebts(ctx, cur.project_id) };
}
// Quitar (data e observação) ou reabrir
export function settleDebt(ctx, id, body, ip) {
  const cur = loadDebt(ctx, id);
  const b = body || {};
  if (b.settled === false) {
    run(`UPDATE field_debts SET status = 'aberta', settled_date = NULL, settled_note = NULL, settled_by = NULL, updated_at = datetime('now') WHERE id = ?`, cur.id);
    audit(ctx.user.id, 'field', cur.id, 'Dívida anterior reaberta', { valor: cur.amount }, ip);
  } else {
    const sd = date(b.settled_date, 'Data da quitação') || today();
    if (sd > today()) throw badRequest('A data da quitação não pode ser no futuro.');
    run(`UPDATE field_debts SET status = 'quitada', settled_date = ?, settled_note = ?, settled_by = ?, updated_at = datetime('now') WHERE id = ?`,
      sd, str(b.settled_note, { max: 500, label: 'Observação da quitação' }), ctx.user.id, cur.id);
    audit(ctx.user.id, 'field', cur.id, 'Dívida anterior quitada', { valor: cur.amount, data: sd }, ip);
  }
  return { id: cur.id, ...listDebts(ctx, cur.project_id) };
}
export function deleteDebt(ctx, id, ip) {
  const cur = loadDebt(ctx, id);
  const files = all('SELECT stored_name FROM field_debt_files WHERE debt_id = ?', cur.id);
  run('DELETE FROM field_debts WHERE id = ?', cur.id);
  for (const f of files) deleteStored(f.stored_name);
  audit(ctx.user.id, 'field', cur.id, 'Dívida anterior excluída', { tipo: cur.kind, valor: cur.amount }, ip);
  return listDebts(ctx, cur.project_id);
}
export function removeDebtFile(ctx, id, fileId, ip) {
  const cur = loadDebt(ctx, id);
  const f = one('SELECT * FROM field_debt_files WHERE id = ? AND debt_id = ?', fileId, cur.id);
  if (!f) throw notFound('Arquivo não encontrado.');
  run('DELETE FROM field_debt_files WHERE id = ?', f.id);
  deleteStored(f.stored_name);
  audit(ctx.user.id, 'field', cur.id, 'Comprovante removido da dívida anterior', { arquivo: f.original_name }, ip);
  return { id: cur.id, ...listDebts(ctx, cur.project_id) };
}
export function debtFileForUser(ctx, fileId) {
  const f = one('SELECT * FROM field_debt_files WHERE id = ?', fileId);
  if (!f) throw notFound('Arquivo não encontrado.');
  loadDebt(ctx, f.debt_id);
  return f;
}