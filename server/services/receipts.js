// Recebimentos dos contratos: parcelas do cliente, RT (reserva técnica paga por fornecedor) e outras entradas sem contrato.
// Lançamento manual (com baixa: data, valor recebido, desconto, juros) ou importação das planilhas do financeiro (.xlsx):
// contrato = cliente + obra; reenviar a mesma planilha não duplica e dá baixa nas parcelas que foram recebidas depois.
import { createHash } from 'node:crypto';
import { all, one, run, tx } from '../db.js';
import { badRequest, notFound, str, oneOf, date, intOrNull } from '../lib/http.js';
import { readXlsx, serialToDate } from '../lib/xlsx.js';
import { audit } from './audit.js';
import { today, addDays, daysBetween } from './metrics.js';
import { requireContracts } from './contracts.js';

export const KINDS = ['parcela', 'rt', 'outra'];
const r2 = v => Math.round((Number(v) || 0) * 100) / 100;
const num = (v, label, { min = 0 } = {}) => {
  if (v === '' || v === null || v === undefined) return null;
  const t = typeof v === 'number' ? v : String(v).trim().replace(/^R\$\s*/, '');
  const n = typeof t === 'number' ? t : Number(t.includes(',') ? t.replace(/\./g, '').replace(',', '.') : t);
  if (!Number.isFinite(n)) throw badRequest(`${label}: número inválido.`);
  if (n < min) throw badRequest(`${label}: valor inválido.`);
  return r2(n);
};

// ---------- Situação e totais ----------
export const receiptStatus = (r, ref = today()) => (r.received_date ? 'recebido' : r.due_date < ref ? 'vencido' : 'a_receber');
const net = r => r2(r.received_amount ?? r.amount - (r.discount || 0) + (r.interest || 0));
function decorate(r, ref = today()) {
  const status = receiptStatus(r, ref);
  return { ...r, status, net: r.received_date ? net(r) : null, days_late: status === 'vencido' ? daysBetween(r.due_date, ref) : 0 };
}

// Totais de um contrato. Recebimento ligado a um boletim recebido (mesmo dinheiro) não soma de novo.
export function receiptsSummary(contractId, ref = today()) {
  const rows = all('SELECT * FROM contract_receipts WHERE contract_id = ? AND measurement_id IS NULL', contractId);
  const rec = rows.filter(r => r.received_date), open = rows.filter(r => !r.received_date), late = open.filter(r => r.due_date < ref);
  const sum = (a, f) => r2(a.reduce((s, r) => s + f(r), 0));
  return {
    count: rows.length,
    billed: sum(rows, r => r.amount),
    received: sum(rec, net),
    open: sum(open, r => r.amount),
    open_count: open.length,
    overdue: sum(late, r => r.amount),
    overdue_count: late.length,
    rt_received: sum(rec.filter(r => r.kind === 'rt'), net),
    last_received: rec.map(r => r.received_date).sort().at(-1) || null,
    next_due: open.filter(r => r.due_date >= ref).map(r => r.due_date).sort()[0] || null,
  };
}
// Recebimentos que entram no faturamento dos contratos (painel): com contrato, sem boletim ligado
export const countedReceipts = () => all(`SELECT r.*, c.client AS contract_client, c.code AS contract_code FROM contract_receipts r JOIN contracts c ON c.id = r.contract_id
  WHERE r.measurement_id IS NULL`).map(r => ({ ...r, net: r.received_date ? net(r) : null }));

const listOf = (where, ...args) => all(`SELECT r.*, m.code AS measurement_code FROM contract_receipts r LEFT JOIN measurements m ON m.id = r.measurement_id
  WHERE ${where} ORDER BY COALESCE(r.received_date, r.due_date) DESC, r.due_date DESC, r.id DESC`, ...args).map(r => decorate(r));
export const receiptsOf = contractId => listOf('r.contract_id = ?', contractId);

// Outras entradas (sem contrato): aporte, empréstimo, reembolso…
export function otherReceipts(ctx) {
  requireContracts(ctx.user);
  const rows = listOf('r.contract_id IS NULL');
  const rec = rows.filter(r => r.received_date);
  return { receipts: rows, totals: { count: rows.length, received: r2(rec.reduce((s, r) => s + r.net, 0)), open: r2(rows.filter(r => !r.received_date).reduce((s, r) => s + r.amount, 0)) } };
}

