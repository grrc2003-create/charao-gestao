// Lista Mestra de projetos: os projetos de cada obra (arquitetura, estrutural, complementares…) com as etapas do tipo,
// a etapa atual, as datas (base congelada, prevista e realizada) e o histórico de alterações com motivo.
// Alteram datas: administrador, gestor/coordenador com acesso à obra e o responsável (líder) da obra. A alteração vale na hora.
import { all, one, run, tx } from '../db.js';
import { badRequest, forbidden, notFound, str, date, intOrNull } from '../lib/http.js';
import { canAccessProject, isAdmin, isManagerRole, requireSettingsManager, canManageSettings } from '../lib/permissions.js';
import { audit } from './audit.js';
import { today } from './metrics.js';
import { writeXlsx } from '../lib/xlsx-write.js';

// Motivos de alteração (padrão de mercado: código do motivo + explicação)
export const REASONS = ['Cliente (solicitação ou decisão)', 'Aprovações e licenças', 'Projetista / fornecedor', 'Compatibilização entre disciplinas',
  'Escopo / aditivo', 'Informações ou insumos pendentes', 'Equipe / mão de obra', 'Financeiro', 'Planejamento interno', 'Outro'];

const days = (a, b) => Math.round((Date.parse(a) - Date.parse(b)) / 86400e3);
const fmtD = d => (d ? d.split('-').reverse().join('/') : '');
const SIT = { concluido: 'Concluído', atrasado: 'Atrasado', em_dia: 'Em dia', sem_datas: 'Sem datas' };
const STAGE_SIT = { concluida: 'Concluída', atrasada: 'Atrasada', prevista: 'Prevista', sem_data: 'Sem data' };

// ---------- Permissões ----------
function projectRow(ctx, projectId) {
  const p = one('SELECT id, code, name, client, lead_id, kind, has_master_list FROM projects WHERE id = ?', projectId);
  if (!p || !canAccessProject(ctx.user, p.id, ctx.projects)) throw notFound('Obra não encontrada.');
  return p;
}
const requireEnabled = p => {
  if (!p.has_master_list) throw badRequest('Este projeto não tem Lista Mestra. Para usar, marque "Este projeto terá Lista Mestra" no cadastro do projeto.');
}
export const canEditProject = (ctx, p) => !ctx.user.is_external
  && (isAdmin(ctx.user) || (isManagerRole(ctx.user) && canAccessProject(ctx.user, p.id, ctx.projects)) || p.lead_id === ctx.user.id);
const canRebase = ctx => isAdmin(ctx.user) || isManagerRole(ctx.user);
function requireEdit(ctx, p) {
  if (!canEditProject(ctx, p)) throw forbidden('Somente o responsável da obra e os gestores alteram a Lista Mestra.');
}

// ---------- Tipos de projeto e etapas ----------
// Formato padrão (Configurações): tipos sem obra. Cada obra com Lista Mestra tem a própria cópia, editável na obra.
export function listTypes({ includeInactive = false, projectId = null } = {}) {
  const types = all(`SELECT t.id, t.name, t.active, t.sort_order, (SELECT COUNT(*) FROM ml_items i WHERE i.type_id = t.id) AS use_count
    FROM ml_types t WHERE IFNULL(t.project_id, 0) = ? ${includeInactive ? '' : 'AND t.active = 1'} ORDER BY t.sort_order, t.id`, projectId || 0);
  const stages = all(`SELECT s.id, s.type_id, s.name, s.active, s.sort_order,
      (SELECT COUNT(*) FROM ml_item_stages x WHERE x.stage_id = s.id AND (x.planned_date IS NOT NULL OR x.done_date IS NOT NULL OR x.base_date IS NOT NULL))
        + (SELECT COUNT(*) FROM ml_changes c WHERE c.stage_id = s.id) AS use_count
    FROM ml_type_stages s ORDER BY s.sort_order, s.id`);
  return types.map(t => ({ ...t, stages: stages.filter(s => s.type_id === t.id && (includeInactive || s.active)) }));
}

