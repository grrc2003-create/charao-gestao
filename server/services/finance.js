// Tarefas financeiras: obrigações mensais/periódicas que geram parcelas (Pendente → Paga, com valor e comprovante).
// Cada parcela é também uma tarefa na área interna restrita "Financeiro" (responsável e prazo), visível só para liberados.
import { all, one, run, tx } from '../db.js';
import { badRequest, forbidden, notFound, str, oneOf, date, intOrNull } from '../lib/http.js';
import { audit, taskHistory } from './audit.js';
import { today } from './metrics.js';
import { defaultStageId } from './stages.js';
import { saveImageFromDataUrl, isPdf, cleanFileName } from './files.js';
import { insertTask } from './tasks.js';
import { billedByMonth } from './contracts.js';

export const CATEGORIES = ['Impostos', 'Folha de pagamento', 'Encargos e benefícios', 'Aluguel e condomínio', 'Fornecedores', 'Financiamentos e empréstimos', 'Seguros', 'Serviços e assinaturas', 'Contas de consumo', 'Outros'];
export const FREQUENCIES = { mensal: 1, bimestral: 2, trimestral: 3, semestral: 6, anual: 12, unica: 0 };
export const FREQ_LABEL = { mensal: 'Mensal', bimestral: 'Bimestral', trimestral: 'Trimestral', semestral: 'Semestral', anual: 'Anual', unica: 'Única' };
const MONTHS = ['JAN', 'FEV', 'MAR', 'ABR', 'MAI', 'JUN', 'JUL', 'AGO', 'SET', 'OUT', 'NOV', 'DEZ'];
const monthLabel = ym => `${MONTHS[Number(ym.slice(5, 7)) - 1]}/${ym.slice(2, 4)}`;
const r2 = v => Math.round((Number(v) || 0) * 100) / 100;
const brl = v => (Number(v) || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const num = (v, label) => {
  if (v === '' || v === null || v === undefined) return 0;
  const s = typeof v === 'number' ? v : String(v).trim();
  const n = typeof s === 'number' ? s : Number(s.includes(',') ? s.replace(/\./g, '').replace(',', '.') : s);
  if (!Number.isFinite(n) || n < 0) throw badRequest(`${label}: valor inválido.`);
  return n;
};
const addMonths = (ym, k) => { let [y, m] = ym.split('-').map(Number); m += k; while (m > 12) { m -= 12; y++; } while (m < 1) { m += 12; y--; } return `${y}-${String(m).padStart(2, '0')}`; };
const dueOf = (ym, day) => {
  const [y, m] = ym.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${ym}-${String(Math.min(day, last)).padStart(2, '0')}`;
};

export const canFinance = user => !!user?.can_finance;
export function requireFinance(user) {
  if (!canFinance(user)) throw forbidden('Acesso restrito: solicite a liberação de Tarefas financeiras ao administrador.');
}

// ---------- Área interna restrita "Financeiro" ----------
export function ensureFinanceArea() {
  if (one(`SELECT value FROM app_settings WHERE key = 'finance_area_created'`)) return null;
  return tx(() => {
    const r0 = one(`SELECT MAX(CAST(SUBSTR(code, 5) AS INTEGER)) AS n FROM projects WHERE code LIKE 'INT-%'`);
    const code = `INT-${String((r0?.n || 0) + 1).padStart(3, '0')}`;
    const now = new Date().toISOString();
    const r = run(`INSERT INTO projects (code, name, client, description, status, kind, restricted, created_at, updated_at) VALUES (?,?,?,?, 'em_andamento', 'interno', 2, ?, ?)`,
      code, 'Financeiro (restrito)', 'Charão Engenharia e Construção', 'Obrigações financeiras mensais e periódicas. Visível somente para quem tem a liberação de Tarefas financeiras.', now, now);
    const id = Number(r.lastInsertRowid);
    defaultStageId(id);
    run(`INSERT INTO app_settings (key, value) VALUES ('finance_area_created', ?)`, String(id));
    audit(null, 'finance', null, 'Área interna restrita do Financeiro criada', { codigo: code });
    return id;
  });
}
export const financeAreaId = () => one('SELECT id FROM projects WHERE restricted = 2 ORDER BY id LIMIT 1')?.id || null;

// Classificação da tarefa = categoria da obrigação (criada na área quando não existe)
function stageFor(areaId, category) {
  const s = one('SELECT id FROM project_stages WHERE project_id = ? AND name = ? COLLATE NOCASE', areaId, category);
  if (s) return s.id;
  const n = one('SELECT COALESCE(MAX(sort_order), 0) AS n FROM project_stages WHERE project_id = ?', areaId).n;
  return Number(run('INSERT INTO project_stages (project_id, name, sort_order) VALUES (?,?,?)', areaId, category, n + 1).lastInsertRowid);
}

// ---------- Geração das parcelas (e das tarefas) ----------
const HORIZON = 2; // gera até 2 meses à frente do mês atual
function monthsOf(o, until) {
  const step = FREQUENCIES[o.frequency];
  const last = o.end_month && o.end_month < until ? o.end_month : until;
  const out = [];
  if (!step) { if (o.start_month <= last) out.push(o.start_month); return out; }
  for (let m = o.start_month; m <= last; m = addMonths(m, step)) out.push(m);
  return out;
}

function taskTitle(o, ref) { return `${o.title} — ${monthLabel(ref)}`; }
function taskDescription(o, amount) {
  return [`Obrigação financeira · ${o.category}${o.payee ? ` · ${o.payee}` : ''}`, `Valor previsto: ${brl(amount)}${o.variable ? ' (valor variável)' : ''}`, 'Registre o pagamento em Tarefas financeiras (data, valor e comprovante).', o.notes || ''].filter(Boolean).join('\n');
}

// Valor da parcela anterior da mesma obrigação (pago, se houver; senão o previsto)
export function previousAmount(obligationId, ref) {
  const it = one('SELECT amount_expected, paid_amount, status FROM finance_items WHERE obligation_id = ? AND ref_month < ? ORDER BY ref_month DESC LIMIT 1', obligationId, ref);
  return it ? r2(it.status === 'paga' && it.paid_amount != null ? it.paid_amount : it.amount_expected) : null;
}

function createItem(o, ref, userId) {
  const area = one('SELECT * FROM projects WHERE id = ?', financeAreaId() || ensureFinanceArea() || financeAreaId());
  const due = dueOf(ref, o.due_day);
  const amount = o.variable && o.repeat_last ? previousAmount(o.id, ref) ?? o.amount : o.amount;
  const r = run('INSERT INTO finance_items (obligation_id, ref_month, due_date, amount_expected, estimated) VALUES (?,?,?,?,?)', o.id, ref, due, amount, o.variable ? 1 : 0);
  const itemId = Number(r.lastInsertRowid);
  const assignee = o.assignee_id && one('SELECT id FROM users WHERE id = ? AND active = 1 AND can_finance = 1', o.assignee_id) ? o.assignee_id : null;
  const taskId = insertTask({
    project: area,
    data: { task_type: 'tarefa', title: taskTitle(o, ref), description: taskDescription(o, amount), field_summary: null, notes: null, due_date: due, start_date: due, priority: 'media', proof_type: 'nenhuma', assignee_id: assignee },
    stageInput: stageFor(area.id, o.category),
    creatorId: userId || o.created_by,
  });
  run('UPDATE finance_items SET task_id = ? WHERE id = ?', taskId, itemId);
  return itemId;
}

export function generateItems(userId = null) {
  if (!financeAreaId()) ensureFinanceArea();
  const until = addMonths(today().slice(0, 7), HORIZON);
  let n = 0;
  for (const o of all('SELECT * FROM finance_obligations WHERE active = 1')) {
    const have = new Set(all('SELECT ref_month FROM finance_items WHERE obligation_id = ?', o.id).map(r => r.ref_month));
    for (const ref of monthsOf(o, until)) if (!have.has(ref)) { tx(() => createItem(o, ref, userId)); n++; }
  }
  return n;
}

// Remove parcelas pendentes futuras que não valem mais (obrigação inativada, término antecipado) e cancela as tarefas
function pruneFuture(o, userId) {
  const cur = today().slice(0, 7);
  const valid = new Set(o.active ? monthsOf(o, addMonths(cur, HORIZON)) : []);
  for (const it of all(`SELECT * FROM finance_items WHERE obligation_id = ? AND status = 'pendente' AND ref_month > ?`, o.id, cur)) {
    if (valid.has(it.ref_month)) continue;
    if (it.task_id) {
      run(`UPDATE tasks SET cancelled_at = ?, cancelled_by = ?, cancel_reason = ?, updated_at = ? WHERE id = ? AND cancelled_at IS NULL`,
        new Date().toISOString(), userId, 'Parcela financeira removida (obrigação alterada ou inativada)', new Date().toISOString(), it.task_id);
      taskHistory(it.task_id, userId, 'Tarefa cancelada', 'Parcela financeira removida (obrigação alterada ou inativada)');
    }
    run('DELETE FROM finance_items WHERE id = ?', it.id);
  }
}

// ---------- Obrigações ----------
export function readObligation(body) {
  const d = {
    title: str(body.title, { max: 160, required: true, label: 'Descrição' }),
    category: str(body.category, { max: 60, label: 'Categoria' }) || 'Outros',
    payee: str(body.payee, { max: 160, label: 'Favorecido' }),
    amount: r2(num(body.amount, 'Valor previsto')),
    variable: body.variable === true || body.variable === 1 || body.variable === '1' || body.variable === 'on' ? 1 : 0,
    repeat_last: body.repeat_last === true || body.repeat_last === 1 || body.repeat_last === '1' || body.repeat_last === 'on' ? 1 : 0,
    frequency: oneOf(body.frequency, Object.keys(FREQUENCIES), 'Periodicidade', 'mensal'),
    due_day: intOrNull(body.due_day) || 10,
    start_month: /^\d{4}-\d{2}$/.test(String(body.start_month || '')) ? body.start_month : today().slice(0, 7),
    end_month: /^\d{4}-\d{2}$/.test(String(body.end_month || '')) ? body.end_month : null,
    assignee_id: intOrNull(body.assignee_id),
    notes: str(body.notes, { max: 2000, label: 'Observações' }),
    active: body.active === false || body.active === 0 || body.active === '0' ? 0 : 1,
  };
  if (d.due_day < 1 || d.due_day > 31) throw badRequest('Dia de vencimento: informe de 1 a 31.');
  if (d.end_month && d.end_month < d.start_month) throw badRequest('O término deve ser depois do início.');
  if (d.assignee_id && !one('SELECT id FROM users WHERE id = ? AND active = 1 AND can_finance = 1', d.assignee_id)) {
    throw badRequest('O responsável precisa ter a liberação de Tarefas financeiras.');
  }
  return d;
}

export function listObligations(ctx) {
  requireFinance(ctx.user);
  return all(`SELECT o.*, u.name AS assignee_name,
      (SELECT COUNT(*) FROM finance_items i WHERE i.obligation_id = o.id AND i.status = 'pendente' AND i.due_date < ?) AS overdue,
      (SELECT MIN(i.due_date) FROM finance_items i WHERE i.obligation_id = o.id AND i.status = 'pendente') AS next_due
    FROM finance_obligations o LEFT JOIN users u ON u.id = o.assignee_id ORDER BY o.active DESC, o.category, o.title`, today())
    .map(o => ({ ...o, frequency_label: FREQ_LABEL[o.frequency] }));
}

export function getObligation(ctx, id) {
  requireFinance(ctx.user);
  const o = one('SELECT o.*, u.name AS assignee_name FROM finance_obligations o LEFT JOIN users u ON u.id = o.assignee_id WHERE o.id = ?', id);
  if (!o) throw notFound('Obrigação não encontrada.');
  return { ...o, frequency_label: FREQ_LABEL[o.frequency], items: all('SELECT * FROM finance_items WHERE obligation_id = ? ORDER BY ref_month DESC', id) };
}

// Grava a obrigação (sem gerar as parcelas — quem chama roda generateItems). Usado no cadastro e na importação.
export function insertObligation(ctx, d, ip, { imported = false } = {}) {
  if (!d.assignee_id) d.assignee_id = ctx.user.id; // sem responsável: quem cadastrou
  return tx(() => {
    const r = run(`INSERT INTO finance_obligations (title, category, payee, amount, variable, repeat_last, frequency, due_day, start_month, end_month, assignee_id, notes, active, created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, d.title, d.category, d.payee, d.amount, d.variable, d.variable ? d.repeat_last : 0, d.frequency, d.due_day, d.start_month, d.end_month, d.assignee_id, d.notes, d.active, ctx.user.id);
    const nid = Number(r.lastInsertRowid);
    audit(ctx.user.id, 'finance', nid, imported ? 'Obrigação financeira importada de planilha' : 'Obrigação financeira cadastrada', { descricao: d.title, categoria: d.category, valor: d.amount, periodicidade: FREQ_LABEL[d.frequency], vencimento: `dia ${d.due_day}` }, ip);
    return nid;
  });
}

