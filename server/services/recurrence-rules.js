// Motor de datas das tarefas recorrentes (puro, sem banco — testado em scripts/recurrence-test.js).
// Datas no formato 'YYYY-MM-DD'. Semana de segunda a domingo.
export const FREQS = ['diaria', 'semanal', 'mensal', 'anual'];
export const END_TYPES = ['data', 'ocorrencias', 'nunca'];

const ms = d => Date.parse(d + 'T00:00:00Z');
export const addDays = (d, n) => new Date(ms(d) + n * 86400e3).toISOString().slice(0, 10);
export const weekday = d => new Date(ms(d)).getUTCDay(); // 0 = domingo
const mondayOf = d => addDays(d, weekday(d) === 0 ? -6 : 1 - weekday(d));
const lastDayOfMonth = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate(); // m: 1..12

/**
 * Gera as datas de ocorrência da regra, em ordem, a partir de rule.start_date.
 * rule: { freq, interval, weekdays: [0..6], month_day, year_month, workdays_only, start_date, end_type, end_date, end_count }
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
  if (rule.freq === 'anual') {
    let y = Number(rule.start_date.slice(0, 4));
    const mo = rule.year_month || Number(rule.start_date.slice(5, 7));
    const day = rule.month_day || Number(rule.start_date.slice(8, 10));
    for (let i = 0; i < 400; i++) {
      const d = `${y}-${String(mo).padStart(2, '0')}-${String(Math.min(day, lastDayOfMonth(y, mo))).padStart(2, '0')}`;
      if (stop && d > stop) return;
      if (d >= rule.start_date) {
        if (!emit(d)) return;
        yield d;
      }
      y += interval;
    }
  }
}

// Período de cada ocorrência (mensal e anual): a data da regra é o INÍCIO e o término vem de N dias úteis ou corridos
// (o início conta como 1º dia). O cálculo dos dias úteis usa o calendário da obra (recurrences.js). Sem período: prazo + duração.
export const hasPeriod = r => (r.freq === 'mensal' || r.freq === 'anual') && Number(r.period_days) > 0;
export const periodLabel = r => { const n = Number(r.period_days), c = r.period_day_type === 'corridos'; return n === 1 ? (c ? '1 dia corrido' : '1 dia útil') : `${n} dias ${c ? 'corridos' : 'úteis'}`; };
const MESES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
const dm = (d, m) => `${String(d).padStart(2, '0')}/${String(m).padStart(2, '0')}`;

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
  } else if (r.freq === 'anual') {
    const day = r.month_day || Number(r.start_date.slice(8, 10));
    const mo = r.year_month || Number(r.start_date.slice(5, 7));
    base = hasPeriod(r)
      ? `${n === 1 ? 'Todo ano' : `A cada ${n} anos`}, início em ${dm(day, mo)} + ${periodLabel(r)}`
      : `${n === 1 ? 'Todo ano' : `A cada ${n} anos`}, em ${day} de ${MESES[mo - 1]}`;
  } else {
    const day = r.month_day || Number(r.start_date.slice(8, 10));
    base = hasPeriod(r)
      ? `${n === 1 ? 'Todo mês' : `A cada ${n} meses`}, início no dia ${day}${day > 28 ? ' (ou último dia do mês)' : ''} + ${periodLabel(r)}`
      : `${n === 1 ? 'Todo mês' : `A cada ${n} meses`}, no dia ${day}${day > 28 ? ' (ou último dia do mês)' : ''}`;
  }
  if (r.freq === 'diaria' && r.workdays_only) base += ' (somente dias úteis)';
  const end = r.end_type === 'data' ? `até ${fmt(r.end_date)}` : r.end_type === 'ocorrencias' ? `${r.end_count} ocorrência(s)` : 'sem data de término';
  return `${base} · a partir de ${fmt(r.start_date)} · ${end}`;
}