// Obra com Lista Mestra e ainda sem tipos próprios: copia o formato padrão atual
export function ensureProjectTypes(projectId) {
  if (!projectId || one('SELECT 1 FROM ml_types WHERE project_id = ? LIMIT 1', projectId)) return;
  tx(() => {
    for (const t of all('SELECT * FROM ml_types WHERE project_id IS NULL ORDER BY sort_order, id')) {
      const nid = Number(run('INSERT INTO ml_types (project_id, src_id, name, active, sort_order) VALUES (?,?,?,?,?)', projectId, t.id, t.name, t.active, t.sort_order).lastInsertRowid);
      for (const s of all('SELECT * FROM ml_type_stages WHERE type_id = ? ORDER BY sort_order, id', t.id)) {
        run('INSERT INTO ml_type_stages (type_id, src_id, name, active, sort_order) VALUES (?,?,?,?,?)', nid, s.id, s.name, s.active, s.sort_order);
      }
    }
  });
}
// Tipos e etapas de uma obra (quem vê a Lista Mestra da obra)
export function projectTypes(ctx, projectId) {
  const p = projectRow(ctx, projectId);
  requireEnabled(p);
  ensureProjectTypes(p.id);
  return { project: { id: p.id, code: p.code, name: p.name }, can_edit: canEditProject(ctx, p), types: listTypes({ includeInactive: true, projectId: p.id }) };
}
export function saveProjectTypes(ctx, projectId, input, ip) {
  const p = projectRow(ctx, projectId);
  requireEnabled(p);
  requireEdit(ctx, p);
  ensureProjectTypes(p.id);
  return saveTypes(ctx, input, ip, p);
}

