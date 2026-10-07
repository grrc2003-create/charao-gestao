// Cronograma (Gantt) das tarefas — HTML/CSS puro, adequado à tela e à impressão A4.
// Barra: início previsto (ou início da execução / criação) até o prazo. Concluídas vão até a data de conclusão;
// atrasadas ganham uma extensão hachurada do prazo até hoje. Losango = prazo. Linha laranja = hoje.
import { html, STATUS, fmtDate } from '../core.js';
import { STATUS_COLOR } from './shared.js';

const TZ = 'America/Sao_Paulo';
const dayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ });
const toDay = ts => (ts ? (/^\d{4}-\d{2}-\d{2}$/.test(ts) ? ts : dayFmt.format(new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(ts) ? ts : ts.replace(' ', 'T') + 'Z'))) : null);
const ms = d => Date.parse(d + 'T00:00:00Z');
const addDays = (d, n) => new Date(ms(d) + n * 86400e3).toISOString().slice(0, 10);
const MONTHS = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];

export function ganttSpan(t, ref) {
  const start = t.start_date || toDay(t.started_at) || toDay(t.created_at) || ref;
  const due = t.due_date || null;
  const done = t.eff_status === 'concluida' ? toDay(t.completed_at) : null;
  const delivered = t.eff_status === 'aguardando_conferencia' ? t.delivered_date : null;
  const end = done || delivered || due || start;
  const lateTo = t.eff_status === 'atrasada' && due ? ref : null;
  return { start: start > end ? end : start, end, due, lateTo };
}

const monday = d => { while (new Date(ms(d)).getUTCDay() !== 1) d = addDays(d, -1); return d; };

// Semanas inteiras (segunda a domingo); com muitas semanas, o rótulo aparece a cada 2 ou 4
function weekTicks(from, to) {
  const n = Math.round((ms(to) - ms(from)) / (7 * 86400e3));
  const every = n <= 16 ? 1 : n <= 32 ? 2 : 4;
  const out = [];
  for (let d = from, i = 0; d < to; d = addDays(d, 7), i++) out.push({ d, label: i % every ? '' : `${d.slice(8, 10)}/${d.slice(5, 7)}`, week: i });
  return out;
}

function ticks(from, to) {
  const days = (ms(to) - ms(from)) / 86400e3;
  const out = [];
  if (days <= 31) {
    const step = days <= 14 ? 1 : 2;
    for (let d = from; d <= to; d = addDays(d, step)) out.push({ d, label: `${d.slice(8, 10)}/${d.slice(5, 7)}` });
  } else if (days <= 120) {
    // Segundas-feiras
    let d = from;
    while (new Date(ms(d)).getUTCDay() !== 1) d = addDays(d, 1);
    for (; d <= to; d = addDays(d, 7)) out.push({ d, label: `${d.slice(8, 10)}/${d.slice(5, 7)}` });
  } else {
    const stepM = days <= 400 ? 1 : 3;
    let [y, m] = from.split('-').map(Number);
    m += 1;
    if (m > 12) { m = 1; y++; }
    for (;;) {
      const d = `${y}-${String(m).padStart(2, '0')}-01`;
      if (d > to) break;
      out.push({ d, label: `${MONTHS[m - 1]}/${String(y).slice(2)}` });
      m += stepM;
      while (m > 12) { m -= 12; y++; }
    }
  }
  return out;
}

/**
 * @param rows  tarefas (formato gantt_tasks do relatório)
 * @param opts  { ref: 'YYYY-MM-DD', groupLabel: t => string|null, showProject: bool,
 *               weekly: colunas por semana (segunda a domingo), color: t => cor da barra, statusOf: t => texto,
 *               noun: ['tarefa(s)', 'concluída(s)'], head: 'Tarefa', legend: html, note: texto }
 */
