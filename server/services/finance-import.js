// Tarefas financeiras: planilha modelo (.xlsx) para preencher e importação com prévia.
// Cada linha vira uma tarefa financeira (mesmas regras de "Nova tarefa"); as parcelas mês a mês são geradas como hoje.
// Tarefa que já existe (mesma descrição e tipo da despesa) é pulada e avisada; linhas com erro não entram.
import { all, one, run, tx } from '../db.js';
import { badRequest, notFound, str, intOrNull } from '../lib/http.js';
import { readXlsxSheets, serialToDate } from '../lib/xlsx.js';
import { writeXlsx } from '../lib/xlsx-write.js';
import { audit } from './audit.js';
import { today } from './metrics.js';
import { requireFinance, CATEGORIES, FREQ_LABEL, readObligation, insertObligation, generateItems, removeObligationInternal, monthsOf, ensureItem, payItem, unpayItem } from './finance.js';

const HEAD = ['Descrição *', 'Tipo da despesa', 'Valor previsto (R$) *', 'Valor variável?', 'Usar valor do mês anterior?', 'Periodicidade *', 'Dia do vencimento *', 'Início (mês/ano) *', 'Término (mês/ano)', 'Responsável', 'Observações'];
const KEYS = ['title', 'category', 'amount', 'variable', 'repeat_last', 'frequency', 'due_day', 'start_month', 'end_month', 'assignee', 'notes'];
const MAX_ROWS = 1000;
const MES = ['JAN', 'FEV', 'MAR', 'ABR', 'MAI', 'JUN', 'JUL', 'AGO', 'SET', 'OUT', 'NOV', 'DEZ'];
const PAY_HEAD = ['Tarefa *', 'Tipo da despesa', 'Ano *', ...MES];
const norm = s => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
const hkey = s => norm(s).replace(/[^a-z0-9]/g, '');
const r2 = v => Math.round((Number(v) || 0) * 100) / 100;