export function saveTypes(ctx, input, ip, proj = null) {
  if (!proj) requireSettingsManager(ctx.user);
  const projectId = proj?.id || null;
  if (!Array.isArray(input)) throw badRequest('Lista de tipos inválida.');
  const current = listTypes({ includeInactive: true, projectId });
  const byId = new Map(current.map(t => [t.id, t]));
  const clean = v => String(v ?? '').replace(/\s+/g, ' ').trim();
  const items = input.slice(0, 60).map((x, i) => ({
    id: intOrNull(x?.id), name: clean(x?.name), active: x?.active === false || x?.active === 0 ? 0 : 1, order: i + 1,
    stages: (Array.isArray(x?.stages) ? x.stages : []).slice(0, 40).map((s, k) => ({ id: intOrNull(s?.id), name: clean(s?.name), active: s?.active === false || s?.active === 0 ? 0 : 1, order: k + 1 })),
  }));
  const seen = new Set();
  for (const x of items) {
    if (!x.name) throw badRequest('Informe o nome de todos os tipos de projeto.');
    if (x.name.length > 80) throw badRequest(`Tipo "${x.name.slice(0, 30)}…" excede 80 caracteres.`);
    const k = x.name.toLocaleLowerCase('pt-BR');
    if (seen.has(k)) throw badRequest(`Tipo repetido: ${x.name}.`);
    seen.add(k);
    if (x.id && !byId.has(x.id)) throw badRequest('Tipo inválido.');
    if (!x.stages.length) throw badRequest(`Cadastre ao menos uma etapa em "${x.name}".`);
    const own = new Map((x.id ? byId.get(x.id).stages : []).map(s => [s.id, s]));
    const sn = new Set();
    for (const s of x.stages) {
      if (!s.name) throw badRequest(`Informe o nome de todas as etapas de "${x.name}".`);
      if (s.name.length > 80) throw badRequest(`Etapa "${s.name.slice(0, 30)}…" excede 80 caracteres.`);
      const sk = s.name.toLocaleLowerCase('pt-BR');
      if (sn.has(sk)) throw badRequest(`Etapa repetida em "${x.name}": ${s.name}.`);
      sn.add(sk);
      if (s.id && !own.has(s.id)) throw badRequest('Etapa inválida.');
    }
    if (!x.stages.some(s => s.active)) throw badRequest(`"${x.name}" precisa de ao menos uma etapa ativa.`);
    for (const s of own.values()) {
      if (!x.stages.some(n => n.id === s.id) && s.use_count) throw badRequest(`A etapa "${s.name}" de "${x.name}" já tem datas registradas. Inative-a em vez de excluir.`);
    }
  }
  const keep = new Set(items.filter(x => x.id).map(x => x.id));
  const removed = current.filter(t => !keep.has(t.id));
  for (const t of removed) if (t.use_count) throw badRequest(`"${t.name}" está em ${t.use_count} projeto(s) da Lista Mestra. Inative-o em vez de excluir.`);
  const log = { criados: [], alterados: [], excluidos: removed.map(t => t.name) };
  tx(() => {
    for (const t of removed) run('DELETE FROM ml_types WHERE id = ?', t.id);
    for (const x of items.filter(x => x.id)) run('UPDATE ml_types SET name = ? WHERE id = ?', `~tmp~${x.id}`, x.id);
    for (const x of items) {
      let tid = x.id;
      if (tid) {
        const old = byId.get(tid);
        run(`UPDATE ml_types SET name = ?, active = ?, sort_order = ?, updated_at = datetime('now') WHERE id = ?`, x.name, x.active, x.order, tid);
        const before = JSON.stringify([old.name, old.active, old.stages.map(s => [s.id, s.name, s.active])]);
        if (before !== JSON.stringify([x.name, x.active, x.stages.map(s => [s.id, s.name, s.active])])) log.alterados.push(x.name);
        for (const s of old.stages) if (!x.stages.some(n => n.id === s.id)) run('DELETE FROM ml_type_stages WHERE id = ?', s.id);
      } else {
        tid = Number(run('INSERT INTO ml_types (project_id, name, active, sort_order) VALUES (?, ?, ?, ?)', projectId, x.name, x.active, x.order).lastInsertRowid);
        log.criados.push(x.name);
      }
      for (const s of x.stages) {
        if (s.id) run('UPDATE ml_type_stages SET name = ?, active = ?, sort_order = ? WHERE id = ?', s.name, s.active, s.order, s.id);
        else run('INSERT INTO ml_type_stages (type_id, name, active, sort_order) VALUES (?, ?, ?, ?)', tid, s.name, s.active, s.order);
      }
    }
    if (proj) audit(ctx.user.id, 'project', proj.id, 'Lista Mestra: tipos de projeto e etapas da obra atualizados', log, ip);
    else audit(ctx.user.id, 'settings', null, 'Lista Mestra: formato padrão de tipos e etapas atualizado', log, ip);
  });
  return listTypes({ includeInactive: true, projectId });
}

// ---------- Leitura ----------
function stageStatus(s, t) {
  if (s.done_date) return 'concluida';
  if (!s.planned_date) return 'sem_data';
  return s.planned_date < t ? 'atrasada' : 'prevista';
}

