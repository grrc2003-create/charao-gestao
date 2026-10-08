// Regras de negócio de tarefas: criação, edição, execução, conferência e histórico.
import { all, one, run, tx } from '../db.js';
import { badRequest, forbidden, notFound, str, oneOf, date, intOrNull } from '../lib/http.js';
import {
  canSeeTask, canManageTask, canReviewTask, canExecuteTask, canCreateTaskIn, canReassignTask, userHasProjectAccess, isAdmin, isManagerRole } from '../lib/permissions.js';
import { decorate, today, daysBetween } from './metrics.js';
import { taskHistory, audit } from './audit.js';
import { saveImageFromDataUrl, deleteStored, copyStored, cleanFileName, isPdf } from './files.js';
import { resolveStage } from './stages.js';
import { activeReason, getSetting } from './settings.js';
import { readItems, insertItems, checklistView, checklistCheck, checklistStoredFiles, answeredCount, PHOTO_RULES, PHOTO_RULE_LABEL } from './checklist.js';

export const PRIORITIES = ['baixa', 'media', 'alta', 'urgente'];
export const PROOF_TYPES = ['nenhuma', 'foto', 'descricao', 'foto_descricao'];
const PRIORITY_LABEL = { baixa: 'Baixa', media: 'Média', alta: 'Alta', urgente: 'Urgente' };
const PROOF_LABEL = { nenhuma: 'Nenhuma', foto: 'Somente foto', descricao: 'Somente descrição', foto_descricao: 'Foto + descrição' };
const STATUS_LABEL = { aberta: 'Aberta', em_andamento: 'Em andamento', aguardando_conferencia: 'Aguardando conferência', concluida: 'Concluída' };

const BASE_SQL = `SELECT t.*, p.code AS project_code, p.name AS project_name, p.client AS project_client, p.kind AS project_kind,
    a.name AS assignee_name, a.is_external AS assignee_external, a.login_enabled AS assignee_login, a.manager_id AS assignee_leader_id, a.company AS assignee_company, (SELECT lu.name FROM users lu WHERE lu.id = a.manager_id) AS assignee_leader_name,
    c.name AS creator_name, ab.name AS assigned_by_name, r.name AS reviewer_name,
    (SELECT COUNT(*) FROM task_files f WHERE f.task_id = t.id AND f.kind = 'referencia') AS ref_count,
    (SELECT COUNT(*) FROM task_files f WHERE f.task_id = t.id AND f.kind = 'execucao') AS exec_count,
    pt.code AS parent_code, pt.title AS parent_title,
    (SELECT COUNT(*) FROM task_reschedules rs WHERE rs.task_id = t.id) AS reschedule_count,
    (SELECT rs.old_due FROM task_reschedules rs WHERE rs.task_id = t.id ORDER BY rs.id LIMIT 1) AS original_due, st.name AS stage_name, st.sort_order AS stage_order, st.is_default AS stage_default,
    (SELECT COUNT(*) FROM tasks s WHERE s.parent_id = t.id AND s.cancelled_at IS NULL) AS sub_total,
    (SELECT COUNT(*) FROM tasks s WHERE s.parent_id = t.id AND s.cancelled_at IS NULL AND s.status = 'concluida') AS sub_done,
    cb.name AS cancelled_by_name,
    (SELECT rc.title FROM recurrences rc WHERE rc.id = t.recurrence_id) AS recurrence_title,
    (SELECT rc.active FROM recurrences rc WHERE rc.id = t.recurrence_id) AS recurrence_active,
    (SELECT COUNT(*) FROM checklist_items ci WHERE ci.task_id = t.id) AS cl_total,
    (SELECT COUNT(*) FROM checklist_items ci WHERE ci.task_id = t.id AND ci.result IN ('conforme','na')) AS cl_done,
    (SELECT COUNT(*) FROM checklist_items ci WHERE ci.task_id = t.id AND (ci.result = 'nao_conforme'
      OR (ci.result IS NULL AND EXISTS (SELECT 1 FROM checklist_files f WHERE f.item_id = ci.id AND f.kind = 'referencia')))) AS cl_nc
  FROM tasks t
  JOIN projects p ON p.id = t.project_id
  LEFT JOIN tasks pt ON pt.id = t.parent_id
  LEFT JOIN project_stages st ON st.id = t.stage_id
  LEFT JOIN users a ON a.id = t.assignee_id
  LEFT JOIN users c ON c.id = t.creator_id
  LEFT JOIN users ab ON ab.id = t.assigned_by_id
  LEFT JOIN users r ON r.id = t.reviewed_by
  LEFT JOIN users cb ON cb.id = t.cancelled_by`;

const nowIso = () => new Date().toISOString();
// Execução registrada pelo líder em nome de um terceirizado (fica explícito no histórico)
const onBehalf = (ctx, t) => (t.assignee_external && !t.assignee_login && t.assignee_id !== ctx.user.id ? `Registrado por ${ctx.user.name} (líder) em nome de ${t.assignee_name} (terceirizado)` : null);
const withBehalf = (ctx, t, details) => [details, onBehalf(ctx, t)].filter(Boolean).join(' · ') || null;

// Reagendamentos agrupados por tarefa (para os indicadores de prazo e repactuação)
function reschedulesByTask(taskIds) {
  const m = new Map();
  if (!taskIds.length) return m;
  const rows = taskIds.length > 500
    ? all('SELECT task_id, old_due, new_due, created_at FROM task_reschedules ORDER BY id')
    : all(`SELECT task_id, old_due, new_due, created_at FROM task_reschedules WHERE task_id IN (${taskIds.map(() => '?').join(',')}) ORDER BY id`, ...taskIds);
  for (const r of rows) {
    if (!m.has(r.task_id)) m.set(r.task_id, []);
    m.get(r.task_id).push(r);
  }
  return m;
}

