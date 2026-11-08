// Financeiro: obrigações mensais/periódicas que geram parcelas (Pendente → Paga, com valor e comprovante).
// Cada parcela é também uma tarefa na área interna restrita "Financeiro" (responsável e prazo), visível só para liberados.
import { all, one, run, tx } from '../db.js';
import { badRequest, forbidden, notFound, str, oneOf, date, intOrNull } from '../lib/http.js';
import { audit, taskHistory } from './audit.js';
import { today } from './metrics.js';
import { defaultStageId } from './stages.js';
import { saveImageFromDataUrl, isPdf, cleanFileName } from './files.js';
import { insertTask } from './tasks.js';
import { billedByMonth } from './contracts.js';
import { addWorkingDays } from './calendar.js';

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
  if (!canFinance(user)) throw forbidden('Acesso restrito: solicite a liberação do Financeiro ao administrador.');
}

// ---------- Área interna restrita "Financeiro" ----------
export function ensureFinanceArea() {
  if (one(`SELECT value FROM app_settings WHERE key = 'finance_area_created'`)) return null;
  return tx(() => {
    const r0 = one(`SELECT MAX(CAST(SUBSTR(code, 5) AS INTEGER)) AS n FROM projects WHERE code LIKE 'INT-%'`);
    const code = `INT-${String((r0?.n || 0) + 1).padStart(3, '0')}`;
    const now = new Date().toISOString();
    const r = run(`INSERT INTO projects (code, name, client, description, status, kind, restricted, created_at, updated_at) VALUES (?,?,?,?, 'em_andamento', 'interno', 2, ?, ?)`,
      code, 'Financeiro (restrito)', 'Charão Engenharia e Construção', 'Obrigações financeiras mensais e periódicas. Visível somente para quem tem a liberação do Financeiro.', now, now);
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

// Vencimento das despesas: o último dia do mês em que caem, não o dia em que ocorrem. Só ficam atrasadas depois do 10º dia
// útil do mês seguinte, que é também o prazo da tarefa. A coluna due_date guarda o dia previsto (lembrete de pagar e data da folha).
export const conferenceDate = it => dueOf(it.due_date && it.due_date.slice(0, 7) > it.ref_month ? it.due_date.slice(0, 7) : it.ref_month, 31);
const TASK_WORK_DAYS = 10;
const financeTaskDue = (areaId, conf) => addWorkingDays(areaId, conf, TASK_WORK_DAYS);
// Data limite (antes dela não há atraso); guarda o cálculo por mês enquanto a tela é montada
export function limitReader() {
  const memo = new Map(), area = financeAreaId();
  return conf => { if (!memo.has(conf)) memo.set(conf, area ? financeTaskDue(area, conf) : conf); return memo.get(conf); };
}

// ---------- Geração das parcelas (e das tarefas) ----------
const HORIZON = 2; // gera até 2 meses à frente do mês atual
export function monthsOf(o, until, history = true) {
  const step = FREQUENCIES[o.frequency];
  const start = history && o.mc_start && o.mc_start < o.start_month ? o.mc_start : o.start_month;
  const last = o.end_month && o.end_month < until ? o.end_month : until;
  const out = [];
  if (!step) { if (start <= last) out.push(start); return out; }
  for (let m = start; m <= last; m = addMonths(m, step)) out.push(m);
  return out;
}

function taskTitle(o, ref) { return `${o.title} — ${monthLabel(ref)}`; }
function taskDescription(o, amount) {
  return [`Obrigação financeira · ${o.category}${o.payee ? ` · ${o.payee}` : ''}`, `Valor previsto: ${brl(amount)}${o.variable ? ' (valor variável)' : ''}`, 'Registre o pagamento no Financeiro (data, valor e comprovante).', o.notes || ''].filter(Boolean).join('\n');
}

// Valor da parcela anterior da mesma obrigação (pago, se houver; senão o previsto)
export function previousAmount(obligationId, ref) {
  const it = one('SELECT amount_expected, paid_amount, status FROM finance_items WHERE obligation_id = ? AND ref_month < ? ORDER BY ref_month DESC LIMIT 1', obligationId, ref);
  return it ? r2(it.status === 'paga' && it.paid_amount ? it.paid_amount : it.amount_expected) : null; // real 0 (não ocorreu) não vira previsão
}

// Nova parcela não cria tarefa própria: entra como check na lista do mês (tarefa "Contas do mês" do responsável)
function createItem(o, ref, userId, { noTask = true } = {}) {
  const area = one('SELECT * FROM projects WHERE id = ?', financeAreaId() || ensureFinanceArea() || financeAreaId());
  const due = dueOf(ref, o.due_day);
  // Previsto do mês ajustado no Planejamento anual tem prioridade
  const plan = one('SELECT amount FROM finance_plan WHERE obligation_id = ? AND ref_month = ?', o.id, ref);
  const amount = o.plan_zero === 1 ? 0 : plan ? plan.amount : o.variable && o.repeat_last ? previousAmount(o.id, ref) ?? o.amount : o.amount;
  const r = run('INSERT INTO finance_items (obligation_id, ref_month, due_date, amount_expected, estimated) VALUES (?,?,?,?,?)', o.id, ref, due, amount, o.variable ? 1 : 0);
  const itemId = Number(r.lastInsertRowid);
  if (noTask) return itemId;
  itemTask(o, one('SELECT * FROM finance_items WHERE id = ?', itemId), userId, area);
  return itemId;
}
// Tarefa da parcela (área restrita do Financeiro)
function itemTask(o, it, userId, area = one('SELECT * FROM projects WHERE id = ?', financeAreaId() || ensureFinanceArea() || financeAreaId())) {
  const assignee = o.assignee_id && one('SELECT id FROM users WHERE id = ? AND active = 1 AND can_finance = 1', o.assignee_id) ? o.assignee_id : null;
  const amount = r2(it.amount_expected);
  const conf = conferenceDate(it);
  const taskId = insertTask({
    project: area,
    data: { task_type: 'tarefa', title: taskTitle(o, it.ref_month), description: taskDescription(o, amount), field_summary: null, notes: null, due_date: financeTaskDue(area.id, conf), start_date: conf, priority: 'media', proof_type: 'nenhuma', assignee_id: assignee },
    stageInput: stageFor(area.id, o.category),
    creatorId: userId || o.created_by,
  });
  run('UPDATE finance_items SET task_id = ?, task_skip = 0 WHERE id = ?', taskId, it.id);
  if (amount === 0) syncZeroTask(taskId, 0, userId || o.created_by);
  return taskId;
}

// ---------- Lista do mês: uma tarefa "Contas do mês" por mês e responsável; cada despesa é um check ----------
// Estados do check (derivados da parcela): a confirmar → vai ter → pago; ou não vai ter (real R$ 0).
// "Paguei" (aguardando o Mais Controle) já conta como pago. Avanço: resolvido = 1, vai ter = ½.
const MONTH_STAGE = 'Contas do mês';
const CONVERT_REASON = 'Convertida em check da lista "Contas do mês"';
export function itemCheckState(it) {
  if (it.status === 'paga') return it.paid_amount !== null && it.paid_amount !== undefined && Number(it.paid_amount) === 0 ? 'nao_vai_ter' : 'pago';
  if (it.marked_paid_at) return 'pago_aguardando';
  if (it.confirmed_at || it.justify_kind === 'vai_ocorrer') return 'vai_ter';
  return 'a_confirmar';
}
const CHECK_WEIGHT = { pago: 1, pago_aguardando: 1, nao_vai_ter: 1, vai_ter: 0.5, a_confirmar: 0 };
const resolved = st => CHECK_WEIGHT[st] === 1;
// Despesas do mês (sem as de previsto zero ainda pendentes: nada esperado)
function monthItems(ym) {
  return all(`SELECT i.*, o.title, o.category, o.payee, o.variable, o.assignee_id, u.name AS assignee_name
    FROM finance_items i JOIN finance_obligations o ON o.id = i.obligation_id LEFT JOIN users u ON u.id = o.assignee_id
    WHERE i.ref_month = ? AND NOT (i.status = 'pendente' AND i.amount_expected = 0) ORDER BY i.due_date, o.title`, ym).map(i => ({ ...i, check: itemCheckState(i), key: i.assignee_id || 0 }));
}
const checkSummary = list => {
  const c = { total: list.length, a_confirmar: 0, vai_ter: 0, pago: 0, nao_vai_ter: 0 };
  for (const i of list) c[i.check === 'pago_aguardando' ? 'pago' : i.check]++;
  c.resolved = c.pago + c.nao_vai_ter;
  c.pct = list.length ? Math.round((list.reduce((a, i) => a + CHECK_WEIGHT[i.check], 0) / list.length) * 100) : 0;
  return c;
};
const monthTaskTitle = (ym, name) => `Contas do mês — ${monthLabel(ym)}${name ? ` — ${name}` : ' — sem responsável'}`;
const monthTaskDescription = (ym, c) => [`Lista do mês ${monthLabel(ym)}: ${c.resolved} de ${c.total} resolvido(s) · ${c.a_confirmar} a confirmar · ${c.vai_ter} vai(ão) ter (a pagar) · ${c.pago} pago(s) · ${c.nao_vai_ter} não vai(ão) ter.`,
  'Marque em cada despesa se vai ter ou não neste mês e registre os pagamentos. A tarefa avança com os checks e conclui sozinha quando todos estiverem resolvidos (pagos ou sem despesa no mês).'].join('\n');

// Acerta avanço, situação e descrição de uma tarefa "Contas do mês"
function refreshMonthTask(mt, userId) {
  const t = mt.task_id && one('SELECT * FROM tasks WHERE id = ?', mt.task_id);
  if (!t || t.cancelled_at) return;
  const list = monthItems(mt.ref_month).filter(i => i.key === mt.assignee_key);
  const c = checkSummary(list);
  const done = list.length > 0 && list.every(i => resolved(i.check));
  const now = new Date().toISOString();
  run('UPDATE tasks SET description = ?, progress_pct = ?, updated_at = ? WHERE id = ?', monthTaskDescription(mt.ref_month, c), done ? 100 : c.pct, now, t.id);
  if (done && t.status !== 'concluida') {
    run(`UPDATE tasks SET status = 'concluida', started_at = COALESCE(started_at, ?), delivered_at = ?, completed_at = ?, review_status = 'aprovada', reviewed_by = ?, reviewed_at = ? WHERE id = ?`, now, now, now, userId, now, t.id);
    taskHistory(t.id, userId, 'Tarefa concluída', `Todos os ${c.total} checks da lista do mês resolvidos`);
  } else if (!done && t.status === 'concluida') {
    run(`UPDATE tasks SET status = ?, delivered_at = NULL, completed_at = NULL, review_status = NULL, reviewed_by = NULL, reviewed_at = NULL WHERE id = ?`, c.pct > 0 ? 'em_andamento' : 'aberta', t.id);
    taskHistory(t.id, userId, 'Tarefa reaberta', 'Um check da lista do mês voltou a pendente');
  } else if (!done && ['aberta', 'em_andamento'].includes(t.status)) {
    const st = c.pct > 0 ? 'em_andamento' : 'aberta';
    if (st !== t.status) run(`UPDATE tasks SET status = ?, started_at = CASE WHEN ? = 'em_andamento' THEN COALESCE(started_at, ?) ELSE started_at END WHERE id = ?`, st, st, now, t.id);
  }
}
// Recalcula todas as tarefas "Contas do mês" (chamado depois de qualquer mudança nas despesas)
export function syncMonthTasks(userId = null) {
  let rows = [];
  try { rows = all('SELECT * FROM finance_month_tasks WHERE task_id IS NOT NULL'); } catch { return; } // antes da migração
  for (const mt of rows) refreshMonthTask(mt, userId);
}
export const monthTaskOf = taskId => { try { return one('SELECT * FROM finance_month_tasks WHERE task_id = ?', taskId) || null; } catch { return null; } };

// Pergunta (Sim/Não, sem padrão): criar a tarefa "Contas do mês" de cada responsável (mês passado, atual e próximo)
export function taskSuggestions(ctx) {
  requireFinance(ctx.user);
  const cur = today().slice(0, 7);
  try {
    const out = [];
    for (const ym of [addMonths(cur, -1), cur, addMonths(cur, 1)]) {
      if (ym < cutoff()) continue;
      const have = new Set(all('SELECT assignee_key FROM finance_month_tasks WHERE ref_month = ?', ym).map(r => r.assignee_key));
      const groups = new Map();
      for (const i of monthItems(ym)) { if (!groups.has(i.key)) groups.set(i.key, []); groups.get(i.key).push(i); }
      for (const [key, list] of groups) {
        if (have.has(key)) continue;
        const c = checkSummary(list);
        if (ym < cur && c.resolved === c.total) continue; // mês passado já resolvido: nada a acompanhar
        const legacy = list.filter(i => i.task_id && one('SELECT 1 FROM tasks WHERE id = ? AND cancelled_at IS NULL AND status <> \'concluida\'', i.task_id)).length;
        out.push({ ref_month: ym, month_label: monthLabel(ym), assignee_id: key || null, assignee_name: list[0].assignee_name || null, title: monthTaskTitle(ym, list[0].assignee_name),
          count: c.total, open: c.total - c.resolved, expected: r2(list.reduce((a, i) => a + i.amount_expected, 0)), legacy_open: legacy, start: `${ym}-01`, due: dueOf(ym, 31) });
      }
    }
    return out;
  } catch { return []; } // antes da migração
}
function createMonthTask(ym, key, userId) {
  const area = one('SELECT * FROM projects WHERE id = ?', financeAreaId() || ensureFinanceArea() || financeAreaId());
  const list = monthItems(ym).filter(i => i.key === key);
  if (!list.length) throw badRequest('Não há despesas deste responsável no mês.');
  const assignee = key && one('SELECT id FROM users WHERE id = ? AND active = 1 AND can_finance = 1', key) ? key : null;
  const taskId = insertTask({
    project: area,
    data: { task_type: 'tarefa', title: monthTaskTitle(ym, list[0].assignee_name), description: monthTaskDescription(ym, checkSummary(list)), field_summary: null, notes: null,
      due_date: dueOf(ym, 31), start_date: `${ym}-01`, priority: 'media', proof_type: 'nenhuma', assignee_id: assignee },
    stageInput: stageFor(area.id, MONTH_STAGE),
    creatorId: userId,
  });
  run(`INSERT INTO finance_month_tasks (ref_month, assignee_key, task_id, skipped, created_by) VALUES (?,?,?,0,?)
    ON CONFLICT(ref_month, assignee_key) DO UPDATE SET task_id = excluded.task_id, skipped = 0`, ym, key, taskId, userId);
  // As tarefas antigas (uma por despesa) viram checks: as abertas são encerradas; todas ficam no histórico da parcela
  const now = new Date().toISOString();
  let converted = 0;
  for (const i of list) {
    if (!i.task_id) continue;
    const old = one('SELECT id, status, cancelled_at, code FROM tasks WHERE id = ?', i.task_id);
    if (old && !old.cancelled_at && old.status !== 'concluida') {
      run('UPDATE tasks SET cancelled_at = ?, cancelled_by = ?, cancel_reason = ?, updated_at = ? WHERE id = ?', now, userId, CONVERT_REASON, now, old.id);
      taskHistory(old.id, userId, 'Tarefa cancelada', CONVERT_REASON);
      converted++;
    }
    run('UPDATE finance_items SET legacy_task_id = task_id, task_id = NULL WHERE id = ?', i.id);
  }
  taskHistory(taskId, userId, 'Lista do mês criada', `${list.length} despesa(s) como checks${converted ? ` · ${converted} tarefa(s) antiga(s) convertida(s)` : ''}`);
  refreshMonthTask({ ref_month: ym, assignee_key: key, task_id: taskId }, userId);
  return { taskId, converted };
}
export function answerTaskSuggestions(ctx, body, ip) {
  requireFinance(ctx.user);
  const groups = (Array.isArray(body.groups) ? body.groups : []).map(g => ({ ym: /^\d{4}-\d{2}$/.test(String(g?.ref_month || '')) ? g.ref_month : null, key: Number(g?.assignee_id) || 0 })).filter(g => g.ym);
  if (!groups.length) throw badRequest('Escolha as listas do mês.');
  if (body.create !== true && body.create !== false) throw badRequest('Responda Sim ou Não.');
  const create = body.create === true;
  let n = 0, converted = 0;
  tx(() => {
    for (const g of groups) {
      if (one('SELECT 1 FROM finance_month_tasks WHERE ref_month = ? AND assignee_key = ?', g.ym, g.key)) continue;
      if (create) { const r = createMonthTask(g.ym, g.key, ctx.user.id); converted += r.converted; }
      else run('INSERT INTO finance_month_tasks (ref_month, assignee_key, task_id, skipped, created_by) VALUES (?,?,NULL,1,?)', g.ym, g.key, ctx.user.id);
      n++;
    }
  });
  audit(ctx.user.id, 'finance', null, create ? 'Tarefas "Contas do mês" criadas (pergunta do sistema)' : 'Listas do mês sem tarefa (respondido: não criar)', { listas: n, tarefas_convertidas: converted || undefined }, ip);
  return { ok: true, count: n, converted };
}

// Check "vai ter" (com o valor do mês, se informado) / desfazer; "não vai ter" (motivo opcional)
export function confirmItem(ctx, id, body, ip) {
  const it = loadItem(ctx, id);
  if (it.status === 'paga') throw badRequest('Esta despesa já está resolvida (paga ou sem despesa no mês). Desfaça antes.');
  const hasAmount = body?.amount !== undefined && body?.amount !== null && body?.amount !== '';
  const amount = hasAmount ? r2(num(body.amount, 'Valor do mês')) : null;
  if (hasAmount && !(amount > 0)) throw badRequest('Valor do mês inválido. Se não vai ter a despesa, use "Não vai ter".');
  tx(() => {
    run('UPDATE finance_items SET confirmed_at = ?, confirmed_by = ? WHERE id = ?', new Date().toISOString(), ctx.user.id, id);
    if (hasAmount && amount !== r2(it.amount_expected)) {
      run('UPDATE finance_items SET amount_expected = ?, estimated = 0 WHERE id = ?', amount, id);
      keepManualPlan(it.obligation_id, it.ref_month, amount, ctx.user.id);
    }
    audit(ctx.user.id, 'finance', it.obligation_id, 'Despesa confirmada no mês (vai ter)', { parcela: `${it.title} ${monthLabel(it.ref_month)}`, valor: hasAmount ? amount : it.amount_expected }, ip);
    syncMonthTasks(ctx.user.id);
  });
  return getItem(ctx, id);
}
export function unconfirmItem(ctx, id, ip) {
  const it = loadItem(ctx, id);
  if (it.status === 'paga') throw badRequest('Esta despesa já está resolvida. Desfaça o pagamento antes.');
  tx(() => {
    run('UPDATE finance_items SET confirmed_at = NULL, confirmed_by = NULL WHERE id = ?', id);
    audit(ctx.user.id, 'finance', it.obligation_id, 'Confirmação da despesa desfeita (volta a confirmar)', { parcela: `${it.title} ${monthLabel(it.ref_month)}` }, ip);
    syncMonthTasks(ctx.user.id);
  });
  return getItem(ctx, id);
}
export function skipItem(ctx, id, body, ip) {
  const it = loadItem(ctx, id);
  if (it.status === 'paga') throw badRequest('Esta despesa já está resolvida.');
  const reason = str(body?.reason, { max: 500, label: 'Motivo' });
  tx(() => {
    run('UPDATE finance_items SET justify_kind = ?, justify_reason = ?, justified_at = ?, justified_by = ?, marked_paid_at = NULL, marked_amount = NULL WHERE id = ?', 'nao_ocorre', reason, new Date().toISOString(), ctx.user.id, id);
    payItem(ctx, id, { paid_date: today(), paid_amount: 0, notes: `Não vai ter neste mês${reason ? `: ${reason}` : ''}` }, ip);
  });
  return getItem(ctx, id);
}

// Lista do mês de uma tarefa "Contas do mês" (tela da tarefa)
export function monthChecklist(ctx, taskId) {
  requireFinance(ctx.user);
  const mt = monthTaskOf(taskId);
  if (!mt) throw notFound('Esta tarefa não é uma lista do mês do Financeiro.');
  const list = monthItems(mt.ref_month).filter(i => i.key === mt.assignee_key);
  const files = new Map();
  for (const i of list) {
    const tid = i.task_id || i.legacy_task_id;
    files.set(i.id, [...(tid ? all(`SELECT id, mime, original_name, 'task' AS src FROM task_files WHERE task_id = ? AND kind = 'execucao' ORDER BY id`, tid) : []),
      ...all(`SELECT id, mime, original_name, 'item' AS src FROM finance_item_files WHERE item_id = ? ORDER BY id`, i.id)]);
  }
  return {
    ref_month: mt.ref_month, label: monthLabel(mt.ref_month), assignee_name: list[0]?.assignee_name || null, summary: checkSummary(list), today: today(),
    items: list.map(i => ({ id: i.id, title: i.title, category: i.category, payee: i.payee, variable: !!i.variable, estimated: !!i.estimated, due_date: i.due_date,
      amount_expected: i.amount_expected, paid_amount: i.paid_amount, paid_date: i.paid_date, check: i.check, reason: i.justify_reason, notes: i.notes,
      previous_amount: i.variable ? previousAmount(i.obligation_id, i.ref_month) : null, files: files.get(i.id) })),
  };
}
// Comprovante de uma parcela (sem tarefa própria)
export function itemFileForUser(ctx, fileId) {
  requireFinance(ctx.user);
  const f = one('SELECT * FROM finance_item_files WHERE id = ?', fileId);
  if (!f) throw notFound('Arquivo não encontrado.');
  return f;
}

// Previsto 0 = nada esperado no mês: a tarefa do mês sai da lista (cancelada); voltando a ter previsto, ela reabre
const ZERO_REASON = 'Sem previsão no mês (previsto R$ 0,00)';
export function syncZeroTask(taskId, amount, userId) {
  if (!taskId) return;
  const now = new Date().toISOString();
  if (amount === 0) {
    const r = run(`UPDATE tasks SET cancelled_at = ?, cancelled_by = ?, cancel_reason = ?, updated_at = ? WHERE id = ? AND cancelled_at IS NULL AND status <> 'concluida'`, now, userId, ZERO_REASON, now, taskId);
    if (r.changes) taskHistory(taskId, userId, 'Tarefa cancelada', ZERO_REASON);
  } else {
    const r = run('UPDATE tasks SET cancelled_at = NULL, cancelled_by = NULL, cancel_reason = NULL, updated_at = ? WHERE id = ? AND cancel_reason = ?', now, taskId, ZERO_REASON);
    if (r.changes) taskHistory(taskId, userId, 'Tarefa reaberta', `Previsto do mês: ${brl(amount)}`);
  }
}

// Previsto de um mês (importação da aba "Previsto"): parcela existente (pendente ou paga) ou planejamento do mês ainda não
// gerado. Devolve o estado anterior para poder desfazer.
export function setPlannedInternal(userId, o, ym, amount) {
  const it = one('SELECT * FROM finance_items WHERE obligation_id = ? AND ref_month = ?', o.id, ym);
  if (it) {
    const before = { item_id: it.id, amount: it.amount_expected };
    if (r2(it.amount_expected) === r2(amount)) return null;
    run('UPDATE finance_items SET amount_expected = ?, estimated = 0 WHERE id = ?', r2(amount), it.id);
    keepManualPlan(o.id, ym, amount, userId);
    if (it.task_id && it.status !== 'paga') {
      run('UPDATE tasks SET description = ?, updated_at = ? WHERE id = ?', taskDescription(o, r2(amount)), new Date().toISOString(), it.task_id);
      syncZeroTask(it.task_id, r2(amount), userId);
    }
    return before;
  }
  const p = one('SELECT amount FROM finance_plan WHERE obligation_id = ? AND ref_month = ?', o.id, ym);
  if (p && r2(p.amount) === r2(amount)) return null;
  keepManualPlan(o.id, ym, amount, userId);
  return { plan: p ? p.amount : null };
}
export function restorePlannedInternal(userId, obligationId, ym, before) {
  const o = one('SELECT * FROM finance_obligations WHERE id = ?', obligationId);
  if (!o || !before) return;
  if (before.item_id) {
    const it = one('SELECT * FROM finance_items WHERE id = ?', before.item_id);
    if (!it) return;
    run('UPDATE finance_items SET amount_expected = ? WHERE id = ?', before.amount, it.id);
    if (it.task_id && it.status !== 'paga') { run('UPDATE tasks SET description = ? WHERE id = ?', taskDescription(o, before.amount), it.task_id); syncZeroTask(it.task_id, r2(before.amount), userId); }
    return;
  }
  const it = one('SELECT * FROM finance_items WHERE obligation_id = ? AND ref_month = ?', obligationId, ym);
  if (it && it.status !== 'paga') {
    const amount = before.plan ?? o.amount;
    run('UPDATE finance_items SET amount_expected = ? WHERE id = ?', amount, it.id);
    if (it.task_id) { run('UPDATE tasks SET description = ? WHERE id = ?', taskDescription(o, amount), it.task_id); syncZeroTask(it.task_id, r2(amount), userId); }
  }
  if (before.plan == null) run('DELETE FROM finance_plan WHERE obligation_id = ? AND ref_month = ?', obligationId, ym);
  else run('UPDATE finance_plan SET amount = ? WHERE obligation_id = ? AND ref_month = ?', before.plan, obligationId, ym);
}

export function generateItems(userId = null) {
  if (!financeAreaId()) ensureFinanceArea();
  pruneOutOfRange(userId);
  const until = addMonths(today().slice(0, 7), HORIZON);
  let n = 0;
  for (const o of all('SELECT * FROM finance_obligations WHERE active = 1')) {
    const have = new Set(all('SELECT ref_month FROM finance_items WHERE obligation_id = ?', o.id).map(r => r.ref_month));
    for (const ref of monthsOf(o, until, false)) if (!have.has(ref)) { tx(() => createItem(o, ref, userId, { noTask: true })); n++; }
  }
  return n;
}

// ---------- Início do controle: pendências de meses anteriores ficam no histórico (sem atraso nem tarefa aberta) ----------
const CUTOFF_REASON = 'Anterior ao início do controle do Financeiro';
export const controlStart = () => one(`SELECT value FROM app_settings WHERE key = 'finance_control_start'`)?.value || null;
const cutoff = () => controlStart() || '0000-00';
const beforeControl = ym => all(`SELECT i.*, t.status AS task_status, t.cancelled_at AS task_cancelled FROM finance_items i LEFT JOIN tasks t ON t.id = i.task_id
  WHERE i.status = 'pendente' AND i.amount_expected > 0 AND i.ref_month < ?`, ym);
const openTask = i => i.task_id && !i.task_cancelled && i.task_status !== 'concluida';
export function controlStartInfo(ctx, ym) {
  requireFinance(ctx.user);
  const current = controlStart();
  const month = /^\d{4}-\d{2}$/.test(String(ym || '')) ? ym : current || today().slice(0, 7);
  const rows = beforeControl(month);
  return { current, current_label: current ? monthLabel(current) : null, month, label: monthLabel(month), max: today().slice(0, 7),
    count: rows.length, total: r2(rows.reduce((s, i) => s + i.amount_expected, 0)), tasks: rows.filter(openTask).length };
}
export function setControlStart(ctx, body, ip) {
  requireFinance(ctx.user);
  const clear = body.month === null || body.month === '';
  const ym = clear ? null : /^\d{4}-\d{2}$/.test(String(body.month || '')) ? body.month : null;
  if (!clear && !ym) throw badRequest('Mês inválido.');
  if (ym && ym > today().slice(0, 7)) throw badRequest('O início do controle não pode ser depois do mês atual.');
  const old = controlStart();
  const now = new Date().toISOString();
  let cancelled = 0, restored = 0;
  tx(() => {
    if (ym) run(`INSERT INTO app_settings (key, value) VALUES ('finance_control_start', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`, ym);
    else run(`DELETE FROM app_settings WHERE key = 'finance_control_start'`);
    // Tarefas canceladas pelo início do controle voltam quando o mês passa a ser controlado
    for (const it of all(`SELECT i.task_id, i.ref_month FROM finance_items i JOIN tasks t ON t.id = i.task_id WHERE i.status = 'pendente' AND t.cancel_reason = ?`, CUTOFF_REASON)) {
      if (ym && it.ref_month < ym) continue;
      run('UPDATE tasks SET cancelled_at = NULL, cancelled_by = NULL, cancel_reason = NULL, updated_at = ? WHERE id = ?', now, it.task_id);
      taskHistory(it.task_id, ctx.user.id, 'Tarefa reaberta', 'Início do controle do Financeiro alterado');
      restored++;
    }
    if (ym) for (const it of beforeControl(ym).filter(openTask)) {
      run(`UPDATE tasks SET cancelled_at = ?, cancelled_by = ?, cancel_reason = ?, updated_at = ? WHERE id = ?`, now, ctx.user.id, CUTOFF_REASON, now, it.task_id);
      taskHistory(it.task_id, ctx.user.id, 'Tarefa cancelada', `${CUTOFF_REASON} (${monthLabel(ym)})`);
      cancelled++;
    }
    audit(ctx.user.id, 'finance', null, ym ? 'Início do controle do Financeiro definido' : 'Início do controle do Financeiro removido',
      { de: old ? monthLabel(old) : null, para: ym ? monthLabel(ym) : null, tarefas_canceladas: cancelled, tarefas_reabertas: restored }, ip);
  });
  return { ...controlStartInfo(ctx, ym), cancelled, restored };
}

// Parcela pendente fora do período da tarefa (depois do Término ou antes do Início, ex.: término antecipado depois de as
// parcelas terem sido geradas) não vale, em qualquer mês — passado ou futuro. Parcelas pagas ficam.
function dropItem(it, userId, reason) {
  if (it.task_id) {
    run(`UPDATE tasks SET cancelled_at = ?, cancelled_by = ?, cancel_reason = ?, updated_at = ? WHERE id = ? AND cancelled_at IS NULL`,
      new Date().toISOString(), userId, reason, new Date().toISOString(), it.task_id);
    taskHistory(it.task_id, userId, 'Tarefa cancelada', reason);
  }
  run('DELETE FROM finance_items WHERE id = ?', it.id);
}
export function pruneOutOfRange(userId = null) {
  const stale = all(`SELECT i.* FROM finance_items i JOIN finance_obligations o ON o.id = i.obligation_id
    WHERE i.status = 'pendente' AND ((o.end_month IS NOT NULL AND i.ref_month > o.end_month) OR i.ref_month < MIN(o.start_month, COALESCE(o.mc_start, o.start_month)))`);
  if (stale.length) tx(() => stale.forEach(it => dropItem(it, userId, 'Parcela financeira removida (fora do período da tarefa: início/término)')));
  return stale.length;
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

// Plano de Contas do Mais Controle de cada tarefa (a tarefa é a categoria): o mais frequente nos lançamentos da categoria
const catKey = s => String(s ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]/g, '');
function planAccounts() {
  const m = new Map();
  try {
    for (const r of all(`SELECT category, plan_account, COUNT(*) AS n FROM ext_payments WHERE source = 'maiscontrole' AND COALESCE(plan_account, '') <> '' GROUP BY category, plan_account`)) {
      const k = catKey(r.category), cur = m.get(k);
      if (!cur || r.n > cur.n) m.set(k, { plan: r.plan_account, n: r.n });
    }
  } catch { /* antes da migração */ }
  return m;
}

// ---------- Planejamento anual: tarefas x 12 meses (previsto e real) ----------
// Cada célula: parcela existente (pendente / atrasada / paga, com o valor real) ou mês projetado pela recorrência
// (previsto = ajuste do mês no planejamento, ou o valor da tarefa).
export function financeYear(ctx, y) {
  requireFinance(ctx.user);
  pruneOutOfRange(ctx.user.id);
  const year = /^\d{4}$/.test(String(y || '')) ? String(y) : today().slice(0, 4);
  const keys = Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, '0')}`);
  const ref = today();
  const items = new Map();
  for (const it of all(`SELECT i.*, (SELECT COUNT(*) FROM task_files f WHERE f.task_id = COALESCE(i.task_id, i.legacy_task_id) AND f.kind = 'execucao') + (SELECT COUNT(*) FROM finance_item_files ff WHERE ff.item_id = i.id) AS files FROM finance_items i WHERE ref_month BETWEEN ? AND ?`, keys[0], keys[11])) {
    if (!items.has(it.obligation_id)) items.set(it.obligation_id, new Map());
    items.get(it.obligation_id).set(it.ref_month, it);
  }
  const plans = new Map(all('SELECT * FROM finance_plan WHERE ref_month BETWEEN ? AND ?', keys[0], keys[11]).map(p => [`${p.obligation_id}|${p.ref_month}`, p.amount]));
  const cov = coverage();
  const autoPlans = new Set(all('SELECT obligation_id, ref_month FROM finance_plan WHERE auto = 1 AND ref_month BETWEEN ? AND ?', keys[0], keys[11]).map(p => `${p.obligation_id}|${p.ref_month}`));
  // Mês fechado: anterior ao mês passado e já coberto pela última busca do Mais Controle
  const prevMonth = (() => { const [yy, mm] = ref.slice(0, 7).split('-').map(Number); return mm === 1 ? `${yy - 1}-12` : `${yy}-${String(mm - 1).padStart(2, '0')}`; })();
  const cut = cutoff();
  const limitOf = limitReader();
  const closed = k => (!!cov && k < prevMonth && cov.data_until.slice(0, 7) > k) || k < cut; // antes do início do controle: histórico
  const rows = [];
  for (const o of all(`SELECT o.*, u.name AS assignee_name FROM finance_obligations o LEFT JOIN users u ON u.id = o.assignee_id ORDER BY o.category, o.title`)) {
    const due = new Set(o.active ? monthsOf(o, keys[11]).filter(k => k >= keys[0]) : []);
    const mine = items.get(o.id) || new Map();
    const cells = keys.map(k => {
      const it = mine.get(k);
      if (it) {
        const paid = it.status === 'paga';
        return { ym: k, item_id: it.id, planned: r2(it.amount_expected), real: paid ? r2(it.paid_amount ?? it.amount_expected) : null, paid_date: it.paid_date, due_date: conferenceDate(it), planned_date: it.due_date,
          // Real = 0: a previsão não ocorreu no mês (resolvido, não é atraso)
          status: paid ? (r2(it.paid_amount ?? it.amount_expected) === 0 ? 'nao_ocorreu' : 'pago') : r2(it.amount_expected) === 0 ? 'sem_previsto' : it.marked_paid_at ? markState(it, cov) : closed(k) ? 'sem_pagamento' : limitOf(conferenceDate(it)) < ref ? 'atrasada' : 'pendente',
          source: it.source,
          estimated: !!it.estimated, files: it.files, marked_amount: it.marked_amount, marked_paid_at: it.marked_paid_at, justify_kind: it.justify_kind, justify_reason: it.justify_reason };
      }
      if (!due.has(k)) return null;
      const p = plans.get(`${o.id}|${k}`);
      const pl = r2(p ?? o.amount);
      return { ym: k, item_id: null, planned: pl, custom: p != null && !autoPlans.has(`${o.id}|${k}`), real: null, due_date: dueOf(k, 31), status: pl === 0 ? 'sem_previsto' : closed(k) ? 'sem_pagamento' : 'projetado' };
    });
    if (!cells.some(Boolean)) continue;
    const sum = f => r2(cells.reduce((s, c) => s + (c ? f(c) : 0), 0));
    rows.push({ id: o.id, title: o.title, category: o.category, frequency: o.frequency, frequency_label: FREQ_LABEL[o.frequency], due_day: o.due_day, amount: o.amount,
      variable: !!o.variable, active: !!o.active, assignee_name: o.assignee_name, cells, planned: sum(c => c.planned), real: sum(c => c.real || 0) });
  }
  // Agrupamento: Plano de Contas do Mais Controle; tarefa sem lançamentos lá fica na sua categoria
  const plansMc = planAccounts();
  const cats = [];
  for (const r of rows) {
    const gname = plansMc.get(catKey(r.title))?.plan || r.category;
    r.plan_account = plansMc.get(catKey(r.title))?.plan || null;
    let g = cats.find(c => c.category === gname);
    if (!g) { g = { category: gname, plan: !!r.plan_account, rows: [] }; cats.push(g); }
    g.rows.push(r);
  }
  cats.sort((a, b) => a.category.localeCompare(b.category, 'pt-BR'));
  for (const g of cats) g.rows.sort((a, b) => a.title.localeCompare(b.title, 'pt-BR'));
  const monthTot = keys.map((k, i) => {
    const cs = rows.map(r => r.cells[i]).filter(Boolean);
    return { ym: k, planned: r2(cs.reduce((s, c) => s + c.planned, 0)), real: r2(cs.reduce((s, c) => s + (c.real || 0), 0)),
      paid: cs.filter(c => c.status === 'pago' || c.status === 'nao_ocorreu').length, count: cs.length, late: cs.filter(c => c.status === 'atrasada').length };
  });
  const late = rows.flatMap(r => r.cells.filter(c => c && c.status === 'atrasada'));
  return {
    year, current: ref.slice(0, 7), months: keys,
    groups: cats.map(g => ({ ...g, planned: r2(g.rows.reduce((s, r) => s + r.planned, 0)), real: r2(g.rows.reduce((s, r) => s + r.real, 0)),
      months: keys.map((k, i) => ({ planned: r2(g.rows.reduce((s, r) => s + (r.cells[i]?.planned || 0), 0)), real: r2(g.rows.reduce((s, r) => s + (r.cells[i]?.real || 0), 0)) })) })),
    totals: { planned: r2(monthTot.reduce((s, m) => s + m.planned, 0)), real: r2(monthTot.reduce((s, m) => s + m.real, 0)),
      planned_to_date: r2(monthTot.filter(m => m.ym <= ref.slice(0, 7)).reduce((s, m) => s + m.planned, 0)),
      late: late.length, late_amount: r2(late.reduce((s, c) => s + c.planned, 0)) },
    month_totals: monthTot,
    categories: CATEGORIES,
    projects: projectCosts(keys),
    clients: clientCosts(keys),
  };
}

// Ajusta o previsto de um mês: parcela pendente → altera a parcela; mês ainda não gerado → guarda no planejamento
export function setPlan(ctx, body, ip) {
  requireFinance(ctx.user);
  const o = one('SELECT * FROM finance_obligations WHERE id = ?', intOrNull(body.obligation_id));
  if (!o) throw notFound('Tarefa financeira não encontrada.');
  const ym = /^\d{4}-\d{2}$/.test(String(body.ref_month || '')) ? body.ref_month : null;
  if (!ym) throw badRequest('Mês inválido.');
  const it = one('SELECT * FROM finance_items WHERE obligation_id = ? AND ref_month = ?', o.id, ym);
  if (it) {
    if (it.status === 'paga') throw badRequest('Parcela paga: desfaça o pagamento para alterar o previsto.');
    return setItemAmount(ctx, it.id, { amount_expected: body.amount }, ip);
  }
  if (!monthsOf(o, ym).includes(ym)) throw badRequest('Esta tarefa não tem vencimento neste mês.');
  const clear = body.amount === '' || body.amount === null || body.amount === undefined;
  tx(() => {
    if (clear) run('DELETE FROM finance_plan WHERE obligation_id = ? AND ref_month = ?', o.id, ym);
    else keepManualPlan(o.id, ym, num(body.amount, 'Valor previsto'), ctx.user.id);
    audit(ctx.user.id, 'finance', o.id, clear ? 'Previsto do mês voltou ao valor da tarefa' : 'Previsto do mês ajustado (planejamento)', { tarefa: o.title, mes: monthLabel(ym), valor: clear ? o.amount : r2(num(body.amount, 'Valor previsto')) }, ip);
  });
  return { ok: true };
}

// Lança o real de um mês ainda não gerado (pagamento antecipado): cria a parcela do mês
export function ensureItem(ctx, obligationId, ym) {
  requireFinance(ctx.user);
  const o = one('SELECT * FROM finance_obligations WHERE id = ?', obligationId);
  if (!o) throw notFound('Tarefa financeira não encontrada.');
  if (!/^\d{4}-\d{2}$/.test(String(ym || '')) || !monthsOf(o, ym).includes(ym)) throw badRequest('Esta tarefa não tem vencimento neste mês.');
  const it = one('SELECT id FROM finance_items WHERE obligation_id = ? AND ref_month = ?', o.id, ym);
  const id = it ? it.id : tx(() => createItem(o, ym, ctx.user.id));
  return getItem(ctx, id);
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
    // Previsto: 0 = regra (realizado do ano anterior), 2 = zero no primeiro ano da categoria, 1 = sempre zero
    plan_zero: [0, 1, 2].includes(Number(body.plan_zero)) ? Number(body.plan_zero) : body.plan_zero === true || body.plan_zero === 'on' ? 1 : 0,
  };
  if (d.due_day < 1 || d.due_day > 31) throw badRequest('Dia de vencimento: informe de 1 a 31.');
  if (d.end_month && d.end_month < d.start_month) throw badRequest('O término deve ser depois do início.');
  if (d.assignee_id && !one('SELECT id FROM users WHERE id = ? AND active = 1 AND can_finance = 1', d.assignee_id)) {
    throw badRequest('O responsável precisa ter a liberação do Financeiro.');
  }
  return d;
}

export function listObligations(ctx) {
  requireFinance(ctx.user);
  const ref = today(), limitOf = limitReader(), overdue = new Map();
  for (const i of all(`SELECT obligation_id, ref_month, due_date FROM finance_items WHERE status = 'pendente' AND ref_month >= ? AND amount_expected > 0`, cutoff())) {
    if (limitOf(conferenceDate(i)) < ref) overdue.set(i.obligation_id, (overdue.get(i.obligation_id) || 0) + 1);
  }
  return all(`SELECT o.*, u.name AS assignee_name,
      (SELECT date(MIN(max(i.ref_month || '-01', i.due_date)), 'start of month', '+1 month', '-1 day') FROM finance_items i WHERE i.obligation_id = o.id AND i.status = 'pendente' AND i.ref_month >= ?) AS next_due
    FROM finance_obligations o LEFT JOIN users u ON u.id = o.assignee_id ORDER BY o.active DESC, o.category, o.title`, cutoff())
    .map(o => ({ ...o, overdue: overdue.get(o.id) || 0, frequency_label: FREQ_LABEL[o.frequency] }));
}

export function getObligation(ctx, id) {
  requireFinance(ctx.user);
  const o = one('SELECT o.*, u.name AS assignee_name FROM finance_obligations o LEFT JOIN users u ON u.id = o.assignee_id WHERE o.id = ?', id);
  if (!o) throw notFound('Obrigação não encontrada.');
  return { ...o, frequency_label: FREQ_LABEL[o.frequency], items: all('SELECT * FROM finance_items WHERE obligation_id = ? ORDER BY ref_month DESC', id), deletable: deleteBlock(id) === null };
}

// Excluir só quando não há nenhum pagamento registrado (nem "não ocorreu") e não vem da Folha
function deleteBlock(id) {
  if (one(`SELECT 1 FROM finance_items WHERE obligation_id = ? AND status = 'paga' LIMIT 1`, id)) return 'Esta tarefa tem pagamento registrado: não pode ser excluída (inative pela edição para parar de gerar parcelas).';
  if (one('SELECT 1 FROM payroll_entries WHERE obligation_id = ? LIMIT 1', id)) return 'Esta tarefa foi gerada pela Folha: é removida ao reabrir a folha.';
  return null;
}
export function deleteObligation(ctx, id, ip) {
  requireFinance(ctx.user);
  const o = one('SELECT * FROM finance_obligations WHERE id = ?', id);
  if (!o) throw notFound('Tarefa financeira não encontrada.');
  const why = deleteBlock(id);
  if (why) throw badRequest(why);
  tx(() => {
    run('DELETE FROM finance_plan WHERE obligation_id = ?', id);
    removeObligationInternal(id, ctx.user.id, 'Tarefa financeira excluída');
    audit(ctx.user.id, 'finance', id, 'Obrigação financeira excluída', { descricao: o.title, categoria: o.category }, ip);
  });
  return { ok: true };
}

// Grava a obrigação (sem gerar as parcelas — quem chama roda generateItems). Usado no cadastro e na importação.
export function insertObligation(ctx, d, ip, { imported = false } = {}) {
  if (!d.assignee_id) d.assignee_id = ctx.user.id; // sem responsável: quem cadastrou
  return tx(() => {
    const r = run(`INSERT INTO finance_obligations (title, category, payee, amount, variable, repeat_last, frequency, due_day, start_month, end_month, assignee_id, notes, active, created_by, plan_zero)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, d.title, d.category, d.payee, d.plan_zero === 1 ? 0 : d.amount, d.variable, d.variable ? d.repeat_last : 0, d.frequency, d.due_day, d.start_month, d.end_month, d.assignee_id, d.notes, d.active, ctx.user.id, d.plan_zero);
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
    run(`UPDATE finance_obligations SET title=?, category=?, payee=?, amount=?, variable=?, repeat_last=?, frequency=?, due_day=?, start_month=?, end_month=?, assignee_id=?, notes=?, active=?, plan_zero=?, updated_at=datetime('now') WHERE id=?`,
      d.title, d.category, d.payee, d.plan_zero === 1 ? 0 : d.amount, d.variable, d.variable ? d.repeat_last : 0, d.frequency, d.due_day, d.start_month, d.end_month, d.assignee_id, d.notes, d.active, d.plan_zero, id);
    // Previsto sempre zero: parcelas pendentes e meses projetados passam a 0 (nada esperado, sem alerta)
    if (d.plan_zero === 1) {
      for (const it of all(`SELECT * FROM finance_items WHERE obligation_id = ? AND status = 'pendente' AND amount_expected <> 0`, id)) {
        run('UPDATE finance_items SET amount_expected = 0 WHERE id = ?', it.id);
        if (it.task_id) syncZeroTask(it.task_id, 0, ctx.user.id);
      }
      run('UPDATE finance_plan SET amount = 0 WHERE obligation_id = ?', id);
    }
    const no = { ...o, ...d, id };
    // Parcelas pendentes do mês atual em diante acompanham a obrigação (valor, vencimento, responsável e título da tarefa)
    const area = financeAreaId();
    for (const it of all(`SELECT * FROM finance_items WHERE obligation_id = ? AND status = 'pendente' AND ref_month >= ?`, id, cur)) {
      const due = dueOf(it.ref_month, no.due_day);
      const amount = no.variable && o.variable ? it.amount_expected : no.amount;
      run('UPDATE finance_items SET due_date = ?, amount_expected = ? WHERE id = ?', due, amount, it.id);
      const conf = conferenceDate({ ref_month: it.ref_month, due_date: due });
      if (it.task_id) run('UPDATE tasks SET title = ?, description = ?, due_date = ?, start_date = ?, assignee_id = ?, stage_id = ?, updated_at = ? WHERE id = ? AND status <> \'concluida\'',
        taskTitle(no, it.ref_month), taskDescription(no, amount), financeTaskDue(area, conf), conf, no.assignee_id, stageFor(area, no.category), new Date().toISOString(), it.task_id);
    }
    pruneFuture(no, ctx.user.id);
    pruneOutOfRange(ctx.user.id);
    audit(ctx.user.id, 'finance', id, d.active ? 'Obrigação financeira atualizada' : 'Obrigação financeira inativada', { descricao: d.title, campos: Object.keys(d).filter(k => (d[k] ?? null) !== (o[k] ?? null)) }, ip);
  });
  generateItems(ctx.user.id);
  syncMonthTasks(ctx.user.id);
}