// Monta os projetos (com etapas e situação) das obras acessíveis
function loadItems(ctx, { projectId = null, itemId = null } = {}) {
  const t = today();
  const where = [];
  const args = [];
  if (projectId) { where.push('i.project_id = ?'); args.push(projectId); }
  if (itemId) { where.push('i.id = ?'); args.push(itemId); }
  const rows = all(`SELECT i.*, p.code AS project_code, p.name AS project_name, p.lead_id AS project_lead_id, p.status AS project_status,
      ty.name AS type_name, ty.sort_order AS type_order
    FROM ml_items i JOIN projects p ON p.id = i.project_id JOIN ml_types ty ON ty.id = i.type_id
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY p.code, ty.sort_order, i.name COLLATE NOCASE, i.id`, ...args)
    .filter(r => canAccessProject(ctx.user, r.project_id, ctx.projects));
  if (!rows.length) return [];
  const ids = rows.map(r => r.id);
  const typeIds = [...new Set(rows.map(r => r.type_id))];
  const tStages = all(`SELECT id, type_id, name, active, sort_order FROM ml_type_stages WHERE type_id IN (${typeIds.map(() => '?').join(',')}) ORDER BY sort_order, id`, ...typeIds);
  const data = all(`SELECT * FROM ml_item_stages WHERE item_id IN (${ids.map(() => '?').join(',')})`, ...ids);
  const dataBy = new Map(data.map(d => [`${d.item_id}:${d.stage_id}`, d]));
  const chg = all(`SELECT item_id, COUNT(*) AS n, MAX(created_at) AS last_at FROM ml_changes
    WHERE kind IN ('previsto', 'base') AND old_date IS NOT NULL AND cascade = 0 AND item_id IN (${ids.map(() => '?').join(',')}) GROUP BY item_id`, ...ids);
  const chgBy = new Map(chg.map(c => [c.item_id, c]));
  const lastReason = new Map(all(`SELECT c.item_id, c.reason, c.explanation, c.created_at FROM ml_changes c
    WHERE c.id IN (SELECT MAX(id) FROM ml_changes WHERE reason IS NOT NULL AND cascade = 0 AND item_id IN (${ids.map(() => '?').join(',')}) GROUP BY item_id)`, ...ids).map(r => [r.item_id, r]));
  return rows.map(r => {
    const stages = tStages.filter(s => s.type_id === r.type_id).map(s => {
      const d = dataBy.get(`${r.id}:${s.id}`) || {};
      const x = { id: s.id, name: s.name, active: s.active, base_date: d.base_date || null, planned_date: d.planned_date || null, done_date: d.done_date || null };
      x.status = stageStatus(x, t);
      const ref = x.done_date || x.planned_date;
      x.shift = x.base_date && ref ? days(ref, x.base_date) : null;
      return x;
    }).filter(s => s.active || s.base_date || s.planned_date || s.done_date);
    const current = stages.find(s => !s.done_date) || null;
    const last = stages[stages.length - 1] || null;
    const late = stages.filter(s => s.status === 'atrasada').length;
    const status = !current ? (stages.length ? 'concluido' : 'sem_datas') : late ? 'atrasado' : !current.planned_date ? 'sem_datas' : 'em_dia';
    const c = chgBy.get(r.id);
    const lr = lastReason.get(r.id);
    return {
      id: r.id, project_id: r.project_id, project_code: r.project_code, project_name: r.project_name, project_status: r.project_status,
      type_id: r.type_id, type_name: r.type_name, name: r.name, designer: r.designer, revision: r.revision, notes: r.notes,
      title: r.name ? `${r.type_name} · ${r.name}` : r.type_name,
      stages, status, late,
      done_count: stages.filter(s => s.done_date).length,
      current: current ? { id: current.id, name: current.name, planned_date: current.planned_date, base_date: current.base_date, shift: current.shift, status: current.status } : null,
      next: current ? stages.slice(stages.indexOf(current) + 1).find(s => s.planned_date) || null : null,
      finish: last ? { name: last.name, base_date: last.base_date, date: last.done_date || last.planned_date, done: !!last.done_date, shift: last.shift } : null,
      changes: c?.n || 0, last_change: lr ? { reason: lr.reason, explanation: lr.explanation, at: lr.created_at } : null,
      can_edit: canEditProject(ctx, { id: r.project_id, lead_id: r.project_lead_id }),
    };
  });
}

function summarize(items, t) {
  const in30 = new Date(Date.parse(t) + 30 * 86400e3).toISOString().slice(0, 10);
  const s = { total: items.length, concluido: 0, atrasado: 0, em_dia: 0, sem_datas: 0, alterados: 0, next30: 0, by_stage: [], reasons: [] };
  const stageCount = new Map();
  for (const i of items) {
    s[i.status]++;
    if (i.changes) s.alterados++;
    s.next30 += i.stages.filter(x => !x.done_date && x.planned_date && x.planned_date >= t && x.planned_date <= in30).length;
    const k = i.current ? i.current.name : 'Concluído';
    stageCount.set(k, (stageCount.get(k) || 0) + 1);
  }
  s.by_stage = [...stageCount].map(([name, n]) => ({ name, n })).sort((a, b) => b.n - a.n);
  if (items.length) {
    const ids = items.map(i => i.id);
    s.reasons = all(`SELECT reason, COUNT(*) AS n FROM ml_changes WHERE reason IS NOT NULL AND cascade = 0 AND kind IN ('previsto', 'base') AND old_date IS NOT NULL
      AND item_id IN (${ids.map(() => '?').join(',')}) GROUP BY reason ORDER BY n DESC, reason`, ...ids);
  }
  return s;
}