export function createObligation(ctx, body, ip) {
  requireFinance(ctx.user);
  const id = insertObligation(ctx, readObligation(body), ip);
  generateItems(ctx.user.id);
  return id;
}

export function updateObligation(ctx, id, body, ip) {
  requireFinance(ctx.user);
  const o = one('SELECT * FROM finance_obligations WHERE id = ?', id);
  if (!o) throw notFound('Obrigação não encontrada.');
  const d = readObligation({ ...o, ...body });
  const cur = today().slice(0, 7);
  tx(() => {
    run(`UPDATE finance_obligations SET title=?, category=?, payee=?, amount=?, variable=?, repeat_last=?, frequency=?, due_day=?, start_month=?, end_month=?, assignee_id=?, notes=?, active=?, updated_at=datetime('now') WHERE id=?`,
      d.title, d.category, d.payee, d.amount, d.variable, d.variable ? d.repeat_last : 0, d.frequency, d.due_day, d.start_month, d.end_month, d.assignee_id, d.notes, d.active, id);
    const no = { ...o, ...d, id };
    // Parcelas pendentes do mês atual em diante acompanham a obrigação (valor, vencimento, responsável e título da tarefa)
    const area = financeAreaId();
    for (const it of all(`SELECT * FROM finance_items WHERE obligation_id = ? AND status = 'pendente' AND ref_month >= ?`, id, cur)) {
      const due = dueOf(it.ref_month, no.due_day);
      const amount = no.variable && o.variable ? it.amount_expected : no.amount;
      run('UPDATE finance_items SET due_date = ?, amount_expected = ? WHERE id = ?', due, amount, it.id);
      if (it.task_id) run('UPDATE tasks SET title = ?, description = ?, due_date = ?, start_date = ?, assignee_id = ?, stage_id = ?, updated_at = ? WHERE id = ? AND status <> \'concluida\'',
        taskTitle(no, it.ref_month), taskDescription(no, amount), due, due, no.assignee_id, stageFor(area, no.category), new Date().toISOString(), it.task_id);
    }
    pruneFuture(no, ctx.user.id);
    audit(ctx.user.id, 'finance', id, d.active ? 'Obrigação financeira atualizada' : 'Obrigação financeira inativada', { descricao: d.title, campos: Object.keys(d).filter(k => (d[k] ?? null) !== (o[k] ?? null)) }, ip);
  });
  generateItems(ctx.user.id);
}

