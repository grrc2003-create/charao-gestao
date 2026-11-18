// Avisos de tarefas mostrados pelo mascote Charão (canto da tela) até a pessoa marcar "Ciente".
// 1) Aviso de conclusão: quem conclui/entrega escolhe pessoas ("Concluí a tarefa" ou "Concluí com ressalvas").
// 2) Alertas configurados na tarefa (nenhum por padrão): quem recebe e quais eventos (status, prazo, avanço, alterações).
import { all, one, run } from '../db.js';
import { badRequest, forbidden, notFound, str, oneOf, intOrNull } from '../lib/http.js';
import { canSeeUser, canSeeTask, canManageTask } from '../lib/permissions.js';
import { taskHistory, onTaskHistory } from './audit.js';
import { today, daysBetween } from './metrics.js';

export const ALERT_KINDS = ['concluida', 'ressalvas'];
const KIND_LABEL = { concluida: 'Concluí a tarefa', ressalvas: 'Concluí com ressalvas' };
export const WATCH_EVENTS = ['status', 'prazo', 'avanco', 'alteracao'];
const EVENT_LABEL = { status: 'Mudanças de status', prazo: 'Prazo', avanco: 'Avanço e execução', alteracao: 'Alterações na tarefa' };
const MAX_RECIPIENTS = 20;
const nowIso = () => new Date().toISOString();
const dmy = d => d.split('-').reverse().join('/');

// Líderes acima da pessoa (gestor direto, o gestor dele...)
function leaders(userId) {
  const out = [];
  let cur = userId && one('SELECT manager_id FROM users WHERE id = ?', userId)?.manager_id;
  while (cur && !out.includes(cur)) {
    out.push(cur);
    cur = one('SELECT manager_id FROM users WHERE id = ?', cur)?.manager_id;
  }
  return out;
}

// Quem pode ser avisado: pessoas que o usuário já vê no sistema + as ligadas à tarefa
// (quem pediu, quem atribuiu, o responsável, o responsável do projeto e os líderes de quem conclui e do responsável).
// Só pessoas ativas e com acesso ao sistema (precisam entrar para ver o aviso).
export function notifyOptions(ctx, t, { includeSelf = false } = {}) {
  const lead = t.project_id ? one('SELECT lead_id FROM projects WHERE id = ?', t.project_id)?.lead_id : null;
  const involved = new Set([t.creator_id, t.assigned_by_id, t.assignee_id, lead, ...leaders(ctx.user.id), ...leaders(t.assignee_id)].filter(Boolean));
  return all('SELECT id, name, job_title FROM users WHERE active = 1 AND login_enabled = 1 ORDER BY name')
    .filter(u => (u.id === ctx.user.id ? includeSelf : involved.has(u.id) || canSeeUser(ctx, u.id)))
    .map(u => ({ id: u.id, name: u.name, job_title: u.job_title || null, involved: involved.has(u.id), self: u.id === ctx.user.id }));
}

const readIds = v => {
  if (v === undefined || v === null || v === '') return [];
  const list = Array.isArray(v) ? v : String(v).split(',');
  return [...new Set(list.map(Number).filter(n => Number.isInteger(n) && n > 0))];
};

// ---------- 1) Aviso de conclusão ----------
// Lê e valida o aviso enviado junto com a conclusão (opcional: sem pessoas, nada é enviado)
export function readNotify(ctx, t, body = {}) {
  const ids = readIds(body.notify_ids);
  if (!ids.length) return null;
  if (ids.length > MAX_RECIPIENTS) throw badRequest(`Escolha no máximo ${MAX_RECIPIENTS} pessoas para avisar.`);
  const allowed = new Set(notifyOptions(ctx, t).map(u => u.id));
  if (ids.some(id => !allowed.has(id))) throw badRequest('Escolha pessoas da lista para avisar.');
  const kind = oneOf(body.notify_kind, ALERT_KINDS, 'Tipo do aviso', 'concluida');
  const note = str(body.notify_note, { max: 1000, label: 'Ressalvas' });
  if (kind === 'ressalvas' && !note) throw badRequest('Descreva as ressalvas do aviso.');
  return { ids, kind, note: kind === 'ressalvas' ? note : null };
}