export function list(ctx, { projectId = null, withHistory = false } = {}) {
  const t = today();
  let project = null;
  if (projectId) {
    project = projectRow(ctx, projectId);
    if (!project.has_master_list) return { enabled: false, today: t, items: [], summary: summarize([], t), types: [], projects: [], reasons: REASONS };
    ensureProjectTypes(project.id);
  }
  const items = loadItems(ctx, { projectId });
  const projects = all(`SELECT id, code, name, lead_id, status, kind FROM projects WHERE status <> 'cancelado' AND kind <> 'interno' AND has_master_list = 1 ORDER BY code`)
    .filter(p => canAccessProject(ctx.user, p.id, ctx.projects))
    .map(p => ({ id: p.id, code: p.code, name: p.name, status: p.status, kind: p.kind, can_edit: canEditProject(ctx, p) }));
  return {
    enabled: true, project: project ? { id: project.id, code: project.code, name: project.name, client: project.client, can_edit: canEditProject(ctx, project) } : null,
    today: t, reasons: REASONS, types: listTypes({ projectId: project?.id || null }), items, summary: summarize(items, t),
    projects, can_add: projects.some(p => p.can_edit), can_manage_types: project ? canEditProject(ctx, project) : canManageSettings(ctx.user), can_rebase: canRebase(ctx),
    ...(withHistory ? { history: items.length ? all(`SELECT c.id, c.item_id, c.kind, c.old_date, c.new_date, c.reason, c.explanation, c.cascade, c.created_at, u.name AS user_name, s.name AS stage_name
      FROM ml_changes c LEFT JOIN users u ON u.id = c.created_by LEFT JOIN ml_type_stages s ON s.id = c.stage_id
      WHERE c.reason IS NOT NULL AND c.item_id IN (${items.map(() => '?').join(',')}) ORDER BY c.id DESC LIMIT 500`, ...items.map(i => i.id)) : [] } : {}),
  };
}

export function history(ctx, id) {
  const it = loadItems(ctx, { itemId: id })[0];
  if (!it) throw notFound('Projeto da Lista Mestra não encontrado.');
  const rows = all(`SELECT c.id, c.kind, c.old_date, c.new_date, c.reason, c.explanation, c.cascade, c.created_at, u.name AS user_name, s.name AS stage_name
    FROM ml_changes c LEFT JOIN users u ON u.id = c.created_by LEFT JOIN ml_type_stages s ON s.id = c.stage_id
    WHERE c.item_id = ? ORDER BY c.id DESC`, id);
  return { item: it, changes: rows };
}

// ---------- Cadastro ----------
function readItem(b) {
  return {
    name: str(b.name, { max: 120, label: 'Complemento' }),
    designer: str(b.designer, { max: 160, label: 'Projetista' }),
    revision: str(b.revision, { max: 20, label: 'Revisão' }),
    notes: str(b.notes, { max: 1000, label: 'Observações' }),
  };
}
const validType = (v, current = null, projectId = null) => {
  const id = intOrNull(v);
  if (!id) throw badRequest('Escolha o tipo de projeto.');
  const t = one('SELECT id, active, name FROM ml_types WHERE id = ? AND IFNULL(project_id, 0) = ?', id, projectId || 0);
  if (!t || (!t.active && id !== current)) throw badRequest('Tipo de projeto inválido.');
  return t;
};
const hasDates = id => !!one('SELECT 1 FROM ml_item_stages WHERE item_id = ? AND (planned_date IS NOT NULL OR done_date IS NOT NULL OR base_date IS NOT NULL)', id);

