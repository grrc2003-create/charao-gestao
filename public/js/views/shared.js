// Blocos visuais reutilizados por várias telas (KPIs, gráficos, listas de tarefas, projetos e pessoas).
import { groupTasks } from './periods.js';
import { previousScreen } from '../navhist.js';
import {
  html, raw, STATUS, STATUS_ORDER, PROJECT_STATUS, statusBadge, priorityTag, avatar, progress, icon, fmtPct, dueInfo, fmtDate, esc,
} from '../core.js';

export const STATUS_COLOR = {
  aberta: '#6E7A86', em_andamento: '#2F6FB3', aguardando_conferencia: '#A86F0E', atrasada: '#C0392B', concluida: '#2E8B57',
};

// "Voltar": leva à tela de onde a pessoa veio (com o nome dela); sem caminho anterior, usa o destino padrão da tela
const shortTitle = t => (t.length > 42 ? `${t.slice(0, 40)}…` : t);
export const backTarget = back => {
  const prev = previousScreen();
  if (prev) return { href: prev.hash, label: prev.title ? `Voltar · ${shortTitle(prev.title)}` : 'Voltar' };
  return back || null;
};
export const pageHead = ({ eyebrow, title, sub, actions, back }) => {
  const b = backTarget(back);
  return html`
  ${b ? html`<a class="back-link" href="${b.href}">${icon('back')}${b.label}</a>` : ''}
  ${title || actions ? html`<div class="page-head">
    <div>${eyebrow ? html`<div class="eyebrow">${eyebrow}</div>` : ''}<h1>${title}</h1>${sub ? html`<p>${sub}</p>` : ''}</div>
    ${actions ? html`<div class="page-actions">${actions}</div>` : ''}
  </div>` : ''}`;
};

export function kpi({ label, value, unit, foot, color, href, hero, pct }) {
  const inner = html`<div class="kpi-label">${label}</div>
    <div class="kpi-value">${value}${unit ? html`<small>${unit}</small>` : ''}</div>
    ${pct !== undefined ? progress(pct, label) : ''}
    ${foot ? html`<div class="kpi-foot">${foot}</div>` : ''}`;
  const style = color ? `--kpi-c:${color}` : '';
  return href
    ? html`<a class="kpi ${hero ? 'kpi-hero' : ''}" href="${href}" style="${style}">${inner}</a>`
    : html`<div class="kpi ${hero ? 'kpi-hero' : ''}" style="${style}">${inner}</div>`;
}

// Bloco padrão de indicadores a partir de um resumo do backend
// Indicadores de execução: média de dias (úteis) do início à conclusão real, antecipadas e atraso de preenchimento
const dec = v => String(v).replace('.', ',');
export function execKpis(s, { title = '' } = {}) {
  if (!s) return '';
  const avg = s.exec_work_days_avg ?? null;
  return html`${title ? html`<div class="sub-label section">${title}</div>` : ''}<div class="kpis kpis-3 ${title ? '' : 'section'} kpis-exec">
    ${kpi({ label: 'Média de execução', value: avg !== null ? dec(avg) : s.exec_days_avg !== null && s.exec_days_avg !== undefined ? dec(s.exec_days_avg) : '—', unit: s.exec_count ? (avg !== null ? ' dias úteis' : ' dias') : '', color: '#2A3D50',
      foot: s.exec_count ? `${dec(s.exec_days_avg)} dias corridos · do início à conclusão real · ${s.exec_count} entrega(s)` : 'sem entregas ainda' })}
    ${kpi({ label: 'Tarefas antecipadas', value: s.early ?? 0, color: STATUS_COLOR.concluida, foot: s.early ? `${fmtPct(s.early_pct)} das entregas · em média ${dec(s.early_days_avg)} dia(s) antes do prazo` : 'nenhuma entrega antes do prazo' })}
    ${kpi({ label: 'Atraso de preenchimento', value: s.filling_delays ?? 0, color: '#B7791F', foot: s.filling_delays ? `conclusões registradas depois do dia real · média ${dec(s.filling_delay_days_avg)} dia(s)` : 'todas registradas no dia da conclusão' })}
  </div>`;
}
// Versão em linha (listas: classificações, projetos, pessoas, subtarefas)
export function execInline(s) {
  if (!s || !(s.exec_count || s.early || s.filling_delays)) return '';
  const avg = s.exec_work_days_avg ?? s.exec_days_avg;
  return html`<div class="exec-inline">
    ${avg !== null && avg !== undefined ? html`<span title="Média do início à conclusão real">⏱ <b>${dec(avg)}</b> ${s.exec_work_days_avg !== null && s.exec_work_days_avg !== undefined ? 'dias úteis' : 'dias'}/exec.</span>` : ''}
    <span class="ok" title="Entregas antes do prazo">✓ <b>${s.early || 0}</b> antecipada(s)</span>
    <span class="${s.filling_delays ? 'warn' : ''}" title="Conclusões registradas depois do dia real${s.filling_delays ? ` · média ${dec(s.filling_delay_days_avg)} dia(s)` : ''}">✎ <b>${s.filling_delays || 0}</b> atr. preench.</span>
  </div>`;
}

