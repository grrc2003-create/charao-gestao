// Importação das planilhas de recebimentos do financeiro (.xlsx) como contratos e BMs (boletins de medição).
// Contrato = obra (cliente = quem mais pagou). Valor do contrato = todas as parcelas (recebidas e em aberto), com itens
// por natureza (unidade R$, preço 1,00 → quantidade = valor). BM só do que foi recebido: um por mês (vencimento), status
// Recebida, RT de fornecedor como acréscimo e a diferença do recebimento (desconto/juros) como desconto/acréscimo.
// Parcela em aberto fica como saldo a medir. Cada linha considerada fica registrada (contract_import_rows): reenviar não
// soma de novo e, quando a parcela passa a recebida, ganha o BM. Mês com BM lançado à mão no contrato é ignorado.
// Aporte, empréstimo, reembolso e linhas sem obra ficam fora.
import { createHash } from 'node:crypto';
import { all, one, run, tx } from '../db.js';
import { badRequest, str } from '../lib/http.js';
import { readXlsx, serialToDate } from '../lib/xlsx.js';
import { audit } from './audit.js';
import { today, addDays } from './metrics.js';
import { requireContracts, monthLabel, suggestContractType, COMPANY_KEYS } from './contracts.js';

const r2 = v => Math.round((Number(v) || 0) * 100) / 100;
const norm = s => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
const hkey = s => norm(s).replace(/[^a-z0-9]/g, '');
const COLS = {
  due: 'datadevencimento', received_date: 'dataderecebimento', amount: 'totaldaparcela', received_amount: 'totalrecebido',
  interest: 'jurosmultas', discount: 'descontos', received: 'recebido', nature: 'natureza', description: 'descricao', doc: 'ndocumento',
  client: 'cliente', obra: 'obra', installment: 'condicoesderecebimento', account: 'contabancaria',
};
const OTHER_NATURES = new Set(['aportedecapital', 'emprestimo', 'reembolso']);
const cellDate = v => {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return v > 20000 && v < 80000 ? serialToDate(v) : null;
  const s = String(v).trim();
  let m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(s);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
};
const cellNum = v => {
  if (v === null || v === undefined || v === '') return 0;
  if (typeof v === 'number') return r2(v);
  const s = String(v).trim().replace(/^R\$\s*/, '');
  const n = Number(s.includes(',') ? s.replace(/\./g, '').replace(',', '.') : s);
  return Number.isFinite(n) ? r2(n) : NaN;
};
const txt = v => (v === null || v === undefined ? null : String(v).trim() || null);

