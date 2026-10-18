// Registros do projeto: observações, definições, atas de reunião, pendências e outros tipos cadastráveis.
// Comportamentos: nota (texto e anexos) · decisao (vigente/substituída) · reuniao (ata com itens que geram
// definições e tarefas) · pendencia (gera uma tarefa com responsável e prazo).
import { all, one, run, tx } from '../db.js';
import { badRequest, forbidden, notFound, str, date, intOrNull } from '../lib/http.js';
import { isAdmin, isManagerRole, canAccessProject, canManageProject, canManageSettings, userHasProjectAccess } from '../lib/permissions.js';
import { audit, taskHistory } from './audit.js';
import { today, effectiveStatus, localDate } from './metrics.js';
import { insertTask } from './tasks.js';
import { saveImageFromDataUrl, cleanFileName, isPdf, deleteStored } from './files.js';

export const BEHAVIORS = ['nota', 'decisao', 'reuniao', 'pendencia'];
export const BEHAVIOR_LABEL = { nota: 'Nota', decisao: 'Decisão', reuniao: 'Reunião', pendencia: 'Pendência' };
export const STATUS_LABEL = {
  ativo: 'Registrado', rascunho: 'Rascunho', emitida: 'Emitida', aguardando_aprovacao: 'Aguardando aprovação', vigente: 'Vigente',
  substituida: 'Substituída', reprovada: 'Reprovada', aberta: 'Em aberto', resolvida: 'Resolvida', atrasada: 'Atrasada', cancelada: 'Cancelada',
};
const ITEM_KINDS = ['info', 'definicao', 'demanda'];
const fmtD = d => (d ? d.split('-').reverse().join('/') : '');
const nowIso = () => new Date().toISOString().replace('T', ' ').slice(0, 19);

// ---------- Tipos de registro (Configurações) ----------
export function listRecordTypes({ includeInactive = false } = {}) {
  return all(`SELECT t.*, (SELECT COUNT(*) FROM project_records r WHERE r.type_id = t.id) AS use_count
    FROM record_types t ${includeInactive ? '' : 'WHERE t.active = 1'} ORDER BY t.sort_order, t.id`);
}

export function saveRecordTypes(ctx, input, ip) {
  if (!canManageSettings(ctx.user)) throw forbidden('Apenas quem acessa as Configurações altera os tipos de registro.');
  if (!Array.isArray(input)) throw badRequest('Lista de tipos inválida.');
  const current = listRecordTypes({ includeInactive: true });
  const byId = new Map(current.map(t => [t.id, t]));
  const flag = v => (v === true || v === 1 || v === '1' ? 1 : 0);
  const items = input.slice(0, 60).map((x, i) => ({
    id: intOrNull(x?.id),
    name: String(x?.name ?? '').replace(/\s+/g, ' ').trim(),
    behavior: String(x?.behavior || ''),
    color: /^#[0-9a-fA-F]{6}$/.test(x?.color || '') ? x.color.toUpperCase() : '#2A3D50',
    prefix: String(x?.prefix || '').trim().toUpperCase() || null,
    requires_approval: flag(x?.requires_approval),
    internal: flag(x?.internal),
    allow_colab: flag(x?.allow_colab),
    in_report: x?.in_report === undefined ? 1 : flag(x?.in_report),
    active: x?.active === false || x?.active === 0 ? 0 : 1,
    order: i + 1,
  }));
  const seen = new Set();
  const prefixes = new Set();
  for (const x of items) {
    if (!x.name) throw badRequest('Informe o nome de todos os tipos.');
    if (x.name.length > 60) throw badRequest(`Tipo "${x.name.slice(0, 30)}…" excede 60 caracteres.`);
    const k = x.name.toLocaleLowerCase('pt-BR');
    if (seen.has(k)) throw badRequest(`Tipo repetido: ${x.name}.`);
    seen.add(k);
    if (!BEHAVIORS.includes(x.behavior)) throw badRequest(`Escolha o comportamento de "${x.name}".`);
    if (x.prefix && !/^[A-Z0-9]{2,6}$/.test(x.prefix)) throw badRequest(`Numeração de "${x.name}": use de 2 a 6 letras ou números (ex.: ATA).`);
    if (x.prefix) {
      if (prefixes.has(x.prefix)) throw badRequest(`A numeração ${x.prefix} está repetida.`);
      prefixes.add(x.prefix);
    }
    if (x.id && !byId.has(x.id)) throw badRequest('Tipo inválido.');
    const old = x.id && byId.get(x.id);
    if (old && old.use_count && old.behavior !== x.behavior) throw badRequest(`"${old.name}" já tem registros: o comportamento não pode ser trocado.`);
  }
  const keep = new Set(items.filter(x => x.id).map(x => x.id));
  const removed = current.filter(t => !keep.has(t.id));
  for (const t of removed) if (t.use_count) throw badRequest(`"${t.name}" tem ${t.use_count} registro(s). Inative-o em vez de excluir.`);
  const log = { criados: [], alterados: [], excluidos: removed.map(t => t.name) };
  tx(() => {
    for (const t of removed) run('DELETE FROM record_types WHERE id = ?', t.id);
    // Nomes/numerações temporários para permitir trocas entre tipos
    for (const x of items.filter(x => x.id)) run('UPDATE record_types SET name = ?, prefix = NULL WHERE id = ?', `~tmp~${x.id}`, x.id);
    for (const x of items) {
      const vals = [x.name, x.behavior, x.color, x.prefix, x.requires_approval, x.internal, x.allow_colab, x.in_report, x.active, x.order];
      if (x.id) {
        const o = byId.get(x.id);
        if (['name', 'color', 'prefix', 'requires_approval', 'internal', 'allow_colab', 'in_report', 'active'].some(k => String(o[k] ?? '') !== String(x[k] ?? ''))) log.alterados.push(x.name);
        run(`UPDATE record_types SET name=?, behavior=?, color=?, prefix=?, requires_approval=?, internal=?, allow_colab=?, in_report=?, active=?, sort_order=?,
          updated_at=datetime('now') WHERE id=?`, ...vals, x.id);
      } else {
        run(`INSERT INTO record_types (name, behavior, color, prefix, requires_approval, internal, allow_colab, in_report, active, sort_order)
          VALUES (?,?,?,?,?,?,?,?,?,?)`, ...vals);
        log.criados.push(x.name);
      }
    }
    audit(ctx.user.id, 'settings', null, 'Tipos de registro atualizados', log, ip);
  });
  return listRecordTypes({ includeInactive: true });
}

