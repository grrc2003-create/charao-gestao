// Vendas e Prospecção: funil em Kanban com colunas personalizadas. O tipo de etapa de cada coluna define o que é
// exigido ao entrar nela (prospecção → apresentação → proposta → negociação → contrato fechado / perdido).
// Acesso pela seção "vendas". O contrato é criado na área de Contratos (liberação própria), aproveitando os dados.
import { all, one, run, tx } from '../db.js';
import { badRequest, forbidden, notFound, str, oneOf, intOrNull } from '../lib/http.js';
import { hasSection, isAdmin } from '../lib/permissions.js';
import { audit } from './audit.js';
import { COMPANIES } from '../lib/companies.js';
import { listSalesList, validSalesListId, addSalesListItem, SALES_LISTS } from './settings.js';
import { saveImageFromDataUrl, deleteStored, cleanFileName } from './files.js';

export const KINDS = {
  prospeccao: 'Prospecção', apresentacao: 'Apresentação', proposta: 'Proposta', negociacao: 'Negociação',
  ganho: 'Contrato fechado', perdido: 'Contrato perdido', livre: 'Livre (sem exigência extra)',
};
export const FIELD_LABEL = {
  client: 'Cliente', address: 'Endereço', source_id: 'Origem (de onde veio)', company: 'Empresa',
  client_doc: 'CNPJ/CPF', contact_name: 'Contato', phone: 'Telefone', email: 'E-mail', city: 'Cidade', source_detail: 'Detalhe da origem',
  title: 'Oportunidade (serviço)', possible_scope: 'Escopo possível', owner_id: 'Responsável', notes: 'Observações',
  final_scope: 'Escopo final', proposal_value: 'Valor da proposta', proposal_file: 'Proposta anexada',
  profile_id: 'Avaliação do cliente para fechamento', negotiation_notes: 'Observações da negociação', lost_reason_id: 'Motivo da perda',
};
// ---------- Exigências por coluna (editáveis) ----------
// Sempre: cliente, endereço, origem e empresa. Cada coluna tem o que exige para ENTRAR (padrão do tipo de etapa)
// e o que exige para SAIR e seguir adiante. Ir para a frente (inclusive pulando colunas) pede o que as colunas
// deixadas para trás exigem para sair; voltar não pede nada além do que a coluna de destino exige para entrar.
export const BASE_FIELDS = ['client', 'address', 'source_id', 'company'];
export const RULE_FIELDS = ['client_doc', 'contact_name', 'phone', 'email', 'city', 'source_detail', 'title', 'owner_id', 'possible_scope',
  'final_scope', 'proposal_value', 'proposal_file', 'profile_id', 'negotiation_notes', 'notes'];
export const KIND_ENTRY = { proposta: ['final_scope', 'proposal_value'], negociacao: ['final_scope', 'proposal_value', 'profile_id'], ganho: ['final_scope', 'proposal_value'] };
const parseRule = s => { try { const a = JSON.parse(s); return Array.isArray(a) ? RULE_FIELDS.filter(k => a.includes(k)) : []; } catch { return []; } };
export const stageRules = s => ({
  entry: s.entry_fields !== null && s.entry_fields !== undefined ? parseRule(s.entry_fields) : [...(KIND_ENTRY[s.kind] || [])],
  exit: s.exit_fields !== null && s.exit_fields !== undefined ? parseRule(s.exit_fields) : [],
});
const closingKind = k => k === 'ganho' || k === 'perdido';
// Exigências para a oportunidade ficar/entrar na coluna "to", vindo de "from" (null = cadastro direto na coluna)
export function requiredFor(to, from, stages = listStages()) {
  const req = new Set(BASE_FIELDS);
  if (to.kind === 'perdido') req.add('lost_reason_id');
  stageRules(to).entry.forEach(k => req.add(k));
  if (to.kind === 'perdido') return req;
  const pos = new Map(stages.map((s, i) => [s.id, i]));
  const ti = pos.get(to.id) ?? stages.length;
  const fi = from ? pos.get(from.id) ?? -1 : -1;
  // Para a frente: o que exigem para sair a coluna de origem e as que ficam no caminho (no cadastro direto, todas antes da coluna)
  if (!from || ti > fi) for (const s of stages) { const i = pos.get(s.id); if (i >= Math.max(fi, 0) && i < ti && !closingKind(s.kind)) stageRules(s).exit.forEach(k => req.add(k)); }
  return req;
}
const hasProposalFile = id => !!(id && one('SELECT 1 FROM sales_proposals WHERE opportunity_id = ? AND stored_name IS NOT NULL LIMIT 1', id));
export function missingOf(o, req) {
  const miss = [];
  for (const k of req) {
    if (k === 'proposal_file') { if (!hasProposalFile(o.id)) miss.push(k); continue; }
    const v = o[k];
    if (k === 'proposal_value' ? !(Number(v) > 0) : (v === null || v === undefined || !String(v).trim())) miss.push(k);
  }
  return miss;
}

