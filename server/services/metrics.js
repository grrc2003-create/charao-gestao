// Regras de negócio de indicadores: status efetivo, pontualidade, atraso e consolidações.
export const TZ = 'America/Sao_Paulo';

const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
export const today = () => fmt.format(new Date());
export function parseTs(ts) {
  if (!ts) return null;
  return new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(ts) ? ts : ts.replace(' ', 'T') + 'Z');
}
export const localDate = ts => (ts ? fmt.format(parseTs(ts)) : null);
export const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400e3);
export const addDays = (d, n) => new Date(Date.parse(d) + n * 86400e3).toISOString().slice(0, 10);

// Tarefas do Financeiro (área restrita 2) só entram nos indicadores se criadas depois desta data: as anteriores são da
// implantação. Continuam nas listas de tarefas e no Financeiro; as demais tarefas não mudam.
const FINANCE_COUNTS_AFTER = process.env.FINANCE_INDICATORS_AFTER || '2026-11-03';
export const countsInIndicators = t => t.project_restricted !== 2 || localDate(t.created_at) > FINANCE_COUNTS_AFTER;

export const STATUSES = ['aberta', 'em_andamento', 'aguardando_conferencia', 'atrasada', 'concluida'];

// 'atrasada' = prazo vencido e ainda não entregue (aberta ou em andamento)
export function effectiveStatus(t, ref = today()) {
  if (t.cancelled_at) return 'cancelada';
  if ((t.status === 'aberta' || t.status === 'em_andamento') && t.due_date && t.due_date < ref) return 'atrasada';
  return t.status;
}

// ---------- Prazos e repactuação ----------
// Preventiva: reagendada até o dia do prazo vigente. Corretiva: reagendada com o prazo já vencido (cobre um atraso).
// Episódios de atraso = repactuações corretivas + entrega após o prazo + atraso atual.
export function deadlineStats(t, reschedules = [], ref = today(), chronicMin = 3) {
  let preventive = 0, corrective = 0, daysAdded = 0;
  const entries = reschedules.map(r => {
    const madeOn = localDate(r.created_at);
    const kind = r.old_due && madeOn > r.old_due ? 'corretiva' : 'preventiva';
    if (kind === 'corretiva') corrective++; else preventive++;
    if (r.old_due && r.new_due) daysAdded += daysBetween(r.old_due, r.new_due);
    return { ...r, kind, late_days_at: kind === 'corretiva' ? daysBetween(r.old_due, madeOn) : 0 };
  });
  return { entries, preventive, corrective, daysAdded, chronic: reschedules.length >= chronicMin };
}

// Enriquecimento com dados derivados (usado em listas, telas e relatórios)
export function decorate(t, ref = today(), reschedules = null, chronicMin = 3) {
  const eff = effectiveStatus(t, ref);
  const deliveredDate = localDate(t.delivered_at);
  const delivered = !!deliveredDate && (t.status === 'aguardando_conferencia' || t.status === 'concluida');
  let daysLate = 0;
  if (delivered && t.due_date && deliveredDate > t.due_date) daysLate = daysBetween(t.due_date, deliveredDate);
  else if (eff === 'atrasada') daysLate = daysBetween(t.due_date, ref);
  const ds = deadlineStats(t, reschedules || [], ref, chronicMin);
  const lateNow = eff === 'atrasada' ? 1 : 0;
  const deliveredLate = delivered && t.due_date && deliveredDate > t.due_date ? 1 : 0;
  const lateEpisodes = ds.corrective + deliveredLate + lateNow;
  const originalDue = t.original_due || t.due_date || null;
  return {
    ...t,
    eff_status: eff,
    delivered,
    delivered_date: deliveredDate,
    on_time: delivered ? !t.due_date || deliveredDate <= t.due_date : null,
    // Pontualidade "real": contra o prazo ORIGINAL (antes de qualquer repactuação)
    on_time_original: delivered ? !originalDue || deliveredDate <= originalDue : null,
    days_late: daysLate,
    days_to_due: t.due_date && !delivered ? daysBetween(ref, t.due_date) : null,
    late_episodes: lateEpisodes,
    ever_late: lateEpisodes > 0,
    reschedules_preventive: ds.preventive,
    reschedules_corrective: ds.corrective,
    days_added: ds.daysAdded,
    chronic: ds.chronic,
    ...(reschedules ? { reschedule_entries: ds.entries } : {}),
  };
}