// ---------- Uso interno (Folha): obrigação única por pessoa, sem exigir a liberação do Financeiro ----------
export function createObligationInternal(userId, d) {
  const assignee = d.assignee_id && one('SELECT id FROM users WHERE id = ? AND active = 1 AND can_finance = 1', d.assignee_id) ? d.assignee_id : null;
  const id = Number(run(`INSERT INTO finance_obligations (title, category, payee, amount, variable, frequency, due_day, start_month, end_month, assignee_id, notes, active, created_by)
    VALUES (?,?,?,?,0,'unica',?,?,?,?,?,1,?)`, d.title, d.category || 'Folha de pagamento', d.payee || null, r2(d.amount), d.due_day, d.month, d.month, assignee, d.notes || null, userId).lastInsertRowid);
  createItem(one('SELECT * FROM finance_obligations WHERE id = ?', id), d.month, userId);
  return id;
}
// Folha: corrige (ou restaura) o valor da parcela pré-lançada e registra na tarefa
export function setItemAmountInternal(itemId, amount, userId, { estimated = 0, history, extra } = {}) {
  const it = one('SELECT * FROM finance_items WHERE id = ?', itemId);
  if (!it) return;
  run('UPDATE finance_items SET amount_expected = ?, estimated = ? WHERE id = ?', r2(amount), estimated, itemId);
  if (it.task_id) {
    const o = one('SELECT * FROM finance_obligations WHERE id = ?', it.obligation_id);
    run('UPDATE tasks SET description = ?, updated_at = ? WHERE id = ?', [taskDescription(o, r2(amount)), extra].filter(Boolean).join('\n\n'), new Date().toISOString(), it.task_id);
    if (history) taskHistory(it.task_id, userId, history, `${brl(it.amount_expected)} → ${brl(amount)}`);
  }
}
// Algum pagamento já registrado? (a folha só reabre se nada foi pago)
export const obligationPaid = id => !!one(`SELECT 1 FROM finance_items WHERE obligation_id = ? AND status = 'paga' LIMIT 1`, id);
export function removeObligationInternal(id, userId, reason) {
  for (const it of all('SELECT * FROM finance_items WHERE obligation_id = ?', id)) {
    if (!it.task_id) continue;
    run(`UPDATE tasks SET cancelled_at = ?, cancelled_by = ?, cancel_reason = ?, updated_at = ? WHERE id = ? AND cancelled_at IS NULL`,
      new Date().toISOString(), userId, reason, new Date().toISOString(), it.task_id);
    taskHistory(it.task_id, userId, 'Tarefa cancelada', reason);
  }
  run('DELETE FROM finance_items WHERE obligation_id = ?', id);
  run('DELETE FROM finance_obligations WHERE id = ?', id);
}