export const canSales = user => hasSection(user, 'vendas');
export function requireSales(user) {
  if (!canSales(user)) throw forbidden('A seção Vendas e Prospecção não está liberada para o seu usuário.');
}

const r2 = v => Math.round((Number(v) || 0) * 100) / 100;
const num = (v, label, { min = 0, max = 1e12 } = {}) => {
  if (v === '' || v === null || v === undefined) return null;
  const s = typeof v === 'number' ? v : String(v).trim();
  // "10.000" = dez mil (ponto como milhar); "10,5" e "1.234,56" no formato brasileiro
  const n = typeof s === 'number' ? s : Number(s.includes(',') || /^-?\d{1,3}(\.\d{3})+$/.test(s) ? s.replace(/\./g, '').replace(',', '.') : s);
  if (!Number.isFinite(n) || n < min || n > max) throw badRequest(`${label}: valor inválido.`);
  return n;
};
export const finalValue = o => (o.proposal_value ? r2(o.proposal_value * (1 - (o.discount_pct || 0) / 100)) : 0);

// ---------- Colunas ----------
export const listStages = () => all(`SELECT s.*, (SELECT COUNT(*) FROM sales_opportunities o WHERE o.stage_id = s.id) AS use_count
  FROM sales_stages s ORDER BY s.sort_order, s.id`);

export function saveStages(ctx, input, ip) {
  requireSales(ctx.user);
  if (!Array.isArray(input) || !input.length) throw badRequest('Cadastre ao menos uma coluna.');
  const current = listStages();
  const byId = new Map(current.map(s => [s.id, s]));
  const items = input.slice(0, 20).map((x, i) => ({
    id: intOrNull(x?.id),
    name: String(x?.name ?? '').replace(/\s+/g, ' ').trim(),
    kind: oneOf(x?.kind, Object.keys(KINDS), 'Tipo de etapa', 'livre'),
    order: i + 1,
    entry: Array.isArray(x?.entry_fields) ? RULE_FIELDS.filter(k => x.entry_fields.includes(k)) : undefined,
    exit: Array.isArray(x?.exit_fields) ? RULE_FIELDS.filter(k => x.exit_fields.includes(k)) : undefined,
  }));
  const seen = new Set();
  for (const x of items) {
    if (!x.name) throw badRequest('Informe o nome de todas as colunas.');
    if (x.name.length > 40) throw badRequest(`Coluna "${x.name.slice(0, 20)}…" excede 40 caracteres.`);
    const k = x.name.toLocaleLowerCase('pt-BR');
    if (seen.has(k)) throw badRequest(`Coluna repetida: ${x.name}.`);
    seen.add(k);
    if (x.id && !byId.has(x.id)) throw badRequest('Coluna inválida.');
  }
  if (!items.some(x => !['ganho', 'perdido'].includes(x.kind))) throw badRequest('Mantenha ao menos uma coluna de trabalho (antes do fechamento).');
  const keep = new Set(items.filter(x => x.id).map(x => x.id));
  const removed = current.filter(s => !keep.has(s.id));
  for (const s of removed) if (s.use_count) throw badRequest(`A coluna "${s.name}" tem ${s.use_count} oportunidade(s). Mova-as antes de excluir a coluna.`);
  // Exigências: lista enviada; sem lista, mantém (ou volta ao padrão do tipo, se o tipo mudou)
  for (const x of items) {
    const old = x.id ? byId.get(x.id) : null;
    x.entry_json = x.entry !== undefined ? JSON.stringify(x.entry) : old && old.kind === x.kind ? old.entry_fields : null;
    x.exit_json = x.exit !== undefined ? JSON.stringify(x.exit) : old ? old.exit_fields : null;
  }
  // Mudar o tipo ou o que a coluna exige para entrar, com oportunidades nela: só se todas atenderem
  for (const x of items.filter(x => x.id)) {
    const old = byId.get(x.id);
    const before = JSON.stringify([...requiredFor(old, old, [old])]);
    const next = { ...old, kind: x.kind, entry_fields: x.entry_json };
    if (old.use_count && before !== JSON.stringify([...requiredFor(next, next, [next])])) {
      for (const o of all('SELECT * FROM sales_opportunities WHERE stage_id = ?', x.id)) {
        const miss = missingOf(o, requiredFor(next, next, [next]));
        if (miss.length) throw badRequest(`A coluna "${old.name}" não pode passar a exigir isso agora: a oportunidade ${o.code} não tem ${miss.map(k => FIELD_LABEL[k]).join(', ')}. Complete-a ou mova-a antes.`);
      }
    }
  }
  const log = { criadas: [], renomeadas: [], tipo: [], exigencias: [], excluidas: removed.map(s => s.name) };
  tx(() => {
    for (const s of removed) run('DELETE FROM sales_stages WHERE id = ?', s.id);
    for (const x of items) {
      if (x.id) {
        const old = byId.get(x.id);
        if (old.name !== x.name) log.renomeadas.push(`${old.name} → ${x.name}`);
        if (old.kind !== x.kind) log.tipo.push(`${x.name}: ${KINDS[old.kind]} → ${KINDS[x.kind]}`);
        const r0 = stageRules(old), r1 = stageRules({ kind: x.kind, entry_fields: x.entry_json, exit_fields: x.exit_json });
        if (JSON.stringify(r0) !== JSON.stringify(r1)) log.exigencias.push(`${x.name}: entrar [${r1.entry.map(k => FIELD_LABEL[k]).join(', ') || '—'}] · sair [${r1.exit.map(k => FIELD_LABEL[k]).join(', ') || '—'}]`);
        run(`UPDATE sales_stages SET name = ?, kind = ?, sort_order = ?, entry_fields = ?, exit_fields = ?, updated_at = datetime('now') WHERE id = ?`, x.name, x.kind, x.order, x.entry_json, x.exit_json, x.id);
      } else {
        run('INSERT INTO sales_stages (name, kind, sort_order, entry_fields, exit_fields) VALUES (?,?,?,?,?)', x.name, x.kind, x.order, x.entry_json, x.exit_json);
        log.criadas.push(x.name);
      }
    }
    audit(ctx.user.id, 'sales', null, 'Colunas do funil de vendas atualizadas', log, ip);
  });
  return listStages();
}