const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : null);

// raw: resume exatamente as tarefas recebidas (subtarefas na tela da própria tarefa, que não é indicador)
export function summarize(tasks, ref = today(), { raw = false } = {}) {
  const by = Object.fromEntries(STATUSES.map(s => [s, 0]));
  let delivered = 0, onTime = 0, lateDeliveries = 0, lateDaysSum = 0, lateCount = 0, dueSoon = 0, rescheduled = 0, reschedules = 0;
  let withDue = 0, everLate = 0, episodes = 0, preventive = 0, corrective = 0, chronic = 0, daysAdded = 0, onTimeOriginal = 0;
  const dist = { r0: 0, r1: 0, r2: 0, r3: 0 };
  // Execução: dias do início à conclusão real, entregas antecipadas e atraso de preenchimento
  let execN = 0, execDays = 0, early = 0, earlyDays = 0, fillN = 0, fillDays = 0;
  tasks = tasks.filter(t => !t.cancelled_at && (raw || countsInIndicators(t)));
  for (const t of tasks) {
    if (t.delivered && t.delivered_date) {
      const st = t.start_date || localDate(t.started_at) || localDate(t.created_at);
      if (st && st <= t.delivered_date) { execN++; execDays += daysBetween(st, t.delivered_date) + 1; }
      if (t.due_date && t.delivered_date < t.due_date) { early++; earlyDays += daysBetween(t.delivered_date, t.due_date); }
      if (t.filling_delay_days > 0) { fillN++; fillDays += t.filling_delay_days; }
    }
    if (t.reschedule_count) { rescheduled++; reschedules += t.reschedule_count; }
    if (t.due_date || t.original_due) {
      withDue++;
      const n = t.reschedule_count || 0;
      dist[n >= 3 ? 'r3' : `r${n}`]++;
    }
    if (t.ever_late) everLate++;
    episodes += t.late_episodes || 0;
    preventive += t.reschedules_preventive || 0;
    corrective += t.reschedules_corrective || 0;
    if (t.chronic) chronic++;
    daysAdded += t.days_added || 0;
    if (t.delivered && t.on_time_original) onTimeOriginal++;
    by[t.eff_status]++;
    if (t.delivered) {
      delivered++;
      if (t.on_time) onTime++; else lateDeliveries++;
    }
    if (t.days_late > 0) { lateDaysSum += t.days_late; lateCount++; }
    if (!t.delivered && t.due_date && t.due_date >= ref && daysBetween(ref, t.due_date) <= 7) dueSoon++;
  }
  const total = tasks.length;
  return {
    total,
    by_status: by,
    open: by.aberta,
    in_progress: by.em_andamento,
    review: by.aguardando_conferencia,
    late: by.atrasada,
    done: by.concluida,
    completion_pct: pct(by.concluida, total),
    delivered,
    on_time: onTime,
    late_deliveries: lateDeliveries,
    on_time_pct: pct(onTime, delivered),
    avg_delay_days: lateCount ? Math.round((lateDaysSum / lateCount) * 10) / 10 : 0,
    due_soon: dueSoon,
    rescheduled,
    reschedules,
    // Prazos e repactuação
    with_due: withDue,
    reschedule_rate: pct(rescheduled, withDue),
    reschedules_per_task: withDue ? Math.round((reschedules / withDue) * 100) / 100 : 0,
    reschedules_per_rescheduled: rescheduled ? Math.round((reschedules / rescheduled) * 10) / 10 : 0,
    preventive,
    corrective,
    corrective_pct: pct(corrective, reschedules),
    chronic,
    days_added: daysAdded,
    days_added_avg: reschedules ? Math.round((daysAdded / reschedules) * 10) / 10 : 0,
    reschedule_dist: dist,
    ever_late: everLate,
    late_rate: pct(everLate, withDue),
    late_episodes: episodes,
    late_episodes_avg: withDue ? Math.round((episodes / withDue) * 100) / 100 : 0,
    on_time_original: onTimeOriginal,
    on_time_original_pct: pct(onTimeOriginal, delivered),
    exec_days_avg: execN ? Math.round((execDays / execN) * 10) / 10 : null,
    exec_count: execN,
    early,
    early_pct: pct(early, delivered),
    early_days_avg: early ? Math.round((earlyDays / early) * 10) / 10 : 0,
    filling_delays: fillN,
    filling_delay_days_avg: fillN ? Math.round((fillDays / fillN) * 10) / 10 : 0,
  };
}