// ---------- Parcelas ----------
function loadItem(ctx, id) {
  requireFinance(ctx.user);
  const it = one('SELECT i.*, o.title, o.category, o.payee, o.variable FROM finance_items i JOIN finance_obligations o ON o.id = i.obligation_id WHERE i.id = ?', id);
  if (!it) throw notFound('Parcela não encontrada.');
  return it;
}

export function payItem(ctx, id, body, ip) {
  const it = loadItem(ctx, id);
  if (it.status === 'paga') throw badRequest('Esta parcela já está paga.');
  const pd = date(body.paid_date, 'Data do pagamento') || today();
  if (pd > today()) throw badRequest('A data do pagamento não pode ser no futuro.');
  const amount = body.paid_amount === '' || body.paid_amount === undefined || body.paid_amount === null ? it.amount_expected : r2(num(body.paid_amount, 'Valor pago'));
  const files = Array.isArray(body.files) ? body.files.slice(0, 5) : [];
  const now = new Date().toISOString();
  tx(() => {
    run(`UPDATE finance_items SET status = 'paga', estimated = 0, paid_date = ?, paid_amount = ?, notes = ?, paid_by = ? WHERE id = ?`, pd, amount, str(body.notes, { max: 1000, label: 'Observação' }) || it.notes, ctx.user.id, id);
    if (it.task_id) {
      for (const f of files) {
        const s = saveImageFromDataUrl(f.data);
        run('INSERT INTO task_files (task_id, kind, stored_name, mime, size, caption, original_name, uploaded_by, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
          it.task_id, 'execucao', s.stored_name, s.mime, s.size, 'Comprovante de pagamento', isPdf(s.mime) ? cleanFileName(f.name) || 'comprovante.pdf' : null, ctx.user.id, now);
      }
      run(`UPDATE tasks SET status = 'concluida', started_at = COALESCE(started_at, ?), delivered_at = ?, completed_at = ?, review_status = 'aprovada', reviewed_by = ?, reviewed_at = ?, progress_pct = 100, updated_at = ? WHERE id = ?`,
        now, `${pd}T15:00:00.000Z`, now, ctx.user.id, now, now, it.task_id);
      taskHistory(it.task_id, ctx.user.id, 'Pagamento registrado', `${brl(amount)} pago em ${pd.split('-').reverse().join('/')}${files.length ? ` · ${files.length} comprovante(s)` : ''} (Tarefas financeiras)`);
    }
    audit(ctx.user.id, 'finance', it.obligation_id, 'Parcela paga', { parcela: `${it.title} ${monthLabel(it.ref_month)}`, valor: amount, data: pd }, ip);
  });
  return getItem(ctx, id);
}