// ---------- Lançamento manual ----------
function readReceipt(body, contractId) {
  const d = {
    kind: contractId ? oneOf(body.kind, ['parcela', 'rt'], 'Tipo', 'parcela') : 'outra',
    payer: str(body.payer, { max: 160, label: 'Pagador' }),
    nature: str(body.nature, { max: 80, label: 'Natureza' }),
    description: str(body.description, { max: 400, label: 'Descrição' }),
    doc_number: str(body.doc_number, { max: 40, label: 'Nº do documento' }),
    installment: str(body.installment, { max: 40, label: 'Parcela/condição' }),
    due_date: date(body.due_date, 'Vencimento'),
    competence_date: date(body.competence_date, 'Competência'),
    amount: num(body.amount, 'Valor'),
    received_date: date(body.received_date, 'Data do recebimento'),
    received_amount: num(body.received_amount, 'Valor recebido'),
    discount: num(body.discount, 'Desconto') || 0,
    interest: num(body.interest, 'Juros/multa') || 0,
    account: str(body.account, { max: 80, label: 'Conta bancária' }),
    method: str(body.method, { max: 60, label: 'Forma de recebimento' }),
    notes: str(body.notes, { max: 1000, label: 'Observações' }),
  };
  if (!d.due_date) throw badRequest('Vencimento é obrigatório.');
  if (!d.amount) throw badRequest('Informe o valor.');
  if (d.received_date && d.received_amount === null) d.received_amount = r2(d.amount - d.discount + d.interest);
  if (!d.received_date) { d.received_amount = null; }
  return d;
}
const FIELDS = ['kind', 'payer', 'nature', 'description', 'doc_number', 'installment', 'due_date', 'competence_date', 'amount', 'received_date', 'received_amount', 'discount', 'interest', 'account', 'method', 'notes'];

export function createReceipt(ctx, body, ip) {
  requireContracts(ctx.user);
  const contractId = intOrNull(body.contract_id);
  const c = contractId ? one('SELECT id, code FROM contracts WHERE id = ?', contractId) : null;
  if (contractId && !c) throw notFound('Contrato não encontrado.');
  const d = readReceipt(body, contractId);
  return tx(() => {
    const r = run(`INSERT INTO contract_receipts (contract_id, ${FIELDS.join(', ')}, created_by, received_by) VALUES (?, ${FIELDS.map(() => '?').join(', ')}, ?, ?)`,
      contractId, ...FIELDS.map(f => d[f]), ctx.user.id, d.received_date ? ctx.user.id : null);
    const id = Number(r.lastInsertRowid);
    audit(ctx.user.id, 'receipt', id, 'Recebimento lançado', { contrato: c?.code || 'outras entradas', vencimento: d.due_date, valor: d.amount, recebido: d.received_date ? d.received_amount : null }, ip);
    return id;
  });
}

export function updateReceipt(ctx, id, body, ip) {
  requireContracts(ctx.user);
  const cur = one('SELECT * FROM contract_receipts WHERE id = ?', id);
  if (!cur) throw notFound('Recebimento não encontrado.');
  const d = readReceipt({ ...cur, ...body }, cur.contract_id);
  const changed = FIELDS.filter(f => (d[f] ?? null) !== (cur[f] ?? null));
  if (!changed.length) return;
  tx(() => {
    run(`UPDATE contract_receipts SET ${FIELDS.map(f => `${f} = ?`).join(', ')}, received_by = ?, updated_at = datetime('now') WHERE id = ?`,
      ...FIELDS.map(f => d[f]), d.received_date ? (cur.received_date ? cur.received_by : ctx.user.id) : null, id);
    const action = !cur.received_date && d.received_date ? 'Recebimento baixado' : cur.received_date && !d.received_date ? 'Baixa do recebimento desfeita' : 'Recebimento alterado';
    audit(ctx.user.id, 'receipt', id, action, { campos: changed, vencimento: d.due_date, valor: d.amount, recebido: d.received_amount }, ip);
  });
}

export function deleteReceipt(ctx, id, ip) {
  requireContracts(ctx.user);
  const cur = one('SELECT * FROM contract_receipts WHERE id = ?', id);
  if (!cur) throw notFound('Recebimento não encontrado.');
  tx(() => {
    run('DELETE FROM contract_receipts WHERE id = ?', id);
    audit(ctx.user.id, 'receipt', id, 'Recebimento excluído', { vencimento: cur.due_date, valor: cur.amount, pagador: cur.payer, descricao: cur.description }, ip);
  });
  return { contract_id: cur.contract_id };
}