// ---------- Acesso ----------
function projectFor(ctx, projectId) {
  const p = one('SELECT * FROM projects WHERE id = ?', projectId);
  if (!p || !canAccessProject(ctx.user, p.id, ctx.projects)) throw notFound('Projeto não encontrado.');
  return p;
}
const typeVisible = (ctx, t) => !(t.internal && ctx.user.is_external);
const isManager = (ctx, projectId) => canManageProject(ctx, projectId);
const canCreateType = (ctx, t) => !!t.active && typeVisible(ctx, t) && (isAdmin(ctx.user) || isManagerRole(ctx.user) || !!t.allow_colab);

const BASE = `SELECT r.*, t.name AS type_name, t.behavior, t.color, t.internal, t.in_report, t.requires_approval,
    cu.name AS created_by_name, au.name AS assignee_name, ap.name AS approved_by_name, eu.name AS emitted_by_name, xu.name AS cancelled_by_name,
    rp.code AS replaces_code, rp.title AS replaces_title, rb.code AS replaced_by_code, rb.title AS replaced_by_title,
    sr.code AS source_code, sr.title AS source_title,
    tk.code AS task_code, tk.title AS task_title, tk.status AS task_status, tk.due_date AS task_due, tk.cancelled_at AS task_cancelled, tk.assignee_id AS task_assignee_id,
    (SELECT COUNT(*) FROM record_files f WHERE f.record_id = r.id) AS file_count
  FROM project_records r JOIN record_types t ON t.id = r.type_id
  LEFT JOIN users cu ON cu.id = r.created_by LEFT JOIN users au ON au.id = r.assignee_id LEFT JOIN users ap ON ap.id = r.approved_by
  LEFT JOIN users eu ON eu.id = r.emitted_by LEFT JOIN users xu ON xu.id = r.cancelled_by
  LEFT JOIN project_records rp ON rp.id = r.replaces_id LEFT JOIN project_records rb ON rb.id = r.replaced_by_id
  LEFT JOIN project_records sr ON sr.id = r.source_record_id
  LEFT JOIN tasks tk ON tk.id = r.task_id`;

// Situação efetiva: a pendência acompanha a tarefa gerada (resolvida quando a tarefa é concluída)
function taskEff(r, ref) {
  if (!r.task_id || !r.task_code) return null;
  return effectiveStatus({ status: r.task_status, due_date: r.task_due, cancelled_at: r.task_cancelled }, ref);
}
function effStatus(r, ref = today()) {
  if (r.behavior === 'pendencia' && r.status === 'aberta') {
    const te = taskEff(r, ref);
    if (te === 'concluida') return 'resolvida';
    if (te === 'cancelada') return 'cancelada';
    if (te === 'atrasada') return 'atrasada';
  }
  return r.status;
}