export function kpiBlock(s, { linkBase, extra = [] } = {}) {
  const link = st => (linkBase ? `${linkBase}${linkBase.includes('?') ? '&' : '?'}status=${st}` : undefined);
  return html`<div class="kpis">
    ${kpi({ label: 'Conclusão', value: fmtPct(s.completion_pct ?? 0), hero: true, pct: s.completion_pct ?? 0, foot: `${s.done} de ${s.total} tarefas concluídas` })}
    ${kpi({ label: 'Total de tarefas', value: s.total, href: linkBase, color: '#2A3D50', foot: `${s.due_soon} vencem em 7 dias` })}
    ${kpi({ label: 'Em andamento', value: s.in_progress, href: link('em_andamento'), color: STATUS_COLOR.em_andamento, foot: `${s.open} abertas` })}
    ${kpi({ label: 'Em conferência', value: s.review, href: link('aguardando_conferencia'), color: STATUS_COLOR.aguardando_conferencia, foot: 'aguardando aprovação' })}
    ${kpi({ label: 'Atrasadas', value: s.late, href: link('atrasada'), color: STATUS_COLOR.atrasada, foot: s.avg_delay_days ? `atraso médio ${String(s.avg_delay_days).replace('.', ',')} d` : 'sem atrasos ativos' })}
    ${kpi({ label: 'Entregas no prazo', value: fmtPct(s.on_time_pct), color: STATUS_COLOR.concluida, foot: `${s.on_time} de ${s.delivered} entregas` })}
    ${extra}
  </div>`;
}

// Rosca de distribuição por status, com legenda clicável (identidade nunca só por cor)
export function donut(byStatus, { linkBase = '#/tarefas', size = 168 } = {}) {
  const total = STATUS_ORDER.reduce((a, s) => a + (byStatus[s] || 0), 0);
  const r = 70, cx = 84, cy = 84, w = 22;
  let angle = -Math.PI / 2;
  const gap = total > 1 ? 0.025 : 0;
  const arcs = STATUS_ORDER.filter(s => byStatus[s]).map(s => {
    const frac = byStatus[s] / total;
    const a0 = angle + gap / 2, a1 = angle + frac * Math.PI * 2 - gap / 2;
    angle += frac * Math.PI * 2;
    if (frac >= 0.9999) {
      return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${STATUS_COLOR[s]}" stroke-width="${w}"><title>${STATUS[s].label}: ${byStatus[s]}</title></circle>`;
    }
    const large = a1 - a0 > Math.PI ? 1 : 0;
    const p = (a, rad) => `${(cx + rad * Math.cos(a)).toFixed(2)} ${(cy + rad * Math.sin(a)).toFixed(2)}`;
    const ro = r + w / 2, ri = r - w / 2;
    const d = `M${p(a0, ro)} A${ro} ${ro} 0 ${large} 1 ${p(a1, ro)} L${p(a1, ri)} A${ri} ${ri} 0 ${large} 0 ${p(a0, ri)} Z`;
    return `<a href="${esc(linkBase)}?status=${s}"><path d="${d}" fill="${STATUS_COLOR[s]}" data-tip="${esc(STATUS[s].label)}: ${byStatus[s]} (${Math.round(frac * 100)}%)"></path></a>`;
  }).join('');
  const svg = `<svg class="donut" viewBox="0 0 168 168" width="${size}" height="${size}" role="img" aria-label="Distribuição das tarefas por status">
    <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="#EEF0F2" stroke-width="${w}"/>${arcs}
    <text x="84" y="80" text-anchor="middle" font-size="30" font-weight="700" fill="#1C2A38">${total}</text>
    <text x="84" y="100" text-anchor="middle" font-size="11" fill="#6E7A86" letter-spacing="1">TAREFAS</text></svg>`;
  return html`<div class="donut-wrap">${raw(svg)}
    <ul class="legend">${STATUS_ORDER.map(s => html`<li><a href="${linkBase}?status=${s}">
      <span class="sw" style="--c:${STATUS_COLOR[s]}"></span><span>${STATUS[s].label}</span><b>${byStatus[s] || 0}</b>
      <small>${total ? Math.round(((byStatus[s] || 0) / total) * 100) : 0}%</small></a></li>`)}</ul></div>`;
}