export function unpayItem(ctx, id, ip) {
  const it = loadItem(ctx, id);
  if (it.status !== 'paga') throw badRequest('Esta parcela não está paga.');
  tx(() => {
    run(`UPDATE finance_items SET status = 'pendente', paid_date = NULL, paid_amount = NULL, paid_by = NULL WHERE id = ?`, id);
    if (it.task_id) {
      run(`UPDATE tasks SET status = 'aberta', delivered_at = NULL, completed_at = NULL, review_status = NULL, reviewed_by = NULL, reviewed_at = NULL, progress_pct = NULL, updated_at = ? WHERE id = ?`, new Date().toISOString(), it.task_id);
      taskHistory(it.task_id, ctx.user.id, 'Pagamento desfeito', 'Parcela voltou a pendente (Tarefas financeiras)');
    }
    audit(ctx.user.id, 'finance', it.obligation_id, 'Pagamento desfeito', { parcela: `${it.title} ${monthLabel(it.ref_month)}` }, ip);
  });
  return getItem(ctx, id);
}

// Valor previsto de uma parcela pendente (obrigações de valor variável)
export function setItemAmount(ctx, id, body, ip) {
  const it = loadItem(ctx, id);
  if (it.status === 'paga') throw badRequest('Parcela paga: desfaça o pagamento para alterar o valor previsto.');
  const amount = body.use_previous ? previousAmount(it.obligation_id, it.ref_month) : r2(num(body.amount_expected, 'Valor previsto'));
  if (amount == null) throw badRequest('Não há parcela anterior desta obrigação.');
  const estimated = body.estimated === undefined ? it.estimated : body.estimated === true || body.estimated === 1 || body.estimated === '1' || body.estimated === 'on' ? 1 : 0;
  tx(() => {
    run('UPDATE finance_items SET amount_expected = ?, estimated = ? WHERE id = ?', amount, estimated, id);
    if (it.task_id) {
      const o = one('SELECT * FROM finance_obligations WHERE id = ?', it.obligation_id);
      run('UPDATE tasks SET description = ?, updated_at = ? WHERE id = ?', taskDescription(o, amount), new Date().toISOString(), it.task_id);
      taskHistory(it.task_id, ctx.user.id, 'Valor previsto ajustado', `${brl(it.amount_expected)} → ${brl(amount)}`);
    }
    audit(ctx.user.id, 'finance', it.obligation_id, 'Valor da parcela ajustado', { parcela: `${it.title} ${monthLabel(it.ref_month)}`, de: it.amount_expected, para: amount }, ip);
  });
  return getItem(ctx, id);
}

