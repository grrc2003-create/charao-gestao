// Regras de negócio de tarefas: criação, edição, execução, conferência e histórico.
import { all, one, run, tx } from '../db.js';
import { badRequest, forbidden, notFound, str, oneOf, date, intOrNull } from '../lib/http.js';
import {
  canSeeTask, canManageTask, canReviewTask, canExecuteTask, canCreateTaskIn, userHasProjectAccess, isAdmin,
} from '../lib/permissions.js';
import { decorate, today } from './metrics.js';
import { taskHistory } from './audit.js';
import { saveImageFromDataUrl, deleteStored } from './files.js';
import { resolveStage } from './stages.js';

export const PRIORITIES = ['baixa', 'media', 'alta', 'urgente'];
export const PROOF_TYPES = ['nenhuma', 'foto', 'descricao', 'foto_descricao'];
const PRIORITY_LABEL = { baixa: 'Baixa', media: 'Média', alta: 'Alta', urgente: 'Urgente' };
const PROOF_LABEL = { nenhuma: 'Nenhuma', foto: 'Somente foto', descricao: 'Somente descrição', foto_descricao: 'Foto + descrição' };
const STATUS_LABEL = { aberta: 'Aberta', em_andamento: 'Em andamento', aguardando_conferencia: 'Aguardando conferência', concluida: 'Concluída' };

const BASE_SQL = `SELECT t.*, p.code AS project_code, p.name AS project_name, p.client AS project_client,
    a.name AS assignee_name, c.name AS creator_name, ab.name AS assigned_by_name, r.name AS reviewer_name,
    (SELECT COUNT(*) FROM task_files f WHERE f.task_id = t.id AND f.kind = 'referencia') AS ref_count,
    (SELECT COUNT(*) FROM task_files f WHERE f.task_id = t.id AND f.kind = 'execucao') AS exec_count,
    pt.code AS parent_code, pt.title AS parent_title, st.name AS stage_name, st.sort_order AS stage_order, st.is_default AS stage_default,
    (SELECT COUNT(*) FROM tasks s WHERE s.parent_id = t.id) AS sub_total,
    (SELECT COUNT(*) FROM tasks s WHERE s.parent_id = t.id AND s.status = 'concluida') AS sub_done
  FROM tasks t
  JOIN projects p ON p.id = t.project_id
  LEFT JOIN tasks pt ON pt.id = t.parent_id
  LEFT JOIN project_stages st ON st.id = t.stage_id
  LEFT JOIN users a ON a.id = t.assignee_id
  LEFT JOIN users c ON c.id = t.creator_id
  LEFT JOIN users ab ON ab.id = t.assigned_by_id
  LEFT JOIN users r ON r.id = t.reviewed_by`;

const nowIso = () => new Date().toISOString();

