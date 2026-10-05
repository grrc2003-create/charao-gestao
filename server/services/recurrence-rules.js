// Motor de datas das tarefas recorrentes (puro, sem banco — testado em scripts/recurrence-test.js).
// Datas no formato 'YYYY-MM-DD'. Semana de segunda a domingo.
export const FREQS = ['diaria', 'semanal', 'mensal'];
export const END_TYPES = ['data', 'ocorrencias', 'nunca'];

const ms = d => Date.parse(d + 'T00:00:00Z');
export const addDays = (d, n) => new Date(ms(d) + n * 86400e3).toISOString().slice(0, 10);
export const weekday = d => new Date(ms(d)).getUTCDay(); // 0 = domingo
const mondayOf = d => addDays(d, weekday(d) === 0 ? -6 : 1 - weekday(d));
const lastDayOfMonth = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate(); // m: 1..12

/**
 * Gera as datas de ocorrência da regra, em ordem, a partir de rule.start_date.
 * rule: { freq, interval, weekdays: [0..6], month_day, workdays_only, start_date, end_type, end_date, end_count }
 * Para em `until` (inclusive) ou ao atingir `limit` datas.
 */
export function* occurrenceDates(rule, { until, limit = 1000 } = {}) {
  const interval = Math.max(1, rule.interval || 1);
  const endDate = rule.end_type === 'data' ? rule.end_date : null;
  const maxCount = rule.end_type === 'ocorrencias' ? rule.end_count : Infinity;
  const stop = [until, endDate].filter(Boolean).sort()[0] || null;
  let count = 0;
  const emit = d => (stop && d > stop) || count >= maxCount || count >= limit ? false : (count++, true);

  if (rule.freq === 'diaria') {
    for (let d = rule.start_date; ; d = addDays(d, interval)) {
      if (stop && d > stop) return;
      if (rule.workdays_only && (weekday(d) === 0 || weekday(d) === 6)) continue;
      if (!emit(d)) return;
      yield d;
    }
  }
  if (rule.freq === 'semanal') {
    const days = new Set(rule.weekdays?.length ? rule.weekdays : [weekday(rule.start_date)]);
    const firstWeek = mondayOf(rule.start_date);
    for (let d = rule.start_date; ; d = addDays(d, 1)) {
      if (stop && d > stop) return;
      const weekIdx = Math.round((ms(mondayOf(d)) - ms(firstWeek)) / (7 * 86400e3));
      if (weekIdx % interval !== 0 || !days.has(weekday(d))) continue;
      if (!emit(d)) return;
      yield d;
      if (count > 5000) return;
    }
  }
  if (rule.freq === 'mensal') {
    let [y, m] = rule.start_date.split('-').map(Number);
    const day = rule.month_day || Number(rule.start_date.slice(8, 10));
    for (let i = 0; i < 2400; i++) {
      const d = `${y}-${String(m).padStart(2, '0')}-${String(Math.min(day, lastDayOfMonth(y, m))).padStart(2, '0')}`;
      if (stop && d > stop) return;
      if (d >= rule.start_date) {
        if (!emit(d)) return;
        yield d;
      }
      m += interval;
      while (m > 12) { m -= 12; y++; }
    }
  }
}

const WD = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];
const fmt = d => (d ? d.split('-').reverse().join('/') : '—');

// Descrição legível da regra (telas, histórico e relatórios)
export function describeRule(r) {
  const n = Math.max(1, r.interval || 1);
  let base;
  if (r.freq === 'diaria') base = n === 1 ? 'Todos os dias' : `A cada ${n} dias`;
  else if (r.freq === 'semanal') {
    const days = (r.weekdays?.length ? r.weekdays : [weekday(r.start_date)]).slice().sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7)).map(d => WD[d]);
    const list = days.length > 1 ? `${days.slice(0, -1).join(', ')} e ${days.at(-1)}` : days[0];
    base = n === 1 ? `Toda semana: ${list}` : `A cada ${n} semanas: ${list}`;
  } else {
    const day = r.month_day || Number(r.start_date.slice(8, 10));
    base = `${n === 1 ? 'Todo mês' : `A cada ${n} meses`}, no dia ${day}${day > 28 ? ' (ou último dia do mês)' : ''}`;
  }
  if (r.freq === 'diaria' && r.workdays_only) base += ' (somente dias úteis)';
  const end = r.end_type === 'data' ? `até ${fmt(r.end_date)}` : r.end_type === 'ocorrencias' ? `${r.end_count} ocorrência(s)` : 'sem data de término';
  return `${base} · a partir de ${fmt(r.start_date)} · ${end}`;
}