export function saveItem(ctx, id, body, ip) {
  const b = body || {};
  const d = readItem(b);
  let item = null;
  let p;
  if (id) {
    item = one('SELECT * FROM ml_items WHERE id = ?', id);
    if (!item) throw notFound('Projeto da Lista Mestra não encontrado.');
    p = projectRow(ctx, item.project_id);
  } else {
    p = projectRow(ctx, intOrNull(b.project_id) || 0);
    if (p.kind === 'interno') throw badRequest('A Lista Mestra é para as obras (projetos), não para áreas internas.');
    requireEnabled(p);
  }
  requireEdit(ctx, p);
  ensureProjectTypes(p.id);
  let typeId = item?.type_id;
  if (!item || (b.type_id !== undefined && Number(b.type_id) !== item.type_id)) {
    if (item && hasDates(item.id)) throw badRequest('O tipo não pode ser trocado: este projeto já tem datas registradas.');
    typeId = validType(b.type_id, item?.type_id, p.id).id;
  }
  const dup = one(`SELECT id FROM ml_items WHERE project_id = ? AND type_id = ? AND IFNULL(name, '') = IFNULL(?, '') AND id <> ?`, p.id, typeId, d.name, id || 0);
  if (dup) throw badRequest('Esta obra já tem este projeto na Lista Mestra. Use o complemento (ex.: Bloco A) para diferenciar.');
  const typeName = one('SELECT name FROM ml_types WHERE id = ?', typeId).name;
  let iid = id;
  tx(() => {
    if (id) {
      run(`UPDATE ml_items SET type_id = ?, name = ?, designer = ?, revision = ?, notes = ?, updated_at = datetime('now') WHERE id = ?`, typeId, d.name, d.designer, d.revision, d.notes, id);
    } else {
      iid = Number(run('INSERT INTO ml_items (project_id, type_id, name, designer, revision, notes, created_by) VALUES (?,?,?,?,?,?,?)',
        p.id, typeId, d.name, d.designer, d.revision, d.notes, ctx.user.id).lastInsertRowid);
      run(`INSERT INTO ml_changes (item_id, kind, created_by) VALUES (?, 'cadastro', ?)`, iid, ctx.user.id);
    }
    audit(ctx.user.id, 'project', p.id, id ? 'Lista Mestra: projeto atualizado' : 'Lista Mestra: projeto incluído', { projeto: d.name ? `${typeName} · ${d.name}` : typeName, projetista: d.designer }, ip);
  });
  // Datas iniciais (no cadastro): viram a linha de base
  if (!id && Array.isArray(b.stages) && b.stages.some(s => s?.planned_date || s?.done_date)) updateStages(ctx, iid, { stages: b.stages }, ip);
  return loadItems(ctx, { itemId: iid })[0];
}

export function deleteItem(ctx, id, ip) {
  const item = one('SELECT i.*, t.name AS type_name FROM ml_items i JOIN ml_types t ON t.id = i.type_id WHERE i.id = ?', id);
  if (!item) throw notFound('Projeto da Lista Mestra não encontrado.');
  const p = projectRow(ctx, item.project_id);
  requireEdit(ctx, p);
  tx(() => {
    run('DELETE FROM ml_items WHERE id = ?', id);
    audit(ctx.user.id, 'project', p.id, 'Lista Mestra: projeto excluído', { projeto: item.name ? `${item.type_name} · ${item.name}` : item.type_name }, ip);
  });
  return { ok: true };
}