// ---------- Importação das planilhas do financeiro ----------
const norm = s => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
const hkey = s => norm(s).replace(/[^a-z0-9]/g, '');
const COLS = {
  due: 'datadevencimento', received_date: 'dataderecebimento', competence: 'datadecompetencia', amount: 'totaldaparcela', received_amount: 'totalrecebido',
  interest: 'jurosmultas', discount: 'descontos', received: 'recebido', nature: 'natureza', description: 'descricao', doc: 'ndocumento', client: 'cliente',
  obra: 'obra', installment: 'condicoesderecebimento', account: 'contabancaria', method: 'formaderecebimento', comment: 'comentariossobreorecebimento', obs: 'observacoesdavenda',
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

// Lê as planilhas e devolve as linhas já classificadas (parcela / RT / outra) com a chave de importação
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
    for (const k of ['due', 'amount', 'client', 'obra']) if (col[k] === undefined) throw badRequest(`${name}: falta a coluna "${{ due: 'Data de Vencimento', amount: 'Total da Parcela', client: 'Cliente', obra: 'Obra' }[k]}".`);
    const seen = new Map();
    let n = 0;
    for (let i = hi + 1; i < grid.length; i++) {
      const g = grid[i], v = k => (col[k] === undefined ? null : g[col[k]] ?? null);
      if (!g.some(x => x !== null && x !== '')) continue;
      const line = i + 1;
      const due = cellDate(v('due')), amount = cellNum(v('amount'));
      if (!due) { warnings.push(`${name}, linha ${line}: sem data de vencimento — ignorada.`); continue; }
      if (!Number.isFinite(amount) || amount <= 0) { warnings.push(`${name}, linha ${line}: valor da parcela inválido — ignorada.`); continue; }
      const obra = txt(v('obra')), payer = txt(v('client')), nature = txt(v('nature')), description = txt(v('description'));
      const isReceived = hkey(v('received')) === 'sim';
      const discount = cellNum(v('discount')) || 0, interest = cellNum(v('interest')) || 0;
      const recAmt = cellNum(v('received_amount'));
      const kind = !obra || OTHER_NATURES.has(hkey(nature)) ? 'outra' : hkey(description) === 'rt' || hkey(nature) === 'outrasreceitas' ? 'rt' : 'parcela';
      const installment = txt(v('installment')), doc = txt(v('doc'));
      const base = [hkey(obra), hkey(payer), due, amount.toFixed(2), hkey(description), hkey(installment), hkey(doc)].join('|');
      const occ = (seen.get(base) || 0) + 1;
      seen.set(base, occ);
      rows.push({
        file: name, line, kind, obra, payer, nature, description, doc_number: doc, installment, due_date: due,
        competence_date: cellDate(v('competence')), amount,
        received_date: isReceived ? cellDate(v('received_date')) || due : null,
        received_amount: isReceived ? (Number.isFinite(recAmt) && recAmt > 0 ? recAmt : r2(amount - discount + interest)) : null,
        discount, interest, account: txt(v('account')), method: txt(v('method')),
        notes: [txt(v('comment')), txt(v('obs'))].filter(Boolean).join(' · ') || null,
        import_key: createHash('sha1').update(`${base}|${occ}`).digest('hex').slice(0, 32),
      });
      n++;
    }
    info.push({ name, rows: n });
  }
  return { rows, warnings, files: info };
}