// ---------- Exigências por etapa ----------
const proposalsOf = id => all('SELECT * FROM sales_proposals WHERE opportunity_id = ? ORDER BY rev, id', id);
// O que falta para a oportunidade ficar na coluna em que está (e, à parte, para sair dela e seguir)
const stageOf = id => one('SELECT * FROM sales_stages WHERE id = ?', id);
export const missingHere = o => { const s = stageOf(o.stage_id); return s ? missingOf(o, requiredFor(s, s)) : []; };
export const missingToAdvance = o => { const s = stageOf(o.stage_id); return s && !closingKind(s.kind) ? missingOf(o, stageRules(s).exit) : []; };

// ---------- Leitura ----------
const OPP_SELECT = `SELECT o.*, s.name AS stage_name, s.kind AS stage_kind, src.name AS source_name, lr.name AS lost_reason_name,
    pf.name AS profile_name, u.name AS owner_name, c.code AS contract_code,
    (SELECT COUNT(*) FROM sales_proposals p WHERE p.opportunity_id = o.id) AS proposals_count,
    (SELECT COUNT(*) FROM sales_proposals p WHERE p.opportunity_id = o.id AND p.stored_name IS NOT NULL) AS files_count,
    (SELECT COUNT(*) FROM sales_notes n WHERE n.opportunity_id = o.id) AS notes_count
  FROM sales_opportunities o JOIN sales_stages s ON s.id = o.stage_id
  LEFT JOIN sales_sources src ON src.id = o.source_id LEFT JOIN sales_loss_reasons lr ON lr.id = o.lost_reason_id
  LEFT JOIN sales_profiles pf ON pf.id = o.profile_id LEFT JOIN users u ON u.id = o.owner_id LEFT JOIN contracts c ON c.id = o.contract_id`;
const decorate = o => o && ({ ...o, final_value: finalValue(o), company_name: COMPANIES[o.company]?.name || o.company });
const lists = () => Object.fromEntries(SALES_LISTS.map(k => [k, listSalesList(k, { includeInactive: true })]));