export function getItem(ctx, id) {
  const it = loadItem(ctx, id);
  const files = it.task_id ? all(`SELECT id, mime, original_name, created_at FROM task_files WHERE task_id = ? AND kind = 'execucao' ORDER BY id`, it.task_id) : [];
  return { ...it, files };
}

// Tarefa da parcela concluída/reaberta pela tela de tarefas: a parcela acompanha (valor previsto, data de hoje)
export function syncFromTask(taskId, action, userId) {
  const it = one('SELECT * FROM finance_items WHERE task_id = ?', taskId);
  if (!it) return;
  if ((action === 'approve' || action === 'conclude') && it.status === 'pendente') {
    run(`UPDATE finance_items SET status = 'paga', paid_date = ?, paid_amount = amount_expected, paid_by = ? WHERE id = ?`, today(), userId, it.id);
  } else if (action === 'reopen' && it.status === 'paga') {
    run(`UPDATE finance_items SET status = 'pendente', paid_date = NULL, paid_amount = NULL, paid_by = NULL WHERE id = ?`, it.id);
  }
}

// Quem pode ser responsável: usuários ativos com a liberação de Tarefas financeiras
export function financeAssignees(ctx) {
  requireFinance(ctx.user);
  return all('SELECT id, name, job_title FROM users WHERE active = 1 AND can_finance = 1 ORDER BY name');
}