// ---------- Planilha modelo ----------
export function templateXlsx(ctx) {
  requireFinance(ctx.user);
  const people = all('SELECT name FROM users WHERE active = 1 AND can_finance = 1 ORDER BY name').map(u => u.name);
  const freqs = Object.values(FREQ_LABEL);
  const lists = Math.max(CATEGORIES.length, freqs.length, people.length, 2);
  const listRows = [['Tipos de despesa', 'Periodicidade', 'Sim/Não', 'Responsáveis']];
  for (let i = 0; i < lists; i++) listRows.push([CATEGORIES[i] ?? null, freqs[i] ?? null, ['Sim', 'Não'][i] ?? null, people[i] ?? null]);
  const last = MAX_ROWS + 1;
  const ref = today();
  const mm = `${ref.slice(5, 7)}/${ref.slice(0, 4)}`;
  // Pagamentos: tarefas já cadastradas (ativas) pré-listadas para o ano atual
  const year = Number(ref.slice(0, 4));
  const payRows = all('SELECT title, category FROM finance_obligations WHERE active = 1 ORDER BY category, title').map(o => [o.title, o.category, year]);
  return writeXlsx([
    {
      name: 'Tarefas', header: true, freeze: true, rows: [HEAD],
      widths: [34, 26, 18, 15, 22, 16, 17, 17, 17, 24, 36],
      validations: [
        { col: 1, rows: [2, last], source: `Listas!$A$2:$A$${CATEGORIES.length + 1}` },
        { col: 3, rows: [2, last], source: 'Listas!$C$2:$C$3' },
        { col: 4, rows: [2, last], source: 'Listas!$C$2:$C$3' },
        { col: 5, rows: [2, last], source: `Listas!$B$2:$B$${freqs.length + 1}` },
        ...(people.length ? [{ col: 9, rows: [2, last], source: `Listas!$D$2:$D$${people.length + 1}` }] : []),
      ],
    },
    {
      name: 'Pagamentos', header: true, freeze: true, rows: [PAY_HEAD, ...payRows],
      widths: [34, 24, 8, ...MES.map(() => 11)],
      validations: [{ col: 1, rows: [2, last], source: `Listas!$A$2:$A$${CATEGORIES.length + 1}` }],
    },
    {
      name: 'Instruções', title: true, widths: [30, 90], styles: { 1: 2 },
      rows: [
        ['Como preencher a planilha de Tarefas financeiras'],
        [],
        ['Uma linha por tarefa', 'Preencha a aba "Tarefas" a partir da linha 2 (não altere o cabeçalho). Campos com * são obrigatórios.'],
        ['Descrição *', 'Nome da tarefa (ex.: DAS Simples Nacional, Aluguel do escritório).'],
        ['Tipo da despesa', `Escolha na lista: ${CATEGORIES.join(', ')}. Em branco = Outros.`],
        ['Valor previsto (R$) *', 'Valor de cada parcela. Use número (ex.: 1500 ou 1.500,00).'],
        ['Valor variável?', 'Sim quando o valor muda a cada mês (ajustado na parcela). Em branco = Não.'],
        ['Usar valor do mês anterior?', 'Só para valor variável: Sim para a nova parcela já vir com o valor do mês anterior.'],
        ['Periodicidade *', `Escolha na lista: ${freqs.join(', ')}.`],
        ['Dia do vencimento *', 'De 1 a 31 (em meses mais curtos vale o último dia).'],
        ['Início (mês/ano) *', `Mês da primeira parcela, no formato MM/AAAA (ex.: ${mm}).`],
        ['Término (mês/ano)', 'Último mês (opcional). Em branco = sem término.'],
        ['Responsável', 'Escolha na lista (pessoas com acesso às Tarefas financeiras). Em branco = quem importar.'],
        ['Observações', 'Texto livre (opcional).'],
        [],
        ['Exemplo', `DAS Simples Nacional · Impostos · 1.850,00 · Sim · Sim · Mensal · 20 · ${mm} · (em branco) · (responsável) · Guia no portal do Simples`],
        ['Repetidas', 'Tarefa que já existe no sistema (mesma descrição e tipo da despesa) não é importada de novo: a prévia avisa.'],
        ['Importar', 'Em Tarefas financeiras › Importar planilha: envie o arquivo, confira a prévia (erros por linha) e confirme.'],
        [],
        ['Aba "Pagamentos"', 'Valores pagos (real) mês a mês, como na tela de Planejamento anual: uma linha por tarefa e ano, valor pago na coluna do mês.'],
        ['Tarefa *', 'Nome da tarefa: as já cadastradas vêm listadas; para uma tarefa nova, cadastre-a também na aba "Tarefas" (mesmo nome).'],
        ['Tipo da despesa', 'Só é preciso quando há duas tarefas com o mesmo nome.'],
        ['Ano *', 'Ano dos pagamentos da linha (ex.: 2026). Para lançar outro ano, repita a tarefa em outra linha.'],
        ['JAN … DEZ', 'Valor pago no mês (ex.: 1500 ou 1.500,00). 0 = a previsão não ocorreu no mês (não fica atrasada). Em branco = não pago. A data do pagamento fica a do vencimento (ou hoje, se o vencimento ainda não chegou). Meses futuros não são aceitos.'],
        ['Já pagos', 'Mês que já tem pagamento no sistema é ignorado (para corrigir, desfaça o pagamento na tela).'],
        ['Só pagamentos', 'Pode enviar só a aba "Pagamentos" preenchida (a aba "Tarefas" pode ficar vazia).'],
      ],
    },
    { name: 'Listas', header: true, widths: [30, 16, 10, 30], rows: listRows },
  ]);
}