export function board(ctx) {
  requireSales(ctx.user);
  const stages = listStages();
  const opps = all(`${OPP_SELECT} ORDER BY s.sort_order, o.sort_order, o.id`).map(decorate);
  return {
    stages: stages.map(s => ({ ...s, kind_label: KINDS[s.kind], rules: stageRules(s) })),
    rule_fields: RULE_FIELDS, base_fields: BASE_FIELDS, kind_entry: KIND_ENTRY, field_labels: FIELD_LABEL,
    opportunities: opps,
    kinds: KINDS,
    lists: lists(),
    users: all(`SELECT id, name FROM users WHERE active = 1 ORDER BY name`),
    can_contracts: !!ctx.user.can_contracts,
  };
}

export function getOpportunity(ctx, id) {
  requireSales(ctx.user);
  const o = decorate(one(`${OPP_SELECT} WHERE o.id = ?`, id));
  if (!o) throw notFound('Oportunidade não encontrada.');
  return {
    ...o,
    proposals: proposalsOf(id).map(p => ({ id: p.id, rev: p.rev, value: p.value, discount_pct: p.discount_pct, final_value: finalValue({ proposal_value: p.value, discount_pct: p.discount_pct }),
      notes: p.notes, has_file: !!p.stored_name, mime: p.mime, original_name: p.original_name, size: p.size, created_at: p.created_at,
      created_by_name: one('SELECT name FROM users WHERE id = ?', p.created_by)?.name || null })),
    moves: all(`SELECT m.from_stage, m.to_stage, m.created_at, u.name AS user_name FROM sales_moves m LEFT JOIN users u ON u.id = m.user_id
      WHERE m.opportunity_id = ? ORDER BY m.id DESC`, id),
    missing_here: missingHere(o),
    missing_next: missingToAdvance(o),
    notes: notesOf(ctx, id),
    stages: listStages().map(s => ({ id: s.id, name: s.name, kind: s.kind, sort_order: s.sort_order, rules: stageRules(s) })),
    lists: lists(),
    users: all(`SELECT id, name FROM users WHERE active = 1 ORDER BY name`),
    can_contracts: !!ctx.user.can_contracts,
    kinds: KINDS,
  };
}

// ---------- Gravação ----------
const FIELDS = ['company', 'client', 'client_doc', 'contact_name', 'phone', 'email', 'address', 'city', 'source_id', 'source_detail', 'title',
  'possible_scope', 'final_scope', 'proposal_value', 'discount_pct', 'profile_id', 'negotiation_notes', 'lost_reason_id', 'lost_notes', 'owner_id', 'notes'];
function readFields(body, cur = {}) {
  const has = k => body[k] !== undefined;
  const d = {};
  if (has('company')) d.company = oneOf(body.company, Object.keys(COMPANIES), 'Empresa', null);
  if (has('client')) d.client = str(body.client, { max: 160, label: 'Cliente' });
  if (has('client_doc')) d.client_doc = str(body.client_doc, { max: 30, label: 'CNPJ/CPF' });
  if (has('contact_name')) d.contact_name = str(body.contact_name, { max: 120, label: 'Contato' });
  if (has('phone')) d.phone = str(body.phone, { max: 40, label: 'Telefone' });
  if (has('email')) d.email = str(body.email, { max: 160, label: 'E-mail' });
  if (has('address')) d.address = str(body.address, { max: 300, label: 'Endereço' });
  if (has('city')) d.city = str(body.city, { max: 120, label: 'Cidade' });
  if (has('source_id')) d.source_id = validSalesListId('source', body.source_id, cur.source_id ?? null);
  if (has('source_detail')) d.source_detail = str(body.source_detail, { max: 200, label: 'Detalhe da origem' });
  if (has('title')) d.title = str(body.title, { max: 200, label: 'Oportunidade' });
  if (has('possible_scope')) d.possible_scope = str(body.possible_scope, { max: 4000, label: 'Escopo possível' });
  if (has('final_scope')) d.final_scope = str(body.final_scope, { max: 4000, label: 'Escopo final' });
  if (has('proposal_value')) { const v = num(body.proposal_value, 'Valor da proposta'); d.proposal_value = v === null ? null : r2(v); }
  if (has('discount_pct')) { const v = num(body.discount_pct, 'Desconto (%)', { max: 100 }); d.discount_pct = v === null ? null : Math.round(v * 100) / 100; }
  if (has('profile_id')) d.profile_id = validSalesListId('profile', body.profile_id, cur.profile_id ?? null);
  if (has('negotiation_notes')) d.negotiation_notes = str(body.negotiation_notes, { max: 3000, label: 'Observações da negociação' });
  if (has('lost_reason_id')) d.lost_reason_id = validSalesListId('loss', body.lost_reason_id, cur.lost_reason_id ?? null);
  if (has('lost_notes')) d.lost_notes = str(body.lost_notes, { max: 3000, label: 'Observação da perda' });
  if (has('owner_id')) {
    d.owner_id = intOrNull(body.owner_id);
    if (d.owner_id && !one('SELECT 1 FROM users WHERE id = ?', d.owner_id)) throw badRequest('Responsável inválido.');
  }
  if (has('notes')) d.notes = str(body.notes, { max: 3000, label: 'Observações' });
  return d;
}
const missingError = (miss, stageName, fromName = null) => badRequest(`${fromName ? `Para sair de "${fromName}" e ir para "${stageName}"` : `Para ficar em "${stageName}"`}, preencha: ${miss.map(k => FIELD_LABEL[k]).join(', ')}.`, { missing: miss });