// Quanto cada responsável contribui em um número: os 3 maiores e, se houver mais, o restante em "Outros"
function topContributors(tasks) {
  const m = new Map();
  for (const t of tasks) {
    const k = t.assignee_id || 0;
    if (!m.has(k)) m.set(k, { name: t.assignee_name || 'Sem responsável', n: 0 });
    m.get(k).n++;
  }
  const list = [...m.values()].sort((a, b) => b.n - a.n || a.name.localeCompare(b.name, 'pt-BR'));
  const rest = list.slice(3).reduce((n, u) => n + u.n, 0);
  return [...list.slice(0, 3), ...(rest ? [{ name: 'Outros', n: rest, other: true }] : [])];
}

// Os mesmos grupos de "Reagendamentos por tarefa" (summarize), por responsável
export function rescheduleContributors(tasks) {
  const ts = tasks.filter(t => !t.cancelled_at && countsInIndicators(t) && (t.due_date || t.original_due));
  const of = fn => topContributors(ts.filter(fn));
  return { r0: of(t => !t.reschedule_count), r1: of(t => t.reschedule_count === 1), r2: of(t => t.reschedule_count === 2), r3: of(t => t.reschedule_count >= 3) };
}

// Evolução mensal (mês do prazo original): % de tarefas que atrasaram ao menos uma vez e % repactuadas
export function monthlyTrend(tasks, ref = today(), months = 6) {
  const out = [];
  let [y, m] = ref.slice(0, 7).split('-').map(Number);
  for (let i = 0; i < months; i++) {
    out.unshift(`${y}-${String(m).padStart(2, '0')}`);
    m--; if (!m) { m = 12; y--; }
  }
  tasks = tasks.filter(countsInIndicators);
  return out.map(month => {
    const ts = tasks.filter(t => (t.original_due || t.due_date || '').startsWith(month));
    const late = ts.filter(t => t.ever_late).length;
    const resch = ts.filter(t => t.reschedule_count > 0).length;
    return { month, total: ts.length, ever_late: late, rescheduled: resch, late_rate: pct(late, ts.length), reschedule_rate: pct(resch, ts.length),
      by: { todas: topContributors(ts), atrasadas: topContributors(ts.filter(t => t.ever_late)), repactuadas: topContributors(ts.filter(t => t.reschedule_count > 0)) } };
  });
}

// Por que a tarefa entra nos indicadores de prazo (as mesmas regras de decorate). "cadastro" explica o atraso de quem
// só foi lançada no sistema depois do prazo.
function deadlineReasons(t, ref) {
  const out = [];
  const original = t.original_due || t.due_date;
  if (t.eff_status === 'atrasada') out.push({ code: 'vencida', due: t.due_date, days: daysBetween(t.due_date, ref) });
  if (t.delivered && t.due_date && t.delivered_date > t.due_date) out.push({ code: 'entrega', date: t.delivered_date, due: t.due_date, days: daysBetween(t.due_date, t.delivered_date) });
  if (t.reschedules_corrective) out.push({ code: 'corretiva', n: t.reschedules_corrective });
  const created = localDate(t.created_at);
  if (t.ever_late && original && created > original) out.push({ code: 'cadastro', date: created, due: original });
  if (t.reschedules_preventive) out.push({ code: 'preventiva', n: t.reschedules_preventive });
  return out;
}

