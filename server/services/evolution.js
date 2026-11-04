// Corrida dos indicadores: cada indicador da tabela de desempenho mês a mês, ACUMULADO até o fim de cada mês.
// O último ponto usa as mesmas regras da tela, então é sempre igual ao número da tabela.
import { today, localDate, countsInIndicators } from './metrics.js';
import { actualOf } from './tasks.js';

const MAX_MONTHS = 12;
const KEYS = ['on_time', 'real', 'resched', 'done', 'late', 'assigned', 'exec', 'early', 'filling'];
const COUNTS = ['done', 'late', 'assigned', 'early', 'filling']; // os demais (percentual e média) já são comparáveis entre pessoa e empresa
const round1 = v => Math.round(v * 10) / 10;

const shiftMonth = (ym, n) => {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return d.toISOString().slice(0, 7);
};
const monthEnd = ym => {
  const [y, m] = ym.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
};

// O que importa de cada tarefa, com as datas em que cada coisa aconteceu
function factsOf(t) {
  const created = localDate(t.created_at);
  const delivered = t.delivered ? t.delivered_date : null;
  const doneOn = t.status === 'concluida' ? delivered || localDate(t.completed_at) || created : null;
  // Tarefa lançada depois do fato (implantação): já existia desde o início ou a entrega informados
  const born = [created, t.start_date, delivered].filter(Boolean).sort()[0] || today();
  const act = delivered ? actualOf(t) : null;
  return {
    who: t.assignee_id || 0, born, delivered, doneOn,
    on_time: !!t.on_time,
    real: !!t.on_time_original,
    with_due: !!(t.due_date || t.original_due),
    resched_now: t.reschedule_count > 0,
    first_move: (t.reschedule_entries || [])[0] ? localDate(t.reschedule_entries[0].created_at) : null,
    leader: t.review_leader_id || 0,
    review_on: t.review_late_on || null,
    early: !!(delivered && t.due_date && delivered < t.due_date),
    filling: !!(delivered && t.filling_delay_days > 0),
    work: act && act.work_days !== null ? act.work_days : null,
    late_now: t.eff_status === 'atrasada',
    first_due: t.original_due || t.due_date || null,
    moves: (t.reschedule_entries || []).filter(r => r.new_due).map(r => ({ on: localDate(r.created_at), due: r.new_due })),
  };
}

// Prazo em vigor naquele dia, pelo histórico de reagendamentos
function dueOn(f, day) {
  let due = f.first_due;
  for (const m of f.moves) if (m.on <= day) due = m.due;
  return due;
}

const blank = () => ({ assigned: 0, delivered: 0, on: 0, real: 0, with_due: 0, resched: 0, done: 0, late: 0, early: 0, filling: 0, n: 0, sum: 0 });

function add(c, f, day) {
  const open = day === null; // último ponto: o estado atual, exatamente como na tabela
  if (!open && f.born > day) return false;
  c.assigned++;
  if (f.with_due) {
    c.with_due++;
    if (open ? f.resched_now : f.first_move && f.first_move <= day) c.resched++;
  }
  const deliveredYet = f.delivered && (open || f.delivered <= day);
  if (deliveredYet) {
    c.delivered++;
    if (f.on_time) c.on++;
    if (f.real) c.real++;
    if (f.early) c.early++;
    if (f.filling) c.filling++;
    if (f.work !== null) { c.n++; c.sum += f.work; }
  }
  const doneYet = f.doneOn && (open || f.doneOn <= day);
  if (doneYet) c.done++;
  if (open) { if (f.late_now) c.late++; }
  else if (!deliveredYet && !doneYet) {
    const due = dueOn(f, day);
    if (due && due < day) c.late++;
  }
  return true;
}

// Conferência de liderado acima de 36 h: conta para o líder direto, a partir do dia em que passou do limite
const addReview = (c, f, day) => { if (c && f.review_on && (day === null || f.review_on <= day)) c.filling++; };

const valuesOf = c => ({
  on_time: c.delivered ? round1((c.on / c.delivered) * 100) : null,
  real: c.delivered ? round1((c.real / c.delivered) * 100) : null,
  resched: c.with_due ? round1((c.resched / c.with_due) * 100) : null,
  done: c.done, late: c.late, assigned: c.assigned,
  exec: c.n ? round1(c.sum / c.n) : null,
  early: c.early, filling: c.filling,
});

const emptySeries = keys => Object.fromEntries(keys.map(k => [k, []]));

// tasks: universo da tela. people: quem corre ({ id, name, job_title }). overallTasks: o universo do total (por padrão, o mesmo).
export function evolution({ tasks, people, overallTasks = tasks, overallLabel }) {
  const own = tasks.filter(countsInIndicators).map(factsOf);
  const all = overallTasks === tasks ? own : overallTasks.filter(countsInIndicators).map(factsOf);
  const now = today().slice(0, 7);
  const first = all.reduce((m, f) => (f.born.slice(0, 7) < m ? f.born.slice(0, 7) : m), now);
  const oldest = shiftMonth(now, -(MAX_MONTHS - 1));
  const months = [];
  for (let m = first < oldest ? oldest : first; m <= now; m = shiftMonth(m, 1)) months.push(m);

  const runners = people.map(p => ({ ...p, series: emptySeries(KEYS) }));
  const byId = new Map(runners.map(r => [r.id || 0, r]));
  const overall = { label: overallLabel, series: emptySeries(KEYS), per_person: emptySeries(COUNTS) };

  for (const month of months) {
    const day = month === now ? null : monthEnd(month);
    const cells = new Map(runners.map(r => [r.id || 0, blank()]));
    const total = blank();
    const active = new Set();
    for (const f of all) if (add(total, f, day) && f.who) active.add(f.who);
    for (const f of own) if (cells.has(f.who)) add(cells.get(f.who), f, day);
    for (const f of all) { addReview(total, f, day); addReview(cells.get(f.leader), f, day); }
    for (const r of runners) {
      const v = valuesOf(cells.get(r.id || 0));
      for (const k of KEYS) r.series[k].push(v[k]);
    }
    const v = valuesOf(total);
    for (const k of KEYS) overall.series[k].push(v[k]);
    for (const k of COUNTS) overall.per_person[k].push(active.size ? round1(v[k] / active.size) : 0);
  }
  return { months, overall, people: [...byId.values()] };
}
