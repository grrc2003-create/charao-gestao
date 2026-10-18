// Férias (regras de férias): períodos aquisitivos de 12 meses a partir da admissão, 30 dias de direito por período,
// gozo no período concessivo (12 meses seguintes), até 3 frações (uma com 14+ dias, as demais com 5+),
// início vedado nos 2 dias que antecedem feriado ou o repouso semanal (domingo).
// A pessoa solicita; o gestor (direto ou acima), quem tem a Gestão da Equipe ou o administrador aprova.
import { all, one, run, tx } from '../db.js';
import { badRequest, forbidden, notFound, str, date, intOrNull } from '../lib/http.js';
import { isAdmin, hasSection, teamIds } from '../lib/permissions.js';
import { audit } from './audit.js';
import { today, daysBetween } from './metrics.js';
import { nationalHolidays, nextWorkingDay } from './calendar.js';
import { updateTask } from './tasks.js';

const DIREITO = 30;
const fmtD = d => (d ? d.split('-').reverse().join('/') : '—');
const addDays = (d, n) => new Date(Date.parse(d) + n * 86400e3).toISOString().slice(0, 10);
function addMonths(d, n) {
  let [y, m, dd] = d.split('-').map(Number);
  m += n;
  y += Math.floor((m - 1) / 12);
  m = ((m - 1) % 12 + 12) % 12 + 1;
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${y}-${String(m).padStart(2, '0')}-${String(Math.min(dd, last)).padStart(2, '0')}`;
}
const LIVE = `status IN ('solicitada','aprovada')`;

// Períodos aquisitivos (do mais antigo ao atual), com saldo e situação
export function periodsOf(u, ref = today()) {
  if (!u?.admission_date) return [];
  const vac = all(`SELECT * FROM vacations WHERE user_id = ? AND ${LIVE} ORDER BY start_date`, u.id);
  const out = [];
  for (let k = 0; k < 80; k++) {
    const start = addMonths(u.admission_date, 12 * k);
    if (start > ref) break;
    const end = addDays(addMonths(u.admission_date, 12 * (k + 1)), -1);
    const concessionEnd = addDays(addMonths(u.admission_date, 12 * (k + 2)), -1);
    const list = vac.filter(v => v.period_start === start);
    const used = list.filter(v => v.status === 'aprovada').reduce((n, v) => n + v.days, 0);
    const pending = list.filter(v => v.status === 'solicitada').reduce((n, v) => n + v.days, 0);
    const acquired = end < ref;
    // Períodos encerrados antes do controle no sistema: considerados quitados (férias tiradas fora do sistema)
    if (u.vacation_since && end < u.vacation_since && !list.length) {
      out.push({ start, end, concession_end: concessionEnd, acquired: true, used: 0, pending: 0, balance: 0, status: 'quitado', fractions: 0 });
      continue;
    }
    const balance = acquired ? DIREITO - used - pending : 0;
    const status = !acquired ? 'em_aquisicao' : balance <= 0 ? 'concluido'
      : concessionEnd < ref ? 'vencida' : daysBetween(ref, concessionEnd) <= 60 ? 'vencendo' : 'disponivel';
    out.push({ start, end, concession_end: concessionEnd, acquired, used, pending, balance, status, fractions: list.length });
  }
  return out;
}

// Resumo para listas e painéis
export function vacationSummary(u, ref = today()) {
  if (u.is_external) return null;
  if (!u.admission_date) return { status: 'sem_admissao', available: 0 };
  const ps = periodsOf(u, ref);
  const open = ps.filter(p => p.acquired && p.balance > 0);
  const worst = open.find(p => p.status === 'vencida') || open.find(p => p.status === 'vencendo') || open[0] || null;
  const cur = ps.find(p => !p.acquired);
  return {
    status: worst ? worst.status : cur ? 'em_aquisicao' : 'concluido',
    available: open.reduce((n, p) => n + p.balance, 0),
    deadline: worst?.concession_end || null,
    next_right: cur ? addDays(cur.end, 1) : null,
  };
}

export function canApprove(ctx, target) {
  if (target.id === ctx.user.id && !isAdmin(ctx.user)) return false;
  return isAdmin(ctx.user) || hasSection(ctx.user, 'equipe') || teamIds(ctx.user.id).has(target.id);
}

function holidaySet(years) {
  const s = new Set();
  for (const y of years) for (const h of nationalHolidays(y)) if (!h.optional) s.add(h.date);
  return s;
}

// Validação completa de um pedido; devolve o período escolhido e os avisos (não bloqueiam)
function check(target, startIn, daysIn, { allowPast = false, excludeId = null } = {}) {
  if (target.is_external) throw badRequest('Férias são controladas apenas para a equipe interna (terceirizados não entram).');
  if (!target.admission_date) throw badRequest(`Informe a data de admissão de ${target.name} no Cadastro da Equipe para calcular as férias.`);
  const start = date(startIn, 'Início das férias');
  if (!start) throw badRequest('Informe o início das férias.');
  const days = Number(daysIn);
  if (!Number.isInteger(days) || days < 5 || days > DIREITO) throw badRequest('Cada período de férias deve ter entre 5 e 30 dias.');
  const ref = today();
  if (!allowPast && start < ref) throw badRequest('O início das férias não pode ser no passado.');
  const end = addDays(start, days - 1);
  // Início vedado nos 2 dias que antecedem feriado ou o repouso semanal remunerado (domingo)
  const hol = holidaySet([Number(start.slice(0, 4)), Number(start.slice(0, 4)) + 1]);
  for (const i of [1, 2]) {
    const d = addDays(start, i);
    if (new Date(d + 'T00:00:00Z').getUTCDay() === 0 || hol.has(d)) {
      throw badRequest(`As férias não podem começar nos 2 dias que antecedem feriado ou o repouso semanal (${fmtD(d)}${hol.has(d) ? ', feriado' : ', domingo'}). Escolha outro início.`);
    }
  }
  // Sem sobreposição com outras férias da pessoa
  const clash = one(`SELECT start_date, end_date FROM vacations WHERE user_id = ? AND ${LIVE} AND id <> ? AND start_date <= ? AND end_date >= ?`, target.id, excludeId || 0, end, start);
  if (clash) throw badRequest(`Já existem férias de ${fmtD(clash.start_date)} a ${fmtD(clash.end_date)} neste intervalo.`);
  // Período aquisitivo: o mais antigo já adquirido, com saldo, que comporte este pedido pelas regras de fracionamento
  const ps = periodsOf(target, ref).filter(p => p.acquired && p.status !== 'quitado' && start > p.end);
  let firstErr = null;
  for (const p of ps) {
    const list = all(`SELECT days FROM vacations WHERE user_id = ? AND period_start = ? AND ${LIVE} AND id <> ?`, target.id, p.start, excludeId || 0);
    const balance = DIREITO - list.reduce((n, v) => n + v.days, 0);
    if (balance <= 0) continue;
    let err = null;
    if (days > balance) err = `O período aquisitivo ${fmtD(p.start)}–${fmtD(p.end)} tem saldo de ${balance} dia(s).`;
    else if (list.length >= 3) err = `O período aquisitivo ${fmtD(p.start)}–${fmtD(p.end)} já foi dividido em 3 partes (limite de 3 partes).`;
    else {
      const remaining = balance - days;
      const hasBig = list.some(v => v.days >= 14) || days >= 14;
      if (remaining > 0 && remaining < 5) err = `Sobrariam ${remaining} dia(s) no período ${fmtD(p.start)}–${fmtD(p.end)}; cada parte deve ter ao menos 5 dias.`;
      else if (!hasBig && (remaining < 14 || list.length + 1 >= 3)) err = 'Uma das partes das férias precisa ter ao menos 14 dias. Aumente este período ou reserve 14 dias para outra parte.';
      else if (remaining > 0 && list.length + 1 >= 3) err = `Este seria o 3º período: use todo o saldo restante (${balance} dia(s)).`;
    }
    if (!err) {
      const warnings = [];
      if (daysBetween(ref, start) < 30 && start >= ref) warnings.push('As férias devem ser comunicadas com pelo menos 30 dias de antecedência.');
      if (end > p.concession_end) warnings.push(`As férias terminam depois do fim do período concessivo (${fmtD(p.concession_end)}): os dias excedentes são pagos em dobro.`);
      if (p.concession_end < ref) warnings.push(`Férias do período ${fmtD(p.start)}–${fmtD(p.end)} já vencidas: pagamento em dobro.`);
      // Equipe: outras férias no mesmo período (mesmo gestor)
      if (target.manager_id) {
        const mates = all(`SELECT u.name, v.start_date, v.end_date FROM vacations v JOIN users u ON u.id = v.user_id
          WHERE u.manager_id = ? AND u.id <> ? AND v.${LIVE.replace('status', 'status')} AND v.start_date <= ? AND v.end_date >= ?`, target.manager_id, target.id, end, start);
        if (mates.length) warnings.push(`Também estarão de férias no período: ${mates.map(m => `${m.name} (${fmtD(m.start_date).slice(0, 5)}–${fmtD(m.end_date).slice(0, 5)})`).join(', ')}.`);
      }
      return { start_date: start, end_date: end, days, period: { start: p.start, end: p.end, concession_end: p.concession_end, balance_after: balance - days }, warnings,
        conflicts: conflictsOf(target.id, start, end) };
    }
    firstErr = firstErr || err;
  }
  if (firstErr) throw badRequest(firstErr);
  const cur = periodsOf(target, ref).find(p => !p.acquired);
  throw badRequest(ps.length ? 'Não há saldo de férias disponível.' : `${target.name.split(' ')[0]} ainda não completou um período aquisitivo${cur ? `: o direito começa em ${fmtD(addDays(cur.end, 1))}` : ''}.`);
}

// Tarefas da pessoa com entrega (prazo) dentro das férias: precisam de novo prazo proposto
export function conflictsOf(userId, start, end) {
  return all(`SELECT t.id, t.code, t.title, t.due_date, t.start_date, t.project_id, p.code AS project_code FROM tasks t JOIN projects p ON p.id = t.project_id
    WHERE t.assignee_id = ? AND t.cancelled_at IS NULL AND t.status IN ('aberta','em_andamento') AND t.task_type = 'tarefa'
      AND t.due_date BETWEEN ? AND ? ORDER BY t.due_date, t.code`, userId, start, end)
    .map(t => ({ ...t, suggested: nextWorkingDay(t.project_id, addDays(end, 1), userId) }));
}

// Lê e valida os novos prazos propostos: um para cada tarefa em conflito, fora do período das férias
function readProposals(conflicts, input, start, end) {
  const map = new Map((Array.isArray(input) ? input : []).map(x => [intOrNull(x?.task_id), x?.new_due]));
  const missing = [];
  const out = [];
  for (const t of conflicts) {
    const nd = map.get(t.id) ? date(map.get(t.id), `Novo prazo de ${t.code}`) : null;
    if (!nd) { missing.push(t.code); continue; }
    if (nd >= start && nd <= end) throw badRequest(`O novo prazo de ${t.code} (${fmtD(nd)}) cai dentro das férias. Escolha uma data antes de ${fmtD(start)} ou depois de ${fmtD(end)}.`);
    if (nd < today()) throw badRequest(`O novo prazo de ${t.code} não pode ser no passado.`);
    if (t.start_date && nd < t.start_date) throw badRequest(`O novo prazo de ${t.code} é anterior ao início previsto da tarefa (${fmtD(t.start_date)}).`);
    out.push({ task_id: t.id, old_due: t.due_date, new_due: nd });
  }
  if (missing.length) throw badRequest(`Há ${missing.length} tarefa(s) com entrega nas férias: ${missing.join(', ')}. Proponha o novo prazo de cada uma para solicitar este período.`);
  return out;
}

// Aplica os reagendamentos (na aprovação): justificativa "Férias do responsável"
function applyProposals(ctx, v, t, list) {
  const reason = one(`SELECT id FROM reschedule_reasons WHERE name = 'Férias do responsável' COLLATE NOCASE`)
    || one('SELECT id FROM reschedule_reasons WHERE active = 1 ORDER BY sort_order LIMIT 1');
  const requester = one('SELECT name FROM users WHERE id = ?', v.requested_by)?.name || t.name;
  for (const r of list) {
    const task = one('SELECT id, due_date, cancelled_at, status FROM tasks WHERE id = ?', r.task_id);
    if (!task || task.cancelled_at || !['aberta', 'em_andamento'].includes(task.status) || task.due_date === r.new_due) continue;
    updateTask(ctx, r.task_id, { due_date: r.new_due, reschedule_reason_id: reason.id,
      reschedule_note: `Férias de ${t.name} de ${fmtD(v.start_date)} a ${fmtD(v.end_date)} · proposto por ${requester}, aprovado por ${ctx.user.name}` }, { trusted: true });
    run('UPDATE vacation_reschedules SET applied = 1 WHERE vacation_id = ? AND task_id = ?', v.id, r.task_id);
  }
}

function targetOf(userId) {
  const t = one('SELECT * FROM users WHERE id = ? AND active = 1', userId);
  if (!t) throw notFound('Pessoa não encontrada.');
  return t;
}

export function previewVacation(ctx, body) {
  const t = targetOf(intOrNull(body.user_id) || ctx.user.id);
  const self = t.id === ctx.user.id;
  if (!self && !canApprove(ctx, t)) throw forbidden('Você não pode lançar férias desta pessoa.');
  try {
    return { ok: true, ...check(t, body.start_date, body.days, { allowPast: !self || isAdmin(ctx.user) }) };
  } catch (e) {
    if (e.status === 400) return { ok: false, error: e.message };
    throw e;
  }
}

export function requestVacation(ctx, body, ip) {
  const t = targetOf(intOrNull(body.user_id) || ctx.user.id);
  const self = t.id === ctx.user.id;
  const approver = canApprove(ctx, t);
  if (!self && !approver) throw forbidden('Você não pode lançar férias desta pessoa.');
  const c = check(t, body.start_date, body.days, { allowPast: approver });
  const proposals = readProposals(c.conflicts, body.reschedules, c.start_date, c.end_date);
  const status = approver ? 'aprovada' : 'solicitada';
  const note = str(body.note, { max: 1000, label: 'Observação' });
  const id = tx(() => {
    const r = run(`INSERT INTO vacations (user_id, period_start, start_date, end_date, days, status, note, requested_by, decided_by, decided_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`, t.id, c.period.start, c.start_date, c.end_date, c.days, status, note, ctx.user.id,
      status === 'aprovada' ? ctx.user.id : null, status === 'aprovada' ? new Date().toISOString().replace('T', ' ').slice(0, 19) : null);
    const vid = Number(r.lastInsertRowid);
    for (const x of proposals) run('INSERT INTO vacation_reschedules (vacation_id, task_id, old_due, new_due) VALUES (?,?,?,?)', vid, x.task_id, x.old_due, x.new_due);
    if (status === 'aprovada') applyProposals(ctx, { id: vid, start_date: c.start_date, end_date: c.end_date, requested_by: ctx.user.id }, t, proposals);
    audit(ctx.user.id, 'vacation', vid, status === 'aprovada' ? 'Férias lançadas' : 'Férias solicitadas',
      { pessoa: t.name, periodo: `${fmtD(c.start_date)} a ${fmtD(c.end_date)}`, dias: c.days, reagendamentos: proposals.length }, ip);
    return vid;
  });
  return { id, status, warnings: c.warnings, reschedules: proposals.length };
}

export function vacationAction(ctx, id, action, body = {}, ip) {
  const v = one('SELECT * FROM vacations WHERE id = ?', id);
  if (!v) throw notFound('Férias não encontradas.');
  const t = one('SELECT * FROM users WHERE id = ?', v.user_id);
  const approver = canApprove(ctx, t);
  const self = t.id === ctx.user.id;
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
  if (action === 'approve' || action === 'reject') {
    if (!approver) throw forbidden('Você não pode decidir as férias desta pessoa.');
    if (v.status !== 'solicitada') throw badRequest('Estas férias não estão aguardando aprovação.');
    const note = str(body.note, { max: 1000, required: action === 'reject', label: 'Motivo' });
    tx(() => {
      if (action === 'approve') {
        check(t, v.start_date, v.days, { allowPast: true, excludeId: v.id });
        // Propostas da pessoa (o gestor pode ajustar ou completar, ex.: tarefa criada depois do pedido)
        const saved = all('SELECT task_id, new_due FROM vacation_reschedules WHERE vacation_id = ?', v.id);
        const given = new Map((Array.isArray(body.reschedules) ? body.reschedules : []).map(x => [intOrNull(x?.task_id), x?.new_due]));
        const merged = saved.map(x => ({ task_id: x.task_id, new_due: given.get(x.task_id) || x.new_due }));
        for (const [tid, nd] of given) if (tid && !merged.some(x => x.task_id === tid)) merged.push({ task_id: tid, new_due: nd });
        const proposals = readProposals(conflictsOf(t.id, v.start_date, v.end_date), merged, v.start_date, v.end_date);
        for (const x of proposals) run(`INSERT INTO vacation_reschedules (vacation_id, task_id, old_due, new_due) VALUES (?,?,?,?)
          ON CONFLICT (vacation_id, task_id) DO UPDATE SET new_due = excluded.new_due`, v.id, x.task_id, x.old_due, x.new_due);
        applyProposals(ctx, v, t, proposals);
      }
      run(`UPDATE vacations SET status = ?, decided_by = ?, decided_at = ?, decision_note = ?, updated_at = datetime('now') WHERE id = ?`,
        action === 'approve' ? 'aprovada' : 'recusada', ctx.user.id, now, note, id);
    });
    audit(ctx.user.id, 'vacation', id, action === 'approve' ? 'Férias aprovadas' : 'Férias recusadas', { pessoa: t.name, periodo: `${fmtD(v.start_date)} a ${fmtD(v.end_date)}`, motivo: note }, ip);
  } else if (action === 'cancel') {
    const can = (self && v.status === 'solicitada') || (approver && ['solicitada', 'aprovada'].includes(v.status));
    if (!can) throw forbidden('Você não pode cancelar estas férias.');
    if (v.status === 'aprovada' && v.end_date < today()) throw badRequest('Férias já gozadas não podem ser canceladas.');
    run(`UPDATE vacations SET status = 'cancelada', decided_by = ?, decided_at = ?, decision_note = ?, updated_at = datetime('now') WHERE id = ?`,
      ctx.user.id, now, str(body.note, { max: 1000, label: 'Motivo' }), id);
    audit(ctx.user.id, 'vacation', id, 'Férias canceladas', { pessoa: t.name, periodo: `${fmtD(v.start_date)} a ${fmtD(v.end_date)}` }, ip);
  } else {
    throw badRequest('Ação inválida.');
  }
  return { ok: true };
}

function withProposals(rows) {
  for (const v of rows) {
    v.reschedules = all(`SELECT r.task_id, r.old_due, r.new_due, r.applied, t.code, t.title FROM vacation_reschedules r JOIN tasks t ON t.id = r.task_id WHERE r.vacation_id = ? ORDER BY r.old_due`, v.id);
    if (v.status === 'solicitada') {
      const have = new Set(v.reschedules.map(x => x.task_id));
      v.new_conflicts = conflictsOf(v.user_id, v.start_date, v.end_date).filter(c => !have.has(c.id));
    }
  }
  return rows;
}
const REQ_SQL = `SELECT v.*, u.name AS user_name, u.job_title, u.manager_id, rb.name AS requested_by_name, db.name AS decided_by_name
  FROM vacations v JOIN users u ON u.id = v.user_id LEFT JOIN users rb ON rb.id = v.requested_by LEFT JOIN users db ON db.id = v.decided_by`;

// Férias de uma pessoa (a própria, quem aprova ou a Gestão da Equipe)
export function userVacations(ctx, userId) {
  const t = one('SELECT * FROM users WHERE id = ?', userId);
  if (!t) throw notFound('Pessoa não encontrada.');
  if (t.id !== ctx.user.id && !canApprove(ctx, t)) throw forbidden('Você não pode ver as férias desta pessoa.');
  return {
    user: { id: t.id, name: t.name, job_title: t.job_title, admission_date: t.admission_date, is_external: t.is_external },
    summary: vacationSummary(t), periods: periodsOf(t).reverse(),
    requests: withProposals(all(`${REQ_SQL} WHERE v.user_id = ? ORDER BY v.start_date DESC`, t.id)),
    can_launch: canApprove(ctx, t),
  };
}

// Meu painel: minhas férias e as solicitações que aguardam a minha aprovação
export function myVacations(ctx) {
  const mine = userVacations(ctx, ctx.user.id);
  const pending = all(`${REQ_SQL} WHERE v.status = 'solicitada' ORDER BY v.start_date`).filter(v => v.user_id !== ctx.user.id && canApprove(ctx, one('SELECT * FROM users WHERE id = ?', v.user_id)));
  return { ...mine, approvals: withProposals(pending) };
}

// Gestão da Equipe › Férias: visão geral do ano
export function vacationsOverview(ctx, yearIn) {
  if (!hasSection(ctx.user, 'equipe')) throw forbidden('A seção Organograma e Férias não está liberada para o seu usuário.');
  const ref = today();
  const year = /^\d{4}$/.test(String(yearIn || '')) ? Number(yearIn) : Number(ref.slice(0, 4));
  const people = all(`SELECT u.*, m.name AS manager_name FROM users u LEFT JOIN users m ON m.id = u.manager_id WHERE u.active = 1 AND u.is_external = 0 ORDER BY u.name`);
  const vac = all(`${REQ_SQL} WHERE v.status IN ('solicitada','aprovada') AND v.start_date <= ? AND v.end_date >= ? ORDER BY v.start_date`, `${year}-12-31`, `${year}-01-01`);
  const rows = people.map(u => ({ id: u.id, name: u.name, job_title: u.job_title, department: u.department, manager_name: u.manager_name, admission_date: u.admission_date,
    summary: vacationSummary(u, ref), vacations: vac.filter(v => v.user_id === u.id) }));
  return {
    year, ref,
    people: rows,
    pending: withProposals(all(`${REQ_SQL} WHERE v.status = 'solicitada' ORDER BY v.start_date`)),
    kpis: {
      on_vacation: all(`SELECT DISTINCT user_id FROM vacations WHERE status = 'aprovada' AND start_date <= ? AND end_date >= ?`, ref, ref).length,
      pending: rows.reduce((n, r) => n + r.vacations.filter(v => v.status === 'solicitada').length, 0),
      expiring: rows.filter(r => r.summary?.status === 'vencendo').length,
      expired: rows.filter(r => r.summary?.status === 'vencida').length,
      no_admission: rows.filter(r => r.summary?.status === 'sem_admissao').length,
    },
  };
}
