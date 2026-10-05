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
  if ((t.status === 'aberta' || t.status === 'em_andamento') && t.due_date && t.due_date < ref) return 'atrasada';
  return t.status;
}

// Enriquecimento com dados derivados (usado em listas, telas e relatórios)
export function decorate(t, ref = today()) {
  const eff = effectiveStatus(t, ref);
  const deliveredDate = localDate(t.delivered_at);
  const delivered = !!deliveredDate && (t.status === 'aguardando_conferencia' || t.status === 'concluida');
  let daysLate = 0;
  if (delivered && t.due_date && deliveredDate > t.due_date) daysLate = daysBetween(t.due_date, deliveredDate);
  else if (eff === 'atrasada') daysLate = daysBetween(t.due_date, ref);
  return {
    ...t,
    eff_status: eff,
    delivered,
    delivered_date: deliveredDate,
    on_time: delivered ? !t.due_date || deliveredDate <= t.due_date : null,
    days_late: daysLate,
    days_to_due: t.due_date && !delivered ? daysBetween(ref, t.due_date) : null,
  };
}

const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : null);

export function summarize(tasks, ref = today()) {
  const by = Object.fromEntries(STATUSES.map(s => [s, 0]));
  let delivered = 0, onTime = 0, lateDeliveries = 0, lateDaysSum = 0, lateCount = 0, dueSoon = 0, rescheduled = 0, reschedules = 0;
  for (const t of tasks) {
    if (t.reschedule_count) { rescheduled++; reschedules += t.reschedule_count; }
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
  };
}

// Indicadores individuais (tarefas atribuídas ao usuário + origem das tarefas)
export function userStats(user, tasks, usersById) {
  const assigned = tasks.filter(t => t.assignee_id === user.id);
  const s = summarize(assigned);
  const created = tasks.filter(t => t.creator_id === user.id);
  const selfCreated = assigned.filter(t => t.creator_id === user.id);
  const byManager = assigned.filter(t => {
    const by = usersById.get(t.assigned_by_id || t.creator_id);
    return by && by.id !== user.id && (by.role === 'gestor' || by.role === 'admin' || by.id === user.manager_id);
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

export function behaviorSummary(s, assigned, selfCreated) {
  const lines = [];
  if (!assigned) return ['Sem tarefas atribuídas no período considerado.'];
  if (s.on_time_pct === null) lines.push('Ainda não há entregas registradas para medir pontualidade.');
  else if (s.on_time_pct >= 90) lines.push(`Pontualidade excelente: ${s.on_time_pct}% das entregas dentro do prazo.`);
  else if (s.on_time_pct >= 70) lines.push(`Pontualidade boa (${s.on_time_pct}%), com espaço para reduzir atrasos.`);
  else lines.push(`Pontualidade baixa (${s.on_time_pct}%): recomenda-se revisar prazos e prioridades.`);
  if (s.late > 0) lines.push(`${s.late} tarefa(s) em atraso no momento${s.avg_delay_days ? `, atraso médio de ${s.avg_delay_days} dia(s)` : ''}.`);
  else lines.push('Nenhuma tarefa em atraso no momento.');
  if (s.review > 0) lines.push(`${s.review} entrega(s) aguardando conferência.`);
  if (selfCreated / assigned >= 0.4) lines.push('Perfil proativo: cria boa parte das próprias tarefas.');
  if (s.in_progress + s.open > 8) lines.push('Carga elevada de tarefas abertas — avaliar redistribuição.');
  return lines;
}