// Propostas novas enviadas junto (anexo da proposta ou revisão)
function addProposals(ctx, oppId, list, o) {
  for (const p of (Array.isArray(list) ? list : []).slice(0, 5)) {
    const value = num(p?.value, 'Valor da revisão');
    const disc = num(p?.discount_pct, 'Desconto da revisão (%)', { max: 100 });
    const f = p?.file ? saveImageFromDataUrl(p.file) : null;
    if (!f && value === null) throw badRequest('Informe o valor ou anexe o arquivo da proposta.');
    const rev = (one('SELECT MAX(rev) AS n FROM sales_proposals WHERE opportunity_id = ?', oppId)?.n ?? -1) + 1;
    run(`INSERT INTO sales_proposals (opportunity_id, rev, value, discount_pct, notes, stored_name, mime, original_name, size, created_by) VALUES (?,?,?,?,?,?,?,?,?,?)`,
      oppId, rev, value === null ? (o.proposal_value ?? null) : r2(value), disc === null ? (o.discount_pct ?? null) : disc,
      str(p?.notes, { max: 1000, label: 'Observação da revisão' }), f?.stored_name || null, f?.mime || null, f ? cleanFileName(p.name) : null, f?.size || null, ctx.user.id);
    // A revisão mais recente passa a ser o valor/desconto vigente da oportunidade
    const sets = {};
    if (value !== null) sets.proposal_value = r2(value);
    if (disc !== null) sets.discount_pct = disc;
    if (Object.keys(sets).length) {
      run(`UPDATE sales_opportunities SET ${Object.keys(sets).map(k => `${k} = ?`).join(', ')} WHERE id = ?`, ...Object.values(sets), oppId);
      Object.assign(o, sets);
    }
  }
}