export function stackBar(byStatus) {
  const total = STATUS_ORDER.reduce((a, s) => a + (byStatus[s] || 0), 0) || 1;
  return html`<div class="stackbar" aria-hidden="true">${STATUS_ORDER.filter(s => byStatus[s]).map(s =>
    html`<span style="--c:${STATUS_COLOR[s]};flex:${byStatus[s] / total}" data-tip="${STATUS[s].label}: ${byStatus[s]}"></span>`)}</div>`;
}

export const projectRow = p => html`<li><a class="row-link proj-row" href="#/projetos/${p.id}">
  <div class="grow">
    <div class="row-title"><span class="mono muted">${p.code}</span><span class="truncate">${p.name}</span></div>
    <div class="row-meta"><span>${p.client}</span>${p.type_name ? html`<span>${p.type_name}</span>` : ''}<span>${PROJECT_STATUS[p.status]}</span></div>
    ${progress(p.summary.completion_pct ?? 0, `Conclusão de ${p.name}`)}
    <div class="proj-stats"><span><b>${p.summary.total}</b> tarefas</span><span><b>${p.summary.in_progress}</b> em andamento</span>
      <span style="color:${p.summary.late ? STATUS_COLOR.atrasada : ''}"><b style="color:inherit">${p.summary.late}</b> atrasadas</span><span><b>${p.summary.done}</b> concluídas</span></div>
    ${execInline(p.summary)}
  </div>
  <div class="proj-pct">${fmtPct(p.summary.completion_pct ?? 0)}</div>
  <span class="chev">${icon('chevron')}</span></a></li>`;

export const userRankRow = (u, i) => html`<li><a class="row-link rank" href="#/usuarios/${u.id}">
  <span class="rank-num">${i + 1}</span>${avatar(u.name, 'sm', u.id)}
  <div class="grow"><div class="row-title truncate">${u.name}</div><div class="row-meta"><span class="truncate">${u.job_title || ''}</span></div></div>
  <div class="rank-metrics">
    <div class="ok"><b>${fmtPct(u.stats.on_time_pct)}</b>no prazo</div>
    <div><b>${u.stats.done}</b>concluídas</div>
    <div class="late"><b>${u.stats.late}</b>atrasadas</div>
    <div><b>${u.stats.assigned}</b>atribuídas</div>
    <div title="Média de dias úteis do início à conclusão real"><b>${String(u.stats.exec_work_days_avg ?? u.stats.exec_days_avg ?? '—').replace('.', ',')}</b>${u.stats.exec_work_days_avg !== null && u.stats.exec_work_days_avg !== undefined ? 'dias úteis/exec.' : 'dias/exec.'}</div>
    <div class="ok" title="Entregas antes do prazo"><b>${u.stats.early ?? 0}</b>antecipadas</div>
    <div class="${u.stats.filling_delays ? 'warn' : ''}" title="Conclusões registradas depois do dia real${u.stats.filling_delays ? ` · média ${u.stats.filling_delay_days_avg} dia(s)` : ''}"><b>${u.stats.filling_delays ?? 0}</b>atr. preench.</div>
  </div><span class="chev">${icon('chevron')}</span></a></li>`;

// Concluída após o prazo vigente: selo com os dias de atraso da entrega
export const lateDoneTag = t => (t.status === 'concluida' && t.on_time === false
  ? html`<span class="done-late" title="Entregue ${t.days_late} dia(s) após o prazo de ${fmtDate(t.due_date)}">com ${t.days_late}d de atraso</span>` : '');