// Tarefas visíveis ao usuário. Canceladas ficam de fora (indicadores, listas, relatórios, lista de campo);
// use listCancelled para consultá-las.
export function listVisible(ctx, where = '', ...params) {
  return listTasks(ctx, 't.cancelled_at IS NULL', where, params);
}

export function listCancelled(ctx, where = '', ...params) {
  return listTasks(ctx, 't.cancelled_at IS NOT NULL', where, params);
}

function listTasks(ctx, base, where, params) {
  const ref = today();
  const chronicMin = getSetting('chronic_reschedule_threshold');
  const extra = where ? ` AND (${where.replace(/^\s*WHERE\s+/i, '')})` : '';
  const rows = all(`${BASE_SQL} WHERE ${base}${extra} ORDER BY t.due_date IS NULL, t.due_date, t.id`, ...params).filter(t => canSeeTask(ctx, t));
  const rs = reschedulesByTask(rows.filter(t => t.reschedule_count).map(t => t.id));
  return rows.map(t => decorate(t, ref, rs.get(t.id) || [], chronicMin)).sort(byWorkOrder);
}

// Pendências primeiro (atrasadas, depois por prazo), concluídas por último (mais recentes primeiro)
const RANK = { atrasada: 0, em_andamento: 1, aberta: 1, aguardando_conferencia: 2, concluida: 3 };
function byWorkOrder(a, b) {
  return RANK[a.eff_status] - RANK[b.eff_status]
    || (a.eff_status === 'concluida'
      ? (b.completed_at || '').localeCompare(a.completed_at || '')
      : (a.due_date || '9999').localeCompare(b.due_date || '9999'));
}

function rawTask(id) {
  const t = one(`${BASE_SQL} WHERE t.id = ?`, id);
  if (!t) throw notFound('Tarefa não encontrada.');
  return t;
}

export function loadVisible(ctx, id) {
  const t = rawTask(id);
  if (!canSeeTask(ctx, t)) throw notFound('Tarefa não encontrada.');
  return t;
}

// Check-list: o prazo da tarefa acompanha o maior prazo dos itens (quando algum item tem prazo)
export const checklistMaxDue = taskId => one('SELECT MAX(due_date) AS d FROM checklist_items WHERE task_id = ?', taskId)?.d || null;

export function permissionsFor(ctx, t) {
  const manage = canManageTask(ctx, t);
  if (t.cancelled_at) {
    const parentCancelled = t.parent_id && one('SELECT cancelled_at FROM tasks WHERE id = ?', t.parent_id)?.cancelled_at;
    return { reactivate: manage && !parentCancelled, reactivate_blocked: parentCancelled ? 'Reative antes a tarefa principal.' : null };
  }
  const execute = canExecuteTask(ctx, t);
  const review = canReviewTask(ctx, t);
  const editableExec = execute && (t.status === 'aberta' || t.status === 'em_andamento');
  return {
    edit: manage && t.status !== 'concluida',
    reassign: canReassignTask(ctx, t),
    reschedule: manage && t.status !== 'concluida' && !!t.due_date && !(t.task_type === 'checklist' && checklistMaxDue(t.id)),
    due_from_items: t.task_type === 'checklist' && !!checklistMaxDue(t.id),
    execute: editableExec,
    start: execute && t.status === 'aberta',
    submit: editableExec,
    review: review && t.status === 'aguardando_conferencia',
    reopen: manage && t.status === 'concluida',
    conclude_directly: manage && t.status !== 'concluida' && t.status !== 'aguardando_conferencia' && (isAdmin(ctx.user) || isManagerRole(ctx.user)),
    // Subtarefas: um nível. Quem gerencia a tarefa ou é o responsável por ela pode dividi-la.
    add_subtask: t.task_type !== 'checklist' && !t.parent_id && t.status !== 'concluida' && (manage || t.assignee_id === ctx.user.id),
    cancel: manage && t.status !== 'concluida',
    ...deletePermission(ctx, t),
  };
}

// Exclusão definitiva: só Administrador e só tarefas sem nenhum registro de execução
function deletePermission(ctx, t) {
  if (!isAdmin(ctx.user)) return { delete: false };
  const blocks = [];
  if (t.status !== 'aberta') blocks.push('a execução já foi iniciada');
  if (t.delivered_at || one(`SELECT 1 FROM task_history WHERE task_id = ? AND action = 'Enviada para conferência' LIMIT 1`, t.id)) blocks.push('já foi enviada para conferência');
  if (t.exec_description || t.exec_notes) blocks.push('há descrição ou observação de execução');
  if (one(`SELECT 1 FROM task_files WHERE task_id = ? AND kind = 'execucao' LIMIT 1`, t.id)) blocks.push('há fotos de execução');
  if (one('SELECT 1 FROM tasks WHERE parent_id = ? LIMIT 1', t.id)) blocks.push('possui subtarefas');
  if (t.task_type === 'checklist' && answeredCount(t.id)) blocks.push('há itens do check-list respondidos');
  return { delete: !blocks.length, delete_blocked: blocks.length ? `Não pode ser excluída: ${blocks.join(', ')}. Use "Cancelar tarefa".` : null };
}

// Check-list só é entregue/concluído com todos os itens respondidos (e com as fotos, quando obrigatórias)
function assertChecklistDone(t) {
  if (t.task_type !== 'checklist') return;
  const c = checklistCheck(t);
  if (!c.ok) throw badRequest(`Check-list incompleto: ${c.missing.join(' e ')}.`);
}

// Tarefa principal só é entregue/concluída com todas as subtarefas concluídas
function assertSubtasksDone(t) {
  const pending = one(`SELECT COUNT(*) AS n FROM tasks WHERE parent_id = ? AND status <> 'concluida' AND cancelled_at IS NULL`, t.id).n;
  if (pending) throw badRequest(`Conclua as subtarefas antes: ${pending} pendente(s).`);
}