// Lê as planilhas e classifica cada linha: parcela / rt / outra; recebida ou em aberto
function parseFiles(files) {
  if (!Array.isArray(files) || !files.length) throw badRequest('Envie ao menos uma planilha (.xlsx).');
  if (files.length > 12) throw badRequest('Envie no máximo 12 planilhas por vez.');
  const rows = [], warnings = [], info = [];
  for (const f of files) {
    const name = str(f?.name, { max: 200, label: 'Nome do arquivo' }) || 'planilha.xlsx';
    let grid;
    try { grid = readXlsx(Buffer.from(String(f?.data || '').replace(/^data:[^,]*,/, ''), 'base64')); }
    catch (e) { throw badRequest(`${name}: não foi possível ler a planilha (${e.message}).`); }
    const hi = grid.findIndex(r => r.some(v => hkey(v) === COLS.due) && r.some(v => hkey(v) === COLS.client));
    if (hi < 0) throw badRequest(`${name}: não encontrei o cabeçalho (Data de Vencimento, Cliente, Obra, Total da Parcela…).`);
    const col = {};
    grid[hi].forEach((v, i) => { const k = Object.entries(COLS).find(([, h]) => h === hkey(v))?.[0]; if (k && col[k] === undefined) col[k] = i; });
    for (const k of ['due', 'amount', 'client', 'obra', 'received']) if (col[k] === undefined) throw badRequest(`${name}: falta a coluna "${{ due: 'Data de Vencimento', amount: 'Total da Parcela', client: 'Cliente', obra: 'Obra', received: 'Recebido' }[k]}".`);
    let n = 0;
    const seen = new Map();
    for (let i = hi + 1; i < grid.length; i++) {
      const g = grid[i], v = k => (col[k] === undefined ? null : g[col[k]] ?? null);
      if (!g.some(x => x !== null && x !== '')) continue;
      const line = i + 1;
      const due = cellDate(v('due')), amount = cellNum(v('amount'));
      if (!due) { warnings.push(`${name}, linha ${line}: sem data de vencimento — ignorada.`); continue; }
      if (!Number.isFinite(amount) || amount <= 0) { warnings.push(`${name}, linha ${line}: valor da parcela inválido — ignorada.`); continue; }
      const obra = txt(v('obra')), nature = txt(v('nature')), description = txt(v('description'));
      const received = hkey(v('received')) === 'sim';
      const discount = cellNum(v('discount')) || 0, interest = cellNum(v('interest')) || 0, recAmt = cellNum(v('received_amount'));
      // Identifica a linha (sem os dados do recebimento, que mudam quando a parcela é paga)
      const base = [hkey(obra), hkey(v('client')), due, amount.toFixed(2), hkey(description), hkey(v('installment')), hkey(v('doc'))].join('|');
      const occ = (seen.get(base) || 0) + 1;
      seen.set(base, occ);
      rows.push({
        import_key: createHash('sha1').update(`${base}|${occ}`).digest('hex').slice(0, 32),
        file: name, line, obra, payer: txt(v('client')), nature, description, doc: txt(v('doc')), installment: txt(v('installment')), account: txt(v('account')),
        kind: !obra || OTHER_NATURES.has(hkey(nature)) ? 'outra' : hkey(description) === 'rt' || hkey(nature) === 'outrasreceitas' ? 'rt' : 'parcela',
        due_date: due, amount, received,
        received_date: received ? cellDate(v('received_date')) || due : null,
        received_amount: received ? (Number.isFinite(recAmt) && recAmt > 0 ? recAmt : r2(amount - discount + interest)) : null,
      });
      n++;
    }
    info.push({ name, rows: n });
  }
  return { rows, warnings, files: info };
}

