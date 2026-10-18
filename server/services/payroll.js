// Folha (Administrativa): pessoas da folha, folha do mês, cálculo e recibos.
// Folha do mês = mês do pagamento (AAAA-MM):
//  · valor mensal (bolsa) proporcional aos dias trabalhados no MÊS ANTERIOR (dias úteis do calendário da empresa, menos faltas);
//  · VT e VR ADIANTADOS do próprio mês: para cada dia útil do mês, conforme a escala da pessoa (seg a sex),
//    VT = 2 passagens × tarifa e VR = valor diário. Dias de férias aprovadas não contam.
//  · Home office no mês anterior desconta o VT já adiantado (dias × 2 × tarifa).
//  · Total = valor proporcional + VT + VR + reembolso. Tipo "profissional": sem VT/VR.
// Fechar a folha congela os valores e gera um pagamento por pessoa em Tarefas financeiras.
import { all, one, run, tx } from '../db.js';
import { badRequest, notFound, str, date, intOrNull } from '../lib/http.js';
import { requireSection, hasSection } from '../lib/permissions.js';
import { audit } from './audit.js';
import { workingDaysList } from './calendar.js';
import { createObligationInternal, obligationPaid, removeObligationInternal, setItemAmountInternal } from './finance.js';
import { today } from './metrics.js';

export const COMPANIES = {
  charao: { name: 'Charão Engenharia & Construção', logo: '/assets/logo.webp' },
  lus: { name: 'Ludimila Siqueira Arquitetura & Design', logo: '/assets/logo-lus.png' },
};
export const KINDS = { estagio: 'Estágio (bolsa + VT/VR)', profissional: 'Profissional (valor proporcional, sem VT/VR)' };
const WEEK = [1, 2, 3, 4, 5];
const r2 = v => Math.round((Number(v) || 0) * 100) / 100;
const pad = n => String(n).padStart(2, '0');

export const canPayroll = user => hasSection(user, 'folha');
const requirePayroll = ctx => requireSection(ctx.user, 'folha');

// ---------- Datas ----------
const monthOk = ym => /^\d{4}-(0[1-9]|1[0-2])$/.test(ym || '');
function bounds(ym) {
  const [y, m] = ym.split('-').map(Number);
  return { start: `${ym}-01`, end: `${ym}-${pad(new Date(Date.UTC(y, m, 0)).getUTCDate())}` };
}
function prevMonth(ym) {
  let [y, m] = ym.split('-').map(Number);
  m -= 1; if (m < 1) { m = 12; y--; }
  return `${y}-${pad(m)}`;
}
const dow = d => new Date(`${d}T00:00:00Z`).getUTCDay();
const maxD = (a, b) => (!a ? b : !b ? a : a > b ? a : b);
const minD = (a, b) => (!a ? b : !b ? a : a < b ? a : b);
export const periodsOf = ref => ({ bolsa: bounds(prevMonth(ref)), benefit: bounds(ref) });

// ---------- Pessoas da folha ----------
function parseSchedule(s) {
  let o = {};
  try { o = typeof s === 'string' ? JSON.parse(s || '{}') : s || {}; } catch { o = {}; }
  const out = {};
  for (const w of WEEK) out[w] = { vt: !!(o[w]?.vt), vr: !!(o[w]?.vr) };
  return out;
}
const PERSON_SQL = `SELECT p.*, u.name, u.job_title, u.active AS user_active, u.is_external
  FROM payroll_people p JOIN users u ON u.id = p.user_id`;
const shapePerson = p => p && ({ ...p, schedule: parseSchedule(p.schedule), company_name: COMPANIES[p.company]?.name || p.company });

export function listPeople(ctx) {
  requirePayroll(ctx);
  const people = all(`${PERSON_SQL} ORDER BY p.active DESC, u.name`).map(shapePerson);
  const used = new Set(people.map(p => p.user_id));
  return {
    people,
    candidates: all('SELECT id, name, job_title, is_external, login_enabled FROM users WHERE active = 1 ORDER BY name').filter(u => !used.has(u.id)),
    companies: Object.entries(COMPANIES).map(([key, c]) => ({ key, ...c })),
    kinds: Object.entries(KINDS).map(([key, label]) => ({ key, label })),
  };
}