export function getTask(ctx, id) {
  const t = loadVisible(ctx, id);
  const files = all(`SELECT f.id, f.kind, f.mime, f.size, f.caption, f.original_name, f.created_at, f.uploaded_by, u.name AS uploaded_by_name
    FROM task_files f LEFT JOIN users u ON u.id = f.uploaded_by WHERE f.task_id = ? ORDER BY f.id`, id);
  const history = all(`SELECT h.id, h.action, h.details, h.created_at, u.name AS user_name
    FROM task_history h LEFT JOIN users u ON u.id = h.user_id WHERE h.task_id = ? ORDER BY h.created_at DESC, h.id DESC`, id);
  const ref = today();
  const chronicMin = getSetting('chronic_reschedule_threshold');
  const subRows = all(`${BASE_SQL} WHERE t.parent_id = ? ORDER BY t.seq`, id).filter(s => canSeeTask(ctx, s));
  const subRs = reschedulesByTask(subRows.filter(s => s.reschedule_count).map(s => s.id));
  const subtasks = subRows.map(s => decorate(s, ref, subRs.get(s.id) || [], chronicMin));
  const parent = t.parent_id ? one(`${BASE_SQL} WHERE t.id = ?`, t.parent_id) : null;
  const reschedules = all(`SELECT r.id, r.old_due, r.new_due, r.reason_name, r.note, r.created_at, u.name AS user_name
    FROM task_reschedules r LEFT JOIN users u ON u.id = r.user_id WHERE r.task_id = ? ORDER BY r.id`, id);
  // Cada reagendamento marcado como preventivo ou corretivo
  const { reschedule_entries: entries, ...dec } = decorate(t, ref, reschedules, chronicMin);
  return {
    ...dec, files, history, subtasks,
    reschedules: entries,
    chronic_min: chronicMin,
    parent_visible: !!(parent && canSeeTask(ctx, parent)),
    can: permissionsFor(ctx, t), proof_check: proofCheck(t, files),
    ...(t.task_type === 'checklist' ? checklistDetail(ctx, t) : {}),
  };
}

// Check-list: itens + conferência do preenchimento no lugar da comprovação
function checklistDetail(ctx, t) {
  const checklist = checklistView(ctx, t);
  return { checklist, proof_check: { need_photo: false, need_desc: false, has_photo: false, has_desc: false, ok: checklist.check.ok, missing: checklist.check.missing } };
}

function proofCheck(t, files) {
  const hasPhoto = files.some(f => f.kind === 'execucao' && !isPdf(f.mime)); // PDF não substitui a foto exigida
  const hasDesc = !!(t.exec_description && t.exec_description.trim().length >= 5);
  const needPhoto = t.proof_type === 'foto' || t.proof_type === 'foto_descricao';
  const needDesc = t.proof_type === 'descricao' || t.proof_type === 'foto_descricao';
  const missing = [];
  if (needPhoto && !hasPhoto) missing.push('foto da execução');
  if (needDesc && !hasDesc) missing.push('descrição da execução');
  return { need_photo: needPhoto, need_desc: needDesc, has_photo: hasPhoto, has_desc: hasDesc, ok: missing.length === 0, missing };
}

export function validateAssignee(assigneeId, projectId) {
  if (!assigneeId) return null;
  if (!userHasProjectAccess(assigneeId, projectId)) throw badRequest('O responsável escolhido não tem acesso a este projeto.');
  return assigneeId;
}

export function createTask(ctx, body) {
  const parentId = intOrNull(body.parent_id);
  let parent = null;
  if (parentId) {
    parent = loadVisible(ctx, parentId);
    if (parent.parent_id) throw badRequest('Subtarefas não podem ter novas subtarefas.');
    if (!permissionsFor(ctx, parent).add_subtask) throw forbidden('Você não pode criar subtarefas nesta tarefa.');
    body = { ...body, project_id: parent.project_id };
  }
  const projectId = intOrNull(body.project_id);
  if (!projectId) throw badRequest('Projeto é obrigatório.');
  const project = one('SELECT * FROM projects WHERE id = ?', projectId);
  if (!project) throw badRequest('Projeto inválido.');
  if (!canCreateTaskIn(ctx, projectId)) throw forbidden('Você não tem acesso a este projeto.');
  if (['concluido', 'cancelado'].includes(project.status)) throw badRequest('Projeto encerrado não recebe novas tarefas.');

  const isChecklist = body.task_type === 'checklist';
  if (isChecklist && parent) throw badRequest('Check-list não pode ser subtarefa.');
  const data = {
    task_type: isChecklist ? 'checklist' : 'tarefa',
    photo_rule: isChecklist ? oneOf(body.photo_rule, PHOTO_RULES, 'Regra de fotos', 'livre') : null,
    title: str(body.title, { max: 160, required: true, label: 'Título' }),
    description: str(body.description, { max: 5000, required: !isChecklist, label: 'Descrição' }) || '',
    field_summary: str(body.field_summary, { max: 180, label: 'Resumo para campo' }),
    notes: str(body.notes, { max: 2000, label: 'Observações' }),
    due_date: date(body.due_date, 'Prazo'),
    start_date: date(body.start_date, 'Início previsto'),
    priority: oneOf(body.priority, PRIORITIES, 'Prioridade', 'media'),
    proof_type: isChecklist ? 'nenhuma' : oneOf(body.proof_type, PROOF_TYPES, 'Tipo de comprovação', 'nenhuma'),
    assignee_id: validateAssignee(intOrNull(body.assignee_id), projectId),
  };
  if (isChecklist) {
    data.items = readItems(body.items, projectId, { required: true, requirePhoto: data.photo_rule === 'obrigatoria' });
    // Prazo do check-list = maior prazo dos itens (quando algum item tem prazo)
    const maxDue = data.items.map(i => i.due_date).filter(Boolean).sort().at(-1);
    if (maxDue) data.due_date = maxDue;
  }
  assertDateOrder(data.start_date, data.due_date);
  const images = Array.isArray(body.images) ? body.images.slice(0, 10) : [];
  return tx(() => insertTask({ project, parent, data, stageInput: body.stage_id, creatorId: ctx.user.id, images, ctx }));
}

