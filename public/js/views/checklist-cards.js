// Cartões de situação dos check-lists (Dashboard, página do projeto e página do usuário).
import { html, icon, statusBadge, dueInfo } from '../core.js';

function checklistCard(c) {
  const due = dueInfo(c);
  const w = n => (c.total ? `${(n / c.total) * 100}%` : '0');
  const resolvedClean = c.resolved - c.nc_resolved;
  return html`<a class="cl-dash-card" href="#/tarefas/${c.id}">
    <div class="cl-dash-top"><span class="mono muted">${c.code}</span>${statusBadge(c.eff_status, { short: true })}</div>
    <div class="cl-dash-title">${c.title}</div>
    <div class="cl-dash-sub">${c.project_code} · ${c.project_name} · ${c.assignee_name || 'sem responsável'}</div>
    <div class="cl-dash-bar" title="${c.resolved} de ${c.total} itens concluídos">
      <span class="b-ok" style="width:${w(resolvedClean)}"></span><span class="b-fix" style="width:${w(c.nc_resolved)}"></span>
      <span class="b-nc" style="width:${w(c.nc_open)}"></span><span class="b-pend" style="width:${w(c.pending)}"></span></div>
    <div class="cl-dash-pct"><b>${c.pct}%</b> concluído · ${c.resolved}/${c.total} itens</div>
    <div class="cl-dash-nums">
      <span class="${c.nc_open ? 'is-nc' : ''}"><b>${c.nc_open}</b>NC em aberto</span>
      <span><b>${c.nc_resolved}</b>NC resolvidas</span>
      <span><b>${c.pending}</b>sem resposta</span>
      <span class="${c.overdue ? 'is-late' : ''}"><b>${c.overdue}</b>itens atrasados</span>
    </div>
    ${c.user_items !== undefined ? html`<div class="cl-dash-user ${c.user_open ? 'has-open' : ''}">${icon('user')}
      ${c.user_global ? 'Responsável global · ' : ''}${c.user_items ? html`<b>${c.user_open}</b> pendente(s) de <b>${c.user_items}</b> ${c.user_items === 1 ? 'item' : 'itens'} da pessoa` : 'sem itens próprios'}</div>` : ''}
    ${c.due_date ? html`<div class="cl-dash-due ${due.cls}">${icon('calendar')} ${due.text}</div>` : ''}
  </a>`;
}

// title/linkAll/empty: texto do cabeçalho, link "Ver todos" e mensagem sem check-lists (null = não mostra a seção)
export function checklistSection(list, { title = 'Check-lists', linkAll = '#/tarefas?tipo=checklist', empty = null } = {}) {
  if (!list.length && !empty) return '';
  const open = list.filter(c => c.eff_status !== 'concluida');
  const done = list.filter(c => c.eff_status === 'concluida');
  const ncOpen = open.reduce((n, c) => n + c.nc_open, 0);
  return html`<section class="card section cl-dash">
    <div class="card-head"><h2>${icon('checklist')} ${title}</h2>${linkAll ? html`<a class="sub" href="${linkAll}">Ver todos</a>` : ''}</div>
    ${list.length ? html`<div class="cl-dash-head">
      <span><b>${open.length}</b> em andamento</span><span class="${ncOpen ? 'is-nc' : ''}"><b>${ncOpen}</b> NC em aberto</span>
      <span><b>${done.length}</b> concluído(s)</span>
      <span class="cl-dash-legend"><i class="b-ok"></i>Conforme <i class="b-fix"></i>Corrigida <i class="b-nc"></i>NC em aberto <i class="b-pend"></i>Sem resposta</span>
    </div>` : ''}
    ${open.length ? html`<div class="cl-dash-grid">${open.map(checklistCard)}</div>` : html`<p class="muted" style="padding:0 16px 14px">${list.length ? 'Nenhum check-list em andamento.' : empty}</p>`}
    ${done.length ? html`<div style="padding:0 16px 14px"><button type="button" class="btn btn-ghost btn-sm" data-cl-more data-show="Mostrar concluídos (${done.length})">Mostrar concluídos (${done.length})</button></div>
      <div class="cl-dash-grid" data-cl-done hidden>${done.map(checklistCard)}</div>` : ''}
  </section>`;
}

export function bindChecklistCards(root) {
  root.querySelectorAll('[data-cl-more]').forEach(b => b.addEventListener('click', () => {
    const box = b.closest('.cl-dash').querySelector('[data-cl-done]');
    box.hidden = !box.hidden;
    b.textContent = box.hidden ? b.dataset.show : 'Ocultar concluídos';
  }));
}