export function getPerson(ctx, id) {
  requirePayroll(ctx);
  const p = shapePerson(one(`${PERSON_SQL} WHERE p.id = ?`, id));
  if (!p) throw notFound('Pessoa não encontrada na folha.');
  return p;
}

function readPerson(body, current = null) {
  const b = body || {};
  const userId = current ? current.user_id : intOrNull(b.user_id);
  if (!userId) throw badRequest('Escolha a pessoa do Cadastro da Equipe.');
  if (!current) {
    if (!one('SELECT id FROM users WHERE id = ? AND active = 1', userId)) throw badRequest('Pessoa inválida.');
    if (one('SELECT id FROM payroll_people WHERE user_id = ?', userId)) throw badRequest('Esta pessoa já está na folha.');
  }
  const value = Number(String(b.monthly_value ?? '').replace(',', '.'));
  if (!Number.isFinite(value) || value < 0) throw badRequest('Informe o valor mensal (bolsa).');
  const company = COMPANIES[b.company] ? b.company : 'charao';
  const kind = KINDS[b.kind] ? b.kind : 'estagio';
  const d = {
    user_id: userId, company, kind, monthly_value: r2(value),
    shift: str(b.shift, { max: 60, label: 'Turno' }),
    regime: str(b.regime, { max: 40, label: 'Regime' }) || 'Mensalista',
    schedule: JSON.stringify(parseSchedule(b.schedule)),
    pix: str(b.pix, { max: 120, label: 'PIX' }),
    cost_center: str(b.cost_center, { max: 80, label: 'Centro de custo' }),
    start_date: date(b.start_date, 'Início do contrato'),
    end_date: date(b.end_date, 'Término do contrato'),
    notes: str(b.notes, { max: 1000, label: 'Observações' }),
    active: b.active === false || b.active === 0 || b.active === '0' ? 0 : 1,
  };
  if (d.start_date && d.end_date && d.end_date < d.start_date) throw badRequest('O término do contrato não pode ser antes do início.');
  return d;
}