function itemsOf(recordId, ref = today()) {
  return all(`SELECT i.*, u.name AS assignee_name, tk.code AS task_code, tk.status AS task_status, tk.due_date AS task_due, tk.cancelled_at AS task_cancelled,
      d.code AS decision_code, d.status AS decision_status
    FROM record_items i LEFT JOIN users u ON u.id = i.assignee_id LEFT JOIN tasks tk ON tk.id = i.task_id LEFT JOIN project_records d ON d.id = i.decision_id
    WHERE i.record_id = ? ORDER BY i.seq`, recordId)
    .map(i => ({ ...i, task_eff: i.task_code ? effectiveStatus({ status: i.task_status, due_date: i.task_due, cancelled_at: i.task_cancelled }, ref) : null }));
}

function shape(ctx, r, { full = false } = {}) {
  const ref = today();
  const manager = isManager(ctx, r.project_id);
  const mine = r.created_by === ctx.user.id;
  const st = r.status;
  const locked = ['cancelada', 'substituida', 'reprovada', 'emitida'].includes(st);
  const out = {
    ...r,
    participants: r.participants ? JSON.parse(r.participants) : [],
    eff_status: effStatus(r, ref),
    task_eff: taskEff(r, ref),
    can: {
      edit: !locked && (manager || mine) && !(r.behavior === 'decisao' && st === 'vigente' && !manager),
      approve: st === 'aguardando_aprovacao' && manager && (isAdmin(ctx.user) || !mine),
      emit: r.behavior === 'reuniao' && st === 'rascunho' && (manager || mine),
      addendum: r.behavior === 'reuniao' && st === 'emitida' && manager,
      replace: r.behavior === 'decisao' && st === 'vigente' && (manager || mine),
      cancel: (st === 'ativo' || st === 'rascunho' || st === 'aguardando_aprovacao' || st === 'vigente' || st === 'emitida') && (manager || (mine && st !== 'emitida')),
      pin: manager || mine,
      files: st !== 'cancelada' && (manager || mine),
    },
  };
  if (r.behavior === 'reuniao') {
    const items = itemsOf(r.id, ref);
    out.items = full ? items : undefined;
    out.item_counts = { info: items.filter(i => i.kind === 'info').length, definicao: items.filter(i => i.kind === 'definicao').length, demanda: items.filter(i => i.kind === 'demanda').length };
    out.open_demands = items.filter(i => i.kind === 'demanda' && i.task_eff && !['concluida', 'cancelada'].includes(i.task_eff)).length;
    out.late_demands = items.filter(i => i.task_eff === 'atrasada').length;
  }
  if (full) {
    out.files = all(`SELECT f.id, f.mime, f.size, f.caption, f.original_name, f.created_at, f.uploaded_by, u.name AS uploaded_by_name
      FROM record_files f LEFT JOIN users u ON u.id = f.uploaded_by WHERE f.record_id = ? ORDER BY f.id`, r.id);
    out.derived = all(`SELECT r2.id, r2.code, r2.title, r2.status FROM project_records r2 WHERE r2.source_record_id = ? ORDER BY r2.id`, r.id);
    // Cadeia de definições (substituídas → atual)
    if (r.behavior === 'decisao') {
      const chain = [];
      let cur = r.replaces_id;
      while (cur && chain.length < 30) {
        const x = one('SELECT id, code, title, record_date, status, replaces_id FROM project_records WHERE id = ?', cur);
        if (!x) break;
        chain.push(x);
        cur = x.replaces_id;
      }
      out.history_chain = chain;
    }
  }
  return out;
}

function visibleRows(ctx, projectId) {
  const rows = all(`${BASE} WHERE r.project_id = ? ORDER BY r.record_date DESC, r.id DESC`, projectId);
  return rows.filter(r => typeVisible(ctx, r));
}

export function loadRecord(ctx, id) {
  const r = one(`${BASE} WHERE r.id = ?`, id);
  if (!r || !canAccessProject(ctx.user, r.project_id, ctx.projects) || !typeVisible(ctx, r)) throw notFound('Registro não encontrado.');
  return r;
}