const mainClient = rows => {
  const by = new Map();
  const pool = rows.some(r => r.kind === 'parcela') ? rows.filter(r => r.kind === 'parcela') : rows;
  for (const r of pool) by.set(r.payer || '—', (by.get(r.payer || '—') || 0) + r.amount);
  return [...by.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || '—';
};
const initials = client => (String(client).normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().match(/[A-Z0-9]+/g) || ['BM'])
  .filter(w => w.length > 2 || /\d/.test(w)).map(w => w[0]).join('').slice(0, 4) || 'BM';
const natureLabel = n => txt(n) || 'Serviços';
// Empresa sugerida: LuS quando a maior parte do valor caiu numa conta "(LUS)"
const suggestCompany = rows => {
  const lus = rows.filter(r => /\blus\b/i.test(norm(r.account))).reduce((s, r) => s + r.amount, 0);
  return lus > rows.reduce((s, r) => s + r.amount, 0) / 2 ? 'lus' : 'charao';
};

// BMs de uma lista de linhas recebidas: um por mês do vencimento
function monthsOf(rows) {
  const by = new Map();
  for (const r of rows) {
    const k = r.due_date.slice(0, 7);
    if (!by.has(k)) by.set(k, []);
    by.get(k).push(r);
  }
  return [...by.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([month, rs]) => {
    const parc = rs.filter(r => r.kind === 'parcela'), rt = rs.filter(r => r.kind === 'rt');
    const lines = new Map();
    for (const r of parc) { const k = natureLabel(r.nature); lines.set(k, r2((lines.get(k) || 0) + r.amount)); }
    const adjustments = [];
    const rtBy = new Map();
    for (const r of rt) { const k = r.payer || 'fornecedor'; rtBy.set(k, r2((rtBy.get(k) || 0) + r.received_amount)); }
    for (const [payer, v] of rtBy) adjustments.push({ description: `RT - ${payer}`.slice(0, 200), amount: v });
    const diff = r2(parc.reduce((s, r) => s + r.received_amount - r.amount, 0));
    if (diff) adjustments.push({ description: diff < 0 ? 'Descontos no recebimento' : 'Juros/multas no recebimento', amount: diff });
    const measured = r2([...lines.values()].reduce((s, v) => s + v, 0));
    const total = r2(measured + adjustments.reduce((s, a) => s + a.amount, 0));
    return {
      month, label: monthLabel(month), lines: [...lines.entries()].map(([nature, value]) => ({ nature, value })), adjustments, measured, total,
      nf_date: rs.map(r => r.due_date).sort()[0], paid_date: rs.map(r => r.received_date).sort().at(-1),
      docs: [...new Set(rs.map(r => r.doc).filter(Boolean))].join(', ').slice(0, 40) || null,
      count: rs.length, rows: rs,
      notes: `Importado da planilha de recebimentos: ${rs.map(r => [r.kind === 'rt' ? `RT ${r.payer || ''}`.trim() : r.description, r.installment && !/vista/i.test(r.installment) ? r.installment : '', r.received_date.split('-').reverse().join('/')].filter(Boolean).join(' ')).join('; ')}`.slice(0, 2000),
    };
  });
}

// O que fazer com cada linha da obra no contrato escolhido (null = contrato novo):
// value = soma no valor do contrato · bm = entra num BM agora · track = só registra (em aberto) · skip = mês com BM manual
function analyze(rows, contractId, off = new Set()) {
  const tracked = new Map(all(`SELECT import_key, status FROM contract_import_rows WHERE import_key IN (${rows.map(() => '?').join(',') || "''"})`, ...rows.map(r => r.import_key)).map(t => [t.import_key, t.status]));
  // Meses com BM lançado fora da importação neste contrato
  const manual = new Set(contractId ? all(`SELECT ref_month FROM measurements WHERE contract_id = ? AND status <> 'rascunho' AND id NOT IN (SELECT measurement_id FROM contract_import_rows WHERE measurement_id IS NOT NULL)`, contractId).map(m => m.ref_month) : []);
  const acts = rows.map(r => {
    const t = tracked.get(r.import_key);
    if (t === 'medido' || t === 'ignorado') return { r, act: 'done' };
    if (!t && off.has(r.import_key)) return { r, act: 'off' };
    if (t === 'aberto') return { r, act: r.received ? 'bm' : 'done', value: false };
    if (r.received && manual.has(r.due_date.slice(0, 7))) return { r, act: 'skip' };
    return { r, act: r.received ? 'bm' : 'track', value: r.kind === 'parcela' };
  });
  const valueRows = acts.filter(a => a.value).map(a => a.r);
  const months = monthsOf(acts.filter(a => a.act === 'bm').map(a => a.r));
  const sums = new Map();
  for (const r of valueRows) { const k = natureLabel(r.nature); sums.set(k, r2((sums.get(k) || 0) + r.amount)); }
  return {
    acts, months, value_add: r2(valueRows.reduce((s, r) => s + r.amount, 0)), natures: [...sums.entries()].map(([nature, value]) => ({ nature, value })),
    open_add: r2(valueRows.filter(r => !r.received).reduce((s, r) => s + r.amount, 0)),
    open_count: rows.filter(r => !r.received && r.kind === 'parcela').length, open_total: r2(rows.filter(r => !r.received && r.kind === 'parcela').reduce((s, r) => s + r.amount, 0)),
    skipped_months: [...new Set(acts.filter(a => a.act === 'skip').map(a => a.r.due_date.slice(0, 7)))].length,
    pending: acts.some(a => a.act !== 'done' && a.act !== 'off'),
  };
}

// Pagamentos descartados: os guardados (menos os reativados agora) e os desmarcados agora
function offKeys({ exclude, restore } = {}) {
  const rest = new Set(Array.isArray(restore) ? restore.map(String) : []);
  return new Set([...all('SELECT import_key FROM contract_import_discards').map(d => d.import_key).filter(k => !rest.has(k)), ...(Array.isArray(exclude) ? exclude.map(String) : [])]);
}

function plan(files, opts = {}) {
  const { rows, warnings, files: info } = parseFiles(files);
  const off = offKeys(opts);
  const contracts = all('SELECT id, code, client, title, status, bulletin_prefix, company, company_auto, type_id FROM contracts ORDER BY code');
  const byTitle = new Map(contracts.map(c => [hkey(c.title), c]));
  const groups = new Map();
  for (const r of rows.filter(x => x.kind !== 'outra')) {
    const k = hkey(r.obra);
    if (!groups.has(k)) groups.set(k, { key: k, obra: r.obra, rows: [] });
    groups.get(k).rows.push(r);
  }
  const out = [...groups.values()].map(g => {
    const match = byTitle.get(g.key) || null;
    const a = analyze(g.rows, match?.id || null, off);
    // Classificação: contrato novo usa a sugestão; já cadastrado mantém o que tem (empresa escolhida à mão não muda)
    const sugCompany = suggestCompany(g.rows), sugType = suggestContractType(g.obra);
    const company = match ? (match.company_auto ? sugCompany : match.company) : sugCompany;
    const type_id = match ? (match.type_id || sugType) : sugType;
    return {
      company, type_id, reclassify: !!match && (company !== match.company || (type_id || null) !== (match.type_id || null)),
      key: g.key, obra: g.obra, client: mainClient(g.rows), payers: [...new Set(g.rows.map(r => r.payer).filter(Boolean))], rows: g.rows,
      match: match && { id: match.id, code: match.code, client: match.client, title: match.title, company: match.company, type_id: match.type_id },
      months: a.months.map(({ rows: _r, ...m }) => m), bms: a.months.length, total: r2(a.months.reduce((s, m) => s + m.total, 0)),
      rt: r2(a.months.reduce((s, m) => s + m.adjustments.filter(x => x.description.startsWith('RT - ')).reduce((t, x) => t + x.amount, 0), 0)),
      value_add: a.value_add, natures: a.natures, open_add: a.open_add, open_count: a.open_count, open_total: a.open_total,
      skipped_months: a.skipped_months, pending: a.pending,
      // Pagamentos da obra, um a um (para descartar algum antes de importar)
      items: a.acts.map(x => ({ key: x.r.import_key, state: x.act === 'done' ? 'importado' : x.act === 'off' ? 'descartado' : 'novo', kind: x.r.kind,
        due_date: x.r.due_date, payer: x.r.payer, description: x.r.description, installment: x.r.installment, amount: x.r.amount,
        received_date: x.r.received_date, received_amount: x.r.received_amount, saved_off: off.has(x.r.import_key) })),
      discarded: a.acts.filter(x => x.act === 'off').length,
      first_due: g.rows.map(r => r.due_date).sort()[0], last_activity: g.rows.map(r => r.received_date || r.due_date).sort().at(-1),
    };
  }).sort((a, b) => a.client.localeCompare(b.client, 'pt-BR') || a.obra.localeCompare(b.obra, 'pt-BR'));
  const others = rows.filter(r => r.kind === 'outra');
  return {
    files: info, warnings, total_rows: rows.length, groups: out,
    skipped: { others: others.length, others_total: r2(others.reduce((s, r) => s + (r.received_amount ?? r.amount), 0)) },
    contracts: contracts.map(c => ({ id: c.id, code: c.code, client: c.client, title: c.title })),
    types: all('SELECT id, name FROM contract_types WHERE active = 1 ORDER BY sort_order, id'),
  };
}

// Prévia: nada é gravado
export function previewImport(ctx, body) {
  requireContracts(ctx.user);
  const p = plan(body.files, body);
  return { ...p, groups: p.groups.map(({ rows: _r, ...g }) => g) };
}

// Confirma. mapping: { [obra]: 'new' | id do contrato | 'skip' } · classify: { [obra]: { company, type_id } }
export function applyImport(ctx, body, ip) {
  requireContracts(ctx.user);
  const p = plan(body.files, body);
  const off = offKeys(body);
  const mapping = body.mapping && typeof body.mapping === 'object' ? body.mapping : {};
  const classify = body.classify && typeof body.classify === 'object' ? body.classify : {};
  const typeIds = new Set(all('SELECT id FROM contract_types').map(t => t.id));
  const classOf = g => {
    const c = classify[g.key] || {};
    const company = COMPANY_KEYS.includes(c.company) ? c.company : g.company;
    const t = c.type_id === '' || c.type_id === null ? null : c.type_id === undefined ? g.type_id : Number(c.type_id);
    if (t && !typeIds.has(t)) throw badRequest(`Tipo de contrato inválido em "${g.obra}".`);
    return { company, type_id: t || null };
  };
  const ref = today();
  return tx(() => {
    let reclassified = 0;
    // Guarda os descartes (só de pagamentos ainda não importados) e libera os reativados
    const allRows = new Map(p.groups.flatMap(g => g.rows.map(r => [r.import_key, r])));
    const isTracked = k => !!one('SELECT 1 FROM contract_import_rows WHERE import_key = ?', k);
    let discarded = 0, restored = 0;
    for (const k of Array.isArray(body.restore) ? body.restore.map(String) : []) restored += run('DELETE FROM contract_import_discards WHERE import_key = ?', k).changes;
    for (const k of Array.isArray(body.exclude) ? body.exclude.map(String) : []) {
      const r = allRows.get(k);
      if (!r || isTracked(k)) continue;
      discarded += run(`INSERT INTO contract_import_discards (import_key, obra, payer, due_date, amount, created_by) VALUES (?,?,?,?,?,?) ON CONFLICT(import_key) DO NOTHING`,
        k, r.obra, r.payer, r.due_date, r.amount, ctx.user.id).changes;
    }
    const usedPrefixes = new Set(all('SELECT bulletin_prefix FROM contracts').map(r => r.bulletin_prefix));
    const created = [], used = new Set();
    let bms = 0, skippedMonths = 0, valueAdded = 0;
    const track = (r, contractId, status, mid = null) => run(`INSERT INTO contract_import_rows (import_key, contract_id, kind, nature, amount, status, measurement_id, account) VALUES (?,?,?,?,?,?,?,?)
      ON CONFLICT(import_key) DO UPDATE SET status = excluded.status, measurement_id = excluded.measurement_id, account = COALESCE(excluded.account, account), updated_at = datetime('now')`, r.import_key, contractId, r.kind, natureLabel(r.nature), r.amount, status, mid, r.account);
    for (const g of p.groups) {
      const m = mapping[g.key] === undefined || mapping[g.key] === null || mapping[g.key] === '' ? (g.match ? g.match.id : 'new') : mapping[g.key];
      if (m === 'skip') continue;
      const cls = classOf(g);
      if (!g.pending) {
        // Nada novo da obra: só a empresa/tipo, se mudou
        if (m !== 'new') {
          const c = one('SELECT id, company, type_id FROM contracts WHERE id = ?', Number(m));
          if (c && (c.company !== cls.company || (c.type_id || null) !== cls.type_id)) {
            run(`UPDATE contracts SET company = ?, type_id = ?, updated_at = datetime('now') WHERE id = ?`, cls.company, cls.type_id, c.id);
            reclassified++;
          }
          if (c) for (const r of g.rows) run('UPDATE contract_import_rows SET account = COALESCE(account, ?) WHERE import_key = ?', r.account, r.import_key);
        }
        continue;
      }
      let contract;
      if (m === 'new') {
        const n = one(`SELECT MAX(CAST(SUBSTR(code, 4) AS INTEGER)) AS n FROM contracts WHERE code LIKE 'CT-%'`)?.n || 0;
        const code = `CT-${String(n + 1).padStart(3, '0')}`;
        let prefix = initials(g.client), k = 2;
        const base = prefix;
        while (usedPrefixes.has(prefix)) prefix = `${base}${k++}`;
        usedPrefixes.add(prefix);
        const active = g.open_count > 0 || g.last_activity >= addDays(ref, -90);
        const r = run(`INSERT INTO contracts (code, client, title, start_date, bulletin_prefix, notes, status, company, type_id, created_by) VALUES (?,?,?,?,?,?,?,?,?,?)`,
          code, g.client, g.obra, g.first_due, prefix,
          `Criado pela importação das planilhas de recebimentos em ${ref.split('-').reverse().join('/')}.${g.payers.length > 1 ? ` Pagadores: ${g.payers.join(', ')}.` : ''}`,
          active ? 'vigente' : 'encerrado', cls.company, cls.type_id, ctx.user.id);
        contract = { id: Number(r.lastInsertRowid), code, bulletin_prefix: prefix, fresh: true };
        created.push(code);
      } else {
        const c = one('SELECT id, code, bulletin_prefix, source_import FROM (SELECT c.*, EXISTS(SELECT 1 FROM contract_import_rows i WHERE i.contract_id = c.id) AS source_import FROM contracts c) WHERE id = ?', Number(m));
        if (!c) throw badRequest(`Contrato escolhido para "${g.obra}" não existe.`);
        contract = { ...c, fresh: false };
        const cur = one('SELECT company, type_id FROM contracts WHERE id = ?', c.id);
        if (cur.company !== cls.company || (cur.type_id || null) !== cls.type_id) {
          run(`UPDATE contracts SET company = ?, type_id = ?, updated_at = datetime('now') WHERE id = ?`, cls.company, cls.type_id, c.id);
          reclassified++;
        }
      }
      used.add(contract.id);
      const a = analyze(g.rows, contract.fresh ? null : contract.id, off);
      skippedMonths += a.skipped_months;
      // Valor do contrato: itens por natureza (R$ · preço 1,00). Em contrato lançado à mão entram como aditivo.
      const itemFor = new Map();
      let seqItem = one('SELECT MAX(seq) AS n FROM contract_items WHERE contract_id = ?', contract.id)?.n || 0;
      const natures = new Set([...a.natures.map(x => x.nature), ...a.months.flatMap(x => x.lines.map(l => l.nature))]);
      for (const nature of natures) {
        const add = a.natures.find(x => x.nature === nature)?.value || 0;
        const ex = one(`SELECT id, quantity FROM contract_items WHERE contract_id = ? AND unit = 'R$' AND unit_price = 1 AND description IN (?, ?) ORDER BY seq LIMIT 1`, contract.id, nature, `${nature} (importado das planilhas)`);
        if (ex) { if (add) run('UPDATE contract_items SET quantity = ? WHERE id = ?', r2(ex.quantity + add), ex.id); itemFor.set(nature, ex.id); }
        else {
          const manual = !contract.fresh && !contract.source_import;
          const r = run('INSERT INTO contract_items (contract_id, seq, description, unit, unit_price, quantity, additive) VALUES (?,?,?,?,?,?,?)',
            contract.id, ++seqItem, manual ? `${nature} (importado das planilhas)` : nature, 'R$', 1, add, manual ? 1 : 0);
          itemFor.set(nature, Number(r.lastInsertRowid));
        }
        valueAdded = r2(valueAdded + add);
      }
      // Linhas em aberto e ignoradas: só registra
      for (const x of a.acts) {
        if (x.act === 'track') track(x.r, contract.id, 'aberto');
        else if (x.act === 'skip') track(x.r, contract.id, 'ignorado');
      }
      // BMs (Recebida) do que foi recebido
      const items = all('SELECT id FROM contract_items WHERE contract_id = ?', contract.id);
      let seq = one('SELECT MAX(seq) AS n FROM measurements WHERE contract_id = ?', contract.id)?.n || 0;
      for (const x of a.months) {
        seq++;
        const code = `${contract.bulletin_prefix}${String(seq).padStart(4, '0')}.${x.month.slice(2, 4)}`;
        const [y, mo] = x.month.split('-').map(Number);
        const last = new Date(Date.UTC(y, mo, 0)).getUTCDate();
        const r = run(`INSERT INTO measurements (contract_id, seq, code, ref_month, period_start, period_end, status, notes, nf_number, nf_date, paid_date, paid_amount, issued_at, issued_by, created_by)
          VALUES (?,?,?,?,?,?, 'recebida', ?,?,?,?,?,?,?,?)`, contract.id, seq, code, x.month, `${x.month}-01`, `${x.month}-${String(last).padStart(2, '0')}`,
          x.notes, x.docs, x.nf_date, x.paid_date, x.total, `${x.nf_date}T12:00:00.000Z`, ctx.user.id, ctx.user.id);
        const mid = Number(r.lastInsertRowid);
        const qty = new Map(x.lines.map(l => [itemFor.get(l.nature), l.value]));
        for (const it of items) run('INSERT INTO measurement_lines (measurement_id, item_id, quantity) VALUES (?,?,?)', mid, it.id, qty.get(it.id) || 0);
        x.adjustments.forEach((adj, k) => run('INSERT INTO measurement_adjustments (measurement_id, seq, description, unit, amount) VALUES (?,?,?,?,?)', mid, k + 1, adj.description, 'vb', adj.amount));
        for (const row of x.rows) track(row, contract.id, 'medido', mid);
        bms++;
      }
    }
    const result = { files: p.files.map(f => f.name), bms, value_added: valueAdded, reclassified, discarded, restored, skipped_months: skippedMonths, contracts_created: created, contracts_used: used.size, others_ignored: p.skipped.others };
    audit(ctx.user.id, 'contract', null, 'BMs importados das planilhas de recebimentos', { arquivos: result.files, bms, pagamentos_descartados: discarded, reativados: restored, valor_somado: valueAdded, meses_com_bm_manual: skippedMonths, contratos_criados: created }, ip);
    return result;
  });
}