// Lista de tarefas: tabela no desktop + cards no celular. groupBy = 'dia' | 'semana' | 'mes' organiza por período do prazo.
// Selo do check-list nas listas: itens respondidos e não conformidades
export const checklistTag = t => (t.task_type === 'checklist'
  ? html`<span class="cl-tag" title="Check-list: ${t.cl_done} de ${t.cl_total} itens respondidos${t.cl_nc ? ` · ${t.cl_nc} não conforme(s)` : ''}">☑ ${t.cl_done}/${t.cl_total}${t.cl_nc ? html` <b>✗${t.cl_nc}</b>` : ''}</span> `
  : '');

// Concluídas ficam ocultas nas listas; o botão "Mostrar concluídas" exibe (vale para a tela aberta).
// Se a lista só tem concluídas (ex.: filtro "Concluída"), elas aparecem normalmente.
const isDone = t => t.eff_status === 'concluida';
export const doneToggle = (n, word = 'concluídas') => (n ? html`<button type="button" class="btn btn-ghost btn-sm done-toggle" data-show-done
    data-l-show="Mostrar ${word} (${n})" data-l-hide="Ocultar ${word} (${n})">${icon('check')}<span>Mostrar ${word} (${n})</span></button>` : '');
export function bindDoneToggle(root) {
  document.body.classList.remove('show-done');
  root.querySelectorAll('[data-show-done]').forEach(b => b.addEventListener('click', () => {
    const on = document.body.classList.toggle('show-done');
    document.querySelectorAll('[data-show-done]').forEach(x => { x.querySelector('span').textContent = on ? x.dataset.lHide : x.dataset.lShow; x.setAttribute('aria-pressed', String(on)); });
  }));
}