// ---------- Leitura ----------
export function listRecords(ctx, projectId) {
  const p = projectFor(ctx, projectId);
  const rows = visibleRows(ctx, p.id).map(r => shape(ctx, r));
  const types = listRecordTypes({ includeInactive: true }).filter(t => typeVisible(ctx, t));
  const creatable = types.filter(t => canCreateType(ctx, t));
  const live = rows.filter(r => !['cancelada', 'reprovada', 'rascunho'].includes(r.status));
  return {
    project: { id: p.id, code: p.code, name: p.name, client: p.client, status: p.status, kind: p.kind },
    types: types.map(t => ({ id: t.id, name: t.name, behavior: t.behavior, color: t.color, prefix: t.prefix, active: t.active, internal: t.internal, requires_approval: t.requires_approval })),
    creatable: creatable.map(t => t.id),
    can_manage: isManager(ctx, p.id),
    records: rows,
    summary: {
      total: live.length,
      pinned: rows.filter(r => r.pinned && !['cancelada', 'substituida', 'reprovada'].includes(r.status)).length,
      vigentes: rows.filter(r => r.behavior === 'decisao' && r.status === 'vigente').length,
      awaiting: rows.filter(r => r.status === 'aguardando_aprovacao').length,
      drafts: rows.filter(r => r.status === 'rascunho').length,
      open: rows.filter(r => r.behavior === 'pendencia' && ['aberta', 'atrasada'].includes(r.eff_status)).length
        + rows.filter(r => r.behavior === 'reuniao').reduce((n, r) => n + (r.open_demands || 0), 0),
      late: rows.filter(r => r.eff_status === 'atrasada').length + rows.filter(r => r.behavior === 'reuniao').reduce((n, r) => n + (r.late_demands || 0), 0),
      last_date: live[0]?.record_date || null,
    },
  };
}

export function getRecord(ctx, id) {
  const r = loadRecord(ctx, id);
  const p = one('SELECT id, code, name, client, status FROM projects WHERE id = ?', r.project_id);
  return { ...shape(ctx, r, { full: true }), project: p };
}

// Marcas no Gantt: o momento de cada registro (sem rascunhos, reprovados e cancelados)
export function recordMarks(ctx, projectId) {
  if (!canAccessProject(ctx.user, projectId, ctx.projects)) return [];
  return visibleRows(ctx, projectId).filter(r => !['cancelada', 'reprovada', 'rascunho'].includes(r.status))
    .map(r => ({ id: r.id, project_id: r.project_id, date: r.record_date, code: r.code, title: r.title, type_name: r.type_name, color: r.color,
      behavior: r.behavior, status: effStatus(r) }))
    .sort((a, b) => a.date.localeCompare(b.date) || a.id - b.id);
}

// ---------- Gravação ----------
function readParticipants(v) {
  let list = v;
  if (typeof v === 'string') list = v.split(/\r?\n/).map(l => ({ name: l }));
  if (!Array.isArray(list)) return [];
  return list.slice(0, 80).map(x => {
    const raw = typeof x === 'string' ? x : x?.name;
    const [name, company] = String(raw || '').split(/\s+[-–—]\s+|\s*\(\s*/).map(s => s.replace(/\)\s*$/, '').trim());
    return { name: (name || '').slice(0, 100), company: (x?.company || company || '').slice(0, 100) || null };
  }).filter(x => x.name);
}

function readItemsIn(v, projectId) {
  if (!Array.isArray(v)) return [];
  return v.slice(0, 120).map((x, i) => {
    const kind = ITEM_KINDS.includes(x?.kind) ? x.kind : 'info';
    const text = str(x?.text, { max: 2000, label: `Item ${i + 1} da ata` });
    const assignee = kind === 'demanda' ? intOrNull(x?.assignee_id) : null;
    if (assignee && !userHasProjectAccess(assignee, projectId)) throw badRequest(`Item ${i + 1}: o responsável não tem acesso a este projeto.`);
    return { kind, text, assignee_id: assignee, due_date: kind === 'demanda' ? date(x?.due_date, `Prazo do item ${i + 1}`) : null };
  }).filter(x => x.text);
}