// ---------- Análise comparativa (mensal, trimestral, semestral, anual) ----------
// Gastos por competência (mês de referência da parcela): valor pago, ou o previsto enquanto não pago.
// Faturado: NFs emitidas no período (Contratos) — só para quem também tem a liberação de Contratos.
const GRAN = {
  mes: { months: 1, count: 12, label: (y, i) => `${MONTHS[i]}/${String(y).slice(2)}` },
  tri: { months: 3, count: 8, label: (y, i) => `${i + 1}º TRI/${String(y).slice(2)}` },
  sem: { months: 6, count: 6, label: (y, i) => `${i + 1}º SEM/${String(y).slice(2)}` },
  ano: { months: 12, count: 5, label: y => String(y) },
};
export function financeAnalysis(ctx, granularity) {
  requireFinance(ctx.user);
  const g = GRAN[granularity] || GRAN.mes;
  const key = granularity in GRAN ? granularity : 'mes';
  const ref = today().slice(0, 7);
  const bucketOf = ym => { const [y, m] = ym.split('-').map(Number); return `${y}-${Math.floor((m - 1) / g.months)}`; };
  // Períodos: o atual e os anteriores (mais um ano para a comparação com o mesmo período do ano anterior)
  const perYear = 12 / g.months;
  const total = g.count + perYear;
  const [cy, cm] = ref.split('-').map(Number);
  let y = cy, i = Math.floor((cm - 1) / g.months);
  const keys = [];
  for (let k = 0; k < total; k++) { keys.unshift({ key: `${y}-${i}`, y, i }); i--; if (i < 0) { i = perYear - 1; y--; } }
  const spend = new Map(), byCat = new Map();
  // Só competências até o mês atual (parcelas futuras já geradas não entram na comparação)
  for (const it of all(`SELECT i.ref_month, i.status, i.amount_expected, i.paid_amount, o.category FROM finance_items i JOIN finance_obligations o ON o.id = i.obligation_id WHERE i.ref_month <= ?`, ref)) {
    const b = bucketOf(it.ref_month);
    const v = it.status === 'paga' ? (it.paid_amount ?? it.amount_expected) : it.amount_expected;
    spend.set(b, r2((spend.get(b) || 0) + v));
    const ck = `${b}|${it.category}`;
    byCat.set(ck, r2((byCat.get(ck) || 0) + v));
  }
  const showBilled = !!ctx.user.can_contracts;
  const billed = new Map();
  if (showBilled) for (const [ym, v] of billedByMonth()) { const b = bucketOf(ym); billed.set(b, r2((billed.get(b) || 0) + v)); }
  const pct = (a, b) => (b ? Math.round(((a - b) / b) * 1000) / 10 : null);
  const all2 = keys.map(k => ({ key: k.key, label: g.label(k.y, k.i), spend: spend.get(k.key) || 0, billed: showBilled ? (billed.get(k.key) || 0) : null }));
  let periods = all2.slice(perYear).map((p, idx) => {
    const prev = all2[idx + perYear - 1];
    const yoy = all2[idx];
    const result = p.billed === null ? null : r2(p.billed - p.spend);
    return {
      ...p, partial: p.key === `${cy}-${Math.floor((cm - 1) / g.months)}`,
      result, spend_ratio: p.billed ? Math.round((p.spend / p.billed) * 1000) / 10 : null,
      spend_vs_prev: pct(p.spend, prev.spend), spend_vs_yoy: pct(p.spend, yoy.spend),
      billed_vs_prev: p.billed === null ? null : pct(p.billed, prev.billed), billed_vs_yoy: p.billed === null ? null : pct(p.billed, yoy.billed),
    };
  });
  // Sem dados no início da série: não mostra
  while (periods.length > 1 && !periods[0].spend && !periods[0].billed) periods = periods.slice(1);
  // Categorias: período atual x anterior x mesmo período do ano anterior
  const cur = all2.at(-1), prev = all2.at(-2), yoy = all2[all2.length - 1 - perYear];
  const cats = [...new Set([...byCat.keys()].map(k => k.split('|')[1]))].map(c => {
    const v = k => byCat.get(`${k.key}|${c}`) || 0;
    return { category: c, current: v(cur), previous: v(prev), last_year: v(yoy), vs_prev: pct(v(cur), v(prev)), vs_yoy: pct(v(cur), v(yoy)) };
  }).filter(c => c.current || c.previous || c.last_year).sort((a, b) => b.current - a.current);
  return { granularity: key, periods, categories: cats, current: cur.label, previous: prev.label, last_year: yoy.label, show_billed: showBilled };
}