export function createPerson(ctx, body, ip) {
  requirePayroll(ctx);
  const d = readPerson(body);
  const id = Number(run(`INSERT INTO payroll_people (user_id, company, kind, monthly_value, shift, regime, schedule, pix, cost_center, start_date, end_date, notes, active, created_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, d.user_id, d.company, d.kind, d.monthly_value, d.shift, d.regime, d.schedule, d.pix, d.cost_center, d.start_date, d.end_date, d.notes, d.active, ctx.user.id).lastInsertRowid);
  audit(ctx.user.id, 'payroll', id, 'Pessoa incluída na folha', { pessoa: one('SELECT name FROM users WHERE id = ?', d.user_id)?.name }, ip);
  return getPerson(ctx, id);
}

export function updatePerson(ctx, id, body, ip) {
  requirePayroll(ctx);
  const cur = one('SELECT * FROM payroll_people WHERE id = ?', id);
  if (!cur) throw notFound('Pessoa não encontrada na folha.');
  const d = readPerson(body, cur);
  run(`UPDATE payroll_people SET company=?, kind=?, monthly_value=?, shift=?, regime=?, schedule=?, pix=?, cost_center=?, start_date=?, end_date=?, notes=?, active=?, updated_at=datetime('now') WHERE id=?`,
    d.company, d.kind, d.monthly_value, d.shift, d.regime, d.schedule, d.pix, d.cost_center, d.start_date, d.end_date, d.notes, d.active, id);
  audit(ctx.user.id, 'payroll', id, 'Cadastro da folha atualizado', { pessoa: one('SELECT name FROM users WHERE id = ?', cur.user_id)?.name }, ip);
  return getPerson(ctx, id);
}

// ---------- Cálculo ----------
// Dados da pessoa (ao vivo na folha aberta) + lançamento do mês → valores
export function compute(month, entry, person) {
  const { bolsa, benefit } = periodsOf(month.ref);
  const start = entry.start_date || maxD(bolsa.start, person.start_date);
  const end = entry.end_date || minD(bolsa.end, person.end_date);
  const business = workingDaysList(null, bolsa.start, bolsa.end).length;
  const periodDays = start && end && end >= start ? workingDaysList(null, start, end).length : 0;
  const absences = Math.max(0, Number(entry.absences) || 0);
  const worked = Math.max(0, periodDays - absences);
  const base = business ? r2((Number(person.monthly_value) || 0) * worked / business) : 0;
  const schedule = parseSchedule(person.schedule);
  const fare = Number(month.vt_fare) || 0, daily = Number(month.vr_daily) || 0;
  const estagio = person.kind !== 'profissional';
  // Dias úteis do mês dos benefícios dentro do contrato, sem as férias aprovadas da pessoa
  const bStart = maxD(benefit.start, person.start_date), bEnd = minD(benefit.end, person.end_date);
  const days = estagio && bStart <= bEnd ? workingDaysList(null, bStart, bEnd, person.user_id) : [];
  const perWeekday = Object.fromEntries(WEEK.map(w => [w, 0]));
  for (const d of days) { const w = dow(d); if (perWeekday[w] !== undefined) perWeekday[w]++; }
  const vtDays = WEEK.reduce((n, w) => n + (schedule[w].vt ? perWeekday[w] : 0), 0);
  const vrDays = WEEK.reduce((n, w) => n + (schedule[w].vr ? perWeekday[w] : 0), 0);
  const hasVt = WEEK.some(w => schedule[w].vt);
  const ho = Math.max(0, Number(entry.ho_days) || 0);
  const vtBase = estagio ? r2(vtDays * 2 * fare) : 0;
  const hoDiscount = estagio && hasVt ? r2(ho * 2 * fare) : 0;
  const vtAdjust = estagio ? r2(entry.vt_adjust) : 0, vrAdjust = estagio ? r2(entry.vr_adjust) : 0;
  const vt = r2(vtBase - hoDiscount + vtAdjust);
  const vrBase = estagio ? r2(vrDays * daily) : 0;
  const vr = r2(vrBase + vrAdjust);
  const reimbursement = r2(entry.reimbursement);
  return {
    start, end, business_days: business, period_days: periodDays, absences, worked_days: worked, ho_days: ho,
    weight: business ? r2(worked / business) : 0,
    base, vt_days: vtDays, vr_days: vrDays, per_weekday: perWeekday, vt_base: vtBase, ho_discount: hoDiscount, vt_adjust: vtAdjust, vt,
    vr_base: vrBase, vr_adjust: vrAdjust, vr, reimbursement, total: r2(base + vt + vr + reimbursement),
  };
}

const personSnapshot = p => ({
  name: p.name, job_title: p.job_title, company: p.company, company_name: COMPANIES[p.company]?.name || p.company, kind: p.kind,
  monthly_value: p.monthly_value, shift: p.shift, regime: p.regime, pix: p.pix, cost_center: p.cost_center, schedule: parseSchedule(p.schedule),
});

function entryView(month, e) {
  if (month.status === 'fechada' && e.snapshot) {
    const s = JSON.parse(e.snapshot);
    return { id: e.id, person_id: e.person_id, ...s.person, calc: s.calc, input: s.input, reimbursement_note: e.reimbursement_note, notes: e.notes, obligation_id: e.obligation_id };
  }
  const p = one(`${PERSON_SQL} WHERE p.id = ?`, e.person_id);
  return {
    id: e.id, person_id: e.person_id, ...personSnapshot(p), calc: compute(month, e, p),
    input: { start_date: e.start_date, end_date: e.end_date, absences: e.absences, ho_days: e.ho_days, vt_adjust: e.vt_adjust, vr_adjust: e.vr_adjust, reimbursement: e.reimbursement },
    reimbursement_note: e.reimbursement_note, notes: e.notes, obligation_id: e.obligation_id,
  };
}

function totalsOf(entries) {
  const t = { base: 0, vt: 0, vr: 0, reimbursement: 0, total: 0 };
  for (const e of entries) for (const k of Object.keys(t)) t[k] = r2(t[k] + (e.calc[k] || 0));
  return t;
}

// ---------- Folha pré-lançada em Tarefas financeiras ----------
const ITEM_SQL = `SELECT i.id, i.ref_month, i.due_date, i.amount_expected, i.estimated, i.status, o.title, o.category
  FROM finance_items i JOIN finance_obligations o ON o.id = i.obligation_id`;
// Parcelas pendentes da categoria Folha de pagamento ainda não usadas por outra folha
export function financeCandidates(exceptMonthId = 0) {
  return all(`${ITEM_SQL} WHERE i.status = 'pendente' AND o.category = 'Folha de pagamento'
    AND NOT EXISTS (SELECT 1 FROM payroll_months pm WHERE pm.finance_item_id = i.id AND pm.id <> ?)
    AND NOT EXISTS (SELECT 1 FROM payroll_entries pe WHERE pe.obligation_id = o.id)
    ORDER BY i.ref_month, o.title`, exceptMonthId);
}
function readFinanceItem(v, monthId = 0) {
  if (v === undefined) return undefined;
  if (v === '' || v === null || v === 'nenhuma' || v === 0) return null;
  const id = intOrNull(v);
  if (!financeCandidates(monthId).some(c => c.id === id)) throw badRequest('Escolha uma folha pré-lançada pendente em Tarefas financeiras (categoria Folha de pagamento).');
  return id;
}

// ---------- Folha do mês ----------
function loadMonth(id) {
  const m = one('SELECT * FROM payroll_months WHERE id = ?', id);
  if (!m) throw notFound('Folha não encontrada.');
  return m;
}
const openOnly = m => { if (m.status !== 'aberta') throw badRequest('A folha está fechada. Reabra para alterar.'); };

export function listMonths(ctx) {
  requirePayroll(ctx);
  const months = all('SELECT * FROM payroll_months ORDER BY ref DESC').map(m => {
    const entries = all('SELECT * FROM payroll_entries WHERE month_id = ?', m.id).map(e => entryView(m, e));
    return { ...m, ...periodsOf(m.ref), people: entries.length, totals: totalsOf(entries) };
  });
  const cur = today().slice(0, 7);
  const last = months[0];
  return {
    months,
    suggested_ref: !months.some(m => m.ref === cur) ? cur : nextRef(months[0].ref),
    defaults: { vt_fare: last?.vt_fare ?? 5.9, vr_daily: last?.vr_daily ?? 22 },
    finance_candidates: financeCandidates(),
    people_count: one('SELECT COUNT(*) AS n FROM payroll_people WHERE active = 1').n,
  };
}
function nextRef(ym) {
  let [y, m] = ym.split('-').map(Number);
  m += 1; if (m > 12) { m = 1; y++; }
  return `${y}-${pad(m)}`;
}

function readParams(b, cur = {}) {
  const num = (v, label, fb) => {
    if (v === undefined || v === null || v === '') return fb;
    const n = Number(String(v).replace(',', '.'));
    if (!Number.isFinite(n) || n < 0) throw badRequest(`${label} inválido.`);
    return r2(n);
  };
  return {
    vt_fare: num(b.vt_fare, 'Valor da passagem (VT)', cur.vt_fare ?? 5.9),
    vr_daily: num(b.vr_daily, 'Valor diário do VR', cur.vr_daily ?? 22),
    pay_date: b.pay_date === undefined ? cur.pay_date ?? null : date(b.pay_date, 'Data do pagamento'),
    notes: b.notes === undefined ? cur.notes ?? null : str(b.notes, { max: 1000, label: 'Observações' }),
  };
}

// Inclui na folha as pessoas ativas cujo contrato cruza o período (bolsa ou benefícios)
function addMissing(m) {
  const { bolsa, benefit } = periodsOf(m.ref);
  let n = 0;
  for (const p of all('SELECT * FROM payroll_people WHERE active = 1')) {
    if (p.start_date && p.start_date > benefit.end) continue;
    if (p.end_date && p.end_date < bolsa.start) continue;
    const r = run('INSERT OR IGNORE INTO payroll_entries (month_id, person_id) VALUES (?, ?)', m.id, p.id);
    n += r.changes;
  }
  return n;
}

export function createMonth(ctx, body, ip) {
  requirePayroll(ctx);
  const ref = String(body?.ref || '');
  if (!monthOk(ref)) throw badRequest('Informe o mês da folha (mês do pagamento).');
  if (one('SELECT id FROM payroll_months WHERE ref = ?', ref)) throw badRequest('Já existe uma folha para este mês.');
  const last = one('SELECT * FROM payroll_months ORDER BY ref DESC LIMIT 1');
  const d = readParams(body || {}, last || {});
  const fin = readFinanceItem(body?.finance_item_id) ?? null;
  if (body?.finance_item_id === undefined && financeCandidates().length) throw badRequest('Selecione a folha pré-lançada em Tarefas financeiras (ou indique que não há).');
  if (!body?.pay_date) d.pay_date = fin ? one('SELECT due_date FROM finance_items WHERE id = ?', fin).due_date : `${ref}-05`;
  const id = tx(() => {
    const nid = Number(run('INSERT INTO payroll_months (ref, vt_fare, vr_daily, pay_date, notes, finance_item_id, created_by) VALUES (?,?,?,?,?,?,?)', ref, d.vt_fare, d.vr_daily, d.pay_date, d.notes || null, fin, ctx.user.id).lastInsertRowid);
    addMissing(loadMonth(nid));
    return nid;
  });
  audit(ctx.user.id, 'payroll', id, 'Folha criada', { mes: ref }, ip);
  return getMonth(ctx, id);
}

export function getMonth(ctx, id) {
  requirePayroll(ctx);
  const m = loadMonth(id);
  const entries = all(`SELECT e.* FROM payroll_entries e JOIN payroll_people p ON p.id = e.person_id JOIN users u ON u.id = p.user_id WHERE e.month_id = ? ORDER BY u.name`, m.id).map(e => entryView(m, e));
  const { bolsa, benefit } = periodsOf(m.ref);
  const inMonth = new Set(entries.map(e => e.person_id));
  return {
    ...m, bolsa, benefit,
    business_days: workingDaysList(null, bolsa.start, bolsa.end).length,
    benefit_days: workingDaysList(null, benefit.start, benefit.end).length,
    closed_by_name: m.closed_by ? one('SELECT name FROM users WHERE id = ?', m.closed_by)?.name : null,
    finance_item: m.finance_item_id ? one(`${ITEM_SQL} WHERE i.id = ?`, m.finance_item_id) : null,
    finance_candidates: m.status === 'aberta' ? financeCandidates(m.id) : [],
    entries, totals: totalsOf(entries),
    available: m.status === 'aberta' ? all(`${PERSON_SQL} WHERE p.active = 1 ORDER BY u.name`).filter(p => !inMonth.has(p.id)).map(p => ({ id: p.id, name: p.name })) : [],
    companies: COMPANIES,
    can_finance: !!ctx.user.can_finance,
  };
}

export function updateMonth(ctx, id, body, ip) {
  requirePayroll(ctx);
  const m = loadMonth(id);
  openOnly(m);
  const d = readParams(body || {}, m);
  const fin = readFinanceItem(body?.finance_item_id, m.id);
  run(`UPDATE payroll_months SET vt_fare=?, vr_daily=?, pay_date=?, notes=?, finance_item_id=?, updated_at=datetime('now') WHERE id=?`, d.vt_fare, d.vr_daily, d.pay_date, d.notes, fin === undefined ? m.finance_item_id : fin, m.id);
  audit(ctx.user.id, 'payroll', m.id, 'Parâmetros da folha alterados', { mes: m.ref }, ip);
  return getMonth(ctx, id);
}

export function addPeopleToMonth(ctx, id, body) {
  requirePayroll(ctx);
  const m = loadMonth(id);
  openOnly(m);
  const pid = intOrNull(body?.person_id);
  if (pid) {
    if (!one('SELECT id FROM payroll_people WHERE id = ?', pid)) throw badRequest('Pessoa inválida.');
    run('INSERT OR IGNORE INTO payroll_entries (month_id, person_id) VALUES (?, ?)', m.id, pid);
  } else addMissing(m);
  return getMonth(ctx, id);
}

export function updateEntry(ctx, entryId, body, ip) {
  requirePayroll(ctx);
  const e = one('SELECT * FROM payroll_entries WHERE id = ?', entryId);
  if (!e) throw notFound('Lançamento não encontrado.');
  const m = loadMonth(e.month_id);
  openOnly(m);
  const b = body || {};
  const { bolsa } = periodsOf(m.ref);
  const start = date(b.start_date, 'Início'), end = date(b.end_date, 'Fim');
  if (start && (start < bolsa.start || start > bolsa.end)) throw badRequest('O início precisa estar dentro do mês da bolsa.');
  if (end && (end < bolsa.start || end > bolsa.end)) throw badRequest('O fim precisa estar dentro do mês da bolsa.');
  if (start && end && end < start) throw badRequest('O fim não pode ser antes do início.');
  const int = (v, label) => { const n = Number(v || 0); if (!Number.isInteger(n) || n < 0 || n > 31) throw badRequest(`${label} inválido.`); return n; };
  const money = (v, label, neg = false) => { const n = Number(String(v ?? 0).replace(',', '.') || 0); if (!Number.isFinite(n) || (!neg && n < 0)) throw badRequest(`${label} inválido.`); return r2(n); };
  run(`UPDATE payroll_entries SET start_date=?, end_date=?, absences=?, ho_days=?, vt_adjust=?, vr_adjust=?, reimbursement=?, reimbursement_note=?, notes=?, updated_at=datetime('now') WHERE id=?`,
    start, end, int(b.absences, 'Faltas'), int(b.ho_days, 'Dias em home office'), money(b.vt_adjust, 'VT diferença', true), money(b.vr_adjust, 'VR diferença', true),
    money(b.reimbursement, 'Reembolso'), str(b.reimbursement_note, { max: 300, label: 'Descrição do reembolso' }), str(b.notes, { max: 1000, label: 'Observação' }), e.id);
  audit(ctx.user.id, 'payroll', m.id, 'Lançamento da folha alterado', { mes: m.ref, pessoa: one('SELECT u.name FROM payroll_people p JOIN users u ON u.id = p.user_id WHERE p.id = ?', e.person_id)?.name }, ip);
  return getMonth(ctx, m.id);
}

export function removeEntry(ctx, entryId) {
  requirePayroll(ctx);
  const e = one('SELECT * FROM payroll_entries WHERE id = ?', entryId);
  if (!e) throw notFound('Lançamento não encontrado.');
  const m = loadMonth(e.month_id);
  openOnly(m);
  run('DELETE FROM payroll_entries WHERE id = ?', e.id);
  return getMonth(ctx, m.id);
}

const refLabel = ref => `${ref.slice(5, 7)}/${ref.slice(0, 4)}`;
const brl = v => (Number(v) || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

// Fechar: congela os valores e gera um pagamento por pessoa em Tarefas financeiras
export function closeMonth(ctx, id, ip) {
  requirePayroll(ctx);
  const m = loadMonth(id);
  openOnly(m);
  const rows = all('SELECT * FROM payroll_entries WHERE month_id = ?', m.id);
  if (!rows.length) throw badRequest('A folha não tem pessoas.');
  const dueDay = Number((m.pay_date || `${m.ref}-05`).slice(8, 10)) || 5;
  const linked = m.finance_item_id ? one('SELECT * FROM finance_items WHERE id = ?', m.finance_item_id) : null;
  if (m.finance_item_id && (!linked || linked.status !== 'pendente')) throw badRequest('A folha pré-lançada em Tarefas financeiras não está mais pendente. Escolha outra ou retire o vínculo.');
  let generated = 0;
  tx(() => {
    if (linked) {
      const calcs = rows.map(e => { const p = one(`${PERSON_SQL} WHERE p.id = ?`, e.person_id); return { e, p, calc: compute(m, e, p) }; });
      for (const { e, p, calc } of calcs) {
        const snap = { person: personSnapshot(p), calc, input: { start_date: e.start_date, end_date: e.end_date, absences: e.absences, ho_days: e.ho_days, vt_adjust: e.vt_adjust, vr_adjust: e.vr_adjust, reimbursement: e.reimbursement } };
        run(`UPDATE payroll_entries SET snapshot = ?, obligation_id = NULL, updated_at = datetime('now') WHERE id = ?`, JSON.stringify(snap), e.id);
      }
      const total = r2(calcs.reduce((s, x) => s + x.calc.total, 0));
      const detail = ['Folha ' + refLabel(m.ref) + ' (valores por pessoa):', ...calcs.map(({ p, calc }) => `· ${p.name}: ${brl(calc.total)}${p.pix ? ` — PIX ${p.pix}` : ''}`)].join('\n');
      run('UPDATE payroll_months SET finance_estimate = ? WHERE id = ?', linked.amount_expected, m.id);
      setItemAmountInternal(linked.id, total, ctx.user.id, { estimated: 0, history: `Valor corrigido pela Folha ${refLabel(m.ref)}`, extra: detail });
      run(`UPDATE payroll_months SET status = 'fechada', closed_at = ?, closed_by = ?, updated_at = datetime('now') WHERE id = ?`, new Date().toISOString(), ctx.user.id, m.id);
      return;
    }
    for (const e of rows) {
      const p = one(`${PERSON_SQL} WHERE p.id = ?`, e.person_id);
      const calc = compute(m, e, p);
      const snap = { person: personSnapshot(p), calc, input: { start_date: e.start_date, end_date: e.end_date, absences: e.absences, ho_days: e.ho_days, vt_adjust: e.vt_adjust, vr_adjust: e.vr_adjust, reimbursement: e.reimbursement } };
      let obligation = null;
      if (calc.total > 0) {
        obligation = createObligationInternal(ctx.user.id, {
          title: `Folha ${refLabel(m.ref)} — ${p.name}`, category: 'Folha de pagamento', payee: p.name, amount: calc.total, due_day: dueDay, month: m.ref, assignee_id: ctx.user.id,
          notes: [`Valor proporcional: ${brl(calc.base)} · VT: ${brl(calc.vt)} · VR: ${brl(calc.vr)} · Reembolso: ${brl(calc.reimbursement)}`, p.pix ? `PIX: ${p.pix}` : '', p.cost_center ? `Centro de custo: ${p.cost_center}` : ''].filter(Boolean).join('\n'),
        });
        generated++;
      }
      run(`UPDATE payroll_entries SET snapshot = ?, obligation_id = ?, updated_at = datetime('now') WHERE id = ?`, JSON.stringify(snap), obligation, e.id);
    }
    run(`UPDATE payroll_months SET status = 'fechada', closed_at = ?, closed_by = ?, updated_at = datetime('now') WHERE id = ?`, new Date().toISOString(), ctx.user.id, m.id);
  });
  audit(ctx.user.id, 'payroll', m.id, 'Folha fechada', linked ? { mes: m.ref, folha_pre_lancada: linked.id } : { mes: m.ref, pagamentos_gerados: generated }, ip);
  return { ...getMonth(ctx, m.id), generated, corrected: !!linked };
}

// Reabrir: só se nenhum pagamento foi registrado; remove os pagamentos pendentes gerados
export function reopenMonth(ctx, id, ip) {
  requirePayroll(ctx);
  const m = loadMonth(id);
  if (m.status !== 'fechada') throw badRequest('A folha já está aberta.');
  const rows = all('SELECT * FROM payroll_entries WHERE month_id = ?', m.id);
  if (rows.some(e => e.obligation_id && obligationPaid(e.obligation_id))) throw badRequest('Há pagamento registrado em Tarefas financeiras para esta folha. Desfaça o pagamento antes de reabrir.');
  const linked = m.finance_item_id ? one('SELECT * FROM finance_items WHERE id = ?', m.finance_item_id) : null;
  if (linked?.status === 'paga') throw badRequest('A folha pré-lançada já foi paga em Tarefas financeiras. Desfaça o pagamento antes de reabrir.');
  tx(() => {
    if (linked && m.finance_estimate != null) setItemAmountInternal(linked.id, m.finance_estimate, ctx.user.id, { estimated: 1, history: `Folha ${refLabel(m.ref)} reaberta: volta ao valor estimado` });
    for (const e of rows) if (e.obligation_id) removeObligationInternal(e.obligation_id, ctx.user.id, `Folha ${refLabel(m.ref)} reaberta para correção`);
    run(`UPDATE payroll_entries SET snapshot = NULL, obligation_id = NULL, updated_at = datetime('now') WHERE month_id = ?`, m.id);
    run(`UPDATE payroll_months SET status = 'aberta', closed_at = NULL, closed_by = NULL, updated_at = datetime('now') WHERE id = ?`, m.id);
  });
  audit(ctx.user.id, 'payroll', m.id, 'Folha reaberta', { mes: m.ref }, ip);
  return getMonth(ctx, m.id);
}

export function deleteMonth(ctx, id, ip) {
  requirePayroll(ctx);
  const m = loadMonth(id);
  openOnly(m);
  run('DELETE FROM payroll_months WHERE id = ?', m.id);
  audit(ctx.user.id, 'payroll', m.id, 'Folha excluída', { mes: m.ref }, ip);
  return { ok: true };
}