// ---------- Uso interno (Folha): obrigação única por pessoa, sem exigir a liberação do Financeiro ----------
export function createObligationInternal(userId, d) {
  const assignee = d.assignee_id && one('SELECT id FROM users WHERE id = ? AND active = 1 AND can_finance = 1', d.assignee_id) ? d.assignee_id : null;
  const id = Number(run(`INSERT INTO finance_obligations (title, category, payee, amount, variable, frequency, due_day, start_month, end_month, assignee_id, notes, active, created_by)
    VALUES (?,?,?,?,0,'unica',?,?,?,?,?,1,?)`, d.title, d.category || 'Folha de pagamento', d.payee || null, r2(d.amount), d.due_day, d.month, d.month, assignee, d.notes || null, userId).lastInsertRowid);
  createItem(one('SELECT * FROM finance_obligations WHERE id = ?', id), d.month, userId);
  syncMonthTasks(userId);
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
  syncMonthTasks(userId);
}
// Folha de Campo: baixa a parcela (e conclui a tarefa) quando todos da folha foram pagos; estorna ao desfazer
export function payItemInternal(itemId, userId, pd, note) {
  const it = one('SELECT * FROM finance_items WHERE id = ?', itemId);
  if (!it || it.status === 'paga') return;
  const now = new Date().toISOString();
  run(`UPDATE finance_items SET status = 'paga', estimated = 0, paid_date = ?, paid_amount = amount_expected, paid_by = ? WHERE id = ?`, pd, userId, itemId);
  if (it.task_id) {
    run(`UPDATE tasks SET status = 'concluida', started_at = COALESCE(started_at, ?), delivered_at = ?, completed_at = ?, review_status = 'aprovada', reviewed_by = ?, reviewed_at = ?, progress_pct = 100, updated_at = ? WHERE id = ? AND cancelled_at IS NULL`,
      now, `${pd}T15:00:00.000Z`, now, userId, now, now, it.task_id);
    taskHistory(it.task_id, userId, 'Pagamento registrado', `${brl(it.amount_expected)} pago em ${pd.split('-').reverse().join('/')}${note ? ` (${note})` : ''}`);
  }
  syncMonthTasks(userId);
}
export function unpayItemInternal(itemId, userId, note) {
  const it = one('SELECT * FROM finance_items WHERE id = ?', itemId);
  if (!it || it.status !== 'paga') return;
  run(`UPDATE finance_items SET status = 'pendente', paid_date = NULL, paid_amount = NULL, paid_by = NULL WHERE id = ?`, itemId);
  if (it.task_id) {
    run(`UPDATE tasks SET status = 'aberta', delivered_at = NULL, completed_at = NULL, review_status = NULL, reviewed_by = NULL, reviewed_at = NULL, progress_pct = NULL, updated_at = ? WHERE id = ?`, new Date().toISOString(), it.task_id);
    taskHistory(it.task_id, userId, 'Pagamento desfeito', note || 'Parcela voltou a pendente');
  }
  syncMonthTasks(userId);
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
    if (!it.task_id) for (const f of files) {
      const sv = saveImageFromDataUrl(f.data);
      run('INSERT INTO finance_item_files (item_id, stored_name, mime, size, original_name, uploaded_by, created_at) VALUES (?,?,?,?,?,?,?)',
        id, sv.stored_name, sv.mime, sv.size, cleanFileName(f.name) || (isPdf(sv.mime) ? 'comprovante.pdf' : null), ctx.user.id, now);
    }
    if (it.task_id) {
      for (const f of files) {
        const s = saveImageFromDataUrl(f.data);
        run('INSERT INTO task_files (task_id, kind, stored_name, mime, size, caption, original_name, uploaded_by, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
          it.task_id, 'execucao', s.stored_name, s.mime, s.size, 'Comprovante de pagamento', isPdf(s.mime) ? cleanFileName(f.name) || 'comprovante.pdf' : null, ctx.user.id, now);
      }
      run(`UPDATE tasks SET status = 'concluida', started_at = COALESCE(started_at, ?), delivered_at = ?, completed_at = ?, review_status = 'aprovada', reviewed_by = ?, reviewed_at = ?, progress_pct = 100, updated_at = ? WHERE id = ?`,
        now, `${pd}T15:00:00.000Z`, now, ctx.user.id, now, now, it.task_id);
      run('UPDATE tasks SET cancelled_at = NULL, cancelled_by = NULL, cancel_reason = NULL WHERE id = ? AND cancel_reason = ?', it.task_id, ZERO_REASON);
      taskHistory(it.task_id, ctx.user.id, amount === 0 ? 'Não ocorreu no mês' : 'Pagamento registrado', amount === 0 ? 'Real lançado = R$ 0,00: a previsão não ocorreu neste mês (Financeiro)' : `${brl(amount)} pago em ${pd.split('-').reverse().join('/')}${files.length ? ` · ${files.length} comprovante(s)` : ''} (Financeiro)`);
    }
    audit(ctx.user.id, 'finance', it.obligation_id, amount === 0 ? 'Parcela marcada como não ocorrida (real = 0)' : 'Parcela paga', { parcela: `${it.title} ${monthLabel(it.ref_month)}`, valor: amount, data: pd }, ip);
    syncMonthTasks(ctx.user.id);
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
      taskHistory(it.task_id, ctx.user.id, 'Pagamento desfeito', 'Parcela voltou a pendente (Financeiro)');
    }
    audit(ctx.user.id, 'finance', it.obligation_id, 'Pagamento desfeito', { parcela: `${it.title} ${monthLabel(it.ref_month)}` }, ip);
    syncMonthTasks(ctx.user.id);
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
    keepManualPlan(it.obligation_id, it.ref_month, amount, ctx.user.id);
    if (it.task_id) {
      const o = one('SELECT * FROM finance_obligations WHERE id = ?', it.obligation_id);
      run('UPDATE tasks SET description = ?, updated_at = ? WHERE id = ?', taskDescription(o, amount), new Date().toISOString(), it.task_id);
      taskHistory(it.task_id, ctx.user.id, 'Valor previsto ajustado', `${brl(it.amount_expected)} → ${brl(amount)}`);
      syncZeroTask(it.task_id, amount, ctx.user.id);
    }
    audit(ctx.user.id, 'finance', it.obligation_id, 'Valor da parcela ajustado', { parcela: `${it.title} ${monthLabel(it.ref_month)}`, de: it.amount_expected, para: amount }, ip);
    syncMonthTasks(ctx.user.id);
  });
  return getItem(ctx, id);
}