// ---------- Visão do mês ----------
export function financeMonth(ctx, ym) {
  requireFinance(ctx.user);
  generateItems(ctx.user.id);
  const ref = today();
  const month = /^\d{4}-\d{2}$/.test(String(ym || '')) ? ym : ref.slice(0, 7);
  const rows = all(`SELECT i.*, o.title, o.category, o.payee, o.variable, o.repeat_last, o.frequency, u.name AS assignee_name, t.code AS task_code,
      (SELECT pm.ref FROM payroll_months pm WHERE pm.finance_item_id = i.id) AS payroll_ref
    FROM finance_items i JOIN finance_obligations o ON o.id = i.obligation_id
    LEFT JOIN tasks t ON t.id = i.task_id LEFT JOIN users u ON u.id = t.assignee_id
    WHERE i.ref_month = ? OR (i.status = 'pendente' AND i.due_date < ?) ORDER BY i.due_date, o.title`, month, ref);
  const decorate = it => {
    const late = it.status === 'pendente' && it.due_date < ref;
    const days = Math.round((Date.parse(it.due_date) - Date.parse(ref)) / 86400e3);
    return { ...it, late, days_to_due: days, situation: it.status === 'paga' ? 'paga' : late ? 'atrasada' : days === 0 ? 'hoje' : days <= 7 ? 'semana' : 'futura', frequency_label: FREQ_LABEL[it.frequency] };
  };
  const items = rows.map(decorate).map(it => ({ ...it, previous_amount: it.variable ? previousAmount(it.obligation_id, it.ref_month) : null }));
  const inMonth = items.filter(i => i.ref_month === month);
  const sum = (arr, f) => r2(arr.reduce((s, i) => s + f(i), 0));
  const cats = new Map();
  for (const i of inMonth) {
    if (!cats.has(i.category)) cats.set(i.category, { category: i.category, expected: 0, paid: 0, count: 0, paid_count: 0 });
    const c = cats.get(i.category);
    c.expected = r2(c.expected + i.amount_expected); c.count++;
    if (i.status === 'paga') { c.paid = r2(c.paid + (i.paid_amount ?? i.amount_expected)); c.paid_count++; }
  }
  return {
    month, label: monthLabel(month), today: ref,
    totals: {
      expected: sum(inMonth, i => i.amount_expected),
      paid: sum(inMonth.filter(i => i.status === 'paga'), i => i.paid_amount ?? i.amount_expected),
      open: sum(inMonth.filter(i => i.status === 'pendente'), i => i.amount_expected),
      count: inMonth.length, paid_count: inMonth.filter(i => i.status === 'paga').length,
      late: sum(items.filter(i => i.late), i => i.amount_expected), late_count: items.filter(i => i.late).length,
      week: sum(items.filter(i => i.status === 'pendente' && !i.late && i.days_to_due <= 7), i => i.amount_expected),
      week_count: items.filter(i => i.status === 'pendente' && !i.late && i.days_to_due <= 7).length,
    },
    items, // do mês + atrasadas de meses anteriores
    categories: [...cats.values()].sort((a, b) => b.expected - a.expected),
    area_id: financeAreaId(),
    category_options: CATEGORIES,
  };
}