export function createOpportunity(ctx, body, ip) {
  requireSales(ctx.user);
  const stages = listStages();
  const stage = body.stage_id ? stages.find(s => s.id === intOrNull(body.stage_id)) : stages.find(s => !['ganho', 'perdido'].includes(s.kind));
  if (!stage) throw badRequest('Coluna inválida.');
  const d = readFields({ company: 'charao', ...body });
  if (!d.client) throw badRequest('Informe o cliente.');
  return tx(() => {
    const n = one(`SELECT MAX(CAST(SUBSTR(code, 4) AS INTEGER)) AS n FROM sales_opportunities WHERE code LIKE 'OP-%'`)?.n || 0;
    const code = `OP-${String(n + 1).padStart(3, '0')}`;
    const order = (one('SELECT MAX(sort_order) AS n FROM sales_opportunities WHERE stage_id = ?', stage.id)?.n || 0) + 1;
    const cols = ['code', 'stage_id', 'sort_order', 'created_by', ...Object.keys(d)];
    if (d.owner_id === undefined) { cols.push('owner_id'); d.owner_id = ctx.user.id; }
    const vals = [code, stage.id, order, ctx.user.id, ...cols.slice(4).map(k => d[k])];
    const id = Number(run(`INSERT INTO sales_opportunities (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, ...vals).lastInsertRowid);
    const o = one('SELECT * FROM sales_opportunities WHERE id = ?', id);
    addProposals(ctx, id, body.proposals, o);
    const miss = missingOf(one('SELECT * FROM sales_opportunities WHERE id = ?', id), requiredFor(stage, null));
    if (miss.length) throw missingError(miss, stage.name);
    if (stage.kind === 'perdido' || stage.kind === 'ganho') run(`UPDATE sales_opportunities SET closed_at = datetime('now') WHERE id = ?`, id);
    run('INSERT INTO sales_moves (opportunity_id, from_stage, to_stage, user_id) VALUES (?,?,?,?)', id, null, stage.name, ctx.user.id);
    insertNote(ctx, id, stage, body.stage_note);
    audit(ctx.user.id, 'sales', id, 'Oportunidade cadastrada', { codigo: code, cliente: d.client, coluna: stage.name }, ip);
    return id;
  });
}

// Salva campos e, se informado, move para outra coluna (posição opcional). As exigências da coluna final são conferidas no fim.
export function updateOpportunity(ctx, id, body, ip) {
  requireSales(ctx.user);
  const cur = one('SELECT o.*, s.kind AS stage_kind, s.name AS stage_name FROM sales_opportunities o JOIN sales_stages s ON s.id = o.stage_id WHERE o.id = ?', id);
  if (!cur) throw notFound('Oportunidade não encontrada.');
  const d = readFields(body, cur);
  if (d.client !== undefined && !d.client) throw badRequest('Informe o cliente.');
  if (d.company === null) delete d.company;
  const target = body.stage_id !== undefined ? one('SELECT * FROM sales_stages WHERE id = ?', intOrNull(body.stage_id)) : null;
  if (body.stage_id !== undefined && !target) throw badRequest('Coluna inválida.');
  const curStage = stageOf(cur.stage_id);
  const stage = target || curStage;
  const moving = stage.id !== cur.stage_id;
  return tx(() => {
    const changed = Object.keys(d).filter(k => (d[k] ?? null) !== (cur[k] ?? null));
    if (changed.length) run(`UPDATE sales_opportunities SET ${changed.map(k => `${k} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`, ...changed.map(k => d[k]), id);
    const o = one('SELECT * FROM sales_opportunities WHERE id = ?', id);
    addProposals(ctx, id, body.proposals, o);
    const miss = missingOf(one('SELECT * FROM sales_opportunities WHERE id = ?', id), requiredFor(stage, curStage));
    if (miss.length) throw missingError(miss, stage.name, moving ? curStage.name : null);
    // Posição na coluna (arrastar): renumera a coluna de destino
    if (moving || body.position !== undefined) {
      const others = all('SELECT id FROM sales_opportunities WHERE stage_id = ? AND id <> ? ORDER BY sort_order, id', stage.id, id).map(r => r.id);
      // posição 0 = topo da coluna (não é identificador; aceita 0)
      const p = body.position === undefined || body.position === null || body.position === '' ? NaN : Number(body.position);
      const pos = Number.isFinite(p) ? Math.max(0, Math.min(others.length, Math.trunc(p))) : others.length;
      others.splice(pos, 0, id);
      others.forEach((oid, k) => run('UPDATE sales_opportunities SET sort_order = ? WHERE id = ?', k + 1, oid));
    }
    insertNote(ctx, id, stage, body.stage_note);
    if (moving) {
      const closed = ['ganho', 'perdido'].includes(stage.kind);
      run(`UPDATE sales_opportunities SET stage_id = ?, stage_since = datetime('now'), closed_at = ${closed ? "COALESCE(closed_at, datetime('now'))" : 'NULL'}, updated_at = datetime('now') WHERE id = ?`, stage.id, id);
      run('INSERT INTO sales_moves (opportunity_id, from_stage, to_stage, user_id) VALUES (?,?,?,?)', id, cur.stage_name, stage.name, ctx.user.id);
    }
    if (changed.length || moving || body.proposals?.length) {
      audit(ctx.user.id, 'sales', id, moving ? `Oportunidade movida para ${stage.name}` : 'Oportunidade atualizada',
        { codigo: cur.code, campos: changed, ...(moving ? { de: cur.stage_name, para: stage.name } : {}), ...(body.proposals?.length ? { propostas: body.proposals.length } : {}) }, ip);
    }
    return id;
  });
}

export function deleteOpportunity(ctx, id, ip) {
  requireSales(ctx.user);
  const o = one('SELECT * FROM sales_opportunities WHERE id = ?', id);
  if (!o) throw notFound('Oportunidade não encontrada.');
  if (o.contract_id) throw badRequest('Esta oportunidade já gerou um contrato e não pode ser excluída.');
  const files = all('SELECT stored_name FROM sales_proposals WHERE opportunity_id = ? AND stored_name IS NOT NULL', id);
  tx(() => {
    run('DELETE FROM sales_proposals WHERE opportunity_id = ?', id);
    run('DELETE FROM sales_moves WHERE opportunity_id = ?', id);
    run('DELETE FROM sales_notes WHERE opportunity_id = ?', id);
    run('DELETE FROM sales_opportunities WHERE id = ?', id);
    audit(ctx.user.id, 'sales', id, 'Oportunidade excluída', { codigo: o.code, cliente: o.client }, ip);
  });
  for (const f of files) deleteStored(f.stored_name);
}

export function deleteProposal(ctx, id, ip) {
  requireSales(ctx.user);
  const p = one('SELECT p.*, o.code, o.stage_id FROM sales_proposals p JOIN sales_opportunities o ON o.id = p.opportunity_id WHERE p.id = ?', id);
  if (!p) throw notFound('Proposta não encontrada.');
  tx(() => {
    run('DELETE FROM sales_proposals WHERE id = ?', id);
    const o = one('SELECT o.*, s.kind, s.name AS stage_name FROM sales_opportunities o JOIN sales_stages s ON s.id = o.stage_id WHERE o.id = ?', p.opportunity_id);
    const miss = missingHere(o).filter(k => k === 'proposal_file' || k === 'proposal_value');
    if (miss.length) throw badRequest(`Esta é a única proposta anexada e a coluna "${o.stage_name}" exige uma. Anexe outra antes de excluir.`);
    audit(ctx.user.id, 'sales', p.opportunity_id, 'Proposta excluída', { codigo: p.code, revisao: `R${String(p.rev).padStart(2, '0')}` }, ip);
  });
  if (p.stored_name) deleteStored(p.stored_name);
}

export function proposalFile(ctx, id) {
  requireSales(ctx.user);
  const p = one('SELECT stored_name, mime, original_name FROM sales_proposals WHERE id = ? AND stored_name IS NOT NULL', id);
  if (!p) throw notFound('Arquivo não encontrado.');
  return p;
}

export function addListItem(ctx, kind, name, ip) {
  requireSales(ctx.user);
  if (!SALES_LISTS.includes(kind)) throw notFound();
  const id = addSalesListItem(kind, ctx, name, ip);
  return { id, list: listSalesList(kind, { includeInactive: true }) };
}

// ---------- Contrato a partir da oportunidade ----------
export function contractDraft(ctx, id) {
  requireSales(ctx.user);
  const o = one('SELECT * FROM sales_opportunities WHERE id = ?', id);
  if (!o) throw notFound('Oportunidade não encontrada.');
  if (o.contract_id) throw badRequest('Esta oportunidade já gerou um contrato.');
  const value = finalValue(o);
  const scope = o.final_scope || o.possible_scope || '';
  return {
    opportunity_id: o.id, opportunity_code: o.code,
    company: o.company, client: o.client, client_doc: o.client_doc || '',
    title: o.title || scope.split('\n')[0].slice(0, 200) || '',
    scope: scope.slice(0, 2000),
    notes: [`Origem: oportunidade ${o.code} (Vendas e Prospecção).`, o.contact_name ? `Contato: ${o.contact_name}${o.phone ? ` · ${o.phone}` : ''}${o.email ? ` · ${o.email}` : ''}` : '', o.address ? `Endereço: ${o.address}${o.city ? ` · ${o.city}` : ''}` : '']
      .filter(Boolean).join('\n'),
    items: value ? [{ description: (o.title || scope.split('\n')[0] || 'Serviço contratado').slice(0, 300), unit: 'vb', unit_price: value, quantity: 1 }] : [{}],
    status: 'vigente',
  };
}

// Chamado pelo cadastro do contrato: liga a oportunidade e a leva para a coluna de contrato fechado
export function checkOpportunityForContract(ctx, oppId) {
  if (!oppId) return null;
  requireSales(ctx.user);
  const o = one('SELECT * FROM sales_opportunities WHERE id = ?', oppId);
  if (!o) throw badRequest('Oportunidade inválida.');
  if (o.contract_id) throw badRequest(`A oportunidade ${o.code} já gerou um contrato.`);
  return o;
}
export function linkContract(ctx, o, contractId, contractCode) {
  const won = one(`SELECT id, name FROM sales_stages WHERE kind = 'ganho' ORDER BY sort_order LIMIT 1`);
  const cur = one('SELECT s.name, s.kind FROM sales_opportunities o JOIN sales_stages s ON s.id = o.stage_id WHERE o.id = ?', o.id);
  run(`UPDATE sales_opportunities SET contract_id = ?, updated_at = datetime('now') WHERE id = ?`, contractId, o.id);
  if (won && cur.kind !== 'ganho') {
    const order = (one('SELECT MAX(sort_order) AS n FROM sales_opportunities WHERE stage_id = ?', won.id)?.n || 0) + 1;
    run(`UPDATE sales_opportunities SET stage_id = ?, sort_order = ?, stage_since = datetime('now'), closed_at = COALESCE(closed_at, datetime('now')) WHERE id = ?`, won.id, order, o.id);
    run('INSERT INTO sales_moves (opportunity_id, from_stage, to_stage, user_id) VALUES (?,?,?,?)', o.id, cur.name, won.name, ctx.user.id);
  }
  audit(ctx.user.id, 'sales', o.id, 'Contrato criado a partir da oportunidade', { codigo: o.code, contrato: contractCode });
}

// ---------- Observações por etapa ----------
const canEditNote = (ctx, n) => n.created_by === ctx.user.id || isAdmin(ctx.user);
function notesOf(ctx, oppId) {
  return all(`SELECT n.*, u.name AS user_name, e.name AS editor_name FROM sales_notes n LEFT JOIN users u ON u.id = n.created_by
    LEFT JOIN users e ON e.id = n.updated_by WHERE n.opportunity_id = ? ORDER BY n.created_at, n.id`, oppId)
    .map(n => ({ id: n.id, stage_id: n.stage_id, stage_name: n.stage_name, body: n.body, user_name: n.user_name, created_at: n.created_at,
      updated_at: n.updated_at, editor_name: n.editor_name, can_edit: canEditNote(ctx, n) }));
}
function insertNote(ctx, oppId, stage, text) {
  const body = str(text, { max: 4000, label: 'Observação' });
  if (!body) return null;
  return Number(run('INSERT INTO sales_notes (opportunity_id, stage_id, stage_name, body, created_by) VALUES (?,?,?,?,?)', oppId, stage.id, stage.name, body, ctx.user.id).lastInsertRowid);
}
export function addNote(ctx, oppId, body, ip) {
  requireSales(ctx.user);
  const o = one('SELECT id, code, stage_id FROM sales_opportunities WHERE id = ?', oppId);
  if (!o) throw notFound('Oportunidade não encontrada.');
  const stage = one('SELECT id, name FROM sales_stages WHERE id = ?', intOrNull(body.stage_id) || o.stage_id);
  if (!stage) throw badRequest('Etapa inválida.');
  if (!str(body.body, { max: 4000, label: 'Observação' })) throw badRequest('Escreva a observação.');
  const id = insertNote(ctx, oppId, stage, body.body);
  audit(ctx.user.id, 'sales', oppId, 'Observação incluída', { codigo: o.code, etapa: stage.name }, ip);
  return notesOf(ctx, oppId).find(n => n.id === id);
}
export function updateNote(ctx, id, body, ip) {
  requireSales(ctx.user);
  const n = one('SELECT n.*, o.code FROM sales_notes n JOIN sales_opportunities o ON o.id = n.opportunity_id WHERE n.id = ?', id);
  if (!n) throw notFound('Observação não encontrada.');
  if (!canEditNote(ctx, n)) throw forbidden('Somente quem escreveu (ou o administrador) altera a observação.');
  const text = str(body.body, { max: 4000, label: 'Observação' });
  if (!text) throw badRequest('Escreva a observação.');
  if (text !== n.body) {
    run(`UPDATE sales_notes SET body = ?, updated_by = ?, updated_at = datetime('now') WHERE id = ?`, text, ctx.user.id, id);
    audit(ctx.user.id, 'sales', n.opportunity_id, 'Observação editada', { codigo: n.code, etapa: n.stage_name }, ip);
  }
  return notesOf(ctx, n.opportunity_id).find(x => x.id === id);
}
export function deleteNote(ctx, id, ip) {
  requireSales(ctx.user);
  const n = one('SELECT n.*, o.code FROM sales_notes n JOIN sales_opportunities o ON o.id = n.opportunity_id WHERE n.id = ?', id);
  if (!n) throw notFound('Observação não encontrada.');
  if (!canEditNote(ctx, n)) throw forbidden('Somente quem escreveu (ou o administrador) exclui a observação.');
  run('DELETE FROM sales_notes WHERE id = ?', id);
  audit(ctx.user.id, 'sales', n.opportunity_id, 'Observação excluída', { codigo: n.code, etapa: n.stage_name }, ip);
}