export function sendNotify(ctx, taskId, n) {
  if (!n) return;
  const now = nowIso();
  for (const id of n.ids) {
    run('INSERT INTO task_alerts (task_id, sender_id, recipient_id, kind, tone, title, note, created_at) VALUES (?,?,?,?,?,?,?,?)',
      taskId, ctx.user.id, id, n.kind, n.kind === 'ressalvas' ? 'atencao' : 'parabens', KIND_LABEL[n.kind], n.note, now);
  }
  const names = all(`SELECT name FROM users WHERE id IN (${n.ids.map(() => '?').join(',')}) ORDER BY name`, ...n.ids).map(r => r.name).join(', ');
  taskHistory(taskId, ctx.user.id, 'Aviso de conclusão enviado', `${KIND_LABEL[n.kind]} → ${names}${n.note ? ` · Ressalvas: ${n.note}` : ''}`);
}

// ---------- 2) Alertas configurados na tarefa ----------
// Lê a configuração (eventos, dias antes do prazo e quem recebe). Nada marcado = sem alertas.
export function readWatch(ctx, t, cfg) {
  if (!cfg || typeof cfg !== 'object') return null;
  const events = [...new Set((Array.isArray(cfg.events) ? cfg.events : []).filter(e => WATCH_EVENTS.includes(e)))];
  const ids = readIds(cfg.user_ids);
  if (!events.length || !ids.length) {
    if (events.length && !ids.length) throw badRequest('Alertas da tarefa: escolha quem recebe.');
    if (ids.length && !events.length) throw badRequest('Alertas da tarefa: escolha ao menos um evento.');
    return { events: [], due_days: null, ids: [] };
  }
  if (ids.length > MAX_RECIPIENTS) throw badRequest(`Alertas da tarefa: no máximo ${MAX_RECIPIENTS} pessoas.`);
  const allowed = new Set(notifyOptions(ctx, t, { includeSelf: true }).map(u => u.id));
  if (ids.some(id => !allowed.has(id))) throw badRequest('Alertas da tarefa: escolha pessoas da lista.');
  let dueDays = null;
  if (events.includes('prazo')) {
    dueDays = cfg.due_days === undefined || cfg.due_days === null || cfg.due_days === '' ? 2 : Number(cfg.due_days);
    if (!Number.isInteger(dueDays) || dueDays < 0 || dueDays > 60) throw badRequest('Alertas da tarefa: dias antes do prazo deve ser de 0 a 60.');
  }
  return { events, due_days: dueDays, ids };
}

const watchLabel = w => w.events.map(e => (e === 'prazo' ? `Prazo (${w.due_days === 0 ? 'no dia' : `${w.due_days} dia(s) antes`} e atraso)` : EVENT_LABEL[e])).join(', ');

export function saveWatch(ctx, taskId, w, { silentIfEmpty = false } = {}) {
  if (!w) return;
  const before = watchOf(taskId);
  if (silentIfEmpty && !w.ids.length && !before.users.length) return;
  run('DELETE FROM task_watchers WHERE task_id = ?', taskId);
  const now = nowIso();
  for (const id of w.ids) {
    run('INSERT INTO task_watchers (task_id, user_id, events, due_days, created_by, created_at) VALUES (?,?,?,?,?,?)',
      taskId, id, JSON.stringify(w.events), w.due_days, ctx.user.id, now);
  }
  if (!w.ids.length) { if (before.users.length) taskHistory(taskId, ctx.user.id, 'Alertas da tarefa removidos', null); return; }
  const names = all(`SELECT name FROM users WHERE id IN (${w.ids.map(() => '?').join(',')}) ORDER BY name`, ...w.ids).map(r => r.name).join(', ');
  taskHistory(taskId, ctx.user.id, before.users.length ? 'Alertas da tarefa alterados' : 'Alertas da tarefa configurados', `${watchLabel(w)} → ${names}`);
}

