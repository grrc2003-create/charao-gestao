// Cotações do projeto: itens a cotar por disciplina, fornecedores (cadastro único), solicitações de proposta com
// evidência do envio, cobranças e propostas recebidas (preço por item, revisões e arquivo). Meta: 3 propostas por item.
import { all, one, run, tx } from '../db.js';
import { badRequest, forbidden, notFound, str, date, intOrNull } from '../lib/http.js';
import { canAccessProject } from '../lib/permissions.js';
import { audit } from './audit.js';
import { today } from './metrics.js';
import { saveImageFromDataUrl, cleanFileName, deleteStored, readStored } from './files.js';
import { readXlsxSheets } from '../lib/xlsx.js';
import { writeXlsx, zip } from '../lib/xlsx-write.js';

export const TARGET = 3;
export const CHANNELS = ['E-mail', 'WhatsApp', 'Portal', 'Telefone', 'Pessoalmente'];
const r2 = v => Math.round((Number(v) || 0) * 100) / 100;
const fmtD = d => (d ? d.split('-').reverse().join('/') : '—');
const num = (v, label) => {
  if (v === '' || v === null || v === undefined) return null;
  if (typeof v === 'number') return v;
  const s = String(v).trim();
  const n = Number(/,\d{1,2}$/.test(s) || /^\d{1,3}(\.\d{3})+(,\d+)?$/.test(s) ? s.replace(/\./g, '').replace(',', '.') : s.replace(',', '.'));
  if (!Number.isFinite(n) || n < 0) throw badRequest(`${label}: valor inválido.`);
  return n;
};
const median = arr => { if (!arr.length) return null; const s = [...arr].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return r2(s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2); };