export function taskList(tasks, { showProject = true, showAssignee = true, empty = 'Nenhuma tarefa encontrada.', groupBy = '', inner = false, hideDone } = {}) {
  if (!tasks.length) return html`<div class="card empty-state"><p>${empty}</p></div>`;
  const hide = hideDone ?? tasks.some(t => !isDone(t));
  const nDone = hide ? tasks.filter(isDone).length : 0;
  const doneBar = !inner && nDone ? html`<div class="done-bar"><span class="muted">${nDone} concluída(s) oculta(s)</span>${doneToggle(nDone)}</div>` : '';
  if (groupBy) {
    return html`${doneBar}<div class="period-groups">${groupTasks(tasks, groupBy).map(g => {
      const by = Object.fromEntries(STATUS_ORDER.map(s => [s, g.items.filter(t => t.eff_status === s).length]));
      return html`<section class="period-group period-${g.rel}" ${hide && g.items.every(isDone) ? raw('data-done') : ''}>
        <header class="period-head">
          <div><h3>${g.label}${g.hint ? html` <span class="period-hint">${g.hint}</span>` : ''}</h3>
            <div class="period-meta"><span><b>${g.items.length}</b> tarefa(s)</span>
              ${by.atrasada ? html`<span class="due-late"><b>${by.atrasada}</b> atrasada(s)</span>` : ''}
              ${by.concluida ? html`<span><b>${by.concluida}</b> concluída(s)</span>` : ''}</div></div>
          <div class="period-bar">${stackBar(by)}</div>
        </header>
        ${taskList(g.items, { showProject, showAssignee, inner: true, hideDone: hide })}
      </section>`;
    })}</div>`;
  }
  // Subtarefas ficam recolhidas embaixo da tarefa principal (quando ela está na lista); "▸ N subtarefas" abre e fecha.
  // Subtarefa cuja tarefa principal não está na lista (por causa de um filtro) aparece sozinha, como antes.
  const inList = new Set(tasks.map(t => t.id));
  const kids = new Map();
  for (const t of tasks) if (t.parent_id && inList.has(t.parent_id)) { if (!kids.has(t.parent_id)) kids.set(t.parent_id, []); kids.get(t.parent_id).push(t); }
  const tops = tasks.filter(t => !(t.parent_id && inList.has(t.parent_id)));
  const toggle = (t, cls) => (kids.has(t.id) ? html`<button type="button" class="sub-toggle ${cls}" data-sub-toggle="${t.id}" aria-expanded="false">
      <span class="sub-chev">${icon('chevron')}</span>${kids.get(t.id).length} subtarefa${kids.get(t.id).length > 1 ? 's' : ''}</button>` : '');
  const cardOf = (t, isSub = false) => {
    const due = dueInfo(t);
    return html`<a class="task-card st-${t.eff_status} ${isSub ? 'is-sub' : ''}" href="#/tarefas/${t.id}" ${hide && isDone(t) ? raw('data-done') : ''}>
      <div class="tc-top"><span class="tc-code">${t.code}</span><span class="tc-status">${statusBadge(t.eff_status, { short: true })}${lateDoneTag(t)}</span></div>
      ${t.parent_code ? html`<div class="sub-mark">↳ Subtarefa de ${t.parent_code}</div>` : ''}
      <div class="tc-title">${checklistTag(t)}${t.recurrence_id ? html`<span class="rec-tag" title="Tarefa recorrente">${t.recurrence_seq}ª</span> ` : ''}${t.title}${t.sub_total ? html` <span class="sub-count">· ${t.sub_done}/${t.sub_total} subtarefas</span>` : ''}${t.waiting_on ? html` <span class="dep-wait-tag" title="Aguardando predecessora(s)">${icon('clock')}Aguardando</span>` : ''}</div>
      <div class="tc-meta">
        ${showProject ? html`<span>${icon('projects')}<em>${t.project_name}</em></span>` : ''}
        ${t.stage_name && !t.stage_default ? html`<span style="grid-column:1/-1"><em class="stage-tag">${t.stage_name}</em></span>` : ''}
        ${showAssignee ? html`<span>${icon('user')}<em>${t.assignee_name || 'Sem responsável'}${t.assignee_external ? ' (terc.)' : ''}</em></span>` : ''}
        <span class="${due.cls}">${icon('calendar')}<em>${due.text}</em>${t.reschedule_count ? html`<i class="resched-badge ${t.chronic ? 'is-chronic' : ''}" title="Reagendada ${t.reschedule_count}x">↻${t.reschedule_count}</i>` : ''}</span>
        <span>${priorityTag(t.priority)}</span>
      </div></a>`;
  };
  const rowOf = (t, isSub = false) => {
      const due = dueInfo(t);
      return html`<tr class="row-st st-${t.eff_status} ${isSub ? 'sub-row' : ''}" ${isSub ? raw(`data-sub-of="${t.parent_id}" hidden`) : ''} ${hide && isDone(t) ? raw('data-done') : ''} data-href="#/tarefas/${t.id}" tabindex="0">
        <td class="mono nowrap">${t.code}</td>
        <td>${t.parent_code ? html`<div class="sub-mark">↳ ${isSub ? 'Subtarefa' : `Subtarefa de ${t.parent_code}`}</div>` : ''}<div class="t-title">${checklistTag(t)}${t.recurrence_id ? html`<span class="rec-tag" title="Tarefa recorrente">${t.recurrence_seq}ª</span> ` : ''}${t.title}${t.sub_total ? html` <span class="sub-count">· ${t.sub_done}/${t.sub_total} subtarefas</span>` : ''}${t.waiting_on ? html` <span class="dep-wait-tag" title="Aguardando predecessora(s)">${icon('clock')}Aguardando</span>` : ''}</div>${!isSub ? toggle(t, 'is-row') : ''}${t.stage_name && !t.stage_default ? html`<div style="margin-top:3px"><span class="stage-tag">${t.stage_name}</span></div>` : ''}${t.exec_count || t.ref_count ? html`<div class="t-sub">${t.ref_count ? `${t.ref_count} ref.` : ''} ${t.exec_count ? `· ${t.exec_count} foto(s) execução` : ''}</div>` : ''}</td>
        ${showProject ? html`<td><div>${t.project_name}</div><div class="t-sub mono">${t.project_code}</div></td>` : ''}
        ${showAssignee ? html`<td class="nowrap">${t.assignee_name || html`<span class="muted">—</span>`}${t.assignee_external ? html`<div class="t-sub">Terceirizado${t.assignee_company ? ` · ${t.assignee_company}` : ''}</div>` : ''}</td>` : ''}
        <td class="nowrap ${due.cls}">${due.text}${t.reschedule_count ? html` <i class="resched-badge ${t.chronic ? 'is-chronic' : ''}" title="Reagendada ${t.reschedule_count}x · prazo original ${fmtDate(t.original_due)}${t.chronic ? ' · crônica' : ''}">↻${t.reschedule_count}</i>` : ''}${t.late_episodes > 1 ? html` <i class="late-badge" title="Ficou atrasada ${t.late_episodes} vezes">${t.late_episodes}x</i>` : ''}</td>
        <td>${priorityTag(t.priority)}</td>
        <td>${statusBadge(t.eff_status)}${lateDoneTag(t) ? html`<div style="margin-top:3px">${lateDoneTag(t)}</div>` : ''}</td></tr>`;
  };
  const anyKids = kids.size > 0;
  const bar = anyKids ? html`<div class="sub-bar"><span class="muted">${[...kids.values()].reduce((n, k) => n + k.length, 0)} subtarefa(s) recolhida(s) dentro das tarefas</span>
      <button type="button" class="btn btn-ghost btn-sm" data-sub-all="1">${icon('chevron')}Mostrar todas</button>
      <button type="button" class="btn btn-ghost btn-sm" data-sub-all="0" hidden>Ocultar todas</button></div>` : '';
  const cards = html`<div class="task-cards only-mobile">${tops.map(t => (kids.has(t.id)
    ? html`<div class="tc-group" ${hide && isDone(t) ? raw('data-done') : ''}>${cardOf(t)}${toggle(t, 'is-card')}<div class="tc-subs" data-sub-of="${t.id}" hidden>${kids.get(t.id).map(s => cardOf(s, true))}</div></div>`
    : cardOf(t)))}</div>`;
  const table = html`<div class="card only-desktop"><div class="table-wrap"><table class="data">
    <thead><tr><th>Tarefa</th><th>Título</th>${showProject ? html`<th>Projeto</th>` : ''}${showAssignee ? html`<th>Responsável</th>` : ''}<th>Prazo</th><th>Prioridade</th><th>Status</th></tr></thead>
    <tbody>${tops.map(t => html`${rowOf(t)}${(kids.get(t.id) || []).map(s => rowOf(s, true))}`)}</tbody></table></div></div>`;
  // Ordem exibida (tarefa principal seguida das subtarefas) para navegar entre elas dentro da tarefa
  const order = tops.flatMap(t => [t, ...(kids.get(t.id) || [])]).map(t => ({ i: t.id, c: t.code, t: t.title }));
  return html`<div data-nav-list="${JSON.stringify(order)}">${doneBar}${bar}${cards}${table}</div>`;
}