// Gravação da tarefa (código, classificação, histórico, imagens). Usada na criação manual e pelas recorrências.
// images: [{data, caption}] (upload) | copyFiles: [{stored_name, mime, caption}] (cópia do molde) | recurrence: {id, seq, label}
export function insertTask({ project, parent = null, data, stageInput, creatorId, images = [], copyFiles = [], recurrence = null, ctx = null }) {
  const projectId = project.id;
  {
    let seq, code;
    if (parent) {
      // Código da subtarefa: código da tarefa-mãe + sequência (PRJ-001-00001-01)
      run('UPDATE tasks SET sub_seq = sub_seq + 1 WHERE id = ?', parent.id);
      seq = one('SELECT sub_seq FROM tasks WHERE id = ?', parent.id).sub_seq;
      code = `${parent.code}-${String(seq).padStart(2, '0')}`;
    } else {
      run('UPDATE projects SET task_seq = task_seq + 1 WHERE id = ?', projectId);
      seq = one('SELECT task_seq FROM projects WHERE id = ?', projectId).task_seq;
      code = `${project.code}-${String(seq).padStart(5, '0')}`;
    }
    const now = nowIso();
    // Sem classificação escolhida, a tarefa assume "Geral"
    const stageId = resolveStage(projectId, stageInput);
    const isChecklist = data.task_type === 'checklist';
    const r = run(`INSERT INTO tasks (code, project_id, parent_id, seq, stage_id, title, description, field_summary, notes, assignee_id, assigned_by_id,
        creator_id, start_date, due_date, priority, proof_type, status, recurrence_id, recurrence_seq, task_type, photo_rule, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'aberta', ?, ?, ?, ?, ?, ?)`,
      code, projectId, parent?.id ?? null, seq, stageId, data.title, data.description, data.field_summary, data.notes, data.assignee_id,
      data.assignee_id ? creatorId : null, creatorId, data.start_date, data.due_date, data.priority, data.proof_type,
      recurrence?.id ?? null, recurrence?.seq ?? null, isChecklist ? 'checklist' : 'tarefa', isChecklist ? data.photo_rule : null, now, now);
    const id = Number(r.lastInsertRowid);
    const assignee = data.assignee_id ? one('SELECT name FROM users WHERE id = ?', data.assignee_id).name : 'sem responsável';
    const stageName = one('SELECT name FROM project_stages WHERE id = ?', stageId).name;
    const created = recurrence ? `Tarefa criada automaticamente pela recorrência (${recurrence.seq}ª ocorrência)` : parent ? `Subtarefa criada em ${parent.code}` : isChecklist ? 'Check-list criado' : 'Tarefa criada';
    taskHistory(id, creatorId, created,
      `${recurrence ? `${recurrence.label} · ` : ''}Classificação: ${stageName} · Responsável${isChecklist ? ' global' : ''}: ${assignee} · Prazo: ${fmtDate(data.due_date)} · Prioridade: ${PRIORITY_LABEL[data.priority]} · ${isChecklist ? `${data.items.length} item(ns) · ${PHOTO_RULE_LABEL[data.photo_rule]}` : `Comprovação: ${PROOF_LABEL[data.proof_type]}`}`);
    if (isChecklist) insertItems(id, data.items, creatorId);
    if (parent) taskHistory(parent.id, creatorId, 'Subtarefa adicionada', `${code} · ${data.title} · Responsável: ${assignee}`);
    for (const img of images) addFileInternal(ctx, id, 'referencia', img.data, img.caption, img.name);
    for (const f of copyFiles) {
      const c = copyStored(f.stored_name);
      if (c) run('INSERT INTO task_files (task_id, kind, stored_name, mime, size, caption, original_name, uploaded_by, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
        id, 'referencia', c.stored_name, f.mime, c.size, f.caption, f.original_name || null, creatorId, now);
    }
    const nImg = images.length + copyFiles.length;
    if (nImg) taskHistory(id, creatorId, 'Imagens de referência anexadas', countLabel([...images.map(i => pdfData(i.data)), ...copyFiles.map(f => isPdf(f.mime))]));
    return id;
  }
}

const fmtDate = d => (d ? d.split('-').reverse().join('/') : 'sem prazo');
export { fmtDate as fmtTaskDate };

function assertDateOrder(start, due) {
  if (start && due && start > due) throw badRequest('O início previsto deve ser anterior ou igual ao prazo.');
}

function assertNotCancelled(t) {
  if (t.cancelled_at) throw badRequest('Tarefa cancelada. Reative-a para fazer alterações.');
}