function project(ctx, projectId, { edit = false, any = false } = {}) {
  const p = one('SELECT id, code, name, client, kind, has_quotes FROM projects WHERE id = ?', projectId);
  if (!p || !canAccessProject(ctx.user, p.id, ctx.projects)) throw notFound('Projeto não encontrado.');
  if (!any && !p.has_quotes) throw badRequest('Este projeto não tem cotações. Para usar, marque "Este projeto terá cotações" no cadastro do projeto.');
  if (edit && ctx.user.is_external) throw forbidden('Terceirizados não alteram as cotações.');
  return p;
}
// Nome padrão da proposta: Projeto-Disciplina-Fornecedor-ID (ID = número do arquivo no sistema, não muda).
// Calculado na hora (vale também para as propostas já anexadas); o nome do arquivo enviado fica guardado como está.
const part = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^A-Za-z0-9-]+/g, '_').replace(/^[_-]+|[_-]+$/g, '');
const FILE_EXT = { 'application/pdf': '.pdf', 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp' };
export function proposalName({ code, disciplines = [], supplier, fileId, mime }) {
  const ds = [...new Set(disciplines.map(part).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'pt-BR'));
  const disc = ds.length > 2 ? 'Varias_disciplinas' : ds.join('+') || 'Sem_disciplina';
  return `${part(code) || 'Projeto'}-${disc.slice(0, 60)}-${part(supplier).slice(0, 50) || 'Fornecedor'}-${String(fileId).padStart(4, '0')}${FILE_EXT[mime] || ''}`;
}
function proposalNameOf(requestId, fileId, mime) {
  const r = one('SELECT p.code, s.name AS supplier FROM quote_requests r JOIN projects p ON p.id = r.project_id JOIN suppliers s ON s.id = r.supplier_id WHERE r.id = ?', requestId);
  const discs = all('SELECT DISTINCT i.discipline FROM quote_request_items x JOIN quote_items i ON i.id = x.item_id WHERE x.request_id = ?', requestId).map(d => d.discipline);
  return proposalName({ code: r?.code, disciplines: discs, supplier: r?.supplier, fileId, mime });
}
const saveFiles = (ctx, requestId, files, kind, { followupId = null, revision = null } = {}) => {
  let n = 0;
  for (const f of (Array.isArray(files) ? files : []).slice(0, 10)) {
    const s = saveImageFromDataUrl(f?.data);
    run('INSERT INTO quote_files (request_id, followup_id, kind, revision, stored_name, mime, size, original_name, uploaded_by) VALUES (?,?,?,?,?,?,?,?,?)',
      requestId, followupId, kind, revision, s.stored_name, s.mime, s.size, cleanFileName(f.name) || null, ctx.user.id);
    n++;
  }
  return n;
};

// ---------- Fornecedores ----------
const supplierView = s => ({ ...s, disciplines: (() => { try { return JSON.parse(s.disciplines || '[]'); } catch { return []; } })() });
export function listSuppliers(ctx) {
  if (ctx.user.is_external) throw forbidden('Sem acesso aos fornecedores.');
  return all('SELECT * FROM suppliers ORDER BY active DESC, name COLLATE NOCASE').map(supplierView);
}
function readSupplier(b) {
  const d = {
    name: str(b.name, { max: 160, required: true, label: 'Nome do fornecedor' }),
    cnpj: str(b.cnpj, { max: 30, label: 'CNPJ' }),
    phone: str(b.phone, { max: 80, label: 'Telefone' }),
    email: str(b.email, { max: 160, label: 'E-mail' }),
    address: str(b.address, { max: 300, label: 'Endereço' }),
    contact: str(b.contact, { max: 120, label: 'Contato' }),
    notes: str(b.notes, { max: 1000, label: 'Observações' }),
    disciplines: JSON.stringify([...new Set((Array.isArray(b.disciplines) ? b.disciplines : String(b.disciplines || '').split(',')).map(x => String(x).trim()).filter(Boolean))].slice(0, 30)),
    active: b.active === false || b.active === 0 || b.active === '0' ? 0 : 1,
  };
  return d;
}
export function saveSupplier(ctx, id, body, ip) {
  if (ctx.user.is_external) throw forbidden('Sem acesso aos fornecedores.');
  const d = readSupplier(body || {});
  const dup = d.cnpj && one('SELECT id FROM suppliers WHERE cnpj = ? AND id <> ?', d.cnpj, id || 0);
  if (dup) throw badRequest('Já existe um fornecedor com este CNPJ.');
  let sid = id;
  if (id) {
    if (!one('SELECT id FROM suppliers WHERE id = ?', id)) throw notFound('Fornecedor não encontrado.');
    run(`UPDATE suppliers SET name=?, cnpj=?, phone=?, email=?, address=?, contact=?, notes=?, disciplines=?, active=?, updated_at=datetime('now') WHERE id=?`,
      d.name, d.cnpj, d.phone, d.email, d.address, d.contact, d.notes, d.disciplines, d.active, id);
  } else {
    sid = Number(run('INSERT INTO suppliers (name, cnpj, phone, email, address, contact, notes, disciplines, active, created_by) VALUES (?,?,?,?,?,?,?,?,?,?)',
      d.name, d.cnpj, d.phone, d.email, d.address, d.contact, d.notes, d.disciplines, d.active, ctx.user.id).lastInsertRowid);
  }
  audit(ctx.user.id, 'quote', null, id ? 'Fornecedor atualizado' : 'Fornecedor cadastrado', { fornecedor: d.name }, ip);
  return supplierView(one('SELECT * FROM suppliers WHERE id = ?', sid));
}

// ---------- Mapa do projeto ----------
function loadMap(projectId) {
  const items = all('SELECT * FROM quote_items WHERE project_id = ? ORDER BY discipline COLLATE NOCASE, sort_order, id', projectId);
  const requests = all(`SELECT r.*, s.name AS supplier_name, s.cnpj AS supplier_cnpj, s.phone AS supplier_phone, s.email AS supplier_email, s.address AS supplier_address, u.name AS created_by_name
    FROM quote_requests r JOIN suppliers s ON s.id = r.supplier_id LEFT JOIN users u ON u.id = r.created_by WHERE r.project_id = ? ORDER BY r.sent_date, r.id`, projectId);
  const ref = today();
  const reqItems = new Map();
  for (const x of all('SELECT ri.* FROM quote_request_items ri JOIN quote_requests r ON r.id = ri.request_id WHERE r.project_id = ?', projectId)) {
    if (!reqItems.has(x.request_id)) reqItems.set(x.request_id, []);
    reqItems.get(x.request_id).push(x.item_id);
  }
  // Preço vigente: a revisão mais recente de cada (solicitação, item)
  const prices = new Map();
  for (const p of all(`SELECT qp.* FROM quote_prices qp JOIN quote_requests r ON r.id = qp.request_id WHERE r.project_id = ? ORDER BY qp.revision, qp.id`, projectId)) prices.set(`${p.request_id}|${p.item_id}`, p);
  // Frete da proposta (revisão mais recente): somado ao total e rateado entre os itens pelo valor de cada um (preço × quantidade)
  const freights = new Map();
  for (const f of all(`SELECT qf.* FROM quote_freights qf JOIN quote_requests r ON r.id = qf.request_id WHERE r.project_id = ? ORDER BY qf.revision, qf.id`, projectId)) freights.set(f.request_id, f.amount);
  const qtyOf = new Map(items.map(i => [i.id, Number(i.qty) > 0 ? Number(i.qty) : 1]));
  const reqMoney = new Map();
  for (const [k, p] of prices) {
    const [rid, iid] = k.split('|').map(Number);
    const m = reqMoney.get(rid) || { subtotal: 0 };
    m.subtotal += p.price * (qtyOf.get(iid) || 1);
    reqMoney.set(rid, m);
  }
  const factorOf = rid => { const fr = freights.get(rid) || 0, sub = reqMoney.get(rid)?.subtotal || 0; return fr > 0 && sub > 0 ? fr / sub : 0; };
  const files = new Map();
  for (const f of all(`SELECT f.id, f.request_id, f.followup_id, f.kind, f.revision, f.mime, f.original_name, f.created_at FROM quote_files f JOIN quote_requests r ON r.id = f.request_id WHERE r.project_id = ? ORDER BY f.id`, projectId)) {
    if (!files.has(f.request_id)) files.set(f.request_id, []);
    files.get(f.request_id).push(f);
  }
  const fups = new Map();
  for (const f of all(`SELECT q.*, u.name AS by_name FROM quote_followups q JOIN quote_requests r ON r.id = q.request_id LEFT JOIN users u ON u.id = q.created_by WHERE r.project_id = ? ORDER BY q.date, q.id`, projectId)) {
    if (!fups.has(f.request_id)) fups.set(f.request_id, []);
    fups.get(f.request_id).push(f);
  }
  const reqs = requests.map(r => ({
    ...r, item_ids: reqItems.get(r.id) || [], overdue: r.status === 'enviada' && !!r.due_date && r.due_date < ref,
    files: files.get(r.id) || [], followups: fups.get(r.id) || [],
    revision: Math.max(-1, ...[...prices.values()].filter(p => p.request_id === r.id).map(p => p.revision)),
    freight: freights.get(r.id) || 0, subtotal: r2(reqMoney.get(r.id)?.subtotal || 0), total: r2((reqMoney.get(r.id)?.subtotal || 0) + (freights.get(r.id) || 0)),
  }));
  const its = items.map(it => {
    const offers = reqs.filter(r => r.item_ids.includes(it.id)).map(r => {
      const p = prices.get(`${r.id}|${it.id}`);
      return { request_id: r.id, supplier_id: r.supplier_id, supplier_name: r.supplier_name, status: r.status, overdue: r.overdue, sent_date: r.sent_date, due_date: r.due_date,
        received_date: r.received_date, revision: p ? p.revision : null,
        // Preço para comparar = preço do fornecedor + frete rateado (por unidade); o digitado fica em price_raw
        price: p ? r2(p.price * (1 + factorOf(r.id))) : null, price_raw: p ? p.price : null, freight_unit: p ? r2(p.price * factorOf(r.id)) : 0 };
    });
    const got = offers.filter(o => o.price !== null).map(o => o.price);
    return { ...it, offers, received: got.length, requested: offers.length, pending: offers.filter(o => o.status === 'enviada').length,
      overdue: offers.filter(o => o.overdue).length, median: median(got), min: got.length ? Math.min(...got) : null };
  });
  return { items: its, requests: reqs };
}
const bucketOf = n => (n >= TARGET ? 'tres' : n === 2 ? 'dois' : n === 1 ? 'um' : 'nenhuma');
function summarize(items, requests) {
  const b = { tres: 0, dois: 0, um: 0, nenhuma: 0 };
  const disc = new Map();
  for (const it of items) {
    const k = bucketOf(it.received);
    b[k]++;
    if (!disc.has(it.discipline)) disc.set(it.discipline, { discipline: it.discipline, items: 0, tres: 0, dois: 0, um: 0, nenhuma: 0, no_request: 0 });
    const d = disc.get(it.discipline);
    d.items++; d[k]++; if (!it.requested) d.no_request++;
  }
  const rq = { total: requests.length, recebida: 0, enviada: 0, declinou: 0, vencida: 0 };
  for (const r of requests) { rq[r.status]++; if (r.overdue) rq.vencida++; }
  return { target: TARGET, items: items.length, buckets: b, requests: rq, no_request: items.filter(i => !i.requested).length,
    disciplines: [...disc.values()].sort((a, c) => a.discipline.localeCompare(c.discipline, 'pt-BR')) };
}
export function projectQuotes(ctx, projectId) {
  const p = project(ctx, projectId);
  const { items, requests } = loadMap(p.id);
  return { project: p, items, requests, summary: summarize(items, requests), target: TARGET, channels: CHANNELS,
    suppliers: all('SELECT id, name, cnpj, disciplines FROM suppliers WHERE active = 1 ORDER BY name COLLATE NOCASE').map(supplierView),
    can_edit: !ctx.user.is_external, today: today() };
}
export function quotesSummary(ctx, projectId) {
  const p = project(ctx, projectId, { any: true });
  if (!p.has_quotes) return { enabled: false, items: 0 };
  if (!one('SELECT 1 FROM quote_items WHERE project_id = ? LIMIT 1', p.id)) return { enabled: true, items: 0 };
  const { items, requests } = loadMap(p.id);
  return { enabled: true, ...summarize(items, requests) };
}

// ---------- Itens ----------
function readItem(b) {
  const abc = String(b.abc || '').trim().toUpperCase();
  return {
    discipline: str(b.discipline, { max: 80, required: true, label: 'Disciplina' }),
    code: str(b.code, { max: 60, label: 'Código do orçamento' }),
    location: str(b.location, { max: 160, label: 'Local' }),
    description: str(b.description, { max: 500, required: true, label: 'Descrição' }),
    qty: num(b.qty, 'Quantidade'),
    unit: str(b.unit, { max: 20, label: 'Unidade' }),
    abc: ['A', 'B', 'C'].includes(abc) ? abc : null,
    notes: str(b.notes, { max: 1000, label: 'Observação' }),
  };
}
export function saveItem(ctx, projectId, id, body, ip) {
  const p = project(ctx, projectId, { edit: true });
  const d = readItem(body || {});
  let iid = id;
  if (id) {
    if (!one('SELECT id FROM quote_items WHERE id = ? AND project_id = ?', id, p.id)) throw notFound('Item não encontrado.');
    run(`UPDATE quote_items SET discipline=?, code=?, location=?, description=?, qty=?, unit=?, abc=?, notes=?, updated_at=datetime('now') WHERE id=?`, d.discipline, d.code, d.location, d.description, d.qty, d.unit, d.abc, d.notes, id);
  } else {
    const order = (one('SELECT MAX(sort_order) AS n FROM quote_items WHERE project_id = ?', p.id)?.n || 0) + 1;
    iid = Number(run('INSERT INTO quote_items (project_id, discipline, code, location, description, qty, unit, abc, notes, sort_order, created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      p.id, d.discipline, d.code, d.location, d.description, d.qty, d.unit, d.abc, d.notes, order, ctx.user.id).lastInsertRowid);
  }
  audit(ctx.user.id, 'quote', p.id, id ? 'Item de cotação alterado' : 'Item de cotação incluído', { projeto: p.code, disciplina: d.discipline, item: d.description }, ip);
  return { id: iid };
}
export function deleteItem(ctx, projectId, id, ip) {
  const p = project(ctx, projectId, { edit: true });
  const it = one('SELECT * FROM quote_items WHERE id = ? AND project_id = ?', id, p.id);
  if (!it) throw notFound('Item não encontrado.');
  run('DELETE FROM quote_items WHERE id = ?', id);
  audit(ctx.user.id, 'quote', p.id, 'Item de cotação excluído', { projeto: p.code, item: it.description }, ip);
  return { ok: true };
}

// ---------- Solicitações ----------
function loadRequest(ctx, id, edit = true) {
  const r = one('SELECT * FROM quote_requests WHERE id = ?', id);
  if (!r) throw notFound('Solicitação não encontrada.');
  const p = project(ctx, r.project_id, { edit });
  return { r, p };
}
export function createRequest(ctx, projectId, body, ip) {
  const p = project(ctx, projectId, { edit: true });
  const b = body || {};
  const sup = one('SELECT * FROM suppliers WHERE id = ?', intOrNull(b.supplier_id));
  if (!sup) throw badRequest('Escolha o fornecedor.');
  const ids = [...new Set((Array.isArray(b.item_ids) ? b.item_ids : []).map(Number))].filter(Boolean);
  if (!ids.length) throw badRequest('Escolha os itens desta solicitação.');
  const valid = all(`SELECT id FROM quote_items WHERE project_id = ? AND id IN (${ids.map(() => '?').join(',')})`, p.id, ...ids).map(r => r.id);
  if (valid.length !== ids.length) throw badRequest('Há itens que não são deste projeto.');
  const sent = date(b.sent_date, 'Data do envio') || today();
  if (sent > today()) throw badRequest('A data do envio não pode ser no futuro.');
  const due = date(b.due_date, 'Responder até');
  if (due && due < sent) throw badRequest('O prazo de resposta não pode ser antes do envio.');
  const files = Array.isArray(b.files) ? b.files : [];
  if (!files.length) throw badRequest('Anexe a evidência do envio (print do e-mail/WhatsApp ou PDF enviado).');
  const channel = CHANNELS.includes(b.channel) ? b.channel : null;
  const id = tx(() => {
    const rid = Number(run('INSERT INTO quote_requests (project_id, supplier_id, status, sent_date, channel, due_date, notes, created_by) VALUES (?,?,?,?,?,?,?,?)',
      p.id, sup.id, 'enviada', sent, channel, due, str(b.notes, { max: 1000, label: 'Observação' }), ctx.user.id).lastInsertRowid);
    for (const iid of valid) run('INSERT INTO quote_request_items (request_id, item_id) VALUES (?,?)', rid, iid);
    saveFiles(ctx, rid, files, 'envio');
    return rid;
  });
  audit(ctx.user.id, 'quote', p.id, 'Solicitação de proposta enviada', { projeto: p.code, fornecedor: sup.name, itens: valid.length, envio: fmtD(sent), prazo: due ? fmtD(due) : undefined }, ip);
  return { id };
}
export function requestAction(ctx, id, action, body, ip) {
  const { r, p } = loadRequest(ctx, id);
  const b = body || {};
  const sup = one('SELECT name FROM suppliers WHERE id = ?', r.supplier_id)?.name;
  let label;
  if (action === 'receive') {
    if (r.status === 'declinou') throw badRequest('O fornecedor declinou: reabra a solicitação antes de lançar a proposta.');
    const itemIds = new Set(all('SELECT item_id FROM quote_request_items WHERE request_id = ?', id).map(x => x.item_id));
    const prices = (Array.isArray(b.prices) ? b.prices : []).map(x => ({ item_id: Number(x?.item_id), price: num(x?.price, 'Preço') })).filter(x => x.price !== null);
    if (!prices.length) throw badRequest('Informe o preço de ao menos um item.');
    if (prices.some(x => !itemIds.has(x.item_id))) throw badRequest('Há preço para item que não está nesta solicitação.');
    const recv = date(b.received_date, 'Recebida em') || today();
    if (recv > today()) throw badRequest('A data de recebimento não pode ser no futuro.');
    if (recv < r.sent_date) throw badRequest('A proposta não pode ser recebida antes do envio da solicitação.');
    const rev = (one('SELECT MAX(revision) AS n FROM quote_prices WHERE request_id = ?', id)?.n ?? -1) + 1;
    tx(() => {
      for (const x of prices) run('INSERT INTO quote_prices (request_id, item_id, price, revision, created_by) VALUES (?,?,?,?,?)', id, x.item_id, r2(x.price), rev, ctx.user.id);
      const freight = b.freight === '' || b.freight === undefined || b.freight === null ? 0 : num(b.freight, 'Frete');
      if (freight < 0) throw badRequest('O frete não pode ser negativo.');
      run('INSERT INTO quote_freights (request_id, revision, amount, created_by) VALUES (?,?,?,?)', id, rev, r2(freight || 0), ctx.user.id);
      run(`UPDATE quote_requests SET status = 'recebida', received_date = ?, valid_until = ?, conditions = ?, updated_at = datetime('now') WHERE id = ?`,
        recv, date(b.valid_until, 'Validade'), str(b.conditions, { max: 1000, label: 'Condições' }), id);
      saveFiles(ctx, id, b.files, 'proposta', { revision: rev });
    });
    label = rev ? `Proposta revisada (R${String(rev).padStart(2, '0')})` : 'Proposta recebida';
    if (Number(b.freight) > 0) label += ` com frete de ${Number(b.freight).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}`;
  } else if (action === 'followup') {
    if (r.status !== 'enviada' && !(r.imported && r.status === 'recebida')) throw badRequest('Só é possível cobrar solicitações aguardando resposta.');
    const d = date(b.date, 'Data da cobrança') || today();
    if (d > today()) throw badRequest('A data da cobrança não pode ser no futuro.');
    if (d < r.sent_date) throw badRequest('A cobrança não pode ser antes do envio da solicitação.');
    tx(() => {
      const fid = Number(run('INSERT INTO quote_followups (request_id, date, channel, notes, created_by) VALUES (?,?,?,?,?)', id, d,
        CHANNELS.includes(b.channel) ? b.channel : null, str(b.notes, { max: 1000, label: 'Observação' }), ctx.user.id).lastInsertRowid);
      saveFiles(ctx, id, b.files, 'cobranca', { followupId: fid });
      const nd = date(b.new_due_date, 'Novo prazo de resposta');
      if (nd) run(`UPDATE quote_requests SET due_date = ?, updated_at = datetime('now') WHERE id = ?`, nd, id);
    });
    label = 'Fornecedor cobrado';
  } else if (action === 'edit') {
    // Completa ou corrige a solicitação (ex.: importada da planilha): envio, meio, prazo, evidência e dados da proposta,
    // sem mexer nos preços nem criar revisão. Arquivos novos são acrescentados.
    const sent = date(b.sent_date, 'Enviada em') || r.sent_date;
    if (sent > today()) throw badRequest('A data do envio não pode ser no futuro.');
    const due = b.due_date === undefined ? r.due_date : date(b.due_date, 'Responder até');
    if (due && due < sent) throw badRequest('O prazo de resposta não pode ser antes do envio.');
    let recv = r.received_date;
    if (r.status === 'recebida') {
      recv = date(b.received_date, 'Recebida em') || r.received_date;
      if (recv > today()) throw badRequest('A data de recebimento não pode ser no futuro.');
      if (recv < sent) throw badRequest('A proposta não pode ser recebida antes do envio da solicitação.');
    }
    const fup = one('SELECT MIN(date) AS d FROM quote_followups WHERE request_id = ?', id)?.d;
    if (fup && fup < sent) throw badRequest(`Há cobrança em ${fmtD(fup)}: o envio não pode ser depois dela.`);
    const evid = Array.isArray(b.files) ? b.files : [];
    const props = r.status === 'recebida' && Array.isArray(b.proposal_files) ? b.proposal_files : [];
    const changed = [];
    tx(() => {
      const note = b.notes === undefined ? r.notes : str(b.notes, { max: 1000, label: 'Observação' });
      run(`UPDATE quote_requests SET sent_date = ?, channel = ?, due_date = ?, notes = ?, received_date = ?, valid_until = ?, conditions = ?, updated_at = datetime('now') WHERE id = ?`,
        sent, b.channel === undefined ? r.channel : (CHANNELS.includes(b.channel) ? b.channel : null), due, note, recv,
        r.status === 'recebida' && b.valid_until !== undefined ? date(b.valid_until, 'Validade') : r.valid_until,
        r.status === 'recebida' && b.conditions !== undefined ? str(b.conditions, { max: 1000, label: 'Condições' }) : r.conditions, id);
      if (sent !== r.sent_date) changed.push(`envio ${fmtD(r.sent_date)} → ${fmtD(sent)}`);
      if (recv !== r.received_date) changed.push(`recebida ${fmtD(r.received_date)} → ${fmtD(recv)}`);
      if (evid.length) {
        changed.push(`${saveFiles(ctx, id, evid, 'envio')} evidência(s) do envio`);
        if (note === 'Importada do mapa de cotações (sem evidência do envio)') run('UPDATE quote_requests SET notes = ? WHERE id = ?', 'Importada do mapa de cotações', id);
      }
      if (props.length) {
        const rev = one('SELECT MAX(revision) AS n FROM quote_prices WHERE request_id = ?', id)?.n ?? 0;
        changed.push(`${saveFiles(ctx, id, props, 'proposta', { revision: rev })} arquivo(s) da proposta`);
      }
    });
    audit(ctx.user.id, 'quote', p.id, 'Solicitação de proposta editada', { projeto: p.code, fornecedor: sup, alteracoes: changed.length ? changed : undefined }, ip);
    return { ok: true };
  } else if (action === 'decline') {
    if (r.status === 'recebida') throw badRequest('Já há proposta recebida nesta solicitação.');
    run(`UPDATE quote_requests SET status = 'declinou', notes = COALESCE(?, notes), updated_at = datetime('now') WHERE id = ?`, str(b.notes, { max: 1000, label: 'Motivo' }), id);
    label = 'Fornecedor declinou';
  } else if (action === 'reopen') {
    tx(() => {
      run('DELETE FROM quote_prices WHERE request_id = ?', id);
      for (const f of all(`SELECT stored_name FROM quote_files WHERE request_id = ? AND kind = 'proposta'`, id)) deleteStored(f.stored_name);
      run(`DELETE FROM quote_files WHERE request_id = ? AND kind = 'proposta'`, id);
      run(`UPDATE quote_requests SET status = 'enviada', received_date = NULL, valid_until = NULL, conditions = NULL, updated_at = datetime('now') WHERE id = ?`, id);
    });
    label = 'Solicitação reaberta (proposta retirada)';
  } else throw badRequest('Ação inválida.');
  audit(ctx.user.id, 'quote', p.id, label, { projeto: p.code, fornecedor: sup }, ip);
  return { ok: true };
}
export function deleteRequest(ctx, id, ip) {
  const { r, p } = loadRequest(ctx, id);
  const files = all('SELECT stored_name FROM quote_files WHERE request_id = ?', id);
  run('DELETE FROM quote_requests WHERE id = ?', id);
  for (const f of files) deleteStored(f.stored_name);
  audit(ctx.user.id, 'quote', p.id, 'Solicitação de proposta excluída', { projeto: p.code, fornecedor: one('SELECT name FROM suppliers WHERE id = ?', r.supplier_id)?.name }, ip);
  return { ok: true };
}
export function quoteFileForUser(ctx, fileId) {
  const f = one('SELECT f.*, r.project_id FROM quote_files f JOIN quote_requests r ON r.id = f.request_id WHERE f.id = ?', fileId);
  if (!f) throw notFound('Arquivo não encontrado.');
  project(ctx, f.project_id, { any: true });
  return f.kind === 'proposta' ? { ...f, original_name: proposalNameOf(f.request_id, f.id, f.mime) } : f;
}

// ---------- Importar o mapa de cotações (planilha no modelo atual) ----------
// Cada aba: linha de cabeçalho com "DADOS" e colunas EMPRESA 01…; cada item é um bloco que começa na linha "PREÇO"
// e segue com NOME, CNPJ, TELEFONE, NOME DO ARQUIVO, OBSERVAÇÃO, ENDEREÇO, SOLICITAÇÃO DE PREÇO.
const norm = s => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toUpperCase();
export function parseWorkbook(file) {
  if (!file?.data) throw badRequest('Envie a planilha (.xlsx).');
  let sheets;
  try { sheets = readXlsxSheets(Buffer.from(String(file.data).replace(/^data:[^,]*,/, ''), 'base64')); } catch { throw badRequest('Não foi possível ler a planilha (.xlsx).'); }
  const out = [];
  for (const sh of sheets) {
    const rows = sh.rows || [];
    const hi = rows.findIndex(r => Array.isArray(r) && r.some(c => norm(c) === 'DADOS'));
    if (hi < 0) continue;
    const H = rows[hi].map(norm);
    const col = (...names) => H.findIndex(h => names.includes(h));
    const cD = col('DADOS'), cDesc = col('DESCRICAO'), cCode = col('COD ORC', 'COD. ORC', 'CODIGO'), cLoc = col('LOCAL'), cQty = col('QTD', 'QTDE.', 'QTDE', 'QUANTIDADE'),
      cUnit = col('UNID', 'UND', 'UNIDADE'), cCat = col('CATEGORIA'), cAbc = col('CURVA');
    const supCols = H.map((h, i) => (/^EM?R?PRESA\s*\d+/.test(h.replace('EMRPRESA', 'EMPRESA')) ? i : -1)).filter(i => i >= 0);
    const title = String(rows.slice(0, hi).flat().find(c => /PLANILHA COTA/i.test(String(c || ''))) || '');
    const discipline = (title.includes('-') ? title.split('-').slice(1).join('-') : sh.name).trim().replace(/\s+/g, ' ') || sh.name.trim();
    const items = [];
    let cur = null;
    for (let i = hi + 1; i < rows.length; i++) {
      const r = rows[i] || [];
      const tag = norm(r[cD]);
      if (tag === 'PRECO') {
        cur = { code: r[cCode] ?? null, category: cCat >= 0 ? r[cCat] : null, location: cLoc >= 0 ? r[cLoc] : null, description: cDesc >= 0 ? r[cDesc] : null,
          qty: cQty >= 0 ? r[cQty] : null, unit: cUnit >= 0 ? r[cUnit] : null, abc: cAbc >= 0 ? r[cAbc] : null, sup: supCols.map(c => ({ price: r[c] })) };
        items.push(cur);
        continue;
      }
      if (!cur) continue;
      if (!cur.description && cDesc >= 0 && r[cDesc]) cur.description = r[cDesc];
      const key = { NOME: 'name', CNPJ: 'cnpj', TELEFONE: 'phone', 'NOME DO ARQUIVO': 'file', OBSERVACAO: 'obs', ENDERECO: 'address', 'SOLICITACAO DE PRECO': 'status' }[tag];
      if (key) supCols.forEach((c, k) => { if (r[c] !== null && r[c] !== undefined && String(r[c]).trim() !== '') cur.sup[k][key] = String(r[c]).trim(); });
    }
    const clean = items.filter(it => it.description && String(it.description).trim()).map(it => ({
      code: it.code ? String(it.code).trim() : null, location: it.location ? String(it.location).trim() : null, description: String(it.description).trim(),
      qty: typeof it.qty === 'number' ? it.qty : null, unit: it.unit ? String(it.unit).trim() : null, abc: ['A', 'B', 'C'].includes(norm(it.abc)) ? norm(it.abc) : null,
      category: it.category ? String(it.category).trim() : null,
      offers: it.sup.map(s => ({ ...s, price: typeof s.price === 'number' && s.price > 0 ? r2(s.price) : null })).filter(s => s.name || s.price !== null),
    }));
    if (!clean.length) continue;
    out.push({ sheet: sh.name, discipline, items: clean });
  }
  return out;
}
export function importPreview(ctx, projectId, body) {
  project(ctx, projectId, { edit: true });
  const sheets = parseWorkbook(body?.file);
  return {
    sheets: sheets.map(s => ({ sheet: s.sheet, discipline: s.discipline, items: s.items.length,
      offers: s.items.reduce((n, i) => n + i.offers.length, 0), prices: s.items.reduce((n, i) => n + i.offers.filter(o => o.price !== null).length, 0),
      suppliers: [...new Set(s.items.flatMap(i => i.offers.map(o => o.name).filter(Boolean)))].length,
      sample: s.items.slice(0, 3).map(i => i.description) })),
  };
}
export function importApply(ctx, projectId, body, ip) {
  const p = project(ctx, projectId, { edit: true });
  const pick = new Set(Array.isArray(body?.sheets) ? body.sheets : []);
  if (!pick.size) throw badRequest('Escolha as abas a importar.');
  const sheets = parseWorkbook(body?.file).filter(s => pick.has(s.sheet));
  if (!sheets.length) throw badRequest('Nenhuma das abas escolhidas tem itens.');
  const sent = today();
  const stats = { items: 0, requests: 0, prices: 0, suppliers: 0 };
  tx(() => {
    let order = one('SELECT MAX(sort_order) AS n FROM quote_items WHERE project_id = ?', p.id)?.n || 0;
    const supCache = new Map();
    const supplierFor = o => {
      const key = norm(o.cnpj || o.name);
      if (supCache.has(key)) return supCache.get(key);
      let s = (o.cnpj && one('SELECT id FROM suppliers WHERE cnpj = ?', o.cnpj)) || (o.name && one('SELECT id FROM suppliers WHERE name = ? COLLATE NOCASE', o.name));
      if (!s) {
        s = { id: Number(run('INSERT INTO suppliers (name, cnpj, phone, address, created_by) VALUES (?,?,?,?,?)', o.name || 'Fornecedor sem nome', o.cnpj || null, o.phone || null, o.address || null, ctx.user.id).lastInsertRowid) };
        stats.suppliers++;
      }
      supCache.set(key, s.id);
      return s.id;
    };
    for (const sh of sheets) {
      const reqBySup = new Map(); // uma solicitação por fornecedor na aba
      for (const it of sh.items) {
        const iid = Number(run('INSERT INTO quote_items (project_id, discipline, code, location, description, qty, unit, abc, notes, sort_order, created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
          p.id, sh.discipline, it.code, it.location, it.description, it.qty, it.unit, it.abc, it.category ? `Categoria: ${it.category}` : null, ++order, ctx.user.id).lastInsertRowid);
        stats.items++;
        for (const o of it.offers) {
          if (!o.name && o.price === null) continue;
          const sid = supplierFor(o);
          let rq = reqBySup.get(sid);
          if (!rq) {
            const received = o.price !== null || norm(o.status) === 'RECEBIDO';
            rq = { id: Number(run(`INSERT INTO quote_requests (project_id, supplier_id, status, sent_date, received_date, notes, imported, created_by) VALUES (?,?,?,?,?,?,1,?)`,
              p.id, sid, received ? 'recebida' : 'enviada', sent, received ? sent : null, 'Importada do mapa de cotações (sem evidência do envio)', ctx.user.id).lastInsertRowid) };
            reqBySup.set(sid, rq);
            stats.requests++;
          }
          run('INSERT OR IGNORE INTO quote_request_items (request_id, item_id) VALUES (?,?)', rq.id, iid);
          if (o.price !== null) {
            run('INSERT INTO quote_prices (request_id, item_id, price, revision, created_by) VALUES (?,?,?,0,?)', rq.id, iid, o.price, ctx.user.id);
            run(`UPDATE quote_requests SET status = 'recebida', received_date = COALESCE(received_date, ?) WHERE id = ?`, sent, rq.id);
            stats.prices++;
          }
        }
      }
    }
  });
  audit(ctx.user.id, 'quote', p.id, 'Mapa de cotações importado', { projeto: p.code, abas: [...pick], ...stats }, ip);
  return stats;
}

// ---------- Exportar o mapa (Excel no modelo da planilha; a mesma estrutura alimenta o PDF) ----------
// Por disciplina: cabeçalho, linha de colunas (CÓD ORÇ … DADOS, VALOR MEDIANO, EMPRESA 01…) e, para cada item, o bloco
// PREÇO / NOME / CNPJ / TELEFONE / NOME DO ARQUIVO / OBSERVAÇÃO / ENDEREÇO / SOLICITAÇÃO DE PREÇO / DATA DE ENVIO / DATA DE RECEBIMENTO.
const SIT = (o, r) => (o.price !== null ? 'RECEBIDO' : o.status === 'declinou' ? 'DECLINOU' : o.status === 'recebida' ? 'SEM PREÇO NO ITEM' : r.overdue ? 'ENVIADO (PRAZO VENCIDO)' : 'ENVIADO');
// Memorial do rateio do frete (observação do fornecedor em cada item, no PDF e no Excel)
const brlQ = v => (Number(v) || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const pctQ = v => `${(Math.round(v * 10000) / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%`;
function freightMemo(r, o, it) {
  if (!(r.freight > 0) || o.price_raw === null || o.price_raw === undefined || !(r.subtotal > 0)) return '';
  const q = Number(it.qty) > 0 ? Number(it.qty) : 1;
  const unit = it.unit ? ` ${it.unit}` : '';
  return `Frete da proposta ${brlQ(r.freight)} rateado pelo valor dos itens (+${pctQ(r.freight / r.subtotal)} sobre ${brlQ(r.subtotal)} em itens): `
    + `${brlQ(o.price_raw)} + ${brlQ(o.freight_unit)} de frete = ${brlQ(o.price)} por unidade · frete deste item ${brlQ(o.freight_unit * q)} (${String(q).replace('.', ',')}${unit})`;
}
export function mapData(ctx, projectId) {
  const d = projectQuotes(ctx, projectId);
  const p = one('SELECT code, name, client, location, municipio, uf FROM projects WHERE id = ?', d.project.id);
  p.address = [p.location, p.municipio && p.uf ? `${p.municipio}/${p.uf}` : p.uf].filter(Boolean).join(' · ');
  const reqById = new Map(d.requests.map(r => [r.id, r]));
  // Anexos: arquivos da proposta vigente de cada fornecedor, na ordem em que aparecem no mapa.
  // O nome padrão (Projeto-Disciplina-Fornecedor-ID) vai na linha NOME DO ARQUIVO (Excel e PDF) e liga o mapa à página do anexo.
  const annexes = [], annexOf = new Map();
  const revLabel = n => `R${String(n).padStart(2, '0')}`;
  const discOfItem = new Map(d.items.map(i => [i.id, i.discipline]));
  const stdName = (r, f, supplier) => proposalName({ code: p.code, disciplines: r.item_ids.map(id => discOfItem.get(id)), supplier, fileId: f.id, mime: f.mime });
  const annexFor = (r, supplier) => {
    if (annexOf.has(r.id)) return annexOf.get(r.id);
    const files = r.files.filter(f => f.kind === 'proposta');
    const last = Math.max(0, ...files.map(f => f.revision ?? 0));
    const list = files.filter(f => (f.revision ?? 0) === last).map(f => {
      const a = { no: annexes.length + 1, code: String(f.id).padStart(4, '0'), file_id: f.id, mime: f.mime, name: stdName(r, f, supplier), original: f.original_name || null, supplier, cnpj: r.supplier_cnpj || null,
        revision: revLabel(last), received: r.received_date, disciplines: [], items: 0 };
      annexes.push(a);
      return a;
    });
    const old = files.filter(f => (f.revision ?? 0) < last).map(f => `${stdName(r, f, supplier)} (${revLabel(f.revision ?? 0)} substituída)`);
    const v = { list, text: [...list.map(a => a.name), ...old].join('; ') };
    annexOf.set(r.id, v);
    return v;
  };
  const disciplines = [...new Set(d.items.map(i => i.discipline))].map(name => {
    const items = d.items.filter(i => i.discipline === name).map(it => {
      // Recebidas primeiro (menor preço antes), depois as demais
      const offers = [...it.offers].sort((a, b) => (a.price === null) - (b.price === null) || (a.price ?? 0) - (b.price ?? 0) || a.supplier_name.localeCompare(b.supplier_name, 'pt-BR')).map(o => {
        const r = reqById.get(o.request_id);
        let files = r.files.filter(f => f.kind === 'proposta').map(f => f.original_name || 'proposta').join(', ');
        if (o.price !== null) {
          const ax = annexFor(r, o.supplier_name);
          files = ax.text;
          for (const a of ax.list) { a.items++; if (!a.disciplines.includes(name)) a.disciplines.push(name); }
        }
        return { name: o.supplier_name, cnpj: r.supplier_cnpj, phone: r.supplier_phone, file: files, obs: [r.conditions, r.valid_until ? `validade ${fmtD(r.valid_until)}` : '', freightMemo(r, o, it)].filter(Boolean).join(' · '),
          address: r.supplier_address, status: SIT(o, r), situation: `${SIT(o, r)}${o.price !== null && r.received_date ? ` ${fmtD(r.received_date)}` : SIT(o, r) === 'ENVIADO' && o.sent_date ? ` ${fmtD(o.sent_date)}` : ''}`, sent: o.sent_date, received: o.price !== null ? r.received_date : null, price: o.price, revision: o.revision };
      });
      return { ...it, offers };
    });
    const sum = summarize(items, d.requests.filter(r => r.item_ids.some(id => items.some(i => i.id === id))));
    return { name, items, cols: Math.max(TARGET, ...items.map(i => i.offers.length)), summary: sum };
  });
  return { project: p, today: today(), target: TARGET, summary: d.summary, disciplines, annexes };
}
// Bloco de cada item, igual ao mapa original: PREÇO + 7 linhas de dados do fornecedor
const ROWS = [['NOME', 'name'], ['CNPJ', 'cnpj'], ['TELEFONE', 'phone'], ['NOME DO ARQUIVO', 'file'], ['OBSERVAÇÃO', 'obs'], ['ENDEREÇO', 'address'], ['SOLICITAÇÃO DE PREÇO', 'situation']];
const colL = i => { let s = ''; i++; while (i) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; };
const sheetName = (n, used) => { let b = String(n).replace(/[\\/?*[\]:]/g, ' ').trim().slice(0, 28) || 'Disciplina'; let k = b, i = 2; while (used.has(k.toUpperCase())) k = `${b.slice(0, 25)} ${i++}`; used.add(k.toUpperCase()); return k; };
// Cabeçalho do documento (linhas 1–9): título grande à esquerda; à direita a faixa azul com o projeto, cliente, endereço e data
function docHead(m, title, nCols, rightCols = 3) {
  const rows = Array.from({ length: 9 }, () => Array(nCols).fill(null));
  const R = nCols - rightCols;
  rows[0][0] = { v: title, s: 12 };
  const right = [[{ v: `${m.project.code} · ${m.project.name}`.toUpperCase(), s: 13 }], [{ v: 'Cliente:', s: 15 }], [{ v: m.project.client || '—', s: 14 }],
    [{ v: 'Endereço:', s: 15 }], [{ v: m.project.address || '—', s: 14 }], [{ v: 'Data do documento:', s: 15 }], [{ v: fmtD(m.today), s: 14 }]];
  right.forEach(([c], i) => { rows[i + 1][R] = c; if (c.s === 13) for (let k = R + 1; k < nCols; k++) rows[i + 1][k] = { v: null, s: 13 }; });
  const merges = [`A1:${colL(R - 1)}9`, ...right.map((_, i) => `${colL(R)}${i + 2}:${colL(nCols - 1)}${i + 2}`)];
  return { rows, merges, heights: { 1: 20 } };
}
// Propostas anexas num .zip, com o nome padrão Projeto-Disciplina-Fornecedor-ID (o mesmo da linha NOME DO ARQUIVO do mapa)
const safeName = s => String(s || '').replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim();
export function proposalsZip(ctx, projectId) {
  const m = mapData(ctx, projectId);
  const entries = [];
  for (const a of m.annexes) {
    const f = one('SELECT stored_name, mime FROM quote_files WHERE id = ?', a.file_id);
    const data = f && readStored(f.stored_name);
    if (!data) continue;
    entries.push({ name: a.name, data });
  }
  if (!entries.length) throw notFound('Nenhuma proposta anexada no mapa de cotações deste projeto.');
  return { buffer: zip(entries), filename: `propostas-${safeName(m.project.code)}.zip` };
}

export function exportXlsx(ctx, projectId) {
  const m = mapData(ctx, projectId);
  const used = new Set(['RESUMO']);
  const S = m.summary;
  const pf = (n, t) => (t ? Math.round((n / t) * 1000) / 1000 : null);
  // Resumo no mesmo visual
  const rh = docHead(m, 'MAPA DE COTAÇÕES — RESUMO', 8);
  const resumo = { name: 'Resumo', widths: [30, 10, 13, 13, 13, 13, 16, 16], gridlines: false, landscape: true, merges: rh.merges, heights: rh.heights,
    rows: [...rh.rows,
      ['DISCIPLINA', 'ITENS', '3 OU MAIS', '2 PROPOSTAS', '1 PROPOSTA', 'NENHUMA', 'SEM SOLICITAÇÃO', '% COM 3 OU MAIS'].map(v => ({ v, s: 16 })),
      ...m.disciplines.map(x => [{ v: x.name, s: 24 }, ...[x.items.length, x.summary.buckets.tres, x.summary.buckets.dois, x.summary.buckets.um, x.summary.buckets.nenhuma, x.summary.no_request].map(v => ({ v, s: 22 })), { v: pf(x.summary.buckets.tres, x.items.length), s: 25 }]),
      ['TOTAL', S.items, S.buckets.tres, S.buckets.dois, S.buckets.um, S.buckets.nenhuma, S.no_request].map(v => ({ v, s: 23 })).concat({ v: pf(S.buckets.tres, S.items), s: 26 }),
      [], [{ v: `Meta: ${m.target} propostas por item · solicitações: ${S.requests.total} enviadas, ${S.requests.recebida} recebidas, ${S.requests.enviada} aguardando (${S.requests.vencida} com prazo vencido), ${S.requests.declinou} declinaram`, s: 14 }]] };
  const sheets = [resumo];
  for (const x of m.disciplines) {
    const n = x.cols;
    const nCols = 8 + n + 2; // A–H, empresas, OBSERVAÇÃO, CURVA
    const h = docHead(m, 'PLANILHA COTAÇÃO', nCols);
    const merges = [...h.merges];
    const rows = [...h.rows, ['CÓD ORÇ', 'CATEGORIA', 'LOCAL', 'DESCRIÇÃO', 'QTDE.', 'UND', 'DADOS', 'VALOR MEDIANO', ...Array.from({ length: n }, (_, k) => `EMPRESA ${String(k + 1).padStart(2, '0')}`), 'OBSERVAÇÃO', 'CURVA'].map(v => ({ v, s: 16 }))];
    const firstCo = colL(8), lastCo = colL(7 + n);
    const MERGED = [0, 1, 2, 3, 4, 5, 7, 8 + n, 9 + n];
    for (const it of x.items) {
      const r0 = rows.length + 1, r1 = r0 + ROWS.length;
      for (const c of MERGED) merges.push(`${colL(c)}${r0}:${colL(c)}${r1}`);
      const off = k => it.offers[k];
      const range = `${firstCo}${r0}:${lastCo}${r0}`;
      rows.push([{ v: it.code, s: 17 }, { v: x.name.toUpperCase(), s: 17 }, { v: it.location, s: 17 }, { v: it.description, s: 17 }, { v: it.qty, s: 17 }, { v: it.unit, s: 17 },
        { v: 'PREÇO', s: 19 }, { f: `IF(COUNT(${range})=0,"",MEDIAN(${range}))`, v: it.median ?? undefined, s: 21 },
        ...Array.from({ length: n }, (_, k) => ({ v: off(k)?.price ?? null, s: 20 })), { v: it.notes, s: 17 }, { v: it.abc, s: 17 }]);
      for (const [label, key] of ROWS) {
        const r = Array(nCols).fill(null);
        for (const c of MERGED) r[c] = { v: null, s: 22 };
        r[6] = { v: label, s: 18 };
        for (let k = 0; k < n; k++) r[8 + k] = { v: off(k)?.[key] || null, s: 22 };
        rows.push(r);
      }
    }
    sheets.push({ name: sheetName(x.name, used), widths: [12, 14, 14, 60, 8, 7, 20, 16, ...Array(n).fill(24), 22, 8], gridlines: false, freezeRows: 10, printTitleRows: 10, landscape: true,
      heights: h.heights, rows, merges });
  }
  return { buffer: writeXlsx(sheets), filename: `Mapa de cotações - ${m.project.code}.xlsx` };
}