// Ao abrir uma tarefa a partir de uma lista, guarda a ordem da lista (Anterior/Próxima na tela da tarefa)
export const NAV_SEQ_KEY = 'charao-task-seq';
function rememberList(el) {
  const box = el.closest('[data-nav-list]');
  if (!box) return;
  try { sessionStorage.setItem(NAV_SEQ_KEY, JSON.stringify({ list: JSON.parse(box.dataset.navList), from: location.hash, title: document.title.replace(/ · Charão$/, '') })); } catch { /* sem armazenamento */ }
}

// Liga cliques nas linhas da tabela e tooltips de gráficos
const SUB_KEY = 'charao-subs-open';
const openSubs = () => { try { return new Set(JSON.parse(sessionStorage.getItem(SUB_KEY) || '[]')); } catch { return new Set(); } };
const saveSubs = s => { try { sessionStorage.setItem(SUB_KEY, JSON.stringify([...s])); } catch { /* sem armazenamento */ } };
function bindSubtasks(root) {
  const open = openSubs();
  const setOpen = (id, on) => {
    root.querySelectorAll(`[data-sub-of="${id}"]`).forEach(e => (e.hidden = !on));
    root.querySelectorAll(`[data-sub-toggle="${id}"]`).forEach(b => b.setAttribute('aria-expanded', String(on)));
    if (on) open.add(id); else open.delete(id);
  };
  const syncAll = () => {
    const ids = [...new Set([...root.querySelectorAll('[data-sub-toggle]')].map(b => b.dataset.subToggle))];
    const allOpen = ids.length && ids.every(id => open.has(id));
    root.querySelectorAll('[data-sub-all="1"]').forEach(b => (b.hidden = !!allOpen));
    root.querySelectorAll('[data-sub-all="0"]').forEach(b => (b.hidden = !allOpen));
  };
  root.querySelectorAll('[data-sub-toggle]').forEach(b => {
    if (open.has(b.dataset.subToggle)) setOpen(b.dataset.subToggle, true);
    b.addEventListener('click', e => {
      e.preventDefault();
      e.stopPropagation(); // não abre a tarefa ao clicar no botão
      setOpen(b.dataset.subToggle, b.getAttribute('aria-expanded') !== 'true');
      saveSubs(open); syncAll();
    });
  });
  root.querySelectorAll('[data-sub-all]').forEach(b => b.addEventListener('click', () => {
    const on = b.dataset.subAll === '1';
    new Set([...root.querySelectorAll('[data-sub-toggle]')].map(x => x.dataset.subToggle)).forEach(id => setOpen(id, on));
    saveSubs(open); syncAll();
  }));
  syncAll();
}

