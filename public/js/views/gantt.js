// Cronograma (Gantt) das tarefas — HTML/CSS puro, adequado à tela e à impressão A4.
// Barra: início previsto (ou início da execução / criação) até o prazo. Concluídas vão até a data de conclusão;
// atrasadas ganham uma extensão hachurada do prazo até hoje. Losango = prazo. Linha laranja = hoje.
import { html, icon, STATUS, fmtDate } from '../core.js';
import { STATUS_COLOR } from './shared.js';

const TZ = 'America/Sao_Paulo';
const dayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ });
const toDay = ts => (ts ? (/^\d{4}-\d{2}-\d{2}$/.test(ts) ? ts : dayFmt.format(new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(ts) ? ts : ts.replace(' ', 'T') + 'Z'))) : null);
const ms = d => Date.parse(d + 'T00:00:00Z');
const addDays = (d, n) => new Date(ms(d) + n * 86400e3).toISOString().slice(0, 10);
const DOW = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
const MONTHS = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];

export function ganttSpan(t, ref) {
  const start = t.start_date || toDay(t.started_at) || toDay(t.created_at) || ref;
  const due = t.due_date || null;
  // Concluída: a barra vai até a conclusão real (dia da entrega)
  const done = t.eff_status === 'concluida' ? (t.delivered_date || toDay(t.completed_at)) : null;
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
  if (days <= 8) {
    // Uma semana: um rótulo por dia, com o dia da semana
    for (let d = from; d < to; d = addDays(d, 1)) out.push({ d, label: `${DOW[new Date(ms(d)).getUTCDay()]} ${d.slice(8, 10)}/${d.slice(5, 7)}`, mid: true });
  } else if (days <= 31) {
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
 *               noun: ['tarefa(s)', 'concluída(s)'], head: 'Tarefa', legend: html, note: texto,
 *               range: { from, to } — mostra só o período (ex.: uma semana), com as tarefas que passam por ele }
 */
export function ganttChart(rows, { ref, groupLabel, showProject = false, weekly = false, color, statusOf, noun = ['tarefa(s)', 'concluída(s)'], head = 'Tarefa', legend, note, range } = {}) {
  if (!rows.length) return html`<p class="muted">Sem ${noun[0].replace('(s)', 's')} para o cronograma.</p>`;
  const lastOf = s => [s.end, s.due, s.lateTo].filter(Boolean).reduce((b, v) => (v > b ? v : b), s.end);
  let spans = rows.map(t => ({ t, s: ganttSpan(t, ref) }));
  if (range) {
    spans = spans.filter(x => x.s.start <= range.to && lastOf(x.s) >= range.from);
    if (!spans.length) return html`<p class="muted">Nenhuma ${noun[0].replace('(s)', '')} passa por este período.</p>`;
  }
  let from = spans.reduce((a, x) => (x.s.start < a ? x.s.start : a), spans[0].s.start);
  let to = spans.reduce((a, x) => (lastOf(x.s) > a ? lastOf(x.s) : a), spans[0].s.end);
  if (ref > to) to = ref;
  if (ref < from) from = ref;
  if (range) {
    from = range.from;
    to = addDays(range.to, 1);
  } else if (weekly) {
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
  const showToday = ref >= from && ref < to;
  const wk = 100 / Math.max(tk.length, 1);
  // Semanal: colunas alternadas para facilitar a leitura de cada semana
  const grid = html`${weekly ? tk.filter(x => x.week % 2).map(x => html`<i class="g-week" style="left:${pos(x.d).toFixed(2)}%;width:${wk.toFixed(2)}%"></i>`) : ''}${tk.map(x => html`<i class="g-tick" style="left:${pos(x.d).toFixed(2)}%"></i>`)}${showToday ? html`<i class="g-today" style="left:${todayPct.toFixed(2)}%"></i>` : ''}`;

  const taskRow = ({ t, s }) => {
    const c = color ? color(t) : STATUS_COLOR[t.eff_status];
    // Avanço parcial: parte preenchida da barra (concluídas já são cheias)
    const pg = t.eff_status !== 'concluida' && t.progress_pct !== null && t.progress_pct !== undefined ? t.progress_pct : null;
    const bar = html`<span class="g-bar ${t.eff_status === 'concluida' ? 'is-done' : ''} ${pg !== null ? 'has-progress' : ''}" data-gbar style="left:${pos(s.start).toFixed(2)}%;width:${width(s.start, s.end).toFixed(2)}%;--c:${c}"
      title="${t.code} · ${fmtDate(s.start)} → ${fmtDate(s.end)} · ${statusOf ? statusOf(t) : STATUS[t.eff_status].label}${pg !== null ? ` · avanço ${pg}%` : ''}">${pg !== null ? html`<i class="g-fill" style="width:${pg}%"></i>` : ''}</span>
      ${pg !== null && pg < 100 ? html`<span class="g-pct" style="left:${(pos(s.start) + width(s.start, s.end)).toFixed(2)}%">${pg}%</span>` : ''}`;
    const late = s.lateTo && s.lateTo > s.due
      ? html`<span class="g-late" style="left:${pos(addDays(s.due, 1)).toFixed(2)}%;width:${(pos(addDays(s.lateTo, 1)) - pos(addDays(s.due, 1))).toFixed(2)}%"></span>` : '';
    // Concluída/entregue depois do prazo: trecho hachurado (atraso realizado); antes do prazo: trecho tracejado (antecipação)
    const a = t.actual;
    const doneLate = a && s.due && a.end > s.due
      ? html`<span class="g-late g-late-done" style="left:${pos(addDays(s.due, 1)).toFixed(2)}%;width:${(pos(addDays(a.end, 1)) - pos(addDays(s.due, 1))).toFixed(2)}%" title="Concluída ${a.vs_due} dia(s) após o prazo"></span>` : '';
    const doneEarly = a && s.due && a.end < s.due
      ? html`<span class="g-early" style="left:${pos(addDays(a.end, 1)).toFixed(2)}%;width:${(pos(addDays(s.due, 1)) - pos(addDays(a.end, 1))).toFixed(2)}%" title="Concluída ${-a.vs_due} dia(s) antes do prazo"></span>` : '';
    const doneTag = a ? html`<span class="g-pct g-done-tag ${a.vs_due > 0 ? 'is-late' : 'is-ok'}" style="left:${pos(addDays([a.end, s.due].filter(Boolean).sort().at(-1), 1)).toFixed(2)}%">✓ ${fmtDate(a.end).slice(0, 5)}${a.vs_due ? ` · ${a.vs_due > 0 ? '+' : '−'}${Math.abs(a.vs_due)}d` : ''}</span>` : '';
    const dueMark = s.due ? html`<span class="g-due" style="left:${pos(addDays(s.due, 1)).toFixed(2)}%" title="Prazo ${fmtDate(s.due)}"></span>` : '';
    // Prazo original (antes dos reagendamentos): losango vazado
    const origMark = t.original_due && t.original_due !== s.due
      ? html`<span class="g-due g-orig" style="left:${pos(addDays(t.original_due, 1)).toFixed(2)}%" title="Prazo original ${fmtDate(t.original_due)} · reagendada ${t.reschedule_count}x"></span>` : '';
    return html`<tr class="g-row ${t.critical ? 'is-critical' : ''}" data-gkey="${t.dep_key || ''}" data-preds="${(t.preds || []).map(x => x.key).join(',')}">
      <td class="g-label"><span class="g-code">${t.code}</span>${showProject ? html`<span class="g-proj">${t.project_code}</span>` : ''}
        <span class="g-title">${t.parent_code ? '↳ ' : ''}${t.title}</span>
        <span class="g-meta">${t.assignee_name || 'Sem responsável'} · ${t.actual
          ? `${fmtDate(t.actual.start)} → concluída ${fmtDate(t.actual.end)} · ${t.actual.work_days ?? '—'} d úteis (${t.actual.calendar_days} corridos)${t.actual.vs_due > 0 ? ` · ${t.actual.vs_due}d após o prazo` : t.actual.vs_due < 0 ? ` · ${-t.actual.vs_due}d antes do prazo` : t.actual.vs_due === 0 ? ' · no prazo' : ''}`
          : `${fmtDate(s.start)} → ${t.due_date ? fmtDate(t.due_date) : 'sem prazo'}${t.days_late ? ` · ${t.days_late}d atraso` : ''}`}${t.reschedule_count ? ` · ↻${t.reschedule_count}` : ''}${t.eff_status !== 'concluida' && t.progress_pct !== null && t.progress_pct !== undefined && t.progress_pct < 100 ? ` · ${t.progress_pct}% executado` : ''}</span></td>
      <td class="g-track">${grid}${bar}${late}${doneLate}${doneEarly}${origMark}${dueMark}${doneTag}</td></tr>`;
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
      // Avanço do grupo (quando algum item tem avanço informado): média, concluídos = 100%
      const anyPg = items.some(x => x.t.eff_status !== 'concluida' && x.t.progress_pct !== null && x.t.progress_pct !== undefined);
      const gpg = anyPg ? Math.round(items.reduce((n, x) => n + (x.t.eff_status === 'concluida' ? 100 : x.t.progress_pct || 0), 0) / items.length) : null;
      body.push(html`<tr class="g-group"><td class="g-label"><b>${label}</b><span class="g-meta">${items.length} ${noun[0]} · ${done} ${noun[1]}${gpg !== null ? ` · avanço ${gpg}%` : ''} · ${fmtDate(gs)} → ${fmtDate(ge)}</span></td>
        <td class="g-track">${grid}<span class="g-span" style="left:${pos(gs).toFixed(2)}%;width:${width(gs, ge).toFixed(2)}%"></span></td></tr>`);
      body.push(...items.map(taskRow));
    }
  } else {
    body.push(...spans.map(taskRow));
  }

  // Ligações de dependência (setas desenhadas depois de montar) e caminho crítico
  const hasLinks = rows.some(t => t.preds?.length);
  const hasCritical = rows.some(t => t.critical);
  return html`<div class="gantt ${hasLinks ? 'has-links' : ''}">
    ${hasLinks ? html`<svg class="g-links" aria-hidden="true"></svg>` : ''}
    <table class="g-table">
      <thead><tr><th class="g-label">${head}${weekly ? html`<span class="g-meta">Semanas: segunda a domingo</span>` : ''}</th><th class="g-track g-axis ${weekly ? 'is-weekly' : ''}">${tk.filter(x => x.label).map(x => html`<span style="left:${(weekly || x.mid ? pos(x.d) + wk / 2 : pos(x.d)).toFixed(2)}%">${x.label}</span>`)}
        ${showToday ? html`<span class="g-today-label" style="left:${todayPct.toFixed(2)}%">hoje</span>` : ''}</th></tr></thead>
      <tbody>${body}</tbody>
    </table>
    ${legend || html`<div class="g-legend">
      <span><i class="g-sw" style="--c:${STATUS_COLOR.em_andamento}"></i>Previsto (início → prazo), cor do status</span>
      <span><i class="g-sw is-done" style="--c:${STATUS_COLOR.concluida}"></i>Concluída (até a conclusão)</span>
      ${rows.some(t => t.eff_status !== 'concluida' && t.progress_pct !== null && t.progress_pct !== undefined) ? html`<span><i class="g-sw g-sw-pg" style="--c:${STATUS_COLOR.em_andamento}"></i>Parte executada (avanço %)</span>` : ''}
      <span><i class="g-sw g-sw-late"></i>Atraso (prazo → hoje ou → conclusão)</span>
      ${rows.some(t => t.actual && t.actual.vs_due < 0) ? html`<span><i class="g-sw g-sw-early"></i>Antecipação (concluída antes do prazo)</span>` : ''}
      <span><i class="g-due g-due-legend"></i>Prazo</span>
      <span><i class="g-due g-orig g-due-legend"></i>Prazo original (reagendada)</span>
      <span><i class="g-today-legend"></i>Hoje (${fmtDate(ref)})</span>
    </div>`}
    ${hasLinks ? html`<div class="g-legend g-legend-dep"><span><i class="g-link-legend"></i>Dependência (término → início)</span>
      ${hasCritical ? html`<span><i class="g-sw g-sw-crit"></i>Caminho crítico: sequência sem folga que define a data final</span>` : ''}</div>` : ''}
    <p class="g-note">${note || 'Início = início previsto da tarefa; quando não informado, usa-se o início da execução ou a data de criação.'}</p>
  </div>`;
}

// Desenha as setas das dependências sobre o Gantt (refaz ao redimensionar e ao imprimir)
function drawOne(g) {
  const svg = g.querySelector('svg.g-links');
  if (!svg) return;
  const box = g.getBoundingClientRect();
  svg.setAttribute('width', box.width);
  svg.setAttribute('height', box.height);
  svg.setAttribute('viewBox', `0 0 ${box.width} ${box.height}`);
  const rowOf = key => g.querySelector(`tr[data-gkey="${key}"]`);
  const parts = ['<defs><marker id="g-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="#46535F"/></marker>',
    '<marker id="g-arrow-c" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="#C0392B"/></marker></defs>'];
  g.querySelectorAll('tr[data-preds]').forEach(tr => {
    const keys = (tr.dataset.preds || '').split(',').filter(Boolean);
    const sb = tr.querySelector('[data-gbar]');
    if (!keys.length || !sb) return;
    const s = sb.getBoundingClientRect();
    for (const k of keys) {
      const pr = rowOf(k);
      const pb = pr?.querySelector('[data-gbar]');
      if (!pb) continue;
      const p = pb.getBoundingClientRect();
      const x1 = p.right - box.left, y1 = p.top + p.height / 2 - box.top;
      const x2 = s.left - box.left - 1, y2 = s.top + s.height / 2 - box.top;
      const xm = Math.max(x1 + 6, Math.min(x2 - 6, x1 + 10));
      const crit = tr.classList.contains('is-critical') && pr.classList.contains('is-critical');
      const d = x2 - 6 >= x1 + 6 ? `M${x1},${y1} H${xm} V${y2} H${x2}` : `M${x1},${y1} h6 V${(y1 + y2) / 2} H${x2 - 8} V${y2} H${x2}`;
      parts.push(`<path d="${d}" fill="none" stroke="${crit ? '#C0392B' : '#46535F'}" stroke-width="${crit ? 1.8 : 1.1}" ${crit ? '' : 'stroke-dasharray="3 2"'} marker-end="url(#${crit ? 'g-arrow-c' : 'g-arrow'})"/>`);
    }
  });
  svg.innerHTML = parts.join('');
}
export function drawGanttLinks(root) {
  const all = () => root.querySelectorAll('.gantt.has-links').forEach(drawOne);
  all();
  if (root.__gLinks) return;
  root.__gLinks = true;
  let t;
  window.addEventListener('resize', () => { clearTimeout(t); t = setTimeout(all, 120); });
  window.addEventListener('beforeprint', all);
  window.addEventListener('afterprint', all);
  window.matchMedia?.('print').addEventListener?.('change', all);
}

// Seção "Cronograma (Gantt)" das telas: recolhida; ao abrir, busca as tarefas e desenha (com as setas de dependência)
export function ganttSection({ id, url, title = 'Cronograma (Gantt)', sub = '', showProject = false, groupBy = 'stage' }) {
  return html`<details class="card section gantt-sec" data-gantt-sec="${id}" data-gantt-url="${url}" data-gantt-proj="${showProject ? 1 : 0}" data-gantt-group="${groupBy}">
    <summary class="card-head"><h2>${icon('calendar')}${title}</h2><span class="sub">${sub || 'toque para abrir'}</span></summary>
    <div class="card-body gantt-sec-body"><p class="muted">Carregando…</p></div>
  </details>`;
}
export function bindGanttSections(root, fetcher) {
  root.querySelectorAll('[data-gantt-sec]').forEach(d => {
    const key = `charao-gantt-${d.dataset.ganttSec}`;
    let loaded = false;
    const load = async () => {
      if (loaded) { drawGanttLinks(d); return; }
      loaded = true;
      const body = d.querySelector('.gantt-sec-body');
      try {
        const g = await fetcher(d.dataset.ganttUrl);
        const showProject = d.dataset.ganttProj === '1';
        const label = d.dataset.ganttGroup === 'project' ? t => `${t.project_code}` : t => t.stage_name || 'Geral';
        // Filtro de período: todo o cronograma ou uma semana (segunda a domingo), lembrado por tela
        const pkey = `${key}-periodo`;
        let wk = '';
        try { wk = sessionStorage.getItem(pkey) || ''; } catch { /* sem armazenamento */ }
        const draw = () => {
          const range = wk ? { from: wk, to: addDays(wk, 6) } : null;
          const bar = html`<div class="g-filter" role="group" aria-label="Período do cronograma">
            <div class="chips"><button type="button" class="chip" data-gper="" aria-pressed="${!wk}">Todo o período</button>
              <button type="button" class="chip" data-gper="${wk || monday(g.ref)}" aria-pressed="${!!wk}">Por semana</button></div>
            ${wk ? html`<div class="g-wnav"><button type="button" class="btn btn-ghost btn-sm" data-gper="${addDays(wk, -7)}" aria-label="Semana anterior">‹</button>
              <b>${fmtDate(wk)} a ${fmtDate(addDays(wk, 6))}</b>
              <button type="button" class="btn btn-ghost btn-sm" data-gper="${addDays(wk, 7)}" aria-label="Próxima semana">›</button>
              ${wk !== monday(g.ref) ? html`<button type="button" class="btn btn-ghost btn-sm" data-gper="${monday(g.ref)}">Esta semana</button>` : ''}</div>` : ''}
          </div>`;
          body.innerHTML = html`${bar}${ganttChart(g.tasks, { ref: g.ref, groupLabel: label, showProject, range })}`.toString();
          body.querySelectorAll('[data-gper]').forEach(b => b.addEventListener('click', () => {
            wk = b.dataset.gper;
            try { sessionStorage.setItem(pkey, wk); } catch { /* sem armazenamento */ }
            draw();
          }));
          drawGanttLinks(d);
        };
        draw();
      } catch (e) { body.innerHTML = html`<p class="muted">${e.message}</p>`.toString(); loaded = false; }
    };
    try { if (sessionStorage.getItem(key) === '1') { d.open = true; load(); } } catch { /* sem armazenamento */ }
    d.addEventListener('toggle', () => {
      try { sessionStorage.setItem(key, d.open ? '1' : '0'); } catch { /* sem armazenamento */ }
      if (d.open) load();
    });
  });
}