export function getItem(ctx, id) {
  const it = loadItem(ctx, id);
  const tid = it.task_id || it.legacy_task_id;
  const files = [...(tid ? all(`SELECT id, mime, original_name, created_at, 'task' AS src FROM task_files WHERE task_id = ? AND kind = 'execucao' ORDER BY id`, tid) : []),
    ...all(`SELECT id, mime, original_name, created_at, 'item' AS src FROM finance_item_files WHERE item_id = ? ORDER BY id`, it.id)];
  return { ...it, files, check: itemCheckState(it) };
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
  syncMonthTasks(userId);
}

// Quem pode ser responsável: usuários ativos com a liberação do Financeiro
export function financeAssignees(ctx) {
  requireFinance(ctx.user);
  return financeAssigneeList();
}
export const financeAssigneeList = () => all('SELECT id, name, job_title FROM users WHERE active = 1 AND can_finance = 1 ORDER BY name');

// Tarefa avulsa na área do Financeiro (ex.: atualizar no Mais Controle o recebimento de uma medição de Contratos).
// Responsável só entre quem tem o Financeiro liberado (sem responsável fica para a equipe do Financeiro distribuir).
export function createFinanceTask({ title, description, due_date, assignee_id, stage, userId }) {
  const area = one('SELECT * FROM projects WHERE id = ?', financeAreaId() || ensureFinanceArea() || financeAreaId());
  const assignee = assignee_id && one('SELECT id FROM users WHERE id = ? AND active = 1 AND can_finance = 1', assignee_id) ? assignee_id : null;
  if (assignee_id && !assignee) throw badRequest('O responsável precisa ter o Financeiro liberado.');
  const t = today();
  return insertTask({
    project: area,
    data: { task_type: 'tarefa', title: String(title).slice(0, 200), description, field_summary: null, notes: null, due_date, start_date: t <= due_date ? t : due_date, priority: 'media', proof_type: 'nenhuma', assignee_id: assignee },
    stageInput: stageFor(area.id, stage),
    creatorId: userId,
  });
}
// Cancela uma tarefa ainda aberta (não concluída), com o motivo
export function cancelOpenTask(taskId, userId, reason) {
  if (!taskId) return false;
  const now = new Date().toISOString();
  return run(`UPDATE tasks SET cancelled_at = ?, cancelled_by = ?, cancel_reason = ?, updated_at = ? WHERE id = ? AND cancelled_at IS NULL AND status <> 'concluida'`, now, userId, reason, now, taskId).changes > 0;
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
  const rows = all(`SELECT i.*, o.title, o.category, o.payee, o.variable, o.repeat_last, o.frequency, o.assignee_id AS ob_assignee, COALESCE(u.name, ou.name) AS assignee_name, t.code AS task_code,
      (SELECT pm.ref FROM payroll_months pm WHERE pm.finance_item_id = i.id) AS payroll_ref
    FROM finance_items i JOIN finance_obligations o ON o.id = i.obligation_id
    LEFT JOIN tasks t ON t.id = i.task_id LEFT JOIN users u ON u.id = t.assignee_id LEFT JOIN users ou ON ou.id = o.assignee_id
    WHERE (i.ref_month = ? OR (i.status = 'pendente' AND i.due_date < ? AND i.ref_month >= ?)) AND NOT (i.status = 'pendente' AND i.amount_expected = 0) ORDER BY i.due_date, o.title`, month, ref, cutoff());
  const cut = cutoff();
  const limitOf = limitReader();
  const decorate = it => {
    const before = it.status === 'pendente' && it.ref_month < cut; // antes do início do controle: histórico, não é atraso
    const conf = conferenceDate(it);
    const limit = limitOf(conf);
    const late = !before && it.status === 'pendente' && limit < ref && r2(it.amount_expected) > 0;
    const days = Math.round((Date.parse(conf) - Date.parse(ref)) / 86400e3);
    return { ...it, check: itemCheckState(it), due_date: conf, planned_date: it.due_date, task_limit: limit, late, days_to_due: days, situation: it.status === 'paga' ? 'paga' : before ? 'antes' : late ? 'atrasada' : days < 0 ? 'a_conferir' : days === 0 ? 'hoje' : days <= 7 ? 'semana' : 'futura', frequency_label: FREQ_LABEL[it.frequency] };
  };
  // De outro mês, só as atrasadas; no mês atual, também as vencidas que ainda estão no prazo
  const items = rows.map(decorate).filter(it => it.ref_month === month || it.late || (it.situation === 'a_conferir' && month === ref.slice(0, 7)))
    .sort((a, b) => a.due_date.localeCompare(b.due_date) || a.title.localeCompare(b.title, 'pt-BR')).map(it => ({ ...it, previous_amount: it.variable ? previousAmount(it.obligation_id, it.ref_month) : null }));
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
      week: sum(items.filter(i => i.situation === 'hoje' || i.situation === 'semana'), i => i.amount_expected),
      week_count: items.filter(i => i.situation === 'hoje' || i.situation === 'semana').length,
    },
    control_start: controlStart(), control_label: controlStart() ? monthLabel(controlStart()) : null,
    items, // do mês + atrasadas de meses anteriores
    month_lists: monthLists(month),
    categories: [...cats.values()].sort((a, b) => b.expected - a.expected),
    area_id: financeAreaId(),
    category_options: CATEGORIES,
  };
}