export function updateTask(ctx, id, body) {
  const t = loadVisible(ctx, id);
  assertNotCancelled(t);
  if (!canManageTask(ctx, t)) throw forbidden('Você não pode editar esta tarefa.');
  if (t.status === 'concluida') throw badRequest('Reabra a tarefa antes de editá-la.');
  const changes = [];
  const next = {};
  const set = (field, value, label, show = v => v ?? '—') => {
    if ((value ?? null) !== (t[field] ?? null)) {
      next[field] = value;
      changes.push([label, show(t[field]), show(value)]);
    }
  };
  if ('title' in body) set('title', str(body.title, { max: 160, required: true, label: 'Título' }), 'Título alterado');
  if ('description' in body) set('description', str(body.description, { max: 5000, required: t.task_type !== 'checklist', label: 'Descrição' }) || '', 'Descrição alterada', () => '');
  if (t.task_type === 'checklist' && 'photo_rule' in body) set('photo_rule', oneOf(body.photo_rule, PHOTO_RULES, 'Regra de fotos'), 'Regra de fotos do check-list alterada', v => PHOTO_RULE_LABEL[v]);
  if ('field_summary' in body) set('field_summary', str(body.field_summary, { max: 180, label: 'Resumo para campo' }), 'Resumo para campo alterado', () => '');
  if ('notes' in body) set('notes', str(body.notes, { max: 2000, label: 'Observações' }), 'Observações alteradas', () => '');
  // Prazo: definir um prazo inexistente é livre; alterar um prazo já definido é REAGENDAMENTO,
  // que exige justificativa pré-cadastrada (Configurações) e fica registrado.
  let reschedule = null;
  if ('due_date' in body) {
    const nd = date(body.due_date, 'Prazo');
    if ((nd ?? null) !== (t.due_date ?? null)) {
      const maxDue = t.task_type === 'checklist' ? checklistMaxDue(t.id) : null;
      if (maxDue) throw badRequest(`O prazo do check-list acompanha o maior prazo dos itens (${fmtDate(maxDue)}). Para mudar, altere o prazo dos itens.`);
      next.due_date = nd;
      if (t.due_date) {
        const reason = activeReason(body.reschedule_reason_id);
        const note = str(body.reschedule_note, { max: 1000, label: 'Observação do reagendamento' });
        if (/outro/i.test(reason.name) && !note) throw badRequest('Detalhe o motivo na observação do reagendamento.');
        reschedule = { old: t.due_date, new: nd, reason, note };
      } else {
        changes.push(['Prazo definido', '—', fmtDate(nd)]);
      }
    }
  }
  if ('start_date' in body) set('start_date', date(body.start_date, 'Início previsto'), 'Início previsto alterado', d => (d ? fmtDate(d) : '—'));
  assertDateOrder(next.start_date !== undefined ? next.start_date : t.start_date, next.due_date !== undefined ? next.due_date : t.due_date);
  if ('stage_id' in body) {
    const sid = resolveStage(t.project_id, body.stage_id);
    if (sid !== t.stage_id) {
      next.stage_id = sid;
      const name = s => (s ? one('SELECT name FROM project_stages WHERE id = ?', s)?.name : '—');
      changes.push(['Classificação alterada', name(t.stage_id), name(sid)]);
    }
  }
  if ('priority' in body) set('priority', oneOf(body.priority, PRIORITIES, 'Prioridade'), 'Prioridade alterada', v => PRIORITY_LABEL[v]);
  if ('proof_type' in body) set('proof_type', oneOf(body.proof_type, PROOF_TYPES, 'Tipo de comprovação'), 'Comprovação exigida alterada', v => PROOF_LABEL[v]);
  if ('assignee_id' in body) {
    const aid = validateAssignee(intOrNull(body.assignee_id), t.project_id);
    if (aid !== t.assignee_id) {
      next.assignee_id = aid;
      next.assigned_by_id = aid ? ctx.user.id : null;
      const name = uid => (uid ? one('SELECT name FROM users WHERE id = ?', uid)?.name : 'sem responsável');
      changes.push(['Responsável alterado', name(t.assignee_id), name(aid)]);
    }
  }
  if (!changes.length && !reschedule) return;
  tx(() => {
    const fields = Object.keys(next);
    run(`UPDATE tasks SET ${fields.map(f => `${f} = ?`).join(', ')}, updated_at = ? WHERE id = ?`, ...fields.map(f => next[f]), nowIso(), id);
    if (reschedule) {
      const n = one('SELECT COUNT(*) AS n FROM task_reschedules WHERE task_id = ?', id).n + 1;
      run(`INSERT INTO task_reschedules (task_id, old_due, new_due, reason_id, reason_name, note, user_id, created_at) VALUES (?,?,?,?,?,?,?,?)`,
        id, reschedule.old, reschedule.new, reschedule.reason.id, reschedule.reason.name, reschedule.note, ctx.user.id, nowIso());
      taskHistory(id, ctx.user.id, `Prazo reagendado (${n}º reagendamento)`,
        `${fmtDate(reschedule.old)} → ${fmtDate(reschedule.new)} · Justificativa: ${reschedule.reason.name}${reschedule.note ? ` · ${reschedule.note}` : ''}`);
    }
    for (const [label, from, to] of changes) taskHistory(id, ctx.user.id, label, from || to ? `${from} → ${to}` : null);
  });
}

// Ação dedicada "Alterar responsável": qualquer pessoa liberada no projeto pode alocar a tarefa para outra pessoa do projeto
export function reassignTask(ctx, id, body) {
  const t = loadVisible(ctx, id);
  if (!canReassignTask(ctx, t)) {
    throw t.cancelled_at || !['aberta', 'em_andamento'].includes(t.status)
      ? badRequest('Só é possível trocar o responsável de tarefas abertas ou em andamento.')
      : forbidden('Você não pode alterar o responsável desta tarefa.');
  }
  const aid = validateAssignee(intOrNull(body.assignee_id), t.project_id);
  if (!aid) throw badRequest('Selecione o novo responsável.');
  if (aid === t.assignee_id) throw badRequest('Esta pessoa já é a responsável pela tarefa.');
  const note = str(body.note, { max: 500, label: 'Motivo' });
  const name = uid => (uid ? one('SELECT name FROM users WHERE id = ?', uid)?.name : 'sem responsável');
  tx(() => {
    run('UPDATE tasks SET assignee_id = ?, assigned_by_id = ?, updated_at = ? WHERE id = ?', aid, ctx.user.id, nowIso(), id);
    taskHistory(id, ctx.user.id, 'Responsável alterado', `${name(t.assignee_id)} → ${name(aid)}${note ? ` · Motivo: ${note}` : ''}`);
  });
  return name(aid);
}

