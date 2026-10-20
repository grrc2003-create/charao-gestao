// Importação das planilhas de recebimentos do financeiro (.xlsx) como contratos e BMs (boletins de medição).
// Contrato = obra (cliente = quem mais pagou). Só entra o que já foi recebido. Um BM por mês (vencimento) com status
// Recebida: itens da planilha contratual por natureza (unidade R$, preço 1,00 → quantidade = valor), RT de fornecedor
// como acréscimo e a diferença do recebimento (desconto/juros) como desconto/acréscimo. Mês que já tem BM no contrato
// é ignorado, então reenviar a planilha não duplica. Aporte, empréstimo, reembolso e linhas sem obra ficam fora.
import { all, one, run, tx } from '../db.js';
import { badRequest, str } from '../lib/http.js';
import { readXlsx, serialToDate } from '../lib/xlsx.js';
import { audit } from './audit.js';
import { today, addDays } from './metrics.js';
import { requireContracts, monthLabel } from './contracts.js';

const r2 = v => Math.round((Number(v) || 0) * 100) / 100;
const norm = s => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
const hkey = s => norm(s).replace(/[^a-z0-9]/g, '');
const COLS = {
  due: 'datadevencimento', received_date: 'dataderecebimento', amount: 'totaldaparcela', received_amount: 'totalrecebido',
  interest: 'jurosmultas', discount: 'descontos', received: 'recebido', nature: 'natureza', description: 'descricao', doc: 'ndocumento',
  client: 'cliente', obra: 'obra', installment: 'condicoesderecebimento',
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
      rows.push({
        file: name, line, obra, payer: txt(v('client')), nature, description, doc: txt(v('doc')), installment: txt(v('installment')),
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

// BMs de uma obra: por mês do vencimento, só o que foi recebido
function monthsOf(rows) {
  const by = new Map();
  for (const r of rows.filter(x => x.received)) {
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
      count: rs.length,
      notes: `Importado da planilha de recebimentos: ${rs.map(r => [r.kind === 'rt' ? `RT ${r.payer || ''}`.trim() : r.description, r.installment && !/vista/i.test(r.installment) ? r.installment : '', r.received_date.split('-').reverse().join('/')].filter(Boolean).join(' ')).join('; ')}`.slice(0, 2000),
    };
  });
}

function plan(files) {
  const { rows, warnings, files: info } = parseFiles(files);
  const contracts = all('SELECT id, code, client, title, status, bulletin_prefix FROM contracts ORDER BY code');
  const byTitle = new Map(contracts.map(c => [hkey(c.title), c]));
  const groups = new Map();
  for (const r of rows.filter(x => x.kind !== 'outra')) {
    const k = hkey(r.obra);
    if (!groups.has(k)) groups.set(k, { key: k, obra: r.obra, rows: [] });
    groups.get(k).rows.push(r);
  }
  const out = [...groups.values()].map(g => {
    const match = byTitle.get(g.key) || null;
    const taken = new Set(match ? all(`SELECT ref_month FROM measurements WHERE contract_id = ? AND status <> 'rascunho'`, match.id).map(m => m.ref_month) : []);
    const months = monthsOf(g.rows).map(m => ({ ...m, exists: taken.has(m.month) }));
    const open = g.rows.filter(r => !r.received);
    return {
      key: g.key, obra: g.obra, client: mainClient(g.rows), payers: [...new Set(g.rows.map(r => r.payer).filter(Boolean))],
      match: match && { id: match.id, code: match.code, client: match.client, title: match.title },
      months, bms: months.filter(m => !m.exists).length, total: r2(months.filter(m => !m.exists).reduce((s, m) => s + m.total, 0)),
      rt: r2(months.reduce((s, m) => s + m.adjustments.filter(a => a.description.startsWith('RT - ')).reduce((x, a) => x + a.amount, 0), 0)),
      open_count: open.length, open_total: r2(open.reduce((s, r) => s + r.amount, 0)),
      first_due: g.rows.map(r => r.due_date).sort()[0], last_activity: g.rows.map(r => r.received_date || r.due_date).sort().at(-1),
    };
  }).sort((a, b) => a.client.localeCompare(b.client, 'pt-BR') || a.obra.localeCompare(b.obra, 'pt-BR'));
  const others = rows.filter(r => r.kind === 'outra');
  return {
    files: info, warnings, total_rows: rows.length, groups: out,
    skipped: { open: rows.filter(r => r.kind !== 'outra' && !r.received).length, others: others.length, others_total: r2(others.reduce((s, r) => s + (r.received_amount ?? r.amount), 0)) },
    contracts: contracts.map(c => ({ id: c.id, code: c.code, client: c.client, title: c.title })),
  };
}

// Prévia: nada é gravado
export function previewImport(ctx, body) {
  requireContracts(ctx.user);
  return plan(body.files);
}

// Confirma. mapping: { [obra]: 'new' | id do contrato | 'skip' }
export function applyImport(ctx, body, ip) {
  requireContracts(ctx.user);
  const p = plan(body.files);
  const mapping = body.mapping && typeof body.mapping === 'object' ? body.mapping : {};
  const ref = today();
  return tx(() => {
    const usedPrefixes = new Set(all('SELECT bulletin_prefix FROM contracts').map(r => r.bulletin_prefix));
    const created = [], used = new Set();
    let bms = 0, skippedMonths = 0;
    for (const g of p.groups) {
      const m = mapping[g.key] === undefined || mapping[g.key] === null || mapping[g.key] === '' ? (g.match ? g.match.id : 'new') : mapping[g.key];
      if (m === 'skip') continue;
      const months = g.months;
      if (!months.length) continue;
      let contract;
      if (m === 'new') {
        const n = one(`SELECT MAX(CAST(SUBSTR(code, 4) AS INTEGER)) AS n FROM contracts WHERE code LIKE 'CT-%'`)?.n || 0;
        const code = `CT-${String(n + 1).padStart(3, '0')}`;
        let prefix = initials(g.client), k = 2;
        const base = prefix;
        while (usedPrefixes.has(prefix)) prefix = `${base}${k++}`;
        usedPrefixes.add(prefix);
        const active = g.open_count > 0 || g.last_activity >= addDays(ref, -90);
        const r = run(`INSERT INTO contracts (code, client, title, start_date, bulletin_prefix, notes, status, created_by) VALUES (?,?,?,?,?,?,?,?)`,
          code, g.client, g.obra, g.first_due, prefix,
          `Criado pela importação das planilhas de recebimentos em ${ref.split('-').reverse().join('/')}.${g.payers.length > 1 ? ` Pagadores: ${g.payers.join(', ')}.` : ''}`,
          active ? 'vigente' : 'encerrado', ctx.user.id);
        contract = { id: Number(r.lastInsertRowid), code, bulletin_prefix: prefix, fresh: true };
        created.push(code);
      } else {
        const c = one('SELECT id, code, bulletin_prefix FROM contracts WHERE id = ?', Number(m));
        if (!c) throw badRequest(`Contrato escolhido para "${g.obra}" não existe.`);
        contract = c;
      }
      used.add(contract.id);
      // Meses que já têm BM neste contrato ficam de fora (reenviar não duplica)
      const taken = new Set(all(`SELECT ref_month FROM measurements WHERE contract_id = ? AND status <> 'rascunho'`, contract.id).map(r => r.ref_month));
      const todo = months.filter(x => !taken.has(x.month));
      skippedMonths += months.length - todo.length;
      if (!todo.length) continue;
      // Itens por natureza (R$ · preço 1,00 · quantidade = valor). Em contrato existente entram como aditivo.
      const sums = new Map();
      for (const x of todo) for (const l of x.lines) sums.set(l.nature, r2((sums.get(l.nature) || 0) + l.value));
      const itemId = new Map();
      let seqItem = one('SELECT MAX(seq) AS n FROM contract_items WHERE contract_id = ?', contract.id)?.n || 0;
      for (const [nature, total] of sums) {
        const desc = contract.fresh ? nature : `${nature} (importado das planilhas)`;
        const ex = one(`SELECT id, quantity FROM contract_items WHERE contract_id = ? AND description = ? AND unit = 'R$' AND unit_price = 1`, contract.id, desc);
        if (ex) { run('UPDATE contract_items SET quantity = ? WHERE id = ?', r2(ex.quantity + total), ex.id); itemId.set(nature, ex.id); }
        else {
          const r = run('INSERT INTO contract_items (contract_id, seq, description, unit, unit_price, quantity, additive) VALUES (?,?,?,?,?,?,?)', contract.id, ++seqItem, desc, 'R$', 1, total, contract.fresh ? 0 : 1);
          itemId.set(nature, Number(r.lastInsertRowid));
        }
      }
      const items = all('SELECT id FROM contract_items WHERE contract_id = ?', contract.id);
      let seq = one('SELECT MAX(seq) AS n FROM measurements WHERE contract_id = ?', contract.id)?.n || 0;
      for (const x of todo) {
        seq++;
        const code = `${contract.bulletin_prefix}${String(seq).padStart(4, '0')}.${x.month.slice(2, 4)}`;
        const [y, mo] = x.month.split('-').map(Number);
        const last = new Date(Date.UTC(y, mo, 0)).getUTCDate();
        const r = run(`INSERT INTO measurements (contract_id, seq, code, ref_month, period_start, period_end, status, notes, nf_number, nf_date, paid_date, paid_amount, issued_at, issued_by, created_by)
          VALUES (?,?,?,?,?,?, 'recebida', ?,?,?,?,?,?,?,?)`, contract.id, seq, code, x.month, `${x.month}-01`, `${x.month}-${String(last).padStart(2, '0')}`,
          x.notes, x.docs, x.nf_date, x.paid_date, x.total, `${x.nf_date}T12:00:00.000Z`, ctx.user.id, ctx.user.id);
        const mid = Number(r.lastInsertRowid);
        const qty = new Map(x.lines.map(l => [itemId.get(l.nature), l.value]));
        for (const it of items) run('INSERT INTO measurement_lines (measurement_id, item_id, quantity) VALUES (?,?,?)', mid, it.id, qty.get(it.id) || 0);
        x.adjustments.forEach((a, k) => run('INSERT INTO measurement_adjustments (measurement_id, seq, description, unit, amount) VALUES (?,?,?,?,?)', mid, k + 1, a.description, 'vb', a.amount));
        bms++;
      }
    }
    const result = { files: p.files.map(f => f.name), bms, skipped_months: skippedMonths, contracts_created: created, contracts_used: used.size, open_ignored: p.skipped.open, others_ignored: p.skipped.others };
    audit(ctx.user.id, 'contract', null, 'BMs importados das planilhas de recebimentos', { arquivos: result.files, bms, meses_ja_existentes: skippedMonths, contratos_criados: created }, ip);
    return result;
  });
}