// ---------- Leitura e validação ----------
const yes = v => ['sim', 's', 'yes', 'x', '1', 'true', 'verdadeiro'].includes(hkey(v));
const FREQ_BY = Object.fromEntries(Object.entries(FREQ_LABEL).flatMap(([k, l]) => [[hkey(l), k], [hkey(k), k]]));
const MONTHS = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
function monthOf(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return v > 20000 && v < 80000 ? serialToDate(v).slice(0, 7) : null;
  const s = norm(v);
  let m = /^(\d{1,2})[/.-](\d{4})$/.exec(s);
  if (m) return Number(m[1]) >= 1 && Number(m[1]) <= 12 ? `${m[2]}-${m[1].padStart(2, '0')}` : undefined;
  m = /^(\d{4})-(\d{2})(-\d{2})?$/.exec(s);
  if (m) return `${m[1]}-${m[2]}`;
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}`;
  m = /^([a-z]{3})[a-z]*[/ .-]*(\d{2}|\d{4})$/.exec(s);
  if (m && MONTHS.includes(m[1])) return `${m[2].length === 2 ? `20${m[2]}` : m[2]}-${String(MONTHS.indexOf(m[1]) + 1).padStart(2, '0')}`;
  return undefined;
}
const amountOf = v => {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return r2(v);
  const t = String(v).trim().replace(/^R\$\s*/i, '');
  const n = Number(t.includes(',') ? t.replace(/\./g, '').replace(',', '.') : t);
  return Number.isFinite(n) ? r2(n) : undefined;
};
const txt = v => (v === null || v === undefined ? '' : String(v).trim());

function parse(ctx, file) {
  if (!file?.data) throw badRequest('Envie a planilha (.xlsx).');
  const name = str(file.name, { max: 200, label: 'Nome do arquivo' }) || 'planilha.xlsx';
  let grid;
  let sheets;
  try { sheets = readXlsxSheets(Buffer.from(String(file.data).replace(/^data:[^,]*,/, ''), 'base64')); }
  catch (e) { throw badRequest(`${name}: não foi possível ler a planilha (${e.message}).`); }
  // O cabeçalho pode estar em qualquer aba (ex.: abas reordenadas) e em qualquer linha
  const isHead = r => r.some(v => hkey(v).startsWith('descricao')) && r.some(v => hkey(v).startsWith('periodicidade'));
  let hi = -1;
  for (const s of sheets) { hi = s.rows.findIndex(isHead); if (hi >= 0) { grid = s.rows; break; } }
  const other = sheets.some(s => s.rows.some(r => r.some(v => hkey(v).startsWith('titulo')) && r.some(v => hkey(v) === 'id')));
  const payHead = findPayHead(sheets);
  if (hi < 0 && payHead) {
    const pays = parsePayments(ctx, payHead, []);
    if (!pays.length) throw badRequest('A planilha não tem linhas preenchidas nas abas "Tarefas" e "Pagamentos".');
    return { name, rows: [], pays };
  }
  if (hi < 0 && other) throw badRequest('Esta é a planilha de planejamento de projeto (ID, Título…), que se importa em Projetos. Para tarefas financeiras, use "Baixar planilha modelo" nesta tela.');
  if (hi < 0) throw badRequest(`Não encontrei o cabeçalho da planilha modelo (colunas "Descrição *" e "Periodicidade *") em nenhuma aba (${sheets.map(s => s.name).join(', ')}). Use a planilha baixada em "Baixar planilha modelo", preencha a aba "Tarefas" sem apagar a linha 1 e salve como .xlsx.`);
  const col = {};
  const ALIASES = { categoria: 'category', favorecido: 'payee' };
  grid[hi].forEach((v, i) => {
    const k = HEAD.findIndex(h => hkey(h) === hkey(v));
    const key = k >= 0 ? KEYS[k] : ALIASES[hkey(v)];
    if (key && col[key] === undefined) col[key] = i;
  });
  for (const k of ['title', 'amount', 'frequency', 'due_day', 'start_month']) if (col[k] === undefined) throw badRequest(`Falta a coluna "${HEAD[KEYS.indexOf(k)]}".`);
  const people = all('SELECT id, name, email FROM users WHERE active = 1 AND can_finance = 1');
  const existing = new Set(all('SELECT title, category FROM finance_obligations').map(o => `${hkey(o.title)}|${hkey(o.category)}`));
  const seen = new Map();
  const rows = [];
  for (let i = hi + 1; i < grid.length && rows.length < MAX_ROWS; i++) {
    const g = grid[i], v = k => (col[k] === undefined ? null : g[col[k]] ?? null);
    if (!KEYS.some(k => txt(v(k)))) continue;
    const errors = [];
    const amount = amountOf(v('amount')), start = monthOf(v('start_month')), end = monthOf(v('end_month'));
    const freq = FREQ_BY[hkey(v('frequency'))];
    const day = typeof v('due_day') === 'number' ? v('due_day') : Number(txt(v('due_day')));
    if (!txt(v('title'))) errors.push('Descrição em branco');
    if (amount === null) errors.push('Valor previsto em branco'); else if (amount === undefined || amount < 0) errors.push('Valor previsto inválido');
    if (!freq) errors.push(txt(v('frequency')) ? `Periodicidade "${txt(v('frequency'))}" não existe` : 'Periodicidade em branco');
    if (!Number.isInteger(day) || day < 1 || day > 31) errors.push('Dia do vencimento: de 1 a 31');
    if (!start) errors.push(start === undefined ? 'Início inválido (use MM/AAAA)' : 'Início em branco');
    if (end === undefined) errors.push('Término inválido (use MM/AAAA)');
    let assignee = null;
    const who = txt(v('assignee'));
    if (who) {
      const p = people.find(u => hkey(u.name) === hkey(who) || norm(u.email) === norm(who));
      if (p) assignee = p; else errors.push(`Responsável "${who}" não encontrado entre quem tem acesso às Tarefas financeiras`);
    }
    const body = {
      title: txt(v('title')), category: txt(v('category')) || 'Outros', payee: txt(v('payee')) || null, amount: amount ?? 0,
      variable: yes(v('variable')), repeat_last: yes(v('repeat_last')), frequency: freq, due_day: day, start_month: start, end_month: end || null,
      assignee_id: assignee?.id || ctx.user.id, notes: txt(v('notes')) || null,
    };
    if (!errors.length) { try { readObligation(body); } catch (e) { errors.push(e.message); } }
    const key = `${hkey(body.title)}|${hkey(body.category)}`;
    const status = errors.length ? 'erro' : existing.has(key) ? 'existe' : seen.has(key) ? 'repetida' : 'ok';
    if (status === 'ok') seen.set(key, i + 1);
    rows.push({
      line: i + 1, status, errors, repeated_line: status === 'repetida' ? seen.get(key) : null, body,
      view: { ...body, frequency_label: FREQ_LABEL[freq] || txt(v('frequency')), assignee_name: assignee?.name || (who ? who : null), category_new: body.category && !CATEGORIES.includes(body.category) },
    });
  }
  const pays = payHead ? parsePayments(ctx, payHead, rows) : [];
  if (!rows.length && !pays.length) throw badRequest('A planilha não tem linhas preenchidas nas abas "Tarefas" e "Pagamentos".');
  return { name, rows, pays };
}

// ---------- Aba "Pagamentos" (grade do ano: tarefa × meses, valor pago) ----------
const MKEY = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
function findPayHead(sheets) {
  for (const s of sheets) {
    const hi = s.rows.findIndex(r => r.some(v => hkey(v).startsWith('tarefa')) && r.some(v => hkey(v) === 'jan' || hkey(v) === 'janeiro'));
    if (hi < 0) continue;
    const col = { months: {} };
    s.rows[hi].forEach((v, i) => {
      const k = hkey(v);
      if (k.startsWith('tarefa') && col.title === undefined) col.title = i;
      else if (k.startsWith('tipo') && col.category === undefined) col.category = i;
      else if (k === 'ano' && col.year === undefined) col.year = i;
      else {
        const m = MKEY.findIndex(x => k === x || (k.startsWith(x) && k.length <= 9));
        if (m >= 0 && col.months[m] === undefined) col.months[m] = i;
      }
    });
    return { rows: s.rows, hi, col };
  }
  return null;
}
function parsePayments(ctx, { rows: grid, hi, col }, taskRows) {
  const cur = today().slice(0, 7);
  const obs = all('SELECT * FROM finance_obligations');
  const paidSet = new Set(all(`SELECT obligation_id, ref_month FROM finance_items WHERE status = 'paga'`).map(r => `${r.obligation_id}|${r.ref_month}`));
  const fresh = taskRows.filter(r => r.status === 'ok');
  const out = [];
  for (let i = hi + 1; i < grid.length && out.length < MAX_ROWS; i++) {
    const g = grid[i], at = c => (c === undefined ? null : g[c] ?? null);
    const filled = Object.entries(col.months).map(([m, c]) => ({ m: Number(m), raw: at(c) })).filter(x => txt(x.raw) !== '');
    if (!filled.length) continue; // linha sem nenhum valor pago: nada a lançar
    const title = txt(at(col.title)), category = txt(at(col.category));
    const yRaw = at(col.year), year = typeof yRaw === 'number' ? yRaw : Number(txt(yRaw));
    const errors = [];
    if (!title) errors.push('Tarefa em branco');
    if (!Number.isInteger(year) || year < 2000 || year > 2100) errors.push('Ano inválido (ex.: 2026)');
    // Tarefa: cadastrada no sistema ou nova (aba "Tarefas" do mesmo arquivo)
    let target = null;
    if (title) {
      const same = obs.filter(o => hkey(o.title) === hkey(title) && (!category || hkey(o.category) === hkey(category)));
      const neu = fresh.filter(r => hkey(r.body.title) === hkey(title) && (!category || hkey(r.body.category) === hkey(category)));
      if (same.length + neu.length > 1) errors.push(`Há mais de uma tarefa "${title}": informe o Tipo da despesa`);
      else if (same.length) target = { id: same[0].id, o: same[0] };
      else if (neu.length) target = { line: neu[0].line, o: neu[0].body };
      else errors.push(`Tarefa "${title}" não encontrada (cadastre-a na aba "Tarefas")`);
    }
    const okYear = Number.isInteger(year) && year >= 2000 && year <= 2100;
    const months = filled.map(({ m, raw }) => {
      const ym = okYear ? `${year}-${String(m + 1).padStart(2, '0')}` : null;
      const amount = amountOf(raw);
      const r = { month: MES[m], ym, amount: typeof amount === 'number' ? amount : null, status: 'ok', error: null };
      if (typeof amount !== 'number' || amount < 0) { r.status = 'erro'; r.error = `${MES[m]}: valor inválido`; }
      else if (ym && ym > cur) { r.status = 'erro'; r.error = `${MES[m]}: mês futuro`; }
      else if (ym && target && !monthsOf(target.o, ym).includes(ym)) { r.status = 'erro'; r.error = `${MES[m]}: a tarefa não vence neste mês`; }
      else if (ym && target?.id && paidSet.has(`${target.id}|${ym}`)) r.status = 'pago';
      return r;
    });
    errors.push(...months.filter(x => x.error).map(x => x.error));
    const ok = months.filter(x => x.status === 'ok');
    const status = errors.length ? 'erro' : ok.length ? 'ok' : 'pago';
    out.push({ line: i + 1, status, errors, title, category: category || target?.o.category || null, year: okYear ? year : null,
      target: target ? { id: target.id || null, line: target.line || null } : null, months, total: r2(ok.reduce((s, x) => s + x.amount, 0)) });
  }
  return out;
}

export function previewImport(ctx, body) {
  requireFinance(ctx.user);
  const { name, rows, pays } = parse(ctx, body.file);
  const count = s => rows.filter(r => r.status === s).length;
  const pc = s => pays.filter(r => r.status === s).length;
  const okPays = pays.filter(r => r.status === 'ok');
  return { file: name, rows: rows.map(({ body: _b, ...r }) => r), pays,
    totals: { rows: rows.length, ok: count('ok'), erro: count('erro'), existe: count('existe'), repetida: count('repetida'),
      pay_rows: pays.length, pay_ok: pc('ok'), pay_erro: pc('erro'), pay_pago: pc('pago'),
      pay_count: okPays.reduce((s, r) => s + r.months.filter(m => m.status === 'ok').length, 0),
      pay_total: r2(okPays.reduce((s, r) => s + r.total, 0)) } };
}

// Importa só as linhas válidas (status ok), menos as desmarcadas na prévia (skip: números de linha)
export function applyImport(ctx, body, ip) {
  requireFinance(ctx.user);
  const { name, rows, pays } = parse(ctx, body.file);
  const skip = new Set((Array.isArray(body.skip) ? body.skip : []).map(Number));
  const skipPay = new Set((Array.isArray(body.skip_pay) ? body.skip_pay : []).map(Number));
  const todo = rows.filter(r => r.status === 'ok' && !skip.has(r.line));
  let paid = 0, paidTotal = 0;
  const ids = tx(() => {
    const byLine = new Map();
    const out = todo.map(r => { const id = insertObligation(ctx, readObligation(r.body), ip, { imported: true }); byLine.set(r.line, id); return id; });
    // Pagamentos: tarefa cadastrada ou criada agora (se a linha dela foi importada)
    for (const p of pays.filter(r => r.status === 'ok' && !skipPay.has(r.line))) {
      const oid = p.target.id || byLine.get(p.target.line);
      if (!oid) continue;
      for (const m of p.months.filter(x => x.status === 'ok')) {
        const it = ensureItem(ctx, oid, m.ym);
        if (it.status === 'paga') continue;
        const pd = it.due_date && it.due_date <= today() ? it.due_date : today();
        payItem(ctx, it.id, { paid_date: pd, paid_amount: m.amount, notes: 'Pagamento importado de planilha' }, ip);
        audit(ctx.user.id, 'finance', it.id, PAY, { parcela: `${p.title} ${m.month}/${p.year}`, valor: m.amount, data: pd }, ip);
        paid++; paidTotal += m.amount;
      }
    }
    audit(ctx.user.id, 'finance', null, BATCH, { arquivo: name, importadas: out.length, com_erro: rows.filter(r => r.status === 'erro').length, ja_existiam: rows.filter(r => r.status === 'existe').length, pagamentos: paid, valor_pago: r2(paidTotal) }, ip);
    return out;
  });
  if (ids.length) generateItems(ctx.user.id);
  return { imported: ids.length, skipped: rows.length - ids.length, ids, paid, paid_total: r2(paidTotal) };
}

// ---------- Desfazer importação ----------
// Cada importação deixa na auditoria uma linha por tarefa ("…importada de planilha") e, ao final, a linha do lote
// ("Tarefas financeiras importadas de planilha"). As tarefas do lote são as registradas entre o lote anterior e este.
const BATCH = 'Tarefas financeiras importadas de planilha', ITEM = 'Obrigação financeira importada de planilha', UNDONE = 'Importação de planilha desfeita', PAY = 'Pagamento importado de planilha';
function batchInfo(b) {
  const prev = one(`SELECT MAX(id) AS id FROM audit_log WHERE entity = 'finance' AND action = ? AND id < ?`, BATCH, b.id)?.id || 0;
  const inRange = action => all(`SELECT entity_id FROM audit_log WHERE entity = 'finance' AND action = ? AND id > ? AND id < ? AND actor_id IS ?`, action, prev, b.id, b.actor_id).map(r => r.entity_id);
  const ids = inRange(ITEM), payIds = inRange(PAY);
  const pays = payIds.length ? all(`SELECT i.id, i.obligation_id, i.ref_month, i.paid_amount, i.status, o.title FROM finance_items i JOIN finance_obligations o ON o.id = i.obligation_id
    WHERE i.id IN (${payIds.map(() => '?').join(',')}) AND i.status = 'paga' ORDER BY o.title, i.ref_month`, ...payIds) : [];
  const own = new Set(pays.map(x => x.id));
  // Tarefa importada com pagamento lançado fora desta importação é mantida
  const items = ids.length ? all(`SELECT o.id, o.title, o.category, o.amount, o.frequency,
      (SELECT COUNT(*) FROM finance_items i WHERE i.obligation_id = o.id AND i.status = 'paga') AS paid_n,
      (SELECT GROUP_CONCAT(i.id) FROM finance_items i WHERE i.obligation_id = o.id AND i.status = 'paga') AS paid_ids
    FROM finance_obligations o WHERE o.id IN (${ids.map(() => '?').join(',')}) ORDER BY o.title`, ...ids) : [];
  const d = (() => { try { return JSON.parse(b.details || '{}'); } catch { return {}; } })();
  return {
    id: b.id, file: d.arquivo || null, at: b.created_at, actor_name: b.actor_name, imported: ids.length,
    items: items.map(o => ({ id: o.id, title: o.title, category: o.category, amount: o.amount, frequency_label: FREQ_LABEL[o.frequency],
      paid: String(o.paid_ids || '').split(',').filter(Boolean).some(x => !own.has(Number(x))) })),
    payments: pays.map(x => ({ id: x.id, title: x.title, ref_month: x.ref_month, amount: x.paid_amount })),
    payments_total: r2(pays.reduce((s, x) => s + (x.paid_amount || 0), 0)),
  };
}
export function lastImport(ctx) {
  requireFinance(ctx.user);
  const undone = new Set(all(`SELECT details FROM audit_log WHERE entity = 'finance' AND action = ?`, UNDONE).map(r => { try { return JSON.parse(r.details).lote; } catch { return null; } }));
  const b = all(`SELECT a.*, u.name AS actor_name FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id
    WHERE a.entity = 'finance' AND a.action = ? ORDER BY a.id DESC LIMIT 20`, BATCH).find(x => !undone.has(x.id));
  if (!b) return null;
  const info = batchInfo(b);
  return info.items.length || info.payments.length ? info : null;
}
export function undoImport(ctx, batchId, ip) {
  requireFinance(ctx.user);
  const last = lastImport(ctx);
  if (!last || last.id !== intOrNull(batchId)) throw notFound('Importação não encontrada (só a última importação pode ser desfeita).');
  const keep = last.items.filter(o => o.paid), drop = last.items.filter(o => !o.paid);
  const dropIds = new Set(drop.map(o => o.id));
  let unpaid = 0;
  tx(() => {
    // Pagamentos lançados por esta importação voltam a pendente (os das tarefas excluídas somem junto com elas)
    for (const x of last.payments) {
      const it = one('SELECT obligation_id, status FROM finance_items WHERE id = ?', x.id);
      if (!it || it.status !== 'paga' || dropIds.has(it.obligation_id)) continue;
      unpayItem(ctx, x.id, ip); unpaid++;
    }
    for (const o of drop) {
      run('DELETE FROM finance_plan WHERE obligation_id = ?', o.id);
      removeObligationInternal(o.id, ctx.user.id, 'Importação de planilha desfeita');
      audit(ctx.user.id, 'finance', o.id, 'Obrigação financeira excluída (importação desfeita)', { descricao: o.title, categoria: o.category }, ip);
    }
    audit(ctx.user.id, 'finance', null, UNDONE, { lote: last.id, arquivo: last.file, excluidas: drop.length, pagamentos_desfeitos: unpaid, mantidas_com_pagamento: keep.map(o => o.title) }, ip);
  });
  return { removed: drop.length, unpaid, kept: keep.map(o => o.title) };
}