export function watchOf(taskId) {
  const rows = all('SELECT w.user_id, w.events, w.due_days, u.name FROM task_watchers w JOIN users u ON u.id = w.user_id WHERE w.task_id = ? ORDER BY u.name', taskId);
  const first = rows[0];
  return { events: first ? JSON.parse(first.events) : [], due_days: first?.due_days ?? null, users: rows.map(r => ({ id: r.user_id, name: r.name })) };
}

export function getWatch(ctx, t) {
  const w = watchOf(t.id);
  const canEdit = canManageTask(ctx, t);
  return { ...w, label: w.users.length ? watchLabel(w) : '', can_edit: canEdit, options: canEdit ? notifyOptions(ctx, t, { includeSelf: true }) : [] };
}

export function updateWatch(ctx, t, body) {
  if (!canManageTask(ctx, t)) throw forbidden('Você não pode alterar os alertas desta tarefa.');
  saveWatch(ctx, t.id, readWatch(ctx, t, body) || { events: [], due_days: null, ids: [] });
}

// Eventos do histórico da tarefa que viram alerta (o evento de quem fez a ação não avisa a própria pessoa)
const ALTERACOES = ['Responsável alterado', 'Prazo definido', 'Início previsto alterado', 'Prazo ajustado por dependência', 'Prazo antecipado por dependência',
  'Datas ajustadas pela dependência', 'Datas definidas pelas dependências', 'Datas corrigidas pelo Administrador', 'Prioridade alterada'];
function classify(action, details) {
  const to = details && details.includes('→') ? details.split('→').pop().split(' · ')[0].trim() : '';
  if (action === 'Status alterado') return { kind: 'status', tone: /^Conclu/.test(to) ? 'parabens' : 'atencao', title: `Status: ${to}`, note: null };
  if (action === 'Devolvida para ajustes') return { kind: 'status', tone: 'insatisfacao', title: 'Devolvida para ajustes', note: details };
  if (action === 'Tarefa cancelada') return { kind: 'status', tone: 'insatisfacao', title: 'Tarefa cancelada', note: details };
  if (action === 'Tarefa reativada' || action === 'Tarefa reaberta') return { kind: 'status', tone: 'atencao', title: action, note: details };
  if (action === 'Avanço atualizado' || action === 'Avanço removido') return { kind: 'avanco', tone: 'atencao', title: action === 'Avanço removido' ? 'Avanço removido' : `Avanço: ${to}`, note: null };
  if (['Descrição da execução registrada', 'Observação da execução registrada', 'Fotos de comprovação enviadas'].includes(action)) return { kind: 'avanco', tone: 'atencao', title: action, note: null };
  if (ALTERACOES.includes(action) || action.startsWith('Prazo reagendado')) return { kind: 'alteracao', tone: 'atencao', title: action.replace(/ \(\d+º reagendamento\)/, ''), note: details };
  return null;
}

// Um alerta por tipo e tarefa enquanto a pessoa não marca "Ciente": o mais recente substitui o anterior
onTaskHistory((taskId, userId, action, details) => {
  const c = classify(action, details);
  if (!c) return;
  const watchers = all('SELECT user_id, events FROM task_watchers WHERE task_id = ?', taskId);
  if (!watchers.length) return;
  const now = nowIso();
  for (const w of watchers) {
    if (w.user_id === userId || !JSON.parse(w.events).includes(c.kind)) continue;
    const open = one('SELECT id FROM task_alerts WHERE task_id = ? AND recipient_id = ? AND kind = ? AND seen_at IS NULL', taskId, w.user_id, c.kind);
    if (open) run('UPDATE task_alerts SET sender_id = ?, tone = ?, title = ?, note = ?, created_at = ? WHERE id = ?', userId, c.tone, c.title, c.note, now, open.id);
    else run('INSERT INTO task_alerts (task_id, sender_id, recipient_id, kind, tone, title, note, created_at) VALUES (?,?,?,?,?,?,?,?)',
      taskId, userId, w.user_id, c.kind, c.tone, c.title, c.note, now);
  }
});