// Ação dedicada "Reagendar" (mesma regra da edição, exigindo uma nova data)
export function rescheduleTask(ctx, id, body) {
  const t = loadVisible(ctx, id);
  if (!t.due_date) throw badRequest('A tarefa ainda não tem prazo. Defina o prazo editando a tarefa.');
  const nd = date(body.due_date, 'Novo prazo');
  if (!nd) throw badRequest('Informe o novo prazo.');
  if (nd === t.due_date) throw badRequest('O novo prazo deve ser diferente do atual.');
  updateTask(ctx, id, { due_date: nd, reschedule_reason_id: body.reason_id, reschedule_note: body.note });
}

// Retorno do responsável (descrição/observações da execução)
export function updateExecution(ctx, id, body) {
  const t = loadVisible(ctx, id);
  assertNotCancelled(t);
  if (!canExecuteTask(ctx, t)) throw forbidden('Apenas o responsável pode registrar a execução.');
  if (!['aberta', 'em_andamento'].includes(t.status)) throw badRequest('A execução não pode ser alterada neste status.');
  const next = {};
  if ('exec_description' in body) next.exec_description = str(body.exec_description, { max: 5000, label: 'Descrição da execução' });
  if ('exec_notes' in body) next.exec_notes = str(body.exec_notes, { max: 2000, label: 'Observações' });
  const fields = Object.keys(next);
  if (!fields.length) return;
  tx(() => {
    run(`UPDATE tasks SET ${fields.map(f => `${f} = ?`).join(', ')}, updated_at = ? WHERE id = ?`, ...fields.map(f => next[f]), nowIso(), id);
    if ('exec_description' in next) taskHistory(id, ctx.user.id, 'Descrição da execução registrada', onBehalf(ctx, t));
    if ('exec_notes' in next) taskHistory(id, ctx.user.id, 'Observação da execução registrada', onBehalf(ctx, t));
    autoStart(ctx, t);
  });
}

export function autoStart(ctx, t) {
  if (t.status === 'aberta') {
    run(`UPDATE tasks SET status = 'em_andamento', started_at = COALESCE(started_at, ?) WHERE id = ?`, nowIso(), t.id);
    taskHistory(t.id, ctx.user.id, 'Status alterado', 'Aberta → Em andamento');
  }
}

function addFileInternal(ctx, taskId, kind, dataUrl, caption, name) {
  const f = saveImageFromDataUrl(dataUrl);
  run('INSERT INTO task_files (task_id, kind, stored_name, mime, size, caption, original_name, uploaded_by, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
    taskId, kind, f.stored_name, f.mime, f.size, str(caption, { max: 200, label: 'Legenda' }), isPdf(f.mime) ? cleanFileName(name) || 'documento.pdf' : null,
    ctx.user.id, nowIso());
}

const pdfData = d => typeof d === 'string' && d.startsWith('data:application/pdf');
// "2 imagem(ns) e 1 PDF"
function countLabel(flags) {
  const pdf = flags.filter(Boolean).length, img = flags.length - pdf;
  return [img ? `${img} imagem(ns)` : '', pdf ? `${pdf} PDF` : ''].filter(Boolean).join(' e ');
}

export function addFiles(ctx, id, body) {
  const t = loadVisible(ctx, id);
  assertNotCancelled(t);
  const kind = oneOf(body.kind, ['referencia', 'execucao'], 'Tipo do arquivo');
  const images = Array.isArray(body.images) ? body.images.slice(0, 10) : [];
  if (!images.length) throw badRequest('Nenhum arquivo enviado.');
  if (kind === 'execucao') {
    if (!canExecuteTask(ctx, t)) throw forbidden('Apenas o responsável pode anexar a comprovação da execução.');
    if (!['aberta', 'em_andamento'].includes(t.status)) throw badRequest('Não é possível anexar arquivos neste status.');
  } else {
    if (!canManageTask(ctx, t) || t.status === 'concluida') throw forbidden('Você não pode anexar referências nesta tarefa.');
  }
  tx(() => {
    for (const img of images) addFileInternal(ctx, id, kind, img.data, img.caption, img.name);
    taskHistory(id, ctx.user.id, kind === 'execucao' ? 'Fotos de comprovação enviadas' : 'Imagens de referência anexadas', withBehalf(ctx, t, countLabel(images.map(i => pdfData(i.data)))));
    if (kind === 'execucao') autoStart(ctx, t);
  });
}

export function removeFile(ctx, taskId, fileId) {
  const t = loadVisible(ctx, taskId);
  assertNotCancelled(t);
  const f = one('SELECT * FROM task_files WHERE id = ? AND task_id = ?', fileId, taskId);
  if (!f) throw notFound('Arquivo não encontrado.');
  const allowed = f.kind === 'execucao'
    ? canExecuteTask(ctx, t) && ['aberta', 'em_andamento'].includes(t.status)
    : canManageTask(ctx, t) && t.status !== 'concluida';
  if (!allowed) throw forbidden('Você não pode remover este arquivo.');
  tx(() => {
    run('DELETE FROM task_files WHERE id = ?', fileId);
    taskHistory(taskId, ctx.user.id, f.kind === 'execucao' ? 'Foto de comprovação removida' : 'Imagem de referência removida');
  });
  deleteStored(f.stored_name);
}

export function fileForUser(ctx, fileId) {
  const f = one('SELECT * FROM task_files WHERE id = ?', fileId);
  if (!f) throw notFound();
  loadVisible(ctx, f.task_id);
  return f;
}