// ---------- Datas das etapas ----------
// body: { stages: [{ stage_id, planned_date, done_date, auto }], reason, explanation, rebaseline }
// Mudar uma data prevista que já existia exige motivo e explicação. A primeira data prevista vira a data base.
export function updateStages(ctx, id, body, ip) {
  const b = body || {};
  const item = one('SELECT i.*, t.name AS type_name FROM ml_items i JOIN ml_types t ON t.id = i.type_id WHERE i.id = ?', id);
  if (!item) throw notFound('Projeto da Lista Mestra não encontrado.');
  const p = projectRow(ctx, item.project_id);
  requireEdit(ctx, p);
  const t = today();
  const valid = new Map(all('SELECT id, name FROM ml_type_stages WHERE type_id = ?', item.type_id).map(s => [s.id, s]));
  const cur = new Map(all('SELECT * FROM ml_item_stages WHERE item_id = ?', id).map(s => [s.stage_id, s]));
  const rebaseline = !!b.rebaseline;
  if (rebaseline && !canRebase(ctx)) throw forbidden('Somente gestores e administradores redefinem a linha de base.');
  const input = Array.isArray(b.stages) ? b.stages.slice(0, 60) : [];
  const plan = [];
  let needReason = rebaseline;
  for (const s of input) {
    const sid = intOrNull(s?.stage_id);
    const st = valid.get(sid);
    if (!st) throw badRequest('Etapa inválida para este tipo de projeto.');
    const planned = date(s.planned_date || null, `Data prevista (${st.name})`);
    const done = date(s.done_date || null, `Data realizada (${st.name})`);
    if (done && done > t) throw badRequest(`Data realizada (${st.name}) não pode ser futura.`);
    const old = cur.get(sid) || {};
    const ch = [];
    if (planned !== (old.planned_date || null)) {
      ch.push({ kind: 'previsto', old: old.planned_date || null, new: planned, cascade: s.auto ? 1 : 0 });
      if (old.planned_date) needReason = true;
    }
    if (done !== (old.done_date || null)) ch.push({ kind: 'realizado', old: old.done_date || null, new: done, cascade: 0 });
    let base = old.base_date || null;
    if (rebaseline && planned && planned !== base) { ch.push({ kind: 'base', old: base, new: planned, cascade: 0 }); base = planned; }
    else if (!base && planned) base = planned;
    if (ch.length || base !== (old.base_date || null)) plan.push({ sid, st, planned, done, base, ch });
  }
  const reason = str(b.reason, { max: 80, label: 'Motivo' });
  const explanation = str(b.explanation, { max: 1000, label: 'Explicação' });
  if (needReason) {
    if (!reason) throw badRequest('Informe o motivo da alteração das datas previstas.');
    if (!REASONS.includes(reason)) throw badRequest('Motivo inválido.');
    if (!explanation) throw badRequest('Explique o porquê da alteração.');
  }
  if (!plan.length) return loadItems(ctx, { itemId: id })[0];
  tx(() => {
    for (const x of plan) {
      run(`INSERT INTO ml_item_stages (item_id, stage_id, base_date, planned_date, done_date, updated_at) VALUES (?,?,?,?,?, datetime('now'))
        ON CONFLICT (item_id, stage_id) DO UPDATE SET base_date = excluded.base_date, planned_date = excluded.planned_date, done_date = excluded.done_date, updated_at = excluded.updated_at`,
      id, x.sid, x.base, x.planned, x.done);
      for (const c of x.ch) {
        const withReason = (c.kind === 'previsto' && c.old) || c.kind === 'base';
        run('INSERT INTO ml_changes (item_id, stage_id, kind, old_date, new_date, reason, explanation, cascade, created_by) VALUES (?,?,?,?,?,?,?,?,?)',
          id, x.sid, c.kind, c.old, c.new, withReason ? reason : null, withReason ? explanation : null, c.cascade, ctx.user.id);
      }
    }
    run(`UPDATE ml_items SET updated_at = datetime('now') WHERE id = ?`, id);
    audit(ctx.user.id, 'project', p.id, rebaseline ? 'Lista Mestra: nova linha de base' : 'Lista Mestra: datas atualizadas', {
      projeto: item.name ? `${item.type_name} · ${item.name}` : item.type_name,
      alteracoes: plan.flatMap(x => x.ch.map(c => `${x.st.name} (${c.kind}): ${fmtD(c.old) || '—'} → ${fmtD(c.new) || '—'}`)),
      ...(needReason ? { motivo: reason, explicacao: explanation } : {}),
    }, ip);
  });
  return loadItems(ctx, { itemId: id })[0];
}