function readBody(ctx, body, type, projectId) {
  const d = {
    title: str(body.title, { max: 160, required: true, label: 'Título' }),
    body: str(body.body, { max: 20000, label: 'Descrição' }),
    record_date: date(body.record_date, 'Data do registro') || today(),
    origin: str(body.origin, { max: 160, label: 'Origem' }),
    decided_by: str(body.decided_by, { max: 160, label: type.behavior === 'pendencia' ? 'Solicitante' : 'Quem definiu' }),
    pinned: body.pinned ? 1 : 0,
    assignee_id: null, due_date: null, meeting_time: null, location: null, participants: null, agenda: null,
  };
  if (d.record_date > today()) throw badRequest('A data do registro não pode ser futura.');
  if (type.behavior === 'pendencia') {
    d.assignee_id = intOrNull(body.assignee_id);
    if (d.assignee_id && !userHasProjectAccess(d.assignee_id, projectId)) throw badRequest('O responsável escolhido não tem acesso a este projeto.');
    d.due_date = date(body.due_date, 'Prazo');
  }
  if (type.behavior === 'reuniao') {
    d.meeting_time = /^\d{2}:\d{2}$/.test(body.meeting_time || '') ? body.meeting_time : null;
    d.location = str(body.location, { max: 160, label: 'Local' });
    d.participants = JSON.stringify(readParticipants(body.participants));
    d.agenda = str(body.agenda, { max: 5000, label: 'Pauta' });
  }
  return d;
}

function nextCode(project, type) {
  if (!type.prefix) return { seq: null, code: null };
  const seq = (one('SELECT MAX(seq) AS n FROM project_records WHERE project_id = ? AND type_id = ?', project.id, type.id).n || 0) + 1;
  return { seq, code: `${type.prefix}-${project.code}-${String(seq).padStart(3, '0')}` };
}

function addFiles(ctx, recordId, files) {
  const list = Array.isArray(files) ? files.slice(0, 15) : [];
  for (const f of list) {
    const saved = saveImageFromDataUrl(f.data);
    run('INSERT INTO record_files (record_id, stored_name, mime, size, caption, original_name, uploaded_by) VALUES (?,?,?,?,?,?,?)',
      recordId, saved.stored_name, saved.mime, saved.size, str(f.caption, { max: 200, label: 'Legenda' }), isPdf(saved.mime) ? cleanFileName(f.name) : null, ctx.user.id);
  }
  return list.length;
}

const openProject = p => !['concluido', 'cancelado'].includes(p.status);

// Tarefa gerada por um registro: entra no projeto com a origem anotada
function createTaskFrom(ctx, project, { title, description, assignee_id, due_date, recordId, label }) {
  if (!openProject(project)) throw badRequest('Projeto encerrado não recebe novas tarefas. Reabra o projeto para gerar tarefas a partir dos registros.');
  const assignee = assignee_id || ctx.user.id;
  if (!userHasProjectAccess(assignee, project.id)) throw badRequest('O responsável escolhido não tem acesso a este projeto.');
  const taskId = insertTask({
    project,
    data: { task_type: 'tarefa', title: title.slice(0, 160), description, field_summary: null, notes: null, due_date, start_date: null, priority: 'media', proof_type: 'nenhuma', assignee_id: assignee },
    stageInput: null,
    creatorId: ctx.user.id,
    ctx,
  });
  run('UPDATE tasks SET origin_record_id = ? WHERE id = ?', recordId, taskId);
  taskHistory(taskId, ctx.user.id, 'Origem: registro do projeto', label);
  return taskId;
}

// Pendência aberta: cria a tarefa (uma só)
function openPendencia(ctx, project, r) {
  if (r.task_id) return;
  const desc = `${r.body || r.title}\n\nOrigem: ${r.code || r.type_name} — ${r.title} (${fmtD(r.record_date)})${r.decided_by ? ` · solicitado por ${r.decided_by}` : ''}.`;
  const taskId = createTaskFrom(ctx, project, { title: r.title, description: desc, assignee_id: r.assignee_id, due_date: r.due_date, recordId: r.id, label: `${r.code || r.type_name} · ${r.title}` });
  run('UPDATE project_records SET task_id = ? WHERE id = ?', taskId, r.id);
}

// Definição vigente que substitui outra
function applyReplace(r) {
  if (!r.replaces_id) return;
  run(`UPDATE project_records SET status = 'substituida', replaced_by_id = ?, updated_at = datetime('now') WHERE id = ? AND status = 'vigente'`, r.id, r.replaces_id);
}

function decisionTypeId() {
  const t = one(`SELECT id FROM record_types WHERE behavior = 'decisao' AND active = 1 ORDER BY requires_approval, (name = 'Definição') DESC, sort_order LIMIT 1`)
    || one(`SELECT id FROM record_types WHERE behavior = 'decisao' ORDER BY sort_order LIMIT 1`);
  if (!t) throw badRequest('Cadastre um tipo de registro com comportamento Decisão para registrar as definições da ata.');
  return t.id;
}