export function ganttChart(rows, { ref, groupLabel, showProject = false, weekly = false, color, statusOf, noun = ['tarefa(s)', 'concluída(s)'], head = 'Tarefa', legend, note } = {}) {
  if (!rows.length) return html`<p class="muted">Sem ${noun[0].replace('(s)', 's')} para o cronograma.</p>`;
  const spans = rows.map(t => ({ t, s: ganttSpan(t, ref) }));
  let from = spans.reduce((a, x) => (x.s.start < a ? x.s.start : a), spans[0].s.start);
  let to = spans.reduce((a, x) => [x.s.end, x.s.due, x.s.lateTo].filter(Boolean).reduce((b, v) => (v > b ? v : b), a), spans[0].s.end);
  if (ref > to) to = ref;
  if (ref < from) from = ref;
  if (weekly) {
    from = monday(from);
    to = addDays(monday(to), 7);
  } else {
    const pad = Math.max(1, Math.round((ms(to) - ms(from)) / 86400e3 * 0.03));
    from = addDays(from, -pad);
    to = addDays(to, pad + 1);
  }
  const total = ms(to) - ms(from);
  const pos = d => Math.max(0, Math.min(100, ((ms(d) - ms(from)) / total) * 100));
  const width = (a, b) => Math.max(0.6, pos(addDays(b, 1)) - pos(a)); // fim inclusivo
  const tk = weekly ? weekTicks(from, to) : ticks(from, to);
  const todayPct = pos(ref);
  const wk = 100 / Math.max(tk.length, 1);
  // Semanal: colunas alternadas para facilitar a leitura de cada semana
  const grid = html`${weekly ? tk.filter(x => x.week % 2).map(x => html`<i class="g-week" style="left:${pos(x.d).toFixed(2)}%;width:${wk.toFixed(2)}%"></i>`) : ''}${tk.map(x => html`<i class="g-tick" style="left:${pos(x.d).toFixed(2)}%"></i>`)}<i class="g-today" style="left:${todayPct.toFixed(2)}%"></i>`;

  const taskRow = ({ t, s }) => {
    const c = color ? color(t) : STATUS_COLOR[t.eff_status];
    const bar = html`<span class="g-bar ${t.eff_status === 'concluida' ? 'is-done' : ''}" style="left:${pos(s.start).toFixed(2)}%;width:${width(s.start, s.end).toFixed(2)}%;--c:${c}"
      title="${t.code} · ${fmtDate(s.start)} → ${fmtDate(s.end)} · ${statusOf ? statusOf(t) : STATUS[t.eff_status].label}"></span>`;
    const late = s.lateTo && s.lateTo > s.due
      ? html`<span class="g-late" style="left:${pos(addDays(s.due, 1)).toFixed(2)}%;width:${(pos(addDays(s.lateTo, 1)) - pos(addDays(s.due, 1))).toFixed(2)}%"></span>` : '';
    const dueMark = s.due ? html`<span class="g-due" style="left:${pos(addDays(s.due, 1)).toFixed(2)}%" title="Prazo ${fmtDate(s.due)}"></span>` : '';
    // Prazo original (antes dos reagendamentos): losango vazado
    const origMark = t.original_due && t.original_due !== s.due
      ? html`<span class="g-due g-orig" style="left:${pos(addDays(t.original_due, 1)).toFixed(2)}%" title="Prazo original ${fmtDate(t.original_due)} · reagendada ${t.reschedule_count}x"></span>` : '';
    return html`<tr class="g-row">
      <td class="g-label"><span class="g-code">${t.code}</span>${showProject ? html`<span class="g-proj">${t.project_code}</span>` : ''}
        <span class="g-title">${t.parent_code ? '↳ ' : ''}${t.title}</span>
        <span class="g-meta">${t.assignee_name || 'Sem responsável'} · ${fmtDate(s.start)} → ${t.due_date ? fmtDate(t.due_date) : 'sem prazo'}${t.days_late ? ` · ${t.days_late}d atraso` : ''}${t.reschedule_count ? ` · ↻${t.reschedule_count}` : ''}</span></td>
      <td class="g-track">${grid}${bar}${late}${origMark}${dueMark}</td></tr>`;
  };

  // Agrupamento (classificação), com barra-resumo do grupo
  const body = [];
  if (groupLabel) {
    const groups = new Map();
    for (const x of spans) {
      const k = groupLabel(x.t);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(x);
    }
    for (const [label, items] of groups) {
      const gs = items.reduce((a, x) => (x.s.start < a ? x.s.start : a), items[0].s.start);
      const ge = items.reduce((a, x) => [x.s.end, x.s.lateTo].filter(Boolean).reduce((b, v) => (v > b ? v : b), a), items[0].s.end);
      const done = items.filter(x => x.t.eff_status === 'concluida').length;
      body.push(html`<tr class="g-group"><td class="g-label"><b>${label}</b><span class="g-meta">${items.length} ${noun[0]} · ${done} ${noun[1]} · ${fmtDate(gs)} → ${fmtDate(ge)}</span></td>
        <td class="g-track">${grid}<span class="g-span" style="left:${pos(gs).toFixed(2)}%;width:${width(gs, ge).toFixed(2)}%"></span></td></tr>`);
      body.push(...items.map(taskRow));
    }
  } else {
    body.push(...spans.map(taskRow));
  }

  return html`<div class="gantt">
    <table class="g-table">
      <thead><tr><th class="g-label">${head}${weekly ? html`<span class="g-meta">Semanas: segunda a domingo</span>` : ''}</th><th class="g-track g-axis ${weekly ? 'is-weekly' : ''}">${tk.filter(x => x.label).map(x => html`<span style="left:${(weekly ? pos(x.d) + wk / 2 : pos(x.d)).toFixed(2)}%">${x.label}</span>`)}
        <span class="g-today-label" style="left:${todayPct.toFixed(2)}%">hoje</span></th></tr></thead>
      <tbody>${body}</tbody>
    </table>
    ${legend || html`<div class="g-legend">
      <span><i class="g-sw" style="--c:${STATUS_COLOR.em_andamento}"></i>Previsto (início → prazo), cor do status</span>
      <span><i class="g-sw is-done" style="--c:${STATUS_COLOR.concluida}"></i>Concluída (até a conclusão)</span>
      <span><i class="g-sw g-sw-late"></i>Atraso (prazo → hoje)</span>
      <span><i class="g-due g-due-legend"></i>Prazo</span>
      <span><i class="g-due g-orig g-due-legend"></i>Prazo original (reagendada)</span>
      <span><i class="g-today-legend"></i>Hoje (${fmtDate(ref)})</span>
    </div>`}
    <p class="g-note">${note || 'Início = início previsto da tarefa; quando não informado, usa-se o início da execução ou a data de criação.'}</p>
  </div>`;
}