// ---------- Excel ----------
export function exportXlsx(ctx, { projectId = null } = {}) {
  const d = list(ctx, { projectId });
  const t = d.today;
  const proj = projectId ? d.projects.find(p => p.id === projectId) : null;
  const title = `LISTA MESTRA DE PROJETOS${proj ? ` — ${proj.code} · ${proj.name}` : ''} — ${fmtD(t)}`;
  const n = v => (v === null || v === undefined ? '' : v);
  const main = [[title], [],
    ['Obra', 'Projeto', 'Complemento', 'Projetista', 'Revisão', 'Etapa atual', 'Situação', 'Previsto (etapa atual)', 'Base (etapa atual)', 'Desvio (dias)', 'Término previsto', 'Término base', 'Desvio do término (dias)', 'Etapas concluídas', 'Alterações', 'Último motivo']];
  for (const i of d.items) {
    main.push([`${i.project_code} · ${i.project_name}`, i.type_name, i.name || '', i.designer || '', i.revision || '', i.current ? i.current.name : 'Concluído', SIT[i.status],
      fmtD(i.current?.planned_date), fmtD(i.current?.base_date), n(i.current?.shift), fmtD(i.finish?.date), fmtD(i.finish?.base_date), n(i.finish?.shift),
      `${i.done_count}/${i.stages.length}`, i.changes, i.last_change ? `${i.last_change.reason}: ${i.last_change.explanation || ''}` : '']);
  }
  const st = [['Obra', 'Projeto', 'Etapa', 'Data base', 'Data prevista', 'Data realizada', 'Desvio (dias)', 'Situação']];
  for (const i of d.items) for (const s of i.stages) st.push([`${i.project_code} · ${i.project_name}`, i.title, s.name, fmtD(s.base_date), fmtD(s.planned_date), fmtD(s.done_date), n(s.shift), STAGE_SIT[s.status]]);
  const hs = [['Data', 'Obra', 'Projeto', 'Etapa', 'Alteração', 'De', 'Para', 'Motivo', 'Explicação', 'Por']];
  const KIND = { previsto: 'Data prevista', realizado: 'Data realizada', base: 'Nova linha de base', cadastro: 'Projeto incluído' };
  if (d.items.length) {
    const byId = new Map(d.items.map(i => [i.id, i]));
    const rows = all(`SELECT c.*, u.name AS user_name, s.name AS stage_name FROM ml_changes c LEFT JOIN users u ON u.id = c.created_by LEFT JOIN ml_type_stages s ON s.id = c.stage_id
      WHERE c.item_id IN (${d.items.map(() => '?').join(',')}) ORDER BY c.id DESC`, ...d.items.map(i => i.id));
    for (const c of rows) {
      const i = byId.get(c.item_id);
      hs.push([fmtD(c.created_at.slice(0, 10)), `${i.project_code} · ${i.project_name}`, i.title, c.stage_name || '', `${KIND[c.kind]}${c.cascade ? ' (deslocada junto)' : ''}`, fmtD(c.old_date), fmtD(c.new_date), c.reason || '', c.explanation || '', c.user_name || '']);
    }
  }
  const buffer = writeXlsx([
    { name: 'Lista Mestra', rows: main, widths: [30, 24, 16, 22, 9, 24, 12, 14, 14, 10, 14, 14, 12, 11, 11, 50], rowStyles: { 0: 4, 2: 9 }, heights: { 2: 32 }, styles: { 15: 2 }, freezeRows: 3, landscape: true },
    { name: 'Etapas', rows: st, header: true, freeze: true, widths: [30, 34, 30, 13, 13, 13, 11, 12] },
    { name: 'Histórico', rows: hs, header: true, freeze: true, widths: [11, 30, 34, 28, 26, 11, 11, 30, 60, 22], styles: { 8: 2 } },
  ]);
  return { buffer, filename: `lista-mestra${proj ? `-${proj.code}` : ''}-${t}.xlsx` };
}