// Processa os itens da ata (emissão ou adendo): definições viram registros vigentes; demandas viram tarefas
function processItems(ctx, project, ata, items) {
  let defs = 0, tasks = 0;
  for (const i of items) {
    if (i.kind === 'definicao' && !i.decision_id) {
      const type = one('SELECT * FROM record_types WHERE id = ?', decisionTypeId());
      const { seq, code } = nextCode(project, type);
      const rr = run(`INSERT INTO project_records (project_id, type_id, seq, code, title, body, record_date, status, origin, decided_by, source_record_id, created_by)
        VALUES (?,?,?,?,?,?,?, 'vigente', ?, ?, ?, ?)`, project.id, type.id, seq, code, i.text.split(/\r?\n/)[0].slice(0, 160), i.text,
        i.addendum ? today() : ata.record_date, `Reunião ${ata.code || ''}`.trim(), 'Reunião', ata.id, ctx.user.id);
      run('UPDATE record_items SET decision_id = ? WHERE id = ?', Number(rr.lastInsertRowid), i.id);
      defs++;
    }
    if (i.kind === 'demanda' && !i.task_id) {
      const desc = `${i.text}\n\nDemanda da ${ata.code || 'ata'} — ${ata.title} (reunião de ${fmtD(ata.record_date)}), item ${i.seq}${i.addendum ? ' (adendo)' : ''}.`;
      const taskId = createTaskFrom(ctx, project, { title: i.text.split(/\r?\n/)[0], description: desc, assignee_id: i.assignee_id, due_date: i.due_date, recordId: ata.id,
        label: `${ata.code || 'Ata'} · item ${i.seq}` });
      run('UPDATE record_items SET task_id = ? WHERE id = ?', taskId, i.id);
      tasks++;
    }
  }
  return { defs, tasks };
}

function insertItemsFor(ctx, recordId, items, { addendum = 0 } = {}) {
  let seq = one('SELECT MAX(seq) AS n FROM record_items WHERE record_id = ?', recordId).n || 0;
  for (const i of items) {
    seq++;
    run('INSERT INTO record_items (record_id, seq, kind, text, assignee_id, due_date, addendum, created_by) VALUES (?,?,?,?,?,?,?,?)',
      recordId, seq, i.kind, i.text, i.assignee_id, i.due_date, addendum, ctx.user.id);
  }
}

