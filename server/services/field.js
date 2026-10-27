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
import { createObligationInternal, obligationPaid, removeObligationInternal } from './finance.js';
import { today } from './metrics.js';

const r2 = v => Math.round((Number(v) || 0) * 100) / 100;
const pad = n => String(n).padStart(2, '0');
export const KINDS = { diarista: 'Diarista (mão de obra própria)', empreiteiro: 'Empreiteiro' };
export const PIX_TYPES = ['CPF', 'CNPJ', 'Telefone', 'E-mail', 'Aleatória'];
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
  if (!p || p.kind !== 'obra') return false;
  if (!canAccessProject(ctx.user, p.id, ctx.projects)) return false;
  return canFieldMoney(ctx.user) || p.lead_id === ctx.user.id || canManageProject(ctx, p.id);
}
export function fillableProjects(ctx) {
  return all(`SELECT id, code, name, client, status, lead_id, kind FROM projects WHERE kind = 'obra' ORDER BY status = 'concluido', code`).filter(p => canFill(ctx, p))
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
const workerView = (w, money) => {
  const base = { id: w.id, name: w.name, kind: w.kind, role: w.role, active: w.active };
  return money ? { ...base, daily_rate: w.daily_rate, doc: w.doc, pix: w.pix, pix_type: w.pix_type, phone: w.phone, notes: w.notes } : base;
};
export function listWorkers(ctx) {
  if (!canUseField(ctx)) throw forbidden('A Folha de Campo não está liberada para o seu usuário.');
  const money = canFieldMoney(ctx.user);
  return { workers: all('SELECT * FROM field_workers ORDER BY active DESC, name').map(w => workerView(w, money)), kinds: KINDS, pix_types: PIX_TYPES, can_money: money };
}
function readWorker(b, money, cur = {}) {
  const d = {
    name: str(b.name, { max: 120, required: true, label: 'Nome' }),
    kind: KINDS[b.kind] ? b.kind : cur.kind || 'diarista',
    role: str(b.role, { max: 60, label: 'Função' }),
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
  const id = Number(run(`INSERT INTO field_workers (name, kind, role, daily_rate, doc, pix, pix_type, phone, notes, active, created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    d.name, d.kind, d.role, d.daily_rate, d.doc, d.pix, d.pix_type, d.phone, d.notes, d.active, ctx.user.id).lastInsertRowid);
  audit(ctx.user.id, 'field', id, 'Profissional de campo cadastrado', { nome: d.name }, ip);
  return workerView(one('SELECT * FROM field_workers WHERE id = ?', id), money);
}
export function updateWorker(ctx, id, body, ip) {
  requireMoney(ctx);
  const cur = one('SELECT * FROM field_workers WHERE id = ?', id);
  if (!cur) throw notFound('Profissional não encontrado.');
  const d = readWorker(body || {}, true, cur);
  run(`UPDATE field_workers SET name=?, kind=?, role=?, daily_rate=?, doc=?, pix=?, pix_type=?, phone=?, notes=?, active=?, updated_at=datetime('now') WHERE id=?`,
    d.name, d.kind, d.role, d.daily_rate, d.doc, d.pix, d.pix_type, d.phone, d.notes, d.active, id);
  audit(ctx.user.id, 'field', id, 'Profissional de campo atualizado', { nome: d.name }, ip);
  return workerView(one('SELECT * FROM field_workers WHERE id = ?', id), true);
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
  return all(`${CONTRACT_SQL} ORDER BY c.status, p.code, w.name`).filter(c => allowed.has(c.project_id) && (!projectId || c.project_id === projectId)).map(c => contractView(c, money));
}
function readContract(ctx, b) {
  const projectId = intOrNull(b.project_id);
  if (!projectId) throw badRequest('Escolha a obra.');
  requireProject(ctx, projectId);
  const workerId = intOrNull(b.worker_id);
  if (!workerId || !one(`SELECT id FROM field_workers WHERE id = ? AND kind = 'empreiteiro'`, workerId)) throw badRequest('Escolha o empreiteiro (cadastre-o em Profissionais como Empreiteiro).');
  const total = num(b.total, 'Valor total da empreitada', { max: 1e9 });
  if (!total) throw badRequest('Informe o valor total da empreitada.');
  return {
    project_id: projectId, worker_id: workerId, total,
    service: str(b.service, { max: 200, required: true, label: 'Serviço' }),
    start_date: date(b.start_date, 'Início'),
    notes: str(b.notes, { max: 1000, label: 'Observações' }),
    status: b.status === 'encerrada' ? 'encerrada' : 'ativa',
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
  const d = readContract(ctx, { ...body, project_id: cur.project_id });
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

// Valores ao vivo (folha aberta) ou congelados (fechada)
function computeSheet(s) {
  const snap = s.status === 'fechada' && s.snapshot ? JSON.parse(s.snapshot) : null;
  const people = all(`SELECT e.*, w.name, w.role, w.kind, w.daily_rate, w.pix, w.pix_type, w.doc FROM field_sheet_people e JOIN field_workers w ON w.id = e.worker_id WHERE e.sheet_id = ? ORDER BY w.name`, s.id).map(e => {
    const f = snap?.people?.[e.id] || {};
    const rate = f.rate ?? e.daily_rate;
    const days = parseDays(e.days);
    const diarias = sumDays(days);
    const gross = r2(diarias * rate);
    const total = r2(gross + e.adjust);
    return { id: e.id, worker_id: e.worker_id, name: f.name ?? e.name, role: f.role ?? e.role, pix: f.pix ?? e.pix, pix_type: f.pix_type ?? e.pix_type, doc: f.doc ?? e.doc,
      days, diarias, rate, gross, adjust: e.adjust, adjust_note: e.adjust_note, total, client_paid: e.client_paid, company: r2(total - e.client_paid), service: e.service };
  });
  const contracts = all(`SELECT sc.*, c.service, c.total AS c_total, c.worker_id, w.name AS worker_name, w.pix, w.pix_type FROM field_sheet_contracts sc
    JOIN field_contracts c ON c.id = sc.contract_id JOIN field_workers w ON w.id = c.worker_id WHERE sc.sheet_id = ? ORDER BY w.name, c.service`, s.id).map(x => {
    const f = snap?.contracts?.[x.id] || {};
    const cTotal = f.total ?? x.c_total;
    const amount = r2(cTotal * x.pct / 100);
    const before = measuredBefore(x.contract_id, s);
    return { id: x.id, contract_id: x.contract_id, worker_id: x.worker_id, service: f.service ?? x.service, worker_name: f.worker_name ?? x.worker_name, pix: f.pix ?? x.pix, pix_type: f.pix_type ?? x.pix_type,
      contract_total: cTotal, pct: x.pct, before_pct: before, after_pct: r2(before + x.pct), balance_pct: r2(100 - before - x.pct), amount, client_paid: x.client_paid, company: r2(amount - x.client_paid), notes: x.notes };
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

const MONEY_PEOPLE = ['rate', 'gross', 'adjust', 'adjust_note', 'total', 'client_paid', 'company', 'pix', 'pix_type', 'doc'];
const MONEY_CONTRACT = ['worker_id', 'contract_total', 'amount', 'client_paid', 'company', 'pix', 'pix_type'];
const strip = (o, keys) => { const c = { ...o }; for (const k of keys) delete c[k]; return c; };

function paymentOf(s) {
  if (!s.obligation_id) return null;
  const it = one('SELECT id, status, due_date, amount_expected FROM finance_items WHERE obligation_id = ? ORDER BY id LIMIT 1', s.obligation_id);
  return it ? { item_id: it.id, status: it.status, due_date: it.due_date, amount: it.amount_expected } : null;
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
  return { sheets, projects, can_money: money };
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
    available_workers: open ? all(`SELECT id, name, role FROM field_workers WHERE active = 1 AND kind = 'diarista' ORDER BY name`).filter(w => !inSheet.has(w.id)) : [],
    available_contracts: open ? listContracts(ctx, p.id).filter(x => x.status === 'ativa' && !inContracts.has(x.id) && x.balance_pct > 0) : [],
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
      else if (state === 'pendente') w.company_pending = r2(w.company_pending + Math.max(0, e.company));
      else w.company_paid = r2(w.company_paid + Math.max(0, e.company));
      byWorker.set(e.worker_id, w);
    }
    const company = r2(c.totals.company);
    if (state === 'aberta') open = r2(open + company); else if (state === 'pendente') pending = r2(pending + company); else paid = r2(paid + company);
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
    const workdays = new Set(c.people.flatMap(e => Object.keys(e.days).filter(d => Number(e.days[d]) > 0))).size;
    const company = Math.max(0, c.totals.company);
    for (const x of [o, tot]) {
      x.sheets++; x.diarias = r2(x.diarias + c.totals.diarias); x.people = r2(x.people + c.totals.people); x.contracts = r2(x.contracts + c.totals.contracts);
      x.client = r2(x.client + c.totals.client); x.company = r2(x.company + company); x[state] = r2(x[state] + company); x.workdays += workdays;
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
  return {
    filters: { from: f, to: t, obra: obra || null },
    projects,
    totals: fin(tot),
    obras: [...byObra.values()].map(fin).sort((a, b) => b.total - a.total),
    months,
    services: [...byService.values()].map(x => ({ ...x, total: r2(x.people + x.contracts) })).sort((a, b) => b.total - a.total),
    roles: [...byRole.values()].map(x => ({ name: x.name, diarias: x.diarias, total: x.total, workers: x.workers.size, avg_daily: x.diarias ? r2(x.total / x.diarias) : 0 })).sort((a, b) => b.total - a.total),
    workers: [...byWorker.values()].map(x => ({ name: x.name, role: x.role, kind: x.kind, diarias: x.diarias, total: x.total, obras: [...x.obras] })).sort((a, b) => b.total - a.total).slice(0, 15),
    contracts: listContracts(ctx).filter(c => !obra || c.project_id === obra),
  };
}

// ---------- Pagamentos: quem recebe, quanto e o PIX (parte da empresa ainda não paga) ----------
// Folhas fechadas com pagamento pendente no Financeiro ("a pagar") e folhas abertas ("previsto").
export function payments(ctx, projectId) {
  requireMoney(ctx);
  const ids = new Set(fillableProjects(ctx).map(p => p.id));
  const groups = new Map();
  const totals = { pending: 0, open: 0 };
  for (const s of all(`SELECT f.*, p.code AS project_code, p.name AS project_name FROM field_sheets f JOIN projects p ON p.id = f.project_id ORDER BY f.end_date, f.id`)) {
    if (!ids.has(s.project_id) || (projectId && s.project_id !== projectId)) continue;
    const pay = paymentOf(s);
    const state = s.status === 'aberta' ? 'open' : pay && pay.status !== 'paga' ? 'pending' : null;
    if (!state) continue;
    const c = computeSheet(s);
    const lines = [...c.people.map(e => ({ worker_id: e.worker_id, name: e.name, role: e.role, pix: e.pix, pix_type: e.pix_type, doc: e.doc, amount: e.company, what: `${n2txt(e.diarias)} diária(s)${e.service ? ` · ${e.service}` : ''}` })),
      ...c.contracts.map(x => ({ worker_id: x.worker_id, name: x.worker_name, role: 'Empreiteiro', pix: x.pix, pix_type: x.pix_type, doc: null, amount: x.company, what: `Empreitada ${x.service} (${n2txt(x.pct)}%)` }))];
    for (const l of lines) {
      if (!(l.amount > 0)) continue;
      const g = groups.get(l.worker_id) || { worker_id: l.worker_id, name: l.name, role: l.role, pix: l.pix, pix_type: l.pix_type, doc: l.doc, pending: 0, open: 0, items: [] };
      if (!g.pix && l.pix) { g.pix = l.pix; g.pix_type = l.pix_type; }
      g[state] = r2(g[state] + l.amount);
      g.items.push({ sheet_id: s.id, code: `${s.project_code} ${fcCode(s.seq)}`, project_name: s.project_name, period: `${dm(s.start_date)} a ${dm(s.end_date)}`, state, due_date: pay?.due_date || s.pay_date || null, amount: r2(l.amount), what: l.what });
      groups.set(l.worker_id, g);
      totals[state] = r2(totals[state] + l.amount);
    }
  }
  // PIX atual do cadastro quando a folha não tinha
  for (const g of groups.values()) if (!g.pix) { const w = one('SELECT pix, pix_type FROM field_workers WHERE id = ?', g.worker_id); if (w?.pix) { g.pix = w.pix; g.pix_type = w.pix_type; } }
  return {
    people: [...groups.values()].map(g => ({ ...g, total: r2(g.pending + g.open) })).sort((a, b) => b.pending - a.pending || b.total - a.total),
    totals: { ...totals, total: r2(totals.pending + totals.open) },
    projects: fillableProjects(ctx),
  };
}
const n2txt = v => String(r2(v)).replace('.', ',');