// Transições de status
export function transition(ctx, id, action, body = {}) {
  const t = loadVisible(ctx, id);
  assertNotCancelled(t);
  const can = permissionsFor(ctx, t);
  const now = nowIso();
  const label = s => STATUS_LABEL[s];
  const change = (to, extraSql = '', ...extra) => {
    run(`UPDATE tasks SET status = ?, updated_at = ?${extraSql} WHERE id = ?`, to, now, ...extra, id);
    taskHistory(id, ctx.user.id, 'Status alterado', `${label(t.status)} → ${label(to)}`);
  };
  tx(() => {
    switch (action) {
      case 'start':
        if (!can.start) throw forbidden('Ação não permitida.');
        change('em_andamento', ', started_at = ?', now);
        break;
      case 'submit': {
        if (!can.submit) throw forbidden('Ação não permitida.');
        const files = all('SELECT kind, mime FROM task_files WHERE task_id = ?', id);
        const pc = proofCheck(t, files);
        if (!pc.ok) throw badRequest(`Comprovação incompleta: falta ${pc.missing.join(' e ')}.`);
        assertChecklistDone(t);
        assertSubtasksDone(t);
        change('aguardando_conferencia', ', delivered_at = ?, review_status = \'pendente\', review_comment = NULL, started_at = COALESCE(started_at, ?)', now, now);
        taskHistory(id, ctx.user.id, 'Enviada para conferência', withBehalf(ctx, t, pc.has_photo || pc.has_desc ? 'Comprovação anexada' : null));
        break;
      }
      case 'approve': {
        if (!can.review) throw forbidden('Você não pode conferir esta tarefa.');
        assertSubtasksDone(t);
        const comment = str(body.comment, { max: 1000, label: 'Comentário' });
        change('concluida', ', review_status = \'aprovada\', review_comment = ?, reviewed_by = ?, reviewed_at = ?, completed_at = ?', comment, ctx.user.id, now, now);
        taskHistory(id, ctx.user.id, 'Conferência aprovada — tarefa concluída', comment);
        if (t.parent_id) taskHistory(t.parent_id, ctx.user.id, 'Subtarefa concluída', `${t.code} · ${t.title}`);
        break;
      }
      case 'return': {
        if (!can.review) throw forbidden('Você não pode conferir esta tarefa.');
        const comment = str(body.comment, { max: 1000, required: true, label: 'Motivo da devolução' });
        change('em_andamento', ', review_status = \'devolvida\', review_comment = ?, reviewed_by = ?, reviewed_at = ?, delivered_at = NULL', comment, ctx.user.id, now);
        taskHistory(id, ctx.user.id, 'Devolvida para ajustes', comment);
        break;
      }
      case 'conclude': {
        if (!can.conclude_directly) throw forbidden('Ação não permitida.');
        assertSubtasksDone(t);
        assertChecklistDone(t);
        const comment = str(body.comment, { max: 1000, label: 'Comentário' });
        change('concluida', ', delivered_at = COALESCE(delivered_at, ?), completed_at = ?, reviewed_by = ?, reviewed_at = ?, review_status = \'aprovada\', review_comment = ?', now, now, ctx.user.id, now, comment);
        taskHistory(id, ctx.user.id, 'Concluída diretamente pelo gestor', comment);
        if (t.parent_id) taskHistory(t.parent_id, ctx.user.id, 'Subtarefa concluída', `${t.code} · ${t.title}`);
        break;
      }
      case 'reopen': {
        if (!can.reopen) throw forbidden('Ação não permitida.');
        if (t.parent_id && one('SELECT status FROM tasks WHERE id = ?', t.parent_id).status === 'concluida') {
          throw badRequest(`Reabra antes a tarefa principal ${t.parent_code}.`);
        }
        const comment = str(body.comment, { max: 1000, required: true, label: 'Motivo da reabertura' });
        change('em_andamento', ', completed_at = NULL, delivered_at = NULL, review_status = NULL');
        taskHistory(id, ctx.user.id, 'Tarefa reaberta', comment);
        break;
      }
      default:
        throw badRequest('Ação desconhecida.');
    }
  });
}

// ---------- Cancelamento e exclusão ----------
export function cancelTask(ctx, id, body) {
  const t = loadVisible(ctx, id);
  if (!permissionsFor(ctx, t).cancel) throw t.cancelled_at ? badRequest('A tarefa já está cancelada.') : forbidden('Você não pode cancelar esta tarefa.');
  const reason = str(body.reason, { max: 1000, required: true, label: 'Motivo do cancelamento' });
  if (reason.length < 5) throw badRequest('Descreva o motivo do cancelamento.');
  const now = nowIso();
  tx(() => {
    const cancel = (taskId, why) => {
      run('UPDATE tasks SET cancelled_at = ?, cancelled_by = ?, cancel_reason = ?, updated_at = ? WHERE id = ?', now, ctx.user.id, why, now, taskId);
      taskHistory(taskId, ctx.user.id, 'Tarefa cancelada', why);
    };
    cancel(id, reason);
    // Subtarefas não concluídas são canceladas junto
    const subs = all(`SELECT id, code FROM tasks WHERE parent_id = ? AND cancelled_at IS NULL AND status <> 'concluida'`, id);
    for (const s of subs) cancel(s.id, `Cancelada junto com a tarefa principal ${t.code}: ${reason}`);
    if (subs.length) taskHistory(id, ctx.user.id, 'Subtarefas canceladas', subs.map(s => s.code).join(', '));
    if (t.parent_id) taskHistory(t.parent_id, ctx.user.id, 'Subtarefa cancelada', `${t.code} · ${t.title}`);
  });
}

export function reactivateTask(ctx, id, body = {}) {
  const t = loadVisible(ctx, id);
  if (!t.cancelled_at) throw badRequest('A tarefa não está cancelada.');
  const can = permissionsFor(ctx, t);
  if (!can.reactivate) throw can.reactivate_blocked ? badRequest(can.reactivate_blocked) : forbidden('Você não pode reativar esta tarefa.');
  const note = str(body.note, { max: 1000, label: 'Observação' });
  tx(() => {
    run('UPDATE tasks SET cancelled_at = NULL, cancelled_by = NULL, cancel_reason = NULL, updated_at = ? WHERE id = ?', nowIso(), id);
    taskHistory(id, ctx.user.id, 'Tarefa reativada', note || `Cancelamento desfeito (motivo anterior: ${t.cancel_reason})`);
    if (t.parent_id) taskHistory(t.parent_id, ctx.user.id, 'Subtarefa reativada', `${t.code} · ${t.title}`);
  });
}