export function createRecord(ctx, projectId, body, ip) {
  const project = projectFor(ctx, projectId);
  const type = one('SELECT * FROM record_types WHERE id = ?', intOrNull(body.type_id));
  if (!type) throw badRequest('Escolha o tipo de registro.');
  if (!canCreateType(ctx, type)) throw forbidden('Você não pode criar registros deste tipo.');
  const d = readBody(ctx, body, type, project.id);
  const items = type.behavior === 'reuniao' ? readItemsIn(body.items, project.id) : [];
  let replaces = null;
  if (type.behavior === 'decisao' && body.replaces_id) {
    replaces = one(`SELECT r.*, t.behavior FROM project_records r JOIN record_types t ON t.id = r.type_id WHERE r.id = ?`, intOrNull(body.replaces_id));
    if (!replaces || replaces.project_id !== project.id || replaces.behavior !== 'decisao' || replaces.status !== 'vigente') throw badRequest('A definição a substituir precisa estar vigente neste projeto.');
  }
  const needsApproval = type.requires_approval && !isAdmin(ctx.user);
  const status = type.behavior === 'nota' ? 'ativo' : type.behavior === 'reuniao' ? 'rascunho'
    : needsApproval ? 'aguardando_aprovacao' : type.behavior === 'decisao' ? 'vigente' : 'aberta';
  if (type.behavior === 'pendencia' && status === 'aberta' && !openProject(project)) throw badRequest('Projeto encerrado não recebe novas tarefas.');
  const id = tx(() => {
    const { seq, code } = nextCode(project, type);
    const r = run(`INSERT INTO project_records (project_id, type_id, seq, code, title, body, record_date, status, pinned, origin, decided_by, replaces_id,
        assignee_id, due_date, meeting_time, location, participants, agenda, approved_by, approved_at, created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      project.id, type.id, seq, code, d.title, d.body, d.record_date, status, d.pinned, d.origin, d.decided_by, replaces?.id ?? null,
      d.assignee_id, d.due_date, d.meeting_time, d.location, d.participants, d.agenda,
      type.requires_approval && !needsApproval ? ctx.user.id : null, type.requires_approval && !needsApproval ? nowIso() : null, ctx.user.id);
    const rid = Number(r.lastInsertRowid);
    if (items.length) insertItemsFor(ctx, rid, items);
    addFiles(ctx, rid, body.files);
    const full = one(`${BASE} WHERE r.id = ?`, rid);
    if (status === 'vigente') applyReplace(full);
    if (status === 'aberta') openPendencia(ctx, project, full);
    audit(ctx.user.id, 'record', rid, `${type.name} registrado`, { projeto: project.code, codigo: code, titulo: d.title, situacao: STATUS_LABEL[status] }, ip);
    if (type.behavior === 'reuniao' && body.emit) emitInternal(ctx, project, one(`${BASE} WHERE r.id = ?`, rid), ip);
    return rid;
  });
  return id;
}

export function updateRecord(ctx, id, body, ip) {
  const r = loadRecord(ctx, id);
  const v = shape(ctx, r);
  if (!v.can.edit) throw forbidden('Este registro não pode mais ser editado.');
  const project = one('SELECT * FROM projects WHERE id = ?', r.project_id);
  const type = one('SELECT * FROM record_types WHERE id = ?', r.type_id);
  const d = readBody(ctx, body, type, project.id);
  // Pendência já aberta: responsável e prazo são cuidados na própria tarefa
  if (r.behavior === 'pendencia' && r.task_id) { d.assignee_id = r.assignee_id; d.due_date = r.due_date; }
  tx(() => {
    run(`UPDATE project_records SET title=?, body=?, record_date=?, pinned=?, origin=?, decided_by=?, assignee_id=?, due_date=?, meeting_time=?, location=?,
      participants=?, agenda=?, updated_at=datetime('now') WHERE id=?`,
      d.title, d.body, d.record_date, d.pinned, d.origin, d.decided_by, d.assignee_id, d.due_date, d.meeting_time, d.location, d.participants, d.agenda, id);
    if (r.behavior === 'reuniao' && r.status === 'rascunho' && Array.isArray(body.items)) {
      run('DELETE FROM record_items WHERE record_id = ?', id);
      insertItemsFor(ctx, id, readItemsIn(body.items, project.id));
    }
    addFiles(ctx, id, body.files);
    audit(ctx.user.id, 'record', id, 'Registro editado', { codigo: r.code, titulo: d.title }, ip);
    if (r.behavior === 'reuniao' && r.status === 'rascunho' && body.emit) emitInternal(ctx, project, one(`${BASE} WHERE r.id = ?`, id), ip);
  });
  return getRecord(ctx, id);
}

function emitInternal(ctx, project, r, ip) {
  const items = itemsOf(r.id);
  if (!items.length && !r.agenda && !r.body) throw badRequest('Inclua a pauta, o resumo ou os itens da ata antes de emitir.');
  if (items.some(i => i.kind === 'demanda') && !openProject(project)) throw badRequest('Projeto encerrado não recebe novas tarefas: a ata tem demandas.');
  run(`UPDATE project_records SET status = 'emitida', emitted_by = ?, emitted_at = ?, updated_at = datetime('now') WHERE id = ?`, ctx.user.id, nowIso(), r.id);
  const res = processItems(ctx, project, { ...r, status: 'emitida' }, items);
  audit(ctx.user.id, 'record', r.id, 'Ata emitida', { codigo: r.code, definicoes: res.defs, tarefas: res.tasks }, ip);
  return res;
}

export function recordAction(ctx, id, action, body = {}, ip) {
  const r = loadRecord(ctx, id);
  const v = shape(ctx, r);
  const project = one('SELECT * FROM projects WHERE id = ?', r.project_id);
  tx(() => {
    if (action === 'emit') {
      if (!v.can.emit) throw forbidden('Esta ata não pode ser emitida.');
      emitInternal(ctx, project, r, ip);
    } else if (action === 'approve') {
      if (!v.can.approve) throw forbidden('Você não pode aprovar este registro.');
      const status = r.behavior === 'pendencia' ? 'aberta' : 'vigente';
      if (status === 'aberta' && !openProject(project)) throw badRequest('Projeto encerrado não recebe novas tarefas.');
      run(`UPDATE project_records SET status = ?, approved_by = ?, approved_at = ?, approval_note = ?, updated_at = datetime('now') WHERE id = ?`,
        status, ctx.user.id, nowIso(), str(body.note, { max: 1000, label: 'Observação' }), id);
      const full = one(`${BASE} WHERE r.id = ?`, id);
      if (status === 'vigente') applyReplace(full);
      if (status === 'aberta') openPendencia(ctx, project, full);
      audit(ctx.user.id, 'record', id, 'Registro aprovado', { codigo: r.code, titulo: r.title }, ip);
    } else if (action === 'reject') {
      if (!v.can.approve) throw forbidden('Você não pode reprovar este registro.');
      const note = str(body.note, { max: 1000, required: true, label: 'Motivo' });
      run(`UPDATE project_records SET status = 'reprovada', approved_by = ?, approved_at = ?, approval_note = ?, updated_at = datetime('now') WHERE id = ?`, ctx.user.id, nowIso(), note, id);
      audit(ctx.user.id, 'record', id, 'Registro reprovado', { codigo: r.code, motivo: note }, ip);
    } else if (action === 'cancel') {
      if (!v.can.cancel) throw forbidden('Você não pode cancelar este registro.');
      const reason = str(body.reason, { max: 1000, required: true, label: 'Motivo do cancelamento' });
      run(`UPDATE project_records SET status = 'cancelada', cancelled_by = ?, cancelled_at = ?, cancel_reason = ?, pinned = 0, updated_at = datetime('now') WHERE id = ?`,
        ctx.user.id, nowIso(), reason, id);
      // Definição cancelada: a anterior (se havia) volta a valer
      if (r.behavior === 'decisao' && r.status === 'vigente' && r.replaces_id) {
        run(`UPDATE project_records SET status = 'vigente', replaced_by_id = NULL, updated_at = datetime('now') WHERE id = ? AND status = 'substituida'`, r.replaces_id);
      }
      audit(ctx.user.id, 'record', id, 'Registro cancelado', { codigo: r.code, motivo: reason }, ip);
    } else if (action === 'pin' || action === 'unpin') {
      if (!v.can.pin) throw forbidden('Você não pode fixar este registro.');
      run('UPDATE project_records SET pinned = ? WHERE id = ?', action === 'pin' ? 1 : 0, id);
    } else if (action === 'addendum') {
      if (!v.can.addendum) throw forbidden('Somente gestores e administradores incluem adendos em atas emitidas.');
      const items = readItemsIn(body.items, project.id);
      if (!items.length) throw badRequest('Inclua ao menos um item no adendo.');
      const before = one('SELECT MAX(seq) AS n FROM record_items WHERE record_id = ?', id).n || 0;
      insertItemsFor(ctx, id, items, { addendum: 1 });
      const res = processItems(ctx, project, r, itemsOf(id).filter(i => i.seq > before));
      audit(ctx.user.id, 'record', id, 'Adendo incluído na ata', { codigo: r.code, itens: items.length, definicoes: res.defs, tarefas: res.tasks }, ip);
    } else {
      throw badRequest('Ação inválida.');
    }
  });
  return getRecord(ctx, id);
}

export function addRecordFiles(ctx, id, body) {
  const r = loadRecord(ctx, id);
  if (!shape(ctx, r).can.files) throw forbidden('Você não pode anexar arquivos a este registro.');
  const n = tx(() => addFiles(ctx, id, body.files));
  if (!n) throw badRequest('Nenhum arquivo enviado.');
  return getRecord(ctx, id);
}

export function removeRecordFile(ctx, id, fileId) {
  const r = loadRecord(ctx, id);
  const f = one('SELECT * FROM record_files WHERE id = ? AND record_id = ?', fileId, id);
  if (!f) throw notFound('Arquivo não encontrado.');
  if (!(isManager(ctx, r.project_id) || f.uploaded_by === ctx.user.id) || r.status === 'cancelada') throw forbidden('Você não pode remover este arquivo.');
  run('DELETE FROM record_files WHERE id = ?', fileId);
  deleteStored(f.stored_name);
  return getRecord(ctx, id);
}

export function recordFileForUser(ctx, fileId) {
  const f = one('SELECT * FROM record_files WHERE id = ?', fileId);
  if (!f) throw notFound('Arquivo não encontrado.');
  loadRecord(ctx, f.record_id);
  return f;
}

// Origem de uma tarefa (exibida na tela da tarefa)
export function originOfTask(ctx, recordId) {
  if (!recordId) return null;
  const r = one(`SELECT r.id, r.code, r.title, r.record_date, r.project_id, t.name AS type_name, t.internal FROM project_records r JOIN record_types t ON t.id = r.type_id WHERE r.id = ?`, recordId);
  if (!r || (r.internal && ctx.user.is_external) || !canAccessProject(ctx.user, r.project_id, ctx.projects)) return null;
  return { id: r.id, code: r.code, title: r.title, record_date: r.record_date, type_name: r.type_name, project_id: r.project_id };
}

export { fmtD, localDate };