// Cliente do contrato: quem mais pagou parcelas (RT é de fornecedor); sem parcelas, quem mais pagou
const mainClient = rows => {
  const by = new Map();
  const pool = rows.some(r => r.kind === 'parcela') ? rows.filter(r => r.kind === 'parcela') : rows;
  for (const r of pool) by.set(r.payer || '—', (by.get(r.payer || '—') || 0) + r.amount);
  return [...by.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || '—';
};
const prefixOf = client => (String(client).normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().match(/[A-Z0-9]+/g) || ['REC'])
  .filter(w => w.length > 2 || /\d/.test(w)).map(w => w[0]).join('').slice(0, 4) || 'REC';

function plan(files) {
  const { rows, warnings, files: info } = parseFiles(files);
  const ref = today();
  const existing = new Map(all('SELECT import_key, contract_id, received_date FROM contract_receipts WHERE import_key IS NOT NULL').map(r => [r.import_key, r]));
  const contracts = all('SELECT id, code, client, title, status FROM contracts ORDER BY code');
  const byTitle = new Map(contracts.map(c => [hkey(c.title), c]));
  const stateOf = r => { const e = existing.get(r.import_key); return !e ? 'new' : !e.received_date && r.received_date ? 'update' : 'same'; };
  const tally = list => {
    const sum = (a, f) => r2(a.reduce((s, r) => s + f(r), 0));
    const open = list.filter(r => !r.received_date);
    return {
      count: list.length, rt_count: list.filter(r => r.kind === 'rt').length,
      received: sum(list.filter(r => r.received_date), r => r.received_amount), open: sum(open, r => r.amount),
      overdue: sum(open.filter(r => r.due_date < ref), r => r.amount), overdue_count: open.filter(r => r.due_date < ref).length,
      first_due: list.map(r => r.due_date).sort()[0], last_due: list.map(r => r.due_date).sort().at(-1),
      new_rows: list.filter(r => stateOf(r) === 'new').length, update_rows: list.filter(r => stateOf(r) === 'update').length, same_rows: list.filter(r => stateOf(r) === 'same').length,
    };
  };
  const groups = new Map();
  for (const r of rows.filter(x => x.kind !== 'outra')) {
    const k = hkey(r.obra);
    if (!groups.has(k)) groups.set(k, { key: k, obra: r.obra, rows: [] });
    groups.get(k).rows.push(r);
  }
  const out = [...groups.values()].map(g => {
    const match = byTitle.get(g.key) || null;
    const payers = [...new Set(g.rows.map(r => r.payer).filter(Boolean))];
    return { key: g.key, obra: g.obra, client: mainClient(g.rows), payers, match: match && { id: match.id, code: match.code, client: match.client, title: match.title }, ...tally(g.rows), rows: g.rows };
  }).sort((a, b) => a.client.localeCompare(b.client, 'pt-BR') || a.obra.localeCompare(b.obra, 'pt-BR'));
  const others = rows.filter(r => r.kind === 'outra');
  return { files: info, warnings, total_rows: rows.length, groups: out, others: { ...tally(others), rows: others }, contracts };
}

// Prévia: nada é gravado. Mostra os contratos que serão criados/ligados e o que é novo, baixa ou já importado.
export function previewImport(ctx, body) {
  requireContracts(ctx.user);
  const p = plan(body.files);
  const lite = r => ({ due_date: r.due_date, payer: r.payer, description: r.description, installment: r.installment, kind: r.kind, amount: r.amount, received_date: r.received_date, received_amount: r.received_amount });
  return { ...p, groups: p.groups.map(g => ({ ...g, rows: g.rows.map(lite) })), others: { ...p.others, rows: p.others.rows.map(r => ({ ...lite(r), obra: r.obra, nature: r.nature })) } };
}

// Confirma a importação. mapping: { [obra]: 'new' | id do contrato | 'g:<outra obra>' (junta com o contrato daquela obra) }
export function applyImport(ctx, body, ip) {
  requireContracts(ctx.user);
  const p = plan(body.files);
  const mapping = body.mapping && typeof body.mapping === 'object' ? body.mapping : {};
  const ref = today();
  return tx(() => {
    const target = new Map();
    const created = [];
    const choice = g => { const m = mapping[g.key]; return m === undefined || m === null || m === '' ? (g.match ? g.match.id : 'new') : m; };
    const createFor = g => {
      const n = one(`SELECT MAX(CAST(SUBSTR(code, 4) AS INTEGER)) AS n FROM contracts WHERE code LIKE 'CT-%'`)?.n || 0;
      const code = `CT-${String(n + 1).padStart(3, '0')}`;
      const last = g.rows.map(r => r.received_date || r.due_date).sort().at(-1);
      const active = g.rows.some(r => !r.received_date) || last >= addDays(ref, -180);
      const r = run(`INSERT INTO contracts (code, client, title, start_date, bulletin_prefix, notes, status, source, created_by) VALUES (?,?,?,?,?,?,?, 'importacao', ?)`,
        code, g.client, g.obra, g.first_due, prefixOf(g.client),
        `Criado pela importação de recebimentos em ${ref.split('-').reverse().join('/')}.${g.payers.length > 1 ? ` Pagadores: ${g.payers.join(', ')}.` : ''}`,
        active ? 'vigente' : 'encerrado', ctx.user.id);
      created.push(code);
      return Number(r.lastInsertRowid);
    };
    for (const g of p.groups) {
      const m = choice(g);
      if (m === 'new') target.set(g.key, createFor(g));
      else if (typeof m === 'number' || /^\d+$/.test(String(m))) {
        if (!one('SELECT id FROM contracts WHERE id = ?', Number(m))) throw badRequest(`Contrato escolhido para "${g.obra}" não existe.`);
        target.set(g.key, Number(m));
      }
    }
    for (const g of p.groups) {
      const m = choice(g);
      if (typeof m === 'string' && m.startsWith('g:')) {
        const t = target.get(m.slice(2));
        if (!t) throw badRequest(`"${g.obra}": a obra escolhida para juntar precisa ter o próprio contrato.`);
        target.set(g.key, t);
      }
      if (!target.has(g.key)) throw badRequest(`Escolha o contrato de "${g.obra}".`);
    }
    let inserted = 0, updated = 0, skipped = 0, linked = 0;
    const touched = new Set();
    const put = (r, contractId) => {
      const e = one('SELECT id, contract_id, received_date FROM contract_receipts WHERE import_key = ?', r.import_key);
      if (e) {
        if (!e.received_date && r.received_date) {
          run(`UPDATE contract_receipts SET received_date = ?, received_amount = ?, discount = ?, interest = ?, account = COALESCE(?, account), method = COALESCE(?, method), received_by = ?, updated_at = datetime('now') WHERE id = ?`,
            r.received_date, r.received_amount, r.discount, r.interest, r.account, r.method, ctx.user.id, e.id);
          updated++;
          if (e.contract_id) touched.add(e.contract_id);
        } else skipped++;
        return;
      }
      run(`INSERT INTO contract_receipts (contract_id, kind, payer, nature, description, doc_number, installment, due_date, competence_date, amount, received_date, received_amount, discount, interest, account, method, notes, import_key, created_by, received_by)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, contractId, r.kind, r.payer, r.nature, r.description, r.doc_number, r.installment, r.due_date, r.competence_date, r.amount,
        r.received_date, r.received_amount, r.discount, r.interest, r.account, r.method, r.notes, r.import_key, ctx.user.id, r.received_date ? ctx.user.id : null);
      inserted++;
      if (contractId) touched.add(contractId);
    };
    for (const g of p.groups) for (const r of g.rows) put(r, target.get(g.key));
    for (const r of p.others.rows) put(r, null);
    // Mesmo dinheiro de um boletim já recebido (valor igual, até 7 dias de diferença): liga e não soma duas vezes
    for (const cid of touched) {
      const ms = all(`SELECT id, paid_date, paid_amount FROM measurements WHERE contract_id = ? AND status = 'recebida' AND paid_date IS NOT NULL AND paid_amount IS NOT NULL
        AND id NOT IN (SELECT measurement_id FROM contract_receipts WHERE measurement_id IS NOT NULL)`, cid);
      for (const m of ms) {
        const r = one(`SELECT id FROM contract_receipts WHERE contract_id = ? AND measurement_id IS NULL AND received_date IS NOT NULL AND ABS(received_amount - ?) <= 0.01
          AND ABS(julianday(received_date) - julianday(?)) <= 7 ORDER BY ABS(julianday(received_date) - julianday(?)) LIMIT 1`, cid, m.paid_amount, m.paid_date, m.paid_date);
        if (r) { run('UPDATE contract_receipts SET measurement_id = ? WHERE id = ?', m.id, r.id); linked++; }
      }
    }
    const result = { files: p.files.map(f => f.name), inserted, updated, skipped, linked, contracts_created: created, contracts_used: new Set(target.values()).size, others: p.others.count };
    audit(ctx.user.id, 'receipt', null, 'Recebimentos importados de planilha', { arquivos: result.files, novos: inserted, baixados: updated, ja_importados: skipped, ligados_a_boletim: linked, contratos_criados: created }, ip);
    return result;
  });
}
