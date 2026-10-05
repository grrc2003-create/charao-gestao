// Blocos visuais reutilizados por várias telas (KPIs, gráficos, listas de tarefas, projetos e pessoas).
import {
  html, raw, STATUS, STATUS_ORDER, PROJECT_STATUS, statusBadge, priorityTag, avatar, progress, icon, fmtPct, dueInfo, fmtDate, esc,
} from '../core.js';

export const STATUS_COLOR = {
  aberta: '#6E7A86', em_andamento: '#2F6FB3', aguardando_conferencia: '#A86F0E', atrasada: '#C0392B', concluida: '#2E8B57',
};

export const pageHead = ({ eyebrow, title, sub, actions, back }) => html`
  ${back ? html`<a class="back-link" href="${back.href}">${icon('back')}${back.label}</a>` : ''}
  ${title || actions ? html`<div class="page-head">
    <div>${eyebrow ? html`<div class="eyebrow">${eyebrow}</div>` : ''}<h1>${title}</h1>${sub ? html`<p>${sub}</p>` : ''}</div>
    ${actions ? html`<div class="page-actions">${actions}</div>` : ''}
  </div>` : ''}`;

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
    <div class="row-meta"><span>${p.client}</span><span>${PROJECT_STATUS[p.status]}</span></div>
    ${progress(p.summary.completion_pct ?? 0, `Conclusão de ${p.name}`)}
    <div class="proj-stats"><span><b>${p.summary.total}</b> tarefas</span><span><b>${p.summary.in_progress}</b> em andamento</span>
      <span style="color:${p.summary.late ? STATUS_COLOR.atrasada : ''}"><b style="color:inherit">${p.summary.late}</b> atrasadas</span><span><b>${p.summary.done}</b> concluídas</span></div>
  </div>
  <div class="proj-pct">${fmtPct(p.summary.completion_pct ?? 0)}</div>
  <span class="chev">${icon('chevron')}</span></a></li>`;

export const userRankRow = (u, i) => html`<li><a class="row-link rank" href="#/usuarios/${u.id}">
  <span class="rank-num">${i + 1}</span>${avatar(u.name, 'sm')}
  <div class="grow"><div class="row-title truncate">${u.name}</div><div class="row-meta"><span class="truncate">${u.job_title || ''}</span></div></div>
  <div class="rank-metrics">
    <div class="ok"><b>${fmtPct(u.stats.on_time_pct)}</b>no prazo</div>
    <div><b>${u.stats.done}</b>concluídas</div>
    <div class="late"><b>${u.stats.late}</b>atrasadas</div>
    <div><b>${u.stats.assigned}</b>atribuídas</div>
  </div><span class="chev">${icon('chevron')}</span></a></li>`;

// Lista de tarefas: tabela no desktop + cards no celular
export function taskList(tasks, { showProject = true, showAssignee = true, empty = 'Nenhuma tarefa encontrada.' } = {}) {
  if (!tasks.length) return html`<div class="card empty-state"><p>${empty}</p></div>`;
  const cards = html`<div class="task-cards only-mobile">${tasks.map(t => {
    const due = dueInfo(t);
    return html`<a class="task-card st-${t.eff_status}" href="#/tarefas/${t.id}">
      <div class="tc-top"><span class="tc-code">${t.code}</span>${statusBadge(t.eff_status, { short: true })}</div>
      <div class="tc-title">${t.title}</div>
      <div class="tc-meta">
        ${showProject ? html`<span>${icon('projects')}<em>${t.project_name}</em></span>` : ''}
        ${showAssignee ? html`<span>${icon('user')}<em>${t.assignee_name || 'Sem responsável'}</em></span>` : ''}
        <span class="${due.cls}">${icon('calendar')}<em>${due.text}</em></span>
        <span>${priorityTag(t.priority)}</span>
      </div></a>`;
  })}</div>`;
  const table = html`<div class="card only-desktop"><div class="table-wrap"><table class="data">
    <thead><tr><th>Tarefa</th><th>Título</th>${showProject ? html`<th>Projeto</th>` : ''}${showAssignee ? html`<th>Responsável</th>` : ''}<th>Prazo</th><th>Prioridade</th><th>Status</th></tr></thead>
    <tbody>${tasks.map(t => {
      const due = dueInfo(t);
      return html`<tr class="row-st st-${t.eff_status}" data-href="#/tarefas/${t.id}" tabindex="0">
        <td class="mono nowrap">${t.code}</td>
        <td><div class="t-title">${t.title}</div>${t.exec_count || t.ref_count ? html`<div class="t-sub">${t.ref_count ? `${t.ref_count} ref.` : ''} ${t.exec_count ? `· ${t.exec_count} foto(s) execução` : ''}</div>` : ''}</td>
        ${showProject ? html`<td><div>${t.project_name}</div><div class="t-sub mono">${t.project_code}</div></td>` : ''}
        ${showAssignee ? html`<td class="nowrap">${t.assignee_name || html`<span class="muted">—</span>`}</td>` : ''}
        <td class="nowrap ${due.cls}">${due.text}</td>
        <td>${priorityTag(t.priority)}</td>
        <td>${statusBadge(t.eff_status)}</td></tr>`;
    })}</tbody></table></div></div>`;
  return html`${cards}${table}`;
}

// Liga cliques nas linhas da tabela e tooltips de gráficos
export function bindCommon(root) {
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
