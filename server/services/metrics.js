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

export function summarize(tasks, ref = today()) {
  const by = Object.fromEntries(STATUSES.map(s => [s, 0]));
  let delivered = 0, onTime = 0, lateDeliveries = 0, lateDaysSum = 0, lateCount = 0, dueSoon = 0, rescheduled = 0, reschedules = 0;
  let withDue = 0, everLate = 0, episodes = 0, preventive = 0, corrective = 0, chronic = 0, daysAdded = 0, onTimeOriginal = 0;
  const dist = { r0: 0, r1: 0, r2: 0, r3: 0 };
  tasks = tasks.filter(t => !t.cancelled_at);
  for (const t of tasks) {
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
  };
}

// Evolução mensal (mês do prazo original): % de tarefas que atrasaram ao menos uma vez e % repactuadas
export function monthlyTrend(tasks, ref = today(), months = 6) {
  const out = [];
  let [y, m] = ref.slice(0, 7).split('-').map(Number);
  for (let i = 0; i < months; i++) {
    out.unshift(`${y}-${String(m).padStart(2, '0')}`);
    m--; if (!m) { m = 12; y--; }
  }
  return out.map(month => {
    const ts = tasks.filter(t => (t.original_due || t.due_date || '').startsWith(month));
    const late = ts.filter(t => t.ever_late).length;
    const resch = ts.filter(t => t.reschedule_count > 0).length;
    return { month, total: ts.length, ever_late: late, rescheduled: resch, late_rate: pct(late, ts.length), reschedule_rate: pct(resch, ts.length) };
  });
}

// Indicadores individuais (tarefas atribuídas ao usuário + origem das tarefas)
export function userStats(user, tasks, usersById) {
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