// Listas do mês (uma por responsável): avanço dos checks e a tarefa, se criada
function monthLists(ym) {
  try {
    const groups = new Map();
    for (const i of monthItems(ym)) { if (!groups.has(i.key)) groups.set(i.key, []); groups.get(i.key).push(i); }
    return [...groups].map(([key, list]) => {
      const mt = one('SELECT * FROM finance_month_tasks WHERE ref_month = ? AND assignee_key = ?', ym, key);
      const t = mt?.task_id ? one('SELECT id, code, status, cancelled_at FROM tasks WHERE id = ?', mt.task_id) : null;
      return { assignee_id: key || null, assignee_name: list[0].assignee_name || null, summary: checkSummary(list), task: t && !t.cancelled_at ? { id: t.id, code: t.code, status: t.status } : null, skipped: !!mt?.skipped };
    }).sort((a, b) => (a.assignee_name || 'zz').localeCompare(b.assignee_name || 'zz', 'pt-BR'));
  } catch { return []; }
}

// ---------- Mais Controle: cobertura dos dados, "Paguei" e justificativa ----------
// Até que dia a última busca do Mais Controle cobre (para conferir o "Paguei" e pedir justificativa)
export function coverage() {
  try { return one(`SELECT data_until, fetched_at FROM ext_fetches WHERE source = 'maiscontrole' AND row_count > 0 ORDER BY id DESC LIMIT 1`) || null; } catch { return null; }
}
const tsOf = s => Date.parse(/Z$|T/.test(s) ? s : `${s.replace(' ', 'T')}Z`);
// "Paguei" sem confirmação: aguardando a próxima busca; se a busca já cobre o fim do mês da despesa e não achou → não encontrado
export function markState(it, cov) {
  if (cov && cov.data_until >= conferenceDate(it) && tsOf(cov.fetched_at) > tsOf(it.marked_paid_at)) return 'nao_encontrado';
  return 'aguardando';
}
// Custos de Projetos pagos pela Empresa (centros de custo diferentes de Empresa), uma linha por centro de custo
function projectCosts(keys) {
  let rows = [];
  try {
    rows = all(`SELECT p.cost_center, p.ref_month, SUM(p.amount) AS total, COUNT(*) AS n FROM ext_payments p
      JOIN ext_accounts a ON a.source = p.source AND a.ext_key = p.account_key AND a.active = 1
      WHERE p.paid_date IS NOT NULL AND p.amount > 0 AND COALESCE(p.cost_center, '') <> '' AND lower(p.cost_center) <> 'empresa' AND p.ref_month BETWEEN ? AND ?
      GROUP BY p.cost_center, p.ref_month`, keys[0], keys[11]);
  } catch { return []; }
  const by = new Map();
  for (const r of rows) {
    if (!by.has(r.cost_center)) by.set(r.cost_center, { cost_center: r.cost_center, months: keys.map(() => 0), count: 0 });
    const g = by.get(r.cost_center); g.months[keys.indexOf(r.ref_month)] = r2(r.total); g.count += r.n;
  }
  return [...by.values()].map(g => ({ ...g, total: r2(g.months.reduce((s, v) => s + v, 0)) })).sort((a, b) => a.cost_center.localeCompare(b.cost_center, 'pt-BR'));
}
// Gastos dos clientes (contas bancárias do tipo Cliente) por obra e, dentro da obra, por conta
function clientCosts(keys) {
  let rows = [];
  try {
    rows = all(`SELECT a.ext_key AS acc, a.label AS client, p.cost_center, p.ref_month, SUM(p.amount) AS total FROM ext_payments p
      JOIN ext_accounts a ON a.source = p.source AND a.ext_key = p.account_key AND COALESCE(a.kind, a.auto_kind) = 'cliente'
      WHERE p.paid_date IS NOT NULL AND p.amount > 0 AND COALESCE(p.cost_center, '') <> '' AND lower(p.cost_center) <> 'empresa' AND p.ref_month BETWEEN ? AND ?
      GROUP BY a.ext_key, p.cost_center, p.ref_month`, keys[0], keys[11]);
  } catch { return []; }
  const by = new Map();
  for (const r of rows) {
    if (!by.has(r.cost_center)) by.set(r.cost_center, { cost_center: r.cost_center, accounts: new Map() });
    const o = by.get(r.cost_center);
    if (!o.accounts.has(r.acc)) o.accounts.set(r.acc, { key: r.acc, client: r.client, months: keys.map(() => 0) });
    o.accounts.get(r.acc).months[keys.indexOf(r.ref_month)] = r2(r.total);
  }
  const sum = ms => r2(ms.reduce((s, v) => s + v, 0));
  return [...by.values()].map(o => {
    const accounts = [...o.accounts.values()].map(a => ({ ...a, total: sum(a.months) })).sort((a, b) => a.client.localeCompare(b.client, 'pt-BR'));
    const months = keys.map((k, i) => r2(accounts.reduce((s, a) => s + a.months[i], 0)));
    return { cost_center: o.cost_center, accounts, months, total: sum(months) };
  }).sort((a, b) => a.cost_center.localeCompare(b.cost_center, 'pt-BR'));
}
export function markPaid(ctx, id, body, ip) {
  const it = loadItem(ctx, id);
  if (it.status === 'paga') throw badRequest('Esta parcela já está paga.');
  const amount = body.amount === '' || body.amount === undefined || body.amount === null ? null : r2(num(body.amount, 'Valor pago'));
  const now = new Date().toISOString();
  tx(() => {
    run('UPDATE finance_items SET marked_paid_at = ?, marked_paid_by = ?, marked_amount = ? WHERE id = ?', now, ctx.user.id, amount, id);
    if (it.task_id) {
      run(`UPDATE tasks SET status = 'concluida', started_at = COALESCE(started_at, ?), delivered_at = ?, completed_at = ?, review_status = 'aprovada', reviewed_by = ?, reviewed_at = ?, progress_pct = 100, updated_at = ? WHERE id = ?`,
        now, now, now, ctx.user.id, now, now, it.task_id);
      taskHistory(it.task_id, ctx.user.id, 'Marcado como pago', `${amount != null ? brl(amount) : 'valor a confirmar'} · aguardando confirmação do Mais Controle`);
    }
    audit(ctx.user.id, 'finance', it.obligation_id, 'Parcela marcada como paga (aguardando Mais Controle)', { parcela: `${it.title} ${monthLabel(it.ref_month)}`, valor: amount }, ip);
    syncMonthTasks(ctx.user.id);
  });
  return getItem(ctx, id);
}
export function unmarkPaid(ctx, id, ip) {
  const it = loadItem(ctx, id);
  if (it.status === 'paga' || !it.marked_paid_at) throw badRequest('Esta parcela não está marcada como paga.');
  tx(() => {
    run('UPDATE finance_items SET marked_paid_at = NULL, marked_paid_by = NULL, marked_amount = NULL WHERE id = ?', id);
    if (it.task_id) {
      run(`UPDATE tasks SET status = 'aberta', delivered_at = NULL, completed_at = NULL, review_status = NULL, reviewed_by = NULL, reviewed_at = NULL, progress_pct = NULL, updated_at = ? WHERE id = ?`, new Date().toISOString(), it.task_id);
      taskHistory(it.task_id, ctx.user.id, 'Marcação de pago desfeita', '');
    }
    audit(ctx.user.id, 'finance', it.obligation_id, 'Marcação de pago desfeita', { parcela: `${it.title} ${monthLabel(it.ref_month)}` }, ip);
    syncMonthTasks(ctx.user.id);
  });
  return getItem(ctx, id);
}
// Despesa prevista sem pagamento: "vai ocorrer" (nova data) ou "não vai ocorrer" (real 0), sempre com motivo
export function justifyItem(ctx, id, body, ip) {
  const it = loadItem(ctx, id);
  if (it.status === 'paga') throw badRequest('Esta parcela já está paga.');
  const kind = oneOf(body.kind, ['vai_ocorrer', 'nao_ocorre'], 'Justificativa');
  const reason = str(body.reason, { max: 500, required: true, label: 'Motivo' });
  const now = new Date().toISOString();
  if (kind === 'nao_ocorre') {
    tx(() => {
      run('UPDATE finance_items SET justify_kind = ?, justify_reason = ?, justified_at = ?, justified_by = ?, marked_paid_at = NULL, marked_amount = NULL WHERE id = ?', kind, reason, now, ctx.user.id, id);
      payItem(ctx, id, { paid_date: today(), paid_amount: 0, notes: `Não vai ocorrer: ${reason}` }, ip);
    });
    return getItem(ctx, id);
  }
  const nd = date(body.new_date, 'Nova data prevista');
  if (!nd) throw badRequest('Informe a nova data prevista.');
  if (nd < today()) throw badRequest('A nova data prevista não pode ser no passado.');
  tx(() => {
    run('UPDATE finance_items SET due_date = ?, justify_kind = ?, justify_reason = ?, justified_at = ?, justified_by = ?, marked_paid_at = NULL, marked_amount = NULL WHERE id = ?', nd, kind, reason, now, ctx.user.id, id);
    if (it.task_id) {
      const conf = conferenceDate({ ref_month: it.ref_month, due_date: nd });
      run(`UPDATE tasks SET due_date = ?, start_date = ?, status = CASE WHEN status = 'concluida' THEN 'aberta' ELSE status END, updated_at = ? WHERE id = ?`, financeTaskDue(financeAreaId(), conf), conf, now, it.task_id);
      taskHistory(it.task_id, ctx.user.id, 'Pagamento reprogramado', `Vai ocorrer em ${nd.split('-').reverse().join('/')} · ${reason}`);
    }
    audit(ctx.user.id, 'finance', it.obligation_id, 'Despesa sem pagamento justificada', { parcela: `${it.title} ${monthLabel(it.ref_month)}`, vai_ocorrer: nd, motivo: reason }, ip);
    syncMonthTasks(ctx.user.id);
  });
  return getItem(ctx, id);
}

// Parcela de um mês do histórico (sincronização do Mais Controle): mês já fechado não gera tarefa "a fazer"
export function ensureItemInternal(o, ym, userId) {
  const it = one('SELECT * FROM finance_items WHERE obligation_id = ? AND ref_month = ?', o.id, ym);
  if (it) return it;
  const id = createItem(o, ym, userId, { noTask: true });
  return one('SELECT * FROM finance_items WHERE id = ?', id);
}
// Ajuste manual do previsto de um mês (fica por cima do previsto calculado pelo ano anterior)
function keepManualPlan(obligationId, ym, amount, userId) {
  run(`INSERT INTO finance_plan (obligation_id, ref_month, amount, updated_by, auto) VALUES (?,?,?,?,0)
    ON CONFLICT(obligation_id, ref_month) DO UPDATE SET amount = excluded.amount, updated_by = excluded.updated_by, auto = 0, updated_at = datetime('now')`, obligationId, ym, r2(amount), userId);
}

export const syncZero = (taskId, amount, userId) => syncZeroTask(taskId, amount, userId);