export function deleteTask(ctx, id, body, ip) {
  const t = loadVisible(ctx, id);
  const can = deletePermission(ctx, t);
  if (!can.delete) throw can.delete_blocked ? badRequest(can.delete_blocked) : forbidden('Apenas administradores excluem tarefas.');
  const reason = str(body.reason, { max: 1000, required: true, label: 'Motivo da exclusão' });
  if (reason.length < 5) throw badRequest('Descreva o motivo da exclusão.');
  const files = [...all('SELECT stored_name FROM task_files WHERE task_id = ?', id), ...checklistStoredFiles(id)];
  const resch = one('SELECT COUNT(*) AS n FROM task_reschedules WHERE task_id = ?', id).n;
  tx(() => {
    run('DELETE FROM tasks WHERE id = ?', id); // histórico, imagens e reagendamentos saem em cascata
    if (t.parent_id) taskHistory(t.parent_id, ctx.user.id, 'Subtarefa excluída', `${t.code} · ${t.title} · Motivo: ${reason}`);
    audit(ctx.user.id, 'task', id, 'Tarefa excluída definitivamente', {
      codigo: t.code, titulo: t.title, projeto: `${t.project_code} · ${t.project_name}`, responsavel: t.assignee_name || '—',
      prazo: t.due_date || '—', motivo: reason, imagens: files.length, reagendamentos: resch,
    }, ip);
  });
  for (const f of files) deleteStored(f.stored_name);
  return { project_id: t.project_id, parent_id: t.parent_id };
}

// ---------- Filtros da tela Tarefas (compartilhados com o relatório "Tarefas filtradas") ----------
export const DUE_FILTERS = {
  vencidas: 'Vencidas', hoje: 'Vencem hoje', '7d': 'Próximos 7 dias', '30d': 'Próximos 30 dias', sem_prazo: 'Sem prazo',
  reagendadas: 'Reagendadas', ja_atrasadas: 'Ficaram atrasadas alguma vez', corretivas: 'Repactuadas após vencer',
  cronicas: 'Crônicas (muitos reagendamentos)', concluidas_atraso: 'Concluídas com atraso',
};

// getAll(k) → lista de valores do parâmetro (aceita repetidos ou separados por vírgula)
export function taskFilters(getAll) {
  const list = k => getAll(k).flatMap(v => String(v ?? '').split(',')).map(v => v.trim()).filter(Boolean);
  const first = k => list(k)[0] || '';
  return {
    q: (getAll('q')[0] || '').trim().toLowerCase(), status: list('status'), project: intOrNull(first('project')),
    assignee: first('assignee'), priority: list('priority'), due: first('due'), kind: first('kind'),
    stage: list('stage').map(intOrNull).filter(Boolean), nivel: first('nivel'), tipo: first('tipo'),
  };
}

// cancelled: 'incluir' (lista: quando o filtro pede canceladas) | 'nunca' (relatórios e indicadores)
export function filterTasks(ctx, f, { cancelled = 'incluir' } = {}) {
  const wantCancelled = cancelled === 'incluir' && f.status.includes('cancelada');
  const onlyCancelled = wantCancelled && f.status.length === 1;
  let tasks = [...(onlyCancelled ? [] : listVisible(ctx)), ...(wantCancelled ? listCancelled(ctx) : [])];
  const ref = today();
  if (f.q) tasks = tasks.filter(t => [t.code, t.title, t.description, t.project_name, t.assignee_name].some(v => v && v.toLowerCase().includes(f.q)));
  if (f.status.length) tasks = tasks.filter(t => f.status.includes(t.eff_status));
  if (f.project) tasks = tasks.filter(t => t.project_id === f.project);
  if (f.assignee === 'none') tasks = tasks.filter(t => !t.assignee_id);
  else if (f.assignee === 'me') tasks = tasks.filter(t => t.assignee_id === ctx.user.id || ctx.checklist?.has(t.id));
  else if (f.assignee) tasks = tasks.filter(t => t.assignee_id === intOrNull(f.assignee));
  if (f.priority.length) tasks = tasks.filter(t => f.priority.includes(t.priority));
  if (f.kind === 'obra' || f.kind === 'interno') tasks = tasks.filter(t => t.project_kind === f.kind);
  if (f.stage.length) tasks = tasks.filter(t => f.stage.includes(t.stage_id));
  if (f.tipo === 'checklist' || f.tipo === 'tarefa') tasks = tasks.filter(t => (t.task_type || 'tarefa') === f.tipo);
  if (f.nivel === 'principais') tasks = tasks.filter(t => !t.parent_id);
  else if (f.nivel === 'subtarefas') tasks = tasks.filter(t => t.parent_id);
  if (f.due) {
    const open = t => t.status !== 'concluida';
    const within = n => t => open(t) && t.due_date && t.due_date >= ref && daysBetween(ref, t.due_date) <= n;
    const fn = {
      vencidas: t => t.eff_status === 'atrasada',
      hoje: t => open(t) && t.due_date === ref,
      '7d': within(7),
      '30d': within(30),
      sem_prazo: t => !t.due_date,
      reagendadas: t => t.reschedule_count > 0,
      ja_atrasadas: t => t.ever_late,
      corretivas: t => t.reschedules_corrective > 0,
      cronicas: t => t.chronic,
      concluidas_atraso: t => t.status === 'concluida' && t.on_time === false,
    }[f.due];
    if (fn) tasks = tasks.filter(fn);
  }
  return tasks;
}