// As tarefas por trás de cada número: mês (como em monthlyTrend) e recorte (como em monthlyTrend e summarize)
const DEADLINE_VIEWS = {
  atrasadas: t => t.ever_late,
  repactuadas: t => t.reschedule_count > 0,
  todas: () => true,
  r0: t => !t.reschedule_count,
  r1: t => t.reschedule_count === 1,
  r2: t => t.reschedule_count === 2,
  r3: t => t.reschedule_count >= 3,
};
export const isDeadlineView = v => Object.hasOwn(DEADLINE_VIEWS, v);
export function deadlineDetail(tasks, { month = '', view = 'atrasadas' } = {}, ref = today()) {
  const base = (month ? tasks.filter(t => (t.original_due || t.due_date || '').startsWith(month)) : tasks).filter(t => !t.cancelled_at && countsInIndicators(t) && (t.due_date || t.original_due));
  const items = base.filter(DEADLINE_VIEWS[view]).map(t => ({
    id: t.id, code: t.code, title: t.title, project_code: t.project_code, assignee_name: t.assignee_name,
    kind: t.checklist_item ? 'item' : t.task_type === 'checklist' ? 'checklist' : t.parent_id ? 'subtarefa' : 'tarefa',
    href: `#/tarefas/${t.checklist_item ? t.parent_id : t.id}`, status: t.eff_status, due: t.due_date, original_due: t.original_due || null,
    reasons: deadlineReasons(t, ref),
  })).sort((a, b) => (a.due || '').localeCompare(b.due || '') || String(a.code).localeCompare(String(b.code)));
  return { base: base.length, items };
}

// Indicadores individuais (tarefas atribuídas ao usuário + origem das tarefas)
export function userStats(user, tasks, usersById) {
  tasks = tasks.filter(countsInIndicators);
  const assigned = tasks.filter(t => t.assignee_id === user.id);
  const s = summarize(assigned);
  const created = tasks.filter(t => t.creator_id === user.id);
  const selfCreated = assigned.filter(t => t.creator_id === user.id);
  const byManager = assigned.filter(t => {
    const by = usersById.get(t.assigned_by_id || t.creator_id);
    return by && by.id !== user.id && (by.role === 'gestor' || by.role === 'coordenador' || by.role === 'admin' || by.id === user.manager_id);
  });
  return {
    ...s,
    assigned: assigned.length,
    assigned_items: assigned.filter(t => t.checklist_item).length,
    created_by_user: created.length,
    self_created: selfCreated.length,
    assigned_by_manager: byManager.length,
    behavior: behaviorSummary(s, assigned.length, selfCreated.length),
  };
}

const br = v => String(v).replace('.', ',');