export function listVisible(ctx, where = '', ...params) {
  const ref = today();
  return all(`${BASE_SQL} ${where} ORDER BY t.due_date IS NULL, t.due_date, t.id`, ...params)
    .filter(t => canSeeTask(ctx, t))
    .map(t => decorate(t, ref))
    .sort(byWorkOrder);
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

function loadVisible(ctx, id) {
  const t = rawTask(id);
  if (!canSeeTask(ctx, t)) throw notFound('Tarefa não encontrada.');
  return t;
}

export function permissionsFor(ctx, t) {
  const manage = canManageTask(ctx, t);
  const execute = canExecuteTask(ctx, t);
  const review = canReviewTask(ctx, t);
  const editableExec = execute && (t.status === 'aberta' || t.status === 'em_andamento');
  return {
    edit: manage && t.status !== 'concluida',
    execute: editableExec,
    start: execute && t.status === 'aberta',
    submit: editableExec,
    review: review && t.status === 'aguardando_conferencia',
    reopen: manage && t.status === 'concluida',
    conclude_directly: manage && t.status !== 'concluida' && t.status !== 'aguardando_conferencia' && (isAdmin(ctx.user) || ctx.user.role === 'gestor'),
    // Subtarefas: um nível. Quem gerencia a tarefa ou é o responsável por ela pode dividi-la.
    add_subtask: !t.parent_id && t.status !== 'concluida' && (manage || t.assignee_id === ctx.user.id),
  };
}

// Tarefa principal só é entregue/concluída com todas as subtarefas concluídas
function assertSubtasksDone(t) {
  const pending = one(`SELECT COUNT(*) AS n FROM tasks WHERE parent_id = ? AND status <> 'concluida'`, t.id).n;
  if (pending) throw badRequest(`Conclua as subtarefas antes: ${pending} pendente(s).`);
}

export function getTask(ctx, id) {
  const t = loadVisible(ctx, id);
  const files = all(`SELECT f.id, f.kind, f.mime, f.size, f.caption, f.created_at, f.uploaded_by, u.name AS uploaded_by_name
    FROM task_files f LEFT JOIN users u ON u.id = f.uploaded_by WHERE f.task_id = ? ORDER BY f.id`, id);
  const history = all(`SELECT h.id, h.action, h.details, h.created_at, u.name AS user_name
    FROM task_history h LEFT JOIN users u ON u.id = h.user_id WHERE h.task_id = ? ORDER BY h.id DESC`, id);
  const ref = today();
  const subtasks = all(`${BASE_SQL} WHERE t.parent_id = ? ORDER BY t.seq`, id)
    .filter(s => canSeeTask(ctx, s)).map(s => decorate(s, ref));
  const parent = t.parent_id ? one(`${BASE_SQL} WHERE t.id = ?`, t.parent_id) : null;
  return {
    ...decorate(t), files, history, subtasks,
    parent_visible: !!(parent && canSeeTask(ctx, parent)),
    can: permissionsFor(ctx, t), proof_check: proofCheck(t, files),
  };
}

function proofCheck(t, files) {
  const hasPhoto = files.some(f => f.kind === 'execucao');
  const hasDesc = !!(t.exec_description && t.exec_description.trim().length >= 5);
  const needPhoto = t.proof_type === 'foto' || t.proof_type === 'foto_descricao';
  const needDesc = t.proof_type === 'descricao' || t.proof_type === 'foto_descricao';
  const missing = [];
  if (needPhoto && !hasPhoto) missing.push('foto da execução');
  if (needDesc && !hasDesc) missing.push('descrição da execução');
  return { need_photo: needPhoto, need_desc: needDesc, has_photo: hasPhoto, has_desc: hasDesc, ok: missing.length === 0, missing };
}

function validateAssignee(assigneeId, projectId) {
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

  const data = {
    title: str(body.title, { max: 160, required: true, label: 'Título' }),
    description: str(body.description, { max: 5000, required: true, label: 'Descrição' }),
    field_summary: str(body.field_summary, { max: 180, label: 'Resumo para campo' }),
    notes: str(body.notes, { max: 2000, label: 'Observações' }),
    due_date: date(body.due_date, 'Prazo'),
    start_date: date(body.start_date, 'Início previsto'),
    priority: oneOf(body.priority, PRIORITIES, 'Prioridade', 'media'),
    proof_type: oneOf(body.proof_type, PROOF_TYPES, 'Tipo de comprovação', 'nenhuma'),
    assignee_id: validateAssignee(intOrNull(body.assignee_id), projectId),
  };
  assertDateOrder(data.start_date, data.due_date);
  const images = Array.isArray(body.images) ? body.images.slice(0, 10) : [];

  return tx(() => {
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
    const stageId = resolveStage(projectId, body.stage_id);
    const r = run(`INSERT INTO tasks (code, project_id, parent_id, seq, stage_id, title, description, field_summary, notes, assignee_id, assigned_by_id,
        creator_id, start_date, due_date, priority, proof_type, status, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'aberta', ?, ?)`,
      code, projectId, parent?.id ?? null, seq, stageId, data.title, data.description, data.field_summary, data.notes, data.assignee_id,
      data.assignee_id ? ctx.user.id : null, ctx.user.id, data.start_date, data.due_date, data.priority, data.proof_type, now, now);
    const id = Number(r.lastInsertRowid);
    const assignee = data.assignee_id ? one('SELECT name FROM users WHERE id = ?', data.assignee_id).name : 'sem responsável';
    const stageName = one('SELECT name FROM project_stages WHERE id = ?', stageId).name;
    taskHistory(id, ctx.user.id, parent ? `Subtarefa criada em ${parent.code}` : 'Tarefa criada',
      `Classificação: ${stageName} · Responsável: ${assignee} · Prazo: ${fmtDate(data.due_date)} · Prioridade: ${PRIORITY_LABEL[data.priority]} · Comprovação: ${PROOF_LABEL[data.proof_type]}`);
    if (parent) taskHistory(parent.id, ctx.user.id, 'Subtarefa adicionada', `${code} · ${data.title} · Responsável: ${assignee}`);
    for (const img of images) addFileInternal(ctx, id, 'referencia', img.data, img.caption);
    if (images.length) taskHistory(id, ctx.user.id, 'Imagens de referência anexadas', `${images.length} imagem(ns)`);
    return id;
  });
}

const fmtDate = d => (d ? d.split('-').reverse().join('/') : 'sem prazo');

function assertDateOrder(start, due) {
  if (start && due && start > due) throw badRequest('O início previsto deve ser anterior ou igual ao prazo.');
}

export function updateTask(ctx, id, body) {
  const t = loadVisible(ctx, id);
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
  if ('description' in body) set('description', str(body.description, { max: 5000, required: true, label: 'Descrição' }), 'Descrição alterada', () => '');
  if ('field_summary' in body) set('field_summary', str(body.field_summary, { max: 180, label: 'Resumo para campo' }), 'Resumo para campo alterado', () => '');
  if ('notes' in body) set('notes', str(body.notes, { max: 2000, label: 'Observações' }), 'Observações alteradas', () => '');
  if ('due_date' in body) set('due_date', date(body.due_date, 'Prazo'), 'Prazo alterado', fmtDate);
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
  if (!changes.length) return;
  tx(() => {
    const fields = Object.keys(next);
    run(`UPDATE tasks SET ${fields.map(f => `${f} = ?`).join(', ')}, updated_at = ? WHERE id = ?`, ...fields.map(f => next[f]), nowIso(), id);
    for (const [label, from, to] of changes) taskHistory(id, ctx.user.id, label, from || to ? `${from} → ${to}` : null);
  });
}

// Retorno do responsável (descrição/observações da execução)
export function updateExecution(ctx, id, body) {
  const t = loadVisible(ctx, id);
  if (!canExecuteTask(ctx, t)) throw forbidden('Apenas o responsável pode registrar a execução.');
  if (!['aberta', 'em_andamento'].includes(t.status)) throw badRequest('A execução não pode ser alterada neste status.');
  const next = {};
  if ('exec_description' in body) next.exec_description = str(body.exec_description, { max: 5000, label: 'Descrição da execução' });
  if ('exec_notes' in body) next.exec_notes = str(body.exec_notes, { max: 2000, label: 'Observações' });
  const fields = Object.keys(next);
  if (!fields.length) return;
  tx(() => {
    run(`UPDATE tasks SET ${fields.map(f => `${f} = ?`).join(', ')}, updated_at = ? WHERE id = ?`, ...fields.map(f => next[f]), nowIso(), id);
    if ('exec_description' in next) taskHistory(id, ctx.user.id, 'Descrição da execução registrada');
    if ('exec_notes' in next) taskHistory(id, ctx.user.id, 'Observação da execução registrada');
    autoStart(ctx, t);
  });
}

function autoStart(ctx, t) {
  if (t.status === 'aberta') {
    run(`UPDATE tasks SET status = 'em_andamento', started_at = COALESCE(started_at, ?) WHERE id = ?`, nowIso(), t.id);
    taskHistory(t.id, ctx.user.id, 'Status alterado', 'Aberta → Em andamento');
  }
}

function addFileInternal(ctx, taskId, kind, dataUrl, caption) {
  const f = saveImageFromDataUrl(dataUrl);
  run('INSERT INTO task_files (task_id, kind, stored_name, mime, size, caption, uploaded_by, created_at) VALUES (?,?,?,?,?,?,?,?)',
    taskId, kind, f.stored_name, f.mime, f.size, str(caption, { max: 200, label: 'Legenda' }), ctx.user.id, nowIso());
}

export function addFiles(ctx, id, body) {
  const t = loadVisible(ctx, id);
  const kind = oneOf(body.kind, ['referencia', 'execucao'], 'Tipo do arquivo');
  const images = Array.isArray(body.images) ? body.images.slice(0, 10) : [];
  if (!images.length) throw badRequest('Nenhuma imagem enviada.');
  if (kind === 'execucao') {
    if (!canExecuteTask(ctx, t)) throw forbidden('Apenas o responsável pode anexar fotos da execução.');
    if (!['aberta', 'em_andamento'].includes(t.status)) throw badRequest('Não é possível anexar fotos neste status.');
  } else {
    if (!canManageTask(ctx, t) || t.status === 'concluida') throw forbidden('Você não pode anexar referências nesta tarefa.');
  }
  tx(() => {
    for (const img of images) addFileInternal(ctx, id, kind, img.data, img.caption);
    taskHistory(id, ctx.user.id, kind === 'execucao' ? 'Fotos de comprovação enviadas' : 'Imagens de referência anexadas', `${images.length} imagem(ns)`);
    if (kind === 'execucao') autoStart(ctx, t);
  });
}

export function removeFile(ctx, taskId, fileId) {
  const t = loadVisible(ctx, taskId);
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
        const files = all('SELECT kind FROM task_files WHERE task_id = ?', id);
        const pc = proofCheck(t, files);
        if (!pc.ok) throw badRequest(`Comprovação incompleta: falta ${pc.missing.join(' e ')}.`);
        assertSubtasksDone(t);
        change('aguardando_conferencia', ', delivered_at = ?, review_status = \'pendente\', review_comment = NULL, started_at = COALESCE(started_at, ?)', now, now);
        taskHistory(id, ctx.user.id, 'Enviada para conferência', pc.has_photo || pc.has_desc ? 'Comprovação anexada' : null);
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