export function bindCommon(root) {
  bindSubtasks(root);
  bindDoneToggle(root);
  if (!root.__navList) {
    root.__navList = true; // o container da tela é reaproveitado entre as telas: liga uma vez só
    root.addEventListener('click', e => {
      const el = e.target.closest('[data-nav-list] a[href^="#/tarefas/"], [data-nav-list] tr[data-href]');
      if (el && !e.target.closest('[data-sub-toggle]')) rememberList(el);
    }, true);
  }
  root.querySelectorAll('tr[data-href]').forEach(tr => {
    tr.addEventListener('click', () => (location.hash = tr.dataset.href));
    tr.addEventListener('keydown', e => { if (e.key === 'Enter') location.hash = tr.dataset.href; });
  });
  let tip;
  root.querySelectorAll('[data-tip]').forEach(el => {
    el.addEventListener('mouseenter', () => {
      tip = document.createElement('div');
      tip.className = 'chart-tip';
      tip.textContent = el.dataset.tip;
      document.body.appendChild(tip);
    });
    el.addEventListener('mousemove', e => { if (tip) { tip.style.left = e.clientX + 12 + 'px'; tip.style.top = e.clientY + 12 + 'px'; } });
    el.addEventListener('mouseleave', () => { tip?.remove(); tip = null; });
  });
}

export const fieldListButton = (query, label = 'Gerar lista de campo') =>
  html`<a class="btn btn-accent" href="#/imprimir/campo?${query}">${icon('checklist')}${label}</a>`;

export { fmtDate };

// <option>s de projetos agrupadas: obras e áreas internas da empresa
export const projectOptions = (projects, current, opt) => {
  const obras = projects.filter(p => p.kind !== 'interno');
  const internas = projects.filter(p => p.kind === 'interno');
  const o = p => opt(p.id, `${p.code} · ${p.name}`, current);
  return internas.length
    ? html`<optgroup label="Obras">${obras.map(o)}</optgroup><optgroup label="Interno (empresa)">${internas.map(o)}</optgroup>`
    : html`${obras.map(o)}`;
};

// Prazo do projeto pelas tarefas + efeito dos reagendamentos no fim do projeto (cartão e página do projeto)
export function scheduleLine(p) {
  const sc = p.schedule;
  const start = sc?.start || p.start_date, end = sc?.end || p.end_date;
  if (!start && !end) return '';
  const planned = sc && p.end_date && sc.end && p.end_date !== sc.end ? html`<small class="sch-plan" title="Previsão de término cadastrada no projeto">planejado ${fmtDate(p.start_date)} → ${fmtDate(p.end_date)}</small>` : '';
  const d = sc?.net_days || 0;
  const eff = sc && sc.impacting_count ? html`<span class="sch-imp ${d > 0 ? 'is-late' : d < 0 ? 'is-early' : ''}" title="Reagendamentos (e deslocamentos por dependência) que mudaram o fim do projeto, desde o prazo original das tarefas (${fmtDate(sc.end_original)})">
      ${icon('reschedule')}${sc.impacting_count} reagendada(s) · ${d > 0 ? `+${d} d de atraso` : d < 0 ? `${-d} d antecipado(s)` : 'sem efeito no fim'}${sc.delayed_days && sc.advanced_days ? ` (+${sc.delayed_days} / −${sc.advanced_days})` : ''}</span>` : '';
  return html`<span class="sch-dates" title="Início e fim pelas tarefas e subtarefas">${icon('calendar')} ${fmtDate(start)} → ${fmtDate(end)}</span>${planned}${eff}`;
}