export function behaviorSummary(s, assigned, selfCreated) {
  const lines = [];
  if (!assigned) return ['Sem tarefas atribuídas no período considerado.'];
  if (s.on_time_pct === null) lines.push('Ainda não há entregas registradas para medir pontualidade.');
  else if (s.on_time_pct >= 90) lines.push(`Pontualidade excelente: ${br(s.on_time_pct)}% das entregas dentro do prazo.`);
  else if (s.on_time_pct >= 70) lines.push(`Pontualidade boa (${br(s.on_time_pct)}%), com espaço para reduzir atrasos.`);
  else lines.push(`Pontualidade baixa (${br(s.on_time_pct)}%): recomenda-se revisar prazos e prioridades.`);
  if (s.late > 0) lines.push(`${s.late} tarefa(s) em atraso no momento${s.avg_delay_days ? `, atraso médio de ${br(s.avg_delay_days)} dia(s)` : ''}.`);
  else lines.push('Nenhuma tarefa em atraso no momento.');
  if (s.review > 0) lines.push(`${s.review} entrega(s) aguardando conferência.`);
  if (s.ever_late) lines.push(`${String(s.late_rate).replace('.', ',')}% das tarefas com prazo ficaram atrasadas ao menos uma vez (${s.late_episodes} episódio(s) de atraso).`);
  if (s.reschedules) {
    lines.push(`Repactuou o prazo de ${String(s.reschedule_rate).replace('.', ',')}% das tarefas: ${s.preventive} preventiva(s) e ${s.corrective} corretiva(s), +${s.days_added} dia(s) no total.`);
    if (s.corrective_pct > 50) lines.push('A maior parte das repactuações ocorre com o prazo já vencido — sinal de atraso recorrente.');
    else lines.push('A maior parte das repactuações é feita antes do vencimento — sinal de planejamento.');
  }
  if (s.chronic) lines.push(`${s.chronic} tarefa(s) crônica(s), com reagendamentos repetidos.`);
  if (s.exec_days_avg !== null) lines.push(`Executa as tarefas em média em ${br(s.exec_days_avg)} dia(s) (do início à conclusão).`);
  if (s.early) lines.push(`${s.early} entrega(s) antecipada(s), em média ${br(s.early_days_avg)} dia(s) antes do prazo.`);
  if (s.filling_delays) lines.push(`${s.filling_delays} conclusão(ões) registrada(s) com atraso de preenchimento (média de ${br(s.filling_delay_days_avg)} dia(s)) — registrar no dia evita dependências e indicadores defasados.`);
  if (s.on_time_original_pct !== null && s.on_time_pct !== null && s.on_time_pct - s.on_time_original_pct >= 10) {
    lines.push(`Pontualidade cai de ${String(s.on_time_pct).replace('.', ',')}% para ${String(s.on_time_original_pct).replace('.', ',')}% quando medida contra o prazo original.`);
  }
  if (selfCreated / assigned >= 0.4) lines.push('Perfil proativo: cria boa parte das próprias tarefas.');
  if (s.in_progress + s.open > 8) lines.push('Carga elevada de tarefas abertas — avaliar redistribuição.');
  return lines;
}

// ---------- Organização por período (dia / semana / mês do prazo vigente) ----------
export const PERIODS = ['dia', 'semana', 'mes'];
const cap = s => s[0].toUpperCase() + s.slice(1);
const MONTH_NAMES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
const WEEKDAYS = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
const ddmm = d => `${d.slice(8, 10)}/${d.slice(5, 7)}`;

// Semana de segunda a domingo: retorna a segunda-feira
export function weekStart(d) {
  const dow = new Date(Date.parse(d + 'T00:00:00Z')).getUTCDay();
  return addDays(d, dow === 0 ? -6 : 1 - dow);
}

export function periodKey(date, kind) {
  if (!date) return '9999';
  if (kind === 'dia') return date;
  if (kind === 'semana') return weekStart(date);
  return date.slice(0, 7);
}

export function periodLabel(key, kind) {
  if (key === '9999') return 'Sem prazo';
  if (kind === 'dia') return `${cap(WEEKDAYS[new Date(Date.parse(key + 'T00:00:00Z')).getUTCDay()])}, ${ddmm(key)}/${key.slice(0, 4)}`;
  if (kind === 'semana') { const end = addDays(key, 6); return `Semana de ${ddmm(key)} a ${ddmm(end)}/${end.slice(0, 4)}`; }
  return `${cap(MONTH_NAMES[Number(key.slice(5, 7)) - 1])} de ${key.slice(0, 4)}`;
}

// Ordenação cronológica pelo prazo; sem prazo por último
export const byDue = (a, b) => (a.due_date || '9999').localeCompare(b.due_date || '9999') || a.code.localeCompare(b.code);

export function groupByPeriod(tasks, kind, ref = today()) {
  const m = new Map();
  for (const t of [...tasks].sort(byDue)) {
    const k = periodKey(t.due_date, kind);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(t);
  }
  const cur = periodKey(ref, kind);
  return [...m].map(([key, ts]) => ({ key, label: periodLabel(key, kind), current: key === cur, summary: summarize(ts, ref) }));
}