// Prazo: X dias antes e quando atrasa — gerados ao consultar os avisos (uma vez por prazo)
function checkDeadlines(userId) {
  const td = today();
  const rows = all(`SELECT w.task_id, w.events, w.due_days, t.due_date FROM task_watchers w JOIN tasks t ON t.id = w.task_id
    WHERE w.user_id = ? AND t.cancelled_at IS NULL AND t.status IN ('aberta','em_andamento') AND t.due_date IS NOT NULL`, userId);
  const now = nowIso();
  for (const r of rows) {
    if (!JSON.parse(r.events).includes('prazo')) continue;
    const left = daysBetween(td, r.due_date);
    if (left < 0) {
      run(`INSERT OR IGNORE INTO task_alerts (task_id, recipient_id, kind, tone, title, note, dedupe_key, created_at) VALUES (?,?,?,?,?,?,?,?)`,
        r.task_id, userId, 'atraso', 'insatisfacao', 'Tarefa atrasada', `Prazo era ${dmy(r.due_date)}`, `atraso:${r.task_id}:${r.due_date}`, now);
    } else if (r.due_days !== null && left <= r.due_days) {
      run(`INSERT OR IGNORE INTO task_alerts (task_id, recipient_id, kind, tone, title, note, dedupe_key, created_at) VALUES (?,?,?,?,?,?,?,?)`,
        r.task_id, userId, 'prazo', 'atencao', left === 0 ? 'Prazo vence hoje' : `Prazo em ${left} dia(s)`, `Prazo: ${dmy(r.due_date)}`, `prazo:${r.task_id}:${r.due_date}`, now);
    }
  }
}

// Avisos ainda não marcados como "Ciente" de quem está usando
export function myAlerts(ctx) {
  checkDeadlines(ctx.user.id);
  return all(`SELECT a.id, a.task_id, a.kind, a.tone, a.title, a.note, a.created_at, s.name AS sender_name,
      t.code, t.title AS task_title, t.project_id, t.assignee_id, t.creator_id, p.name AS project_name
    FROM task_alerts a LEFT JOIN users s ON s.id = a.sender_id JOIN tasks t ON t.id = a.task_id LEFT JOIN projects p ON p.id = t.project_id
    WHERE a.recipient_id = ? AND a.seen_at IS NULL ORDER BY a.created_at DESC, a.id DESC LIMIT 50`, ctx.user.id)
    .map(a => {
      const canOpen = canSeeTask(ctx, { id: a.task_id, project_id: a.project_id, assignee_id: a.assignee_id, creator_id: a.creator_id });
      return { id: a.id, task_id: a.task_id, kind: a.kind, tone: a.tone, kind_label: a.title, note: a.note, created_at: a.created_at,
        sender_name: a.sender_name || 'Charão', code: a.code, title: a.task_title, project_name: canOpen ? a.project_name : null, can_open: canOpen };
    });
}

// "Ciente": some do painel; o aviso de conclusão fica registrado no histórico da tarefa
export function markSeen(ctx, id) {
  const a = one('SELECT id, task_id, kind, title FROM task_alerts WHERE id = ? AND recipient_id = ? AND seen_at IS NULL', id, ctx.user.id);
  if (!a) throw notFound('Aviso não encontrado.');
  run('UPDATE task_alerts SET seen_at = ? WHERE id = ?', nowIso(), a.id);
  if (ALERT_KINDS.includes(a.kind)) taskHistory(a.task_id, ctx.user.id, 'Aviso de conclusão: ciente', `${ctx.user.name} viu o aviso "${a.title}"`);
}

export function markAllSeen(ctx) {
  for (const a of all('SELECT id FROM task_alerts WHERE recipient_id = ? AND seen_at IS NULL', ctx.user.id)) markSeen(ctx, a.id);
}

// Criação da tarefa: valida antes de criar (para não criar a tarefa com alertas inválidos)
export function readWatchForNew(ctx, body) {
  if (!body.alerts) return null;
  const pseudo = { project_id: intOrNull(body.project_id), assignee_id: intOrNull(body.assignee_id), creator_id: ctx.user.id, assigned_by_id: ctx.user.id };
  return readWatch(ctx, pseudo, body.alerts);
}
