// Controle de contratos: contratos, planilha contratual (itens/aditivos), medições (boletins) e faturamento global.
// Somente usuários liberados (users.can_contracts) acessam; a área interna restrita "Contratos" segue a mesma liberação.
import { all, one, run, tx } from '../db.js';
import { badRequest, forbidden, notFound, str, oneOf, date, intOrNull } from '../lib/http.js';
import { isAdmin } from '../lib/permissions.js';
import { audit } from './audit.js';
import { today } from './metrics.js';
import { defaultStageId } from './stages.js';
import { validContractTypeId } from './settings.js';
import { COMPANIES } from '../lib/companies.js';

export const COMPANY_KEYS = Object.keys(COMPANIES);
const norm = s => String(s ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
// Tipo sugerido pelo início do nome (ex.: "Fiscalização - …" → Fiscalização); o nome mais longo que casar vence
export function suggestContractType(title) {
  const t = norm(title);
  return all('SELECT id, name FROM contract_types WHERE active = 1').map(x => ({ ...x, n: norm(x.name) }))
    .filter(x => x.n && (t === x.n || t.startsWith(`${x.n} `))).sort((a, b) => b.n.length - a.n.length)[0]?.id || null;
}
// Classificação única dos contratos existentes: tipo pelo nome (os sem tipo)
export function classifyExistingContracts() {
  const changed = [];
  for (const c of all('SELECT id, code, title FROM contracts WHERE type_id IS NULL')) {
    const t = suggestContractType(c.title);
    if (t) { run('UPDATE contracts SET type_id = ? WHERE id = ?', t, c.id); changed.push(c.code); }
  }
  return changed;
}
const withNames = c => c && ({ ...c, company_name: COMPANIES[c.company]?.name || c.company, company_logo: COMPANIES[c.company]?.logo || COMPANIES.charao.logo });
const CT_SELECT = `SELECT c.*, p.code AS project_code, p.name AS project_name, t.name AS type_name FROM contracts c
  LEFT JOIN projects p ON p.id = c.project_id LEFT JOIN contract_types t ON t.id = c.type_id`;

export const STATUSES = ['vigente', 'suspenso', 'encerrado'];
export const MEASUREMENT_STATUSES = ['rascunho', 'emitida', 'faturada', 'recebida'];
const BILLED = ['emitida', 'faturada', 'recebida'];

export const canContracts = user => !!user?.can_contracts;
export function requireContracts(user) {
  if (!canContracts(user)) throw forbidden('Acesso restrito: solicite a liberação de Contratos ao administrador.');
}

const r2 = v => Math.round((Number(v) || 0) * 100) / 100;
const r4 = v => Math.round((Number(v) || 0) * 10000) / 10000;
// Número em formato brasileiro ("1.234,56") ou JS (1234.56)
const num = (v, label, { min = -1e12 } = {}) => {
  if (v === '' || v === null || v === undefined) return 0;
  const s = typeof v === 'number' ? v : String(v).trim();
  const n = typeof s === 'number' ? s : Number(s.includes(',') ? s.replace(/\./g, '').replace(',', '.') : s);
  if (!Number.isFinite(n)) throw badRequest(`${label}: número inválido.`);
  if (n < min) throw badRequest(`${label}: valor inválido.`);
  return n;
};

// ---------- Área interna restrita (tarefas de contratos) ----------
export function ensureContractsArea() {
  if (one(`SELECT value FROM app_settings WHERE key = 'contracts_area_created'`)) return null;
  return tx(() => {
    const r0 = one(`SELECT MAX(CAST(SUBSTR(code, 5) AS INTEGER)) AS n FROM projects WHERE code LIKE 'INT-%'`);
    const code = `INT-${String((r0?.n || 0) + 1).padStart(3, '0')}`;
    const now = new Date().toISOString();
    const r = run(`INSERT INTO projects (code, name, client, description, status, kind, restricted, created_at, updated_at) VALUES (?,?,?,?, 'em_andamento', 'interno', 1, ?, ?)`,
      code, 'Contratos (restrito)', 'Charão Engenharia e Construção',
      'Tarefas de contratos, medições, faturamento e cobrança. Visível somente para quem tem a liberação de Contratos.', now, now);
    const id = Number(r.lastInsertRowid);
    defaultStageId(id);
    ['Medições', 'Faturamento', 'Cobrança', 'Renovações e aditivos'].forEach((n, i) => run('INSERT INTO project_stages (project_id, name, sort_order) VALUES (?,?,?)', id, n, i + 1));
    run(`INSERT INTO app_settings (key, value) VALUES ('contracts_area_created', ?)`, String(id));
    audit(null, 'contract', null, 'Área interna restrita de Contratos criada', { codigo: code });
    return id;
  });
}
export const contractsAreaId = () => one('SELECT id FROM projects WHERE restricted = 1 ORDER BY id LIMIT 1')?.id || null;

// ---------- Cálculos ----------
const itemsOf = contractId => all('SELECT * FROM contract_items WHERE contract_id = ? ORDER BY seq, id', contractId);
const measurementsOf = contractId => all('SELECT * FROM measurements WHERE contract_id = ? ORDER BY seq', contractId);

// Valores de uma medição: soma das linhas (qtd × preço) e dos ajustes
function measurementTotals(m, items = null) {
  const its = items || all('SELECT id, unit_price FROM contract_items WHERE contract_id = ?', m.contract_id);
  const price = new Map(its.map(i => [i.id, i.unit_price]));
  const lines = all('SELECT item_id, quantity FROM measurement_lines WHERE measurement_id = ?', m.id);
  const measured = r2(lines.reduce((s, l) => s + l.quantity * (price.get(l.item_id) || 0), 0));
  const adjustments = r2(one('SELECT COALESCE(SUM(amount), 0) AS s FROM measurement_adjustments WHERE measurement_id = ?', m.id).s);
  return { measured, adjustments, total: r2(measured + adjustments) };
}

function contractSummary(c) {
  const items = itemsOf(c.id);
  const ms = measurementsOf(c.id).map(m => ({ ...m, ...measurementTotals(m, items) }));
  const sum = (arr, k) => r2(arr.reduce((s, x) => s + (x[k] || 0), 0));
  const issued = ms.filter(m => BILLED.includes(m.status));
  const billed = ms.filter(m => m.status === 'faturada' || m.status === 'recebida');
  const received = ms.filter(m => m.status === 'recebida');
  const value = r2(items.reduce((s, i) => s + i.quantity * i.unit_price, 0));
  const measured = sum(issued, 'measured');
  return {
    value,
    measured,
    measured_total: sum(issued, 'total'),
    billed: sum(billed, 'total'),
    received: r2(received.reduce((s, m) => s + (m.paid_amount ?? m.total), 0)),
    to_receive: r2(sum(billed.filter(m => m.status === 'faturada'), 'total')),
    to_bill: r2(sum(ms.filter(m => m.status === 'emitida'), 'total')),
    balance: r2(value - measured),
    pct: value ? Math.round((measured / value) * 1000) / 10 : null,
    measurements: ms.length,
    drafts: ms.filter(m => m.status === 'rascunho').length,
    last: ms.filter(m => m.status !== 'rascunho').at(-1) || null,
  };
}

// ---------- Contratos ----------
export function listContracts(ctx) {
  requireContracts(ctx.user);
  return all(`${CT_SELECT} ORDER BY c.status = 'encerrado', c.code`).map(c => ({ ...withNames(c), summary: contractSummary(c) }));
}

export function getContract(ctx, id) {
  requireContracts(ctx.user);
  const c = withNames(one(`${CT_SELECT} WHERE c.id = ?`, id));
  if (!c) throw notFound('Contrato não encontrado.');
  const items = itemsOf(id);
  const issuedIds = all(`SELECT id FROM measurements WHERE contract_id = ? AND status <> 'rascunho'`, id).map(m => m.id);
  const measuredQty = new Map(issuedIds.length ? all(`SELECT item_id, SUM(quantity) AS q FROM measurement_lines WHERE measurement_id IN (${issuedIds.map(() => '?').join(',')}) GROUP BY item_id`, ...issuedIds).map(r => [r.item_id, r.q]) : []);
  const used = new Set(all('SELECT DISTINCT item_id FROM measurement_lines l JOIN measurements m ON m.id = l.measurement_id WHERE m.contract_id = ? AND l.quantity <> 0', id).map(r => r.item_id));
  return {
    ...c,
    items: items.map(i => {
      const mq = r4(measuredQty.get(i.id) || 0);
      return { ...i, value: r2(i.quantity * i.unit_price), measured_qty: mq, measured_value: r2(mq * i.unit_price), balance_qty: r4(i.quantity - mq), balance_value: r2((i.quantity - mq) * i.unit_price), used: used.has(i.id) };
    }),
    measurements: measurementsOf(id).map(m => ({ ...m, ...measurementTotals(m, items) })),
    summary: contractSummary(c),
  };
}

function readContract(body) {
  const d = {
    client: str(body.client, { max: 160, required: true, label: 'Cliente' }),
    client_doc: str(body.client_doc, { max: 30, label: 'CNPJ/CPF' }),
    number: str(body.number, { max: 60, label: 'Nº do contrato' }),
    title: str(body.title, { max: 200, required: true, label: 'Objeto' }),
    scope: str(body.scope, { max: 2000, label: 'Escopo' }),
    project_id: intOrNull(body.project_id),
    start_date: date(body.start_date, 'Início'),
    end_date: date(body.end_date, 'Término'),
    bulletin_prefix: (str(body.bulletin_prefix, { max: 10, required: true, label: 'Prefixo do boletim' }) || '').toUpperCase().replace(/[^A-Z0-9-]/g, ''),
    payment_info: str(body.payment_info, { max: 1000, label: 'Dados para pagamento' }),
    notes: str(body.notes, { max: 3000, label: 'Observações' }),
    status: oneOf(body.status, STATUSES, 'Situação', 'vigente'),
    company: oneOf(body.company, COMPANY_KEYS, 'Empresa', 'charao'),
    type_id: validContractTypeId(body.type_id, body.current_type_id ?? null),
  };
  if (!d.bulletin_prefix) throw badRequest('Prefixo do boletim: use letras e números (ex.: ORBE).');
  if (d.start_date && d.end_date && d.end_date < d.start_date) throw badRequest('O término deve ser posterior ao início.');
  if (d.project_id && !one('SELECT id FROM projects WHERE id = ?', d.project_id)) throw badRequest('Projeto inválido.');
  const items = (Array.isArray(body.items) ? body.items : []).map((x, i) => ({
    id: intOrNull(x?.id),
    seq: i + 1,
    description: str(x?.description, { max: 300, required: true, label: `Descrição do item ${i + 1}` }),
    unit: str(x?.unit, { max: 12, label: 'Unidade' }) || 'vb',
    unit_price: r4(num(x?.unit_price, `Preço unitário do item ${i + 1}`, { min: 0 })),
    quantity: r4(num(x?.quantity, `Quantidade do item ${i + 1}`, { min: 0 })),
    additive: x?.additive ? 1 : 0,
  }));
  if (!items.length && body.items !== undefined) throw badRequest('Cadastre ao menos um item na planilha contratual.');
  return { d, items };
}

function syncItems(contractId, items) {
  const current = itemsOf(contractId);
  const byId = new Map(current.map(i => [i.id, i]));
  const keep = new Set(items.filter(i => i.id).map(i => i.id));
  for (const i of items) if (i.id && !byId.has(i.id)) throw badRequest('Item inválido.');
  for (const old of current.filter(i => !keep.has(i.id))) {
    if (one('SELECT 1 FROM measurement_lines WHERE item_id = ? AND quantity <> 0 LIMIT 1', old.id)) throw badRequest(`O item "${old.description}" já foi medido e não pode ser removido.`);
    run('DELETE FROM measurement_lines WHERE item_id = ?', old.id);
    run('DELETE FROM contract_items WHERE id = ?', old.id);
  }
  for (const i of items) {
    if (i.id) run('UPDATE contract_items SET seq = ?, description = ?, unit = ?, unit_price = ?, quantity = ?, additive = ? WHERE id = ?', i.seq, i.description, i.unit, i.unit_price, i.quantity, i.additive, i.id);
    else run('INSERT INTO contract_items (contract_id, seq, description, unit, unit_price, quantity, additive) VALUES (?,?,?,?,?,?,?)', contractId, i.seq, i.description, i.unit, i.unit_price, i.quantity, i.additive);
  }
}

export function createContract(ctx, body, ip) {
  requireContracts(ctx.user);
  const { d, items } = readContract({ items: [], ...body });
  return tx(() => {
    const n = one(`SELECT MAX(CAST(SUBSTR(code, 4) AS INTEGER)) AS n FROM contracts WHERE code LIKE 'CT-%'`)?.n || 0;
    const code = `CT-${String(n + 1).padStart(3, '0')}`;
    const r = run(`INSERT INTO contracts (code, client, client_doc, number, title, scope, project_id, start_date, end_date, bulletin_prefix, payment_info, notes, status, company, company_auto, type_id, created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?,?)`, code, d.client, d.client_doc, d.number, d.title, d.scope, d.project_id, d.start_date, d.end_date, d.bulletin_prefix, d.payment_info, d.notes, d.status, d.company, d.type_id, ctx.user.id);
    const id = Number(r.lastInsertRowid);
    syncItems(id, items);
    audit(ctx.user.id, 'contract', id, 'Contrato cadastrado', { codigo: code, cliente: d.client, objeto: d.title, itens: items.length }, ip);
    return id;
  });
}

export function updateContract(ctx, id, body, ip) {
  requireContracts(ctx.user);
  const c = one('SELECT * FROM contracts WHERE id = ?', id);
  if (!c) throw notFound('Contrato não encontrado.');
  const { d, items } = readContract({ ...c, current_type_id: c.type_id, ...body });
  tx(() => {
    // Empresa escolhida à mão: a importação das planilhas não muda mais
    const auto = body.company !== undefined && body.company !== c.company ? 0 : c.company_auto;
    run(`UPDATE contracts SET client=?, client_doc=?, number=?, title=?, scope=?, project_id=?, start_date=?, end_date=?, bulletin_prefix=?, payment_info=?, notes=?, status=?, company=?, company_auto=?, type_id=?, updated_at=datetime('now') WHERE id=?`,
      d.client, d.client_doc, d.number, d.title, d.scope, d.project_id, d.start_date, d.end_date, d.bulletin_prefix, d.payment_info, d.notes, d.status, d.company, auto, d.type_id, id);
    if (body.items !== undefined) syncItems(id, items);
    audit(ctx.user.id, 'contract', id, 'Contrato atualizado', { codigo: c.code, campos: Object.keys(d).filter(k => (d[k] ?? null) !== (c[k] ?? null)), itens: items.length }, ip);
  });
}

// ---------- Medições ----------
const monthBounds = ym => {
  const [y, m] = ym.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return [`${ym}-01`, `${ym}-${String(last).padStart(2, '0')}`];
};
const MONTHS = ['JAN', 'FEV', 'MAR', 'ABR', 'MAI', 'JUN', 'JUL', 'AGO', 'SET', 'OUT', 'NOV', 'DEZ'];
export const monthLabel = ym => `${MONTHS[Number(ym.slice(5, 7)) - 1]}/${ym.slice(2, 4)}`;

function loadMeasurement(ctx, id) {
  requireContracts(ctx.user);
  const m = one('SELECT * FROM measurements WHERE id = ?', id);
  if (!m) throw notFound('Medição não encontrada.');
  return m;
}

export function createMeasurement(ctx, contractId, body, ip) {
  requireContracts(ctx.user);
  const c = one('SELECT * FROM contracts WHERE id = ?', contractId);
  if (!c) throw notFound('Contrato não encontrado.');
  if (c.status === 'encerrado') throw badRequest('Contrato encerrado não recebe novas medições.');
  if (one(`SELECT 1 FROM measurements WHERE contract_id = ? AND status = 'rascunho'`, contractId)) throw badRequest('Já existe uma medição em rascunho neste contrato. Emita ou exclua antes de criar outra.');
  const ref = /^\d{4}-\d{2}$/.test(String(body.ref_month || '')) ? body.ref_month : today().slice(0, 7);
  const [ps, pe] = monthBounds(ref);
  const period_start = date(body.period_start, 'Início do período') || ps;
  const period_end = date(body.period_end, 'Fim do período') || pe;
  if (period_end < period_start) throw badRequest('O fim do período deve ser posterior ao início.');
  return tx(() => {
    const seq = (one('SELECT MAX(seq) AS n FROM measurements WHERE contract_id = ?', contractId)?.n || 0) + 1;
    const code = `${c.bulletin_prefix}${String(seq).padStart(4, '0')}.${ref.slice(2, 4)}`;
    const r = run(`INSERT INTO measurements (contract_id, seq, code, ref_month, period_start, period_end, created_by) VALUES (?,?,?,?,?,?,?)`,
      contractId, seq, code, ref, period_start, period_end, ctx.user.id);
    const id = Number(r.lastInsertRowid);
    for (const i of itemsOf(contractId)) run('INSERT INTO measurement_lines (measurement_id, item_id, quantity) VALUES (?,?,0)', id, i.id);
    // Descontos/acréscimos recorrentes: repete as descrições da medição anterior (com valor zerado)
    const prev = one(`SELECT id FROM measurements WHERE contract_id = ? AND seq < ? ORDER BY seq DESC LIMIT 1`, contractId, seq);
    if (prev) all('SELECT description, unit FROM measurement_adjustments WHERE measurement_id = ? ORDER BY seq', prev.id)
      .forEach((a, k) => run('INSERT INTO measurement_adjustments (measurement_id, seq, description, unit, amount) VALUES (?,?,?,?,0)', id, k + 1, a.description, a.unit));
    audit(ctx.user.id, 'measurement', id, 'Medição criada (rascunho)', { contrato: c.code, boletim: code, referencia: monthLabel(ref) }, ip);
    return id;
  });
}

// Boletim completo: por item, Contrato · Acumulado anterior · Medição · Acumulado atual · Saldo (quantidade e valor)
export function getMeasurement(ctx, id) {
  const m = loadMeasurement(ctx, id);
  const c = withNames(one(`${CT_SELECT} WHERE c.id = ?`, m.contract_id));
  const items = itemsOf(c.id);
  const prevIds = all(`SELECT id FROM measurements WHERE contract_id = ? AND seq < ? AND status <> 'rascunho'`, c.id, m.seq).map(r => r.id);
  const inList = ids => ids.map(() => '?').join(',');
  const prevQty = new Map(prevIds.length ? all(`SELECT item_id, SUM(quantity) AS q FROM measurement_lines WHERE measurement_id IN (${inList(prevIds)}) GROUP BY item_id`, ...prevIds).map(r => [r.item_id, r.q]) : []);
  const curQty = new Map(all('SELECT item_id, quantity FROM measurement_lines WHERE measurement_id = ?', id).map(r => [r.item_id, r.quantity]));
  const rows = items.map(i => {
    const pq = r4(prevQty.get(i.id) || 0);
    const cq = r4(curQty.get(i.id) || 0);
    const aq = r4(pq + cq);
    return {
      item_id: i.id, seq: i.seq, description: i.description, unit: i.unit, unit_price: i.unit_price, additive: !!i.additive,
      contract_qty: i.quantity, contract_value: r2(i.quantity * i.unit_price),
      prev_qty: pq, prev_value: r2(pq * i.unit_price),
      qty: cq, value: r2(cq * i.unit_price),
      acc_qty: aq, acc_value: r2(aq * i.unit_price),
      bal_qty: r4(i.quantity - aq), bal_value: r2((i.quantity - aq) * i.unit_price),
      exceeded: aq > i.quantity + 1e-9,
    };
  });
  // Descontos/acréscimos: acumulado por descrição
  const prevAdj = prevIds.length ? all(`SELECT description, SUM(amount) AS s FROM measurement_adjustments WHERE measurement_id IN (${inList(prevIds)}) GROUP BY description`, ...prevIds) : [];
  const prevAdjMap = new Map(prevAdj.map(a => [a.description.toLocaleLowerCase('pt-BR'), r2(a.s)]));
  const cur = all('SELECT * FROM measurement_adjustments WHERE measurement_id = ? ORDER BY seq, id', id);
  const adjustments = cur.map(a => {
    const p = prevAdjMap.get(a.description.toLocaleLowerCase('pt-BR')) || 0;
    return { id: a.id, description: a.description, unit: a.unit, prev: p, amount: r2(a.amount), acc: r2(p + a.amount) };
  });
  // Ajustes de medições anteriores que não se repetem nesta (aparecem só no acumulado)
  for (const a of prevAdj) {
    if (!cur.some(x => x.description.toLocaleLowerCase('pt-BR') === a.description.toLocaleLowerCase('pt-BR'))) adjustments.push({ id: null, description: a.description, unit: 'vb', prev: r2(a.s), amount: 0, acc: r2(a.s) });
  }
  const sum = (arr, k) => r2(arr.reduce((s, x) => s + (x[k] || 0), 0));
  const totals = {
    contract: sum(rows, 'contract_value'),
    prev: sum(rows, 'prev_value'), measured: sum(rows, 'value'), acc: sum(rows, 'acc_value'), balance: sum(rows, 'bal_value'),
    adj_prev: sum(adjustments, 'prev'), adj: sum(adjustments, 'amount'), adj_acc: sum(adjustments, 'acc'),
  };
  totals.prev_total = r2(totals.prev + totals.adj_prev);
  totals.to_bill = r2(totals.measured + totals.adj);
  totals.acc_total = r2(totals.acc + totals.adj_acc);
  const later = one(`SELECT 1 FROM measurements WHERE contract_id = ? AND seq > ? AND status <> 'rascunho' LIMIT 1`, c.id, m.seq);
  return {
    ...m, ref_label: monthLabel(m.ref_month),
    contract: c, rows, adjustments, totals,
    issued_by_name: m.issued_by ? one('SELECT name FROM users WHERE id = ?', m.issued_by)?.name : null,
    can: {
      edit: m.status === 'rascunho',
      issue: m.status === 'rascunho',
      reopen: m.status === 'emitida' && !later,
      bill: m.status === 'emitida',
      receive: m.status === 'faturada',
      undo: (m.status === 'faturada' || m.status === 'recebida'),
      delete: m.status === 'rascunho',
      // Correção direta (administrador): qualquer boletim já emitido, sem desfazer NF/recebimento
      correct: m.status !== 'rascunho' && isAdmin(ctx.user),
    },
  };
}

export function updateMeasurement(ctx, id, body, ip) {
  const m = loadMeasurement(ctx, id);
  if (m.status !== 'rascunho') throw badRequest('Só é possível alterar uma medição em rascunho. Reabra-a se precisar corrigir.');
  const ref = body.ref_month !== undefined ? (/^\d{4}-\d{2}$/.test(String(body.ref_month)) ? body.ref_month : null) : m.ref_month;
  if (!ref) throw badRequest('Mês de referência inválido.');
  const ps = body.period_start !== undefined ? date(body.period_start, 'Início do período') : m.period_start;
  const pe = body.period_end !== undefined ? date(body.period_end, 'Fim do período') : m.period_end;
  if (ps && pe && pe < ps) throw badRequest('O fim do período deve ser posterior ao início.');
  const items = new Set(all('SELECT id FROM contract_items WHERE contract_id = ?', m.contract_id).map(i => i.id));
  const lines = body.lines && typeof body.lines === 'object' ? Object.entries(body.lines).map(([k, v]) => {
    const itemId = intOrNull(k);
    if (!items.has(itemId)) throw badRequest('Item da medição inválido.');
    return [itemId, r4(num(v, 'Quantidade medida'))];
  }) : null;
  const adjustments = Array.isArray(body.adjustments) ? body.adjustments.map((a, k) => ({
    seq: k + 1,
    description: str(a?.description, { max: 200, required: true, label: 'Descrição do desconto/acréscimo' }),
    unit: str(a?.unit, { max: 12, label: 'Unidade' }) || 'vb',
    amount: r2(num(a?.amount, 'Valor do desconto/acréscimo')),
  })) : null;
  const c = one('SELECT bulletin_prefix FROM contracts WHERE id = ?', m.contract_id);
  tx(() => {
    run(`UPDATE measurements SET ref_month = ?, code = ?, period_start = ?, period_end = ?, notes = ?, updated_at = datetime('now') WHERE id = ?`,
      ref, `${c.bulletin_prefix}${String(m.seq).padStart(4, '0')}.${ref.slice(2, 4)}`, ps, pe,
      body.notes !== undefined ? str(body.notes, { max: 2000, label: 'Observações' }) : m.notes, id);
    if (lines) for (const [itemId, q] of lines) run(`INSERT INTO measurement_lines (measurement_id, item_id, quantity) VALUES (?,?,?)
      ON CONFLICT(measurement_id, item_id) DO UPDATE SET quantity = excluded.quantity`, id, itemId, q);
    if (adjustments) {
      run('DELETE FROM measurement_adjustments WHERE measurement_id = ?', id);
      for (const a of adjustments) run('INSERT INTO measurement_adjustments (measurement_id, seq, description, unit, amount) VALUES (?,?,?,?,?)', id, a.seq, a.description, a.unit, a.amount);
    }
  });
  return getMeasurement(ctx, id);
}

// Leitura das quantidades e descontos/acréscimos (rascunho e correção)
function readLinesAdjustments(m, body) {
  const items = new Set(all('SELECT id FROM contract_items WHERE contract_id = ?', m.contract_id).map(i => i.id));
  const lines = body.lines && typeof body.lines === 'object' ? Object.entries(body.lines).map(([k, v]) => {
    const itemId = intOrNull(k);
    if (!items.has(itemId)) throw badRequest('Item da medição inválido.');
    return [itemId, r4(num(v, 'Quantidade medida'))];
  }) : null;
  const adjustments = Array.isArray(body.adjustments) ? body.adjustments.map((a, k) => ({
    seq: k + 1,
    description: str(a?.description, { max: 200, required: true, label: 'Descrição do desconto/acréscimo' }),
    unit: str(a?.unit, { max: 12, label: 'Unidade' }) || 'vb',
    amount: r2(num(a?.amount, 'Valor do desconto/acréscimo')),
  })) : null;
  return { lines, adjustments };
}

// Correção de boletim já emitido/faturado/recebido (somente administrador): mantém situação, NF e recebimento.
// Motivo obrigatório; auditoria com antes/depois. paid: 'total' = valor recebido acompanha o novo total; 'keep' = mantém.
export function correctMeasurement(ctx, id, body, ip) {
  const m = loadMeasurement(ctx, id);
  if (!isAdmin(ctx.user)) throw forbidden('Só administradores corrigem um boletim já emitido. Para os demais, use Reabrir / Desfazer.');
  if (m.status === 'rascunho') throw badRequest('Rascunho é editado normalmente (Salvar medição).');
  const reason = str(body.reason, { max: 500, required: true, label: 'Motivo da correção' });
  const before = getMeasurement(ctx, id);
  const { lines, adjustments } = readLinesAdjustments(m, body);
  const ps = body.period_start !== undefined ? date(body.period_start, 'Início do período') : m.period_start;
  const pe = body.period_end !== undefined ? date(body.period_end, 'Fim do período') : m.period_end;
  if (ps && pe && pe < ps) throw badRequest('O fim do período deve ser posterior ao início.');
  tx(() => {
    run(`UPDATE measurements SET period_start = ?, period_end = ?, notes = ?, updated_at = datetime('now') WHERE id = ?`,
      ps, pe, body.notes !== undefined ? str(body.notes, { max: 2000, label: 'Observações' }) : m.notes, id);
    if (lines) for (const [itemId, q] of lines) run(`INSERT INTO measurement_lines (measurement_id, item_id, quantity) VALUES (?,?,?)
      ON CONFLICT(measurement_id, item_id) DO UPDATE SET quantity = excluded.quantity`, id, itemId, q);
    if (adjustments) {
      run('DELETE FROM measurement_adjustments WHERE measurement_id = ?', id);
      for (const a of adjustments) run('INSERT INTO measurement_adjustments (measurement_id, seq, description, unit, amount) VALUES (?,?,?,?,?)', id, a.seq, a.description, a.unit, a.amount);
    }
    const after = getMeasurement(ctx, id);
    if (m.status === 'recebida' && body.paid === 'total') run('UPDATE measurements SET paid_amount = ? WHERE id = ?', after.totals.to_bill, id);
    const changedItems = after.rows.filter(r => r.qty !== (before.rows.find(x => x.item_id === r.item_id)?.qty ?? 0)).map(r => `${r.seq}. ${r.description}: ${before.rows.find(x => x.item_id === r.item_id)?.qty ?? 0} → ${r.qty}`);
    audit(ctx.user.id, 'measurement', id, 'Medição corrigida (boletim já emitido)', {
      boletim: m.code, situacao: m.status, motivo: reason,
      total_antes: before.totals.to_bill, total_depois: after.totals.to_bill,
      itens_alterados: changedItems, descontos_acrescimos: after.adjustments.filter(a => a.amount).map(a => `${a.description}: ${a.amount}`),
      ...(m.status === 'recebida' ? { recebido: body.paid === 'total' ? `${m.paid_amount} → ${after.totals.to_bill}` : `mantido ${m.paid_amount}` } : {}),
    }, ip);
  });
  return getMeasurement(ctx, id);
}

export function measurementAction(ctx, id, action, body = {}, ip) {
  const m = loadMeasurement(ctx, id);
  const view = getMeasurement(ctx, id);
  const can = view.can;
  const log = (msg, det) => audit(ctx.user.id, 'measurement', id, msg, { boletim: m.code, ...det }, ip);
  tx(() => {
    switch (action) {
      case 'issue': {
        if (!can.issue) throw badRequest('A medição não está em rascunho.');
        if (!view.totals.measured && !view.totals.adj) throw badRequest('Informe ao menos uma quantidade medida ou um desconto/acréscimo antes de emitir.');
        run(`UPDATE measurements SET status = 'emitida', issued_at = ?, issued_by = ?, updated_at = datetime('now') WHERE id = ?`, new Date().toISOString(), ctx.user.id, id);
        log('Medição emitida', { total_a_faturar: view.totals.to_bill });
        break;
      }
      case 'reopen':
        if (!can.reopen) throw badRequest('Só a última medição emitida (ainda não faturada) pode ser reaberta.');
        run(`UPDATE measurements SET status = 'rascunho', issued_at = NULL, issued_by = NULL, updated_at = datetime('now') WHERE id = ?`, id);
        log('Medição reaberta para correção');
        break;
      case 'bill': {
        if (!can.bill) throw badRequest('Só uma medição emitida pode ser faturada.');
        const nf = str(body.nf_number, { max: 40, required: true, label: 'Nº da nota fiscal' });
        const nfDate = date(body.nf_date, 'Data da nota fiscal') || today();
        run(`UPDATE measurements SET status = 'faturada', nf_number = ?, nf_date = ?, updated_at = datetime('now') WHERE id = ?`, nf, nfDate, id);
        log('Medição faturada', { nf, data: nfDate, valor: view.totals.to_bill });
        break;
      }
      case 'receive': {
        if (!can.receive) throw badRequest('Só uma medição faturada pode ser marcada como recebida.');
        const pd = date(body.paid_date, 'Data do recebimento') || today();
        const amount = body.paid_amount === '' || body.paid_amount === undefined || body.paid_amount === null ? view.totals.to_bill : r2(num(body.paid_amount, 'Valor recebido', { min: 0 }));
        run(`UPDATE measurements SET status = 'recebida', paid_date = ?, paid_amount = ?, updated_at = datetime('now') WHERE id = ?`, pd, amount, id);
        log('Recebimento registrado', { data: pd, valor: amount });
        break;
      }
      case 'undo': {
        if (!can.undo) throw badRequest('Nada a desfazer.');
        if (m.status === 'recebida') run(`UPDATE measurements SET status = 'faturada', paid_date = NULL, paid_amount = NULL, updated_at = datetime('now') WHERE id = ?`, id);
        else run(`UPDATE measurements SET status = 'emitida', nf_number = NULL, nf_date = NULL, updated_at = datetime('now') WHERE id = ?`, id);
        log(m.status === 'recebida' ? 'Recebimento desfeito' : 'Faturamento desfeito');
        break;
      }
      case 'delete':
        if (!can.delete) throw badRequest('Só é possível excluir medição em rascunho.');
        run('DELETE FROM measurements WHERE id = ?', id);
        log('Medição em rascunho excluída');
        break;
      default:
        throw badRequest('Ação desconhecida.');
    }
  });
  return action === 'delete' ? { deleted: true, contract_id: m.contract_id } : getMeasurement(ctx, id);
}

// Faturado por mês (pela data da NF) — usado na análise comparativa das Tarefas financeiras
export function billedByMonth() {
  const out = new Map();
  for (const m of all(`SELECT * FROM measurements WHERE nf_date IS NOT NULL AND status IN ('faturada', 'recebida')`)) {
    const k = m.nf_date.slice(0, 7);
    out.set(k, r2((out.get(k) || 0) + measurementTotals(m).total));
  }
  return out;
}

// ---------- Faturamento global ----------
export function contractsDashboard(ctx, { months = 12, company = '', type = '' } = {}) {
  requireContracts(ctx.user);
  months = [6, 12, 24].includes(Number(months)) ? Number(months) : 12;
  // Filtro do painel inteiro: empresa (charao/lus) e tipo (id ou "sem")
  company = COMPANY_KEYS.includes(company) ? company : '';
  type = type === 'sem' || /^\d+$/.test(String(type || '')) ? String(type) : '';
  const all0 = listContracts(ctx);
  const list = all0.filter(c => (!company || c.company === company) && (!type || (type === 'sem' ? !c.type_id : c.type_id === Number(type))));
  const inList = new Set(list.map(c => c.id));
  const sum = k => r2(list.reduce((s, c) => s + (c.summary[k] || 0), 0));
  const active = list.filter(c => c.status === 'vigente');
  // Série mensal: medido (mês de referência), faturado (mês da NF) e recebido (mês do pagamento)
  const ms = all('SELECT * FROM measurements WHERE status <> \'rascunho\'').filter(m => inList.has(m.contract_id));
  const totalOf = new Map(ms.map(m => [m.id, measurementTotals(m).total]));
  const end = today().slice(0, 7);
  const keys = [];
  let [y, mo] = end.split('-').map(Number);
  for (let k = 0; k < months; k++) { keys.unshift(`${y}-${String(mo).padStart(2, '0')}`); mo--; if (!mo) { mo = 12; y--; } }
  const series = keys.map(k => ({
    month: k, label: monthLabel(k),
    measured: r2(ms.filter(m => m.ref_month === k).reduce((s, m) => s + totalOf.get(m.id), 0)),
    billed: r2(ms.filter(m => m.nf_date && m.nf_date.slice(0, 7) === k).reduce((s, m) => s + totalOf.get(m.id), 0)),
    received: r2(ms.filter(m => m.status === 'recebida' && m.paid_date && m.paid_date.slice(0, 7) === k).reduce((s, m) => s + (m.paid_amount ?? totalOf.get(m.id)), 0)),
  }));
  // Por cliente
  const byClient = new Map();
  for (const c of list) {
    const k = c.client;
    if (!byClient.has(k)) byClient.set(k, { client: k, contracts: 0, value: 0, measured: 0, measured_total: 0, billed: 0, received: 0, to_receive: 0, to_bill: 0, balance: 0 });
    const b = byClient.get(k);
    b.contracts++;
    // Mesmos totais por contrato do restante do painel (aguardando NF = boletins emitidos; saldo = contratado − medido)
    for (const f of ['value', 'measured', 'measured_total', 'billed', 'received', 'to_receive', 'to_bill']) b[f] = r2(b[f] + (c.summary[f] || 0));
    b.balance = r2(b.balance + Math.max(0, c.summary.balance || 0));
  }
  // Ano corrente x mesmo período do ano anterior (faturado pela data da NF, recebido pela data do pagamento)
  const ref = today();
  const year = ref.slice(0, 4);
  const prevYear = String(Number(year) - 1);
  const md = ref.slice(5);
  const inYear = (d, y) => d && d.slice(0, 4) === y && d.slice(5) <= md;
  const billedIn = y => r2(ms.filter(m => inYear(m.nf_date, y)).reduce((s, m) => s + totalOf.get(m.id), 0));
  const receivedIn = y => r2(ms.filter(m => m.status === 'recebida' && inYear(m.paid_date, y)).reduce((s, m) => s + (m.paid_amount ?? totalOf.get(m.id)), 0));
  const measuredIn = y => r2(ms.filter(m => m.ref_month.slice(0, 4) === y && m.ref_month <= `${y}-${md.slice(0, 2)}`).reduce((s, m) => s + totalOf.get(m.id), 0));
  // A receber por antiguidade (dias desde a NF)
  const code = new Map(list.map(c => [c.id, c]));
  const open = ms.filter(m => m.status === 'faturada').map(m => ({
    id: m.id, code: m.code, contract: code.get(m.contract_id)?.client, contract_id: m.contract_id, nf: m.nf_number, nf_date: m.nf_date,
    total: totalOf.get(m.id), days: m.nf_date ? Math.max(0, Math.round((Date.parse(ref) - Date.parse(m.nf_date)) / 86400e3)) : 0,
  }));
  const BUCKETS = [['0–30 dias', 0, 30], ['31–60 dias', 31, 60], ['61–90 dias', 61, 90], ['Mais de 90 dias', 91, 1e9]];
  const aging = BUCKETS.map(([label, a, b]) => {
    const it = open.filter(x => x.days >= a && x.days <= b);
    return { label, count: it.length, total: r2(it.reduce((s, x) => s + x.total, 0)) };
  });
  // Próximas ações
  const [py, pm] = (() => { let [y2, m2] = ref.slice(0, 7).split('-').map(Number); m2--; if (!m2) { m2 = 12; y2--; } return [y2, m2]; })();
  const lastMonth = `${py}-${String(pm).padStart(2, '0')}`;
  const actions = [];
  // Medição mensal: só cobra de contrato vigente com saldo a medir que vinha sendo medido mês a mês
  // (teve BM em um dos 2 meses anteriores ao mês passado). Contrato 100% medido: sugere encerrar.
  const prevMonth = k => { let [y3, m3] = lastMonth.split('-').map(Number); m3 -= k; while (m3 < 1) { m3 += 12; y3--; } return `${y3}-${String(m3).padStart(2, '0')}`; };
  const recent = [prevMonth(1), prevMonth(2)];
  for (const c of active) {
    const s = c.summary;
    // 100% medido e nada pendente (sem boletim aguardando NF, nada a receber, sem rascunho): sugere encerrar
    const pending = s.to_bill > 0.005 || s.to_receive > 0.005 || s.drafts;
    if (s.value > 0 && s.balance <= 0.005 && pending) continue;
    if (s.value > 0 && s.balance <= 0.005) {
      actions.push({ kind: 'encerrar', severity: 'warning', text: '100% medido — encerrar contrato?', group: '100% medido — encerrar contrato?', client: c.client, code: c.code, href: `#/contratos/${c.id}/editar` });
      continue;
    }
    if (c.start_date && c.start_date.slice(0, 7) > lastMonth) continue;
    const monthly = one(`SELECT 1 FROM measurements WHERE contract_id = ? AND status <> 'rascunho' AND ref_month IN (?, ?) LIMIT 1`, c.id, recent[0], recent[1]);
    if (s.balance > 0.005 && monthly && !one('SELECT 1 FROM measurements WHERE contract_id = ? AND ref_month = ?', c.id, lastMonth)) {
      actions.push({ kind: 'medir', severity: 'warning', text: `Sem medição de ${monthLabel(lastMonth)}`, group: `Sem medição de ${monthLabel(lastMonth)}`, client: c.client, code: c.code, href: `#/contratos/${c.id}` });
    }
    if (c.end_date && c.end_date >= ref && Math.round((Date.parse(c.end_date) - Date.parse(ref)) / 86400e3) <= 60) {
      actions.push({ kind: 'vencendo', severity: 'warning', text: `Contrato termina em ${c.end_date.split('-').reverse().join('/')}`, client: c.client, code: c.code, href: `#/contratos/${c.id}` });
    }
  }
  for (const m of ms.filter(x => x.status === 'emitida')) {
    actions.push({ kind: 'faturar', severity: 'serious', text: `Boletim ${m.code} emitido aguardando NF · ${totalOf.get(m.id).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}`, client: code.get(m.contract_id)?.client, code: m.code, href: `#/medicoes/${m.id}` });
  }
  for (const o of open.filter(x => x.days > 30)) {
    actions.push({ kind: 'cobrar', severity: o.days > 90 ? 'critical' : 'serious', text: `NF ${o.nf} sem recebimento há ${o.days} dias · ${o.total.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}`, client: o.contract, code: o.code, href: `#/medicoes/${o.id}` });
  }
  const sev = { critical: 0, serious: 1, warning: 2 };
  actions.sort((a, b) => sev[a.severity] - sev[b.severity]);
  // Comparativo anual: por ano, os 12 meses de medido (referência), faturado (NF) e recebido (pagamento)
  const yearsSet = new Set([year]);
  for (const m of ms) { yearsSet.add(m.ref_month.slice(0, 4)); if (m.nf_date) yearsSet.add(m.nf_date.slice(0, 4)); if (m.paid_date) yearsSet.add(m.paid_date.slice(0, 4)); }
  const years = [...yearsSet].sort();
  const annual = years.map(y => {
    const mon = k => Array.from({ length: 12 }, (_, i) => `${y}-${String(i + 1).padStart(2, '0')}`).map(key => r2(k(key)));
    const measured = mon(key => ms.filter(m => m.ref_month === key).reduce((s, m) => s + totalOf.get(m.id), 0));
    const billed = mon(key => ms.filter(m => m.nf_date && m.nf_date.slice(0, 7) === key).reduce((s, m) => s + totalOf.get(m.id), 0));
    const received = mon(key => ms.filter(m => m.status === 'recebida' && m.paid_date && m.paid_date.slice(0, 7) === key).reduce((s, m) => s + (m.paid_amount ?? totalOf.get(m.id)), 0));
    const tot = a => r2(a.reduce((s, v) => s + v, 0));
    return { year: y, measured, billed, received, totals: { measured: tot(measured), billed: tot(billed), received: tot(received) } };
  });
  // Faturamento por nota (para o ranking de clientes por período, filtrado na tela)
  const billing = ms.filter(m => m.nf_date).map(m => {
    const c = code.get(m.contract_id);
    return { client: c?.client || '—', contract: c?.code, nf_date: m.nf_date, total: totalOf.get(m.id), received: m.status === 'recebida' ? (m.paid_amount ?? totalOf.get(m.id)) : 0 };
  });
  return {
    months,
    filter: { company, type },
    companies: Object.entries(COMPANIES).map(([key, c]) => ({ key, name: c.name, contracts: all0.filter(x => x.company === key).length })),
    types: all('SELECT id, name, active FROM contract_types ORDER BY sort_order, id').map(t => ({ ...t, contracts: all0.filter(x => x.type_id === t.id).length }))
      .filter(t => t.active || t.contracts).concat([{ id: 'sem', name: 'Sem tipo', contracts: all0.filter(x => !x.type_id).length }]),
    annual,
    billing,
    year: { year, prev: prevYear, through: md, billed: billedIn(year), billed_prev: billedIn(prevYear), received: receivedIn(year), received_prev: receivedIn(prevYear), measured: measuredIn(year), measured_prev: measuredIn(prevYear) },
    aging,
    actions,
    totals: {
      contracts: list.length, active: active.length,
      value: r2(active.reduce((s, c) => s + c.summary.value, 0)),
      value_all: sum('value'), measured: sum('measured_total'), billed: sum('billed'), received: sum('received'),
      to_receive: sum('to_receive'), to_bill: sum('to_bill'),
      balance: r2(active.reduce((s, c) => s + c.summary.balance, 0)),
      drafts: list.reduce((s, c) => s + c.summary.drafts, 0),
    },
    series,
    by_client: [...byClient.values()].sort((a, b) => b.value - a.value),
    contracts: list,
    area_id: contractsAreaId(),
  };
}
