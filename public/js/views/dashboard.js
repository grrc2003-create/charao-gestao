import { html, api, icon, statusBadge, fmtDateTime, dueInfo, fmtPct, plural } from '../core.js';
import { fold, bindFolds, nOf, checklistFold, pageHead, kpiBlock, donut, projectRow, userRankRow, bindCommon, kpi, stackBar, STATUS_COLOR, execInline } from './shared.js';
import { deadlineSection, deadlineTable } from './deadlines.js';
import { checklistSection, bindChecklistCards } from './checklist-cards.js';
import { impactRankingSection } from './deps-ui.js';
import { evolutionSection, bindEvolution } from './evolution.js';
import { typeColor } from './projects.js';

// Análise por tipo de projeto: obras, conclusão, atrasos e entregas no prazo de cada tipo
function typeAnalysis(rows) {
  if (!rows?.length) return '';
  const row = r => {
    const s = r.summary;
    const color = typeColor(r.color_index);
    const lateRate = s.total ? Math.round((s.late / s.total) * 100) : 0;
    return html`<li><a class="row-link proj-row type-row" href="#/projetos?status=todos&type=${r.id ?? 'none'}">
      <div class="grow">
        <div class="row-title"><span class="dot" style="--c:${color}"></span><span class="truncate">${r.name}</span></div>
        <div class="row-meta"><span><b>${r.projects}</b> ${r.projects === 1 ? 'projeto' : 'projetos'}</span><span>${r.active_projects} ativo(s)</span><span>${r.done_projects} concluído(s)</span></div>
        ${stackBar(s.by_status)}
        <div class="proj-stats"><span><b>${s.total}</b> tarefas</span><span><b>${s.in_progress}</b> em andamento</span>
          <span style="color:${s.late ? STATUS_COLOR.atrasada : ''}"><b style="color:inherit">${s.late}</b> atrasadas (${lateRate}%)</span>
          <span><b>${fmtPct(s.on_time_pct)}</b> entregas no prazo</span>${s.avg_delay_days ? html`<span><b>${s.avg_delay_days.toLocaleString('pt-BR')}</b> dias de atraso médio</span>` : ''}</div>
        ${execInline(s)}
      </div>
      <div class="proj-pct">${fmtPct(s.completion_pct ?? 0)}<small>concluído</small></div>
      <span class="chev">${icon('chevron')}</span></a></li>`;
  };
  return html`<section class="card section" id="type-analysis">
    <div class="card-head"><h2>${icon('projects')}Análise por tipo de projeto</h2><a class="sub" href="#/projetos?status=todos">Ver projetos</a></div>
    <ul class="rows">${rows.map(row)}</ul></section>`;
}

// Conclusão por projeto: recolhida na altura do quadro ao lado, com botão para ampliar (a escolha vale enquanto a tela estiver aberta)
let foldOpen = false;
function bindProjectFold(root, total) {
  const card = root.querySelector('.dash-fold'), left = root.querySelector('.dash-left');
  if (!card || !left) return;
  const head = card.querySelector('.card-head'), body = card.querySelector('.fold-body'), btn = card.querySelector('.fold-toggle');
  const fit = () => {
    const room = Math.max(100, left.offsetHeight - head.offsetHeight - 46 - 2); // 46 = botão, 2 = bordas
    const fits = body.scrollHeight <= room + 46;
    body.style.maxHeight = foldOpen || fits ? '' : `${room}px`;
    card.classList.toggle('is-open', foldOpen);
    card.classList.toggle('fits', fits);
    btn.setAttribute('aria-expanded', String(foldOpen));
    btn.querySelector('span').textContent = foldOpen ? 'Recolher' : `Ver todos os projetos (${total})`;
  };
  btn.addEventListener('click', () => {
    foldOpen = !foldOpen;
    fit();
    if (!foldOpen && card.getBoundingClientRect().top < 0) card.scrollIntoView({ block: 'start' });
  });
  new ResizeObserver(fit).observe(left);
  fit();
}

export async function view({ state }) {
  const [d, impactRank] = await Promise.all([api('/dashboard'), api('/impact-ranking').catch(() => [])]);
  const u = state.user;
  const s = d.summary;
  const firstName = u.name.split(' ')[0];
  const ranking = [...d.users].sort((a, b) =>
    (b.stats.on_time_pct ?? -1) - (a.stats.on_time_pct ?? -1) || b.stats.done - a.stats.done || a.stats.late - b.stats.late);
  const projects = [...d.projects].sort((a, b) => (a.status === 'concluido') - (b.status === 'concluido') || b.summary.late - a.summary.late);

  const taskMini = t => {
    const due = dueInfo(t);
    return html`<li><a class="row-link" href="#/tarefas/${t.id}">
      <div class="grow"><div class="row-title"><span class="mono muted" style="font-size:12px">${t.code}</span></div>
      <div class="truncate" style="font-weight:600">${t.title}</div>
      <div class="row-meta"><span>${t.assignee_name || 'Sem responsável'}</span><span class="${due.cls}">${due.text}</span></div></div>
      ${statusBadge(t.eff_status, { short: true })}</a></li>`;
  };

  // listas recolhidas: resumo e sinal no cabeçalho
  const myCl = d.my_checklist || [];
  const myClPend = myCl.reduce((n, c) => n + (c.pending || 0), 0);
  const clF = checklistFold(d.checklists || []);
  const rkLate = ranking.filter(x => x.stats?.late).length;
  const impEnd = impactRank.slice(0, 5).filter(r => r.project_end_days > 0).length;
  return {
    title: 'Dashboard',
    html: html`
      ${pageHead({
        eyebrow: 'Visão da empresa',
        title: `Olá, ${firstName}`,
        sub: `${plural(d.projects.filter(p => p.status === 'em_andamento').length, 'obra ativa', 'obras ativas')} · ${plural(s.total, 'tarefa visível', 'tarefas visíveis')} para o seu perfil${d.checklist_items ? ` (inclui ${d.checklist_items} ${d.checklist_items === 1 ? 'item' : 'itens'} de check-list, contados como subtarefas)` : ''}`,
        actions: html`<a class="btn btn-ghost" href="#/painel">${icon('user')}Meu painel</a>${state.meta.can.contracts ? html`<a class="btn btn-ghost" href="#/contratos">${icon('contract')}Contratos</a>` : ''}${state.meta.can.finance ? html`<a class="btn btn-ghost" href="#/financeiro">${icon('wallet')}Financeiro</a>` : ''}<a class="btn btn-ghost" href="#/relatorios">${icon('reports')}Relatórios</a><a class="btn btn-accent" href="#/tarefas/nova">${icon('plus')}Nova tarefa</a>`,
      })}
      ${myCl.length ? fold('meus-cl', nOf(myCl.length, 'check-list', 'check-lists'), myClPend ? nOf(myClPend, 'item pendente', 'itens pendentes') : '', html`<section class="card section cl-alert">
        <div class="card-head"><h2>${icon('checklist')} Itens de check-list para você</h2><a class="sub" href="#/tarefas?tipo=checklist&assignee=me">Ver check-lists</a></div>
        <ul class="rows">${d.my_checklist.map(c => html`<li><a class="row-link" href="#/tarefas/${c.id}">
          <div class="grow"><div class="row-title"><span class="mono muted" style="font-size:12px">${c.code}</span> ${c.title}</div>
            <div class="row-meta"><span>${c.project_code} · ${c.project_name}</span>${c.due_date ? html`<span>${icon('calendar')} ${c.due_date.split('-').reverse().join('/')}</span>` : ''}</div></div>
          <span class="pill pill-orange">${c.pending} ${c.pending === 1 ? 'item pendente' : 'itens pendentes'}</span><span class="chev">${icon('chevron')}</span></a></li>`)}</ul>
      </section>`) : ''}
      ${kpiBlock(s, { linkBase: '#/tarefas' })}
      ${fold('checklists', clF.sum, clF.flag, checklistSection(d.checklists || []))}

      <div class="grid grid-dash section">
        <section class="card dash-left">
          <div class="card-head"><h2>Distribuição por status</h2><a class="sub" href="#/tarefas">Ver tarefas</a></div>
          <div class="card-body">${donut(s.by_status)}</div>
        </section>
        <section class="card dash-fold">
          <div class="card-head"><h2>Conclusão por projeto</h2><a class="sub" href="#/projetos">Todos os projetos</a></div>
          <div class="fold-body">
          <ul class="rows">${projects.map(projectRow)}</ul>
          ${d.internal_areas.length ? html`<div class="card-head" style="border-top:1px solid var(--line)"><h2>Interno (empresa)</h2><span class="sub">tarefas da própria Charão</span></div>
            <ul class="rows">${d.internal_areas.map(projectRow)}</ul>` : ''}
          </div>
          <button type="button" class="fold-toggle no-print" aria-expanded="false">${icon('chevron')}<span></span></button>
        </section>
      </div>

      ${typeAnalysis(d.by_type)}

      ${evolutionSection({ scope: 'empresa' })}

      ${fold('desempenho', nOf(ranking.length, 'pessoa', 'pessoas'), rkLate ? nOf(rkLate, 'pessoa com atraso', 'pessoas com atraso') : '', html`<section class="card section">
        <div class="card-head"><h2>${icon('team')}Desempenho por usuário</h2><span class="sub">ordenado por entregas no prazo</span></div>
        ${ranking.length ? html`<ul class="rows">${ranking.map(userRankRow)}</ul>` : html`<div class="card-body muted">Sem dados de usuários para o seu perfil.</div>`}
      </section>`)}

      ${fold('impacto', nOf(impactRank.slice(0, 5).length, 'tarefa causou atrasos em outras', 'tarefas causaram atrasos em outras'), impEnd ? `${impEnd} ${impEnd === 1 ? 'empurrou' : 'empurraram'} o fim de projeto` : '', impactRankingSection(impactRank.slice(0, 5)))}
      ${deadlineSection(s, d.trend, {
        link: { scope: 'empresa' },
        distBy: d.dist_by,
        chronicMin: d.chronic_min,
        sub: 'constância de atrasos e de repactuações',
        extra: html`${d.users.length ? html`<div><div class="sub-label">Por responsável</div>${deadlineTable(
          [...d.users].filter(u => u.stats.with_due).sort((a, b) => (b.stats.late_rate ?? 0) - (a.stats.late_rate ?? 0))
            .map(u => ({ label: u.name, s: u.stats, href: `#/usuarios/${u.id}` })), 'Responsável')}</div>` : ''}
          ${d.deadline_watch.length ? html`<div><div class="sub-label">Em atenção — tarefas que atrasaram mais de uma vez ou são crônicas</div>
            <ul class="rows dl-watch">${d.deadline_watch.map(t => html`<li><a class="row-link" href="#/tarefas/${t.id}"><div class="grow">
              <div class="row-title"><span class="mono muted" style="font-size:12px">${t.code}</span>
                ${t.late_episodes ? html`<i class="late-badge">atrasou ${t.late_episodes}x</i>` : ''}
                ${t.reschedule_count ? html`<i class="resched-badge ${t.chronic ? 'is-chronic' : ''}">↻ ${t.reschedule_count}x${t.chronic ? ' · crônica' : ''}</i>` : ''}</div>
              <div class="truncate" style="font-weight:600">${t.title}</div>
              <div class="row-meta"><span>${t.assignee_name || 'Sem responsável'}</span><span>${t.project_code}</span></div></div>
              ${statusBadge(t.eff_status, { short: true })}</a></li>`)}</ul></div>` : ''}`,
      })}

      ${d.team_summary ? html`<section class="card section">
        <div class="card-head"><h2>${icon('team')}Minha equipe</h2><a class="sub" href="#/usuarios/${u.id}">Ver detalhes</a></div>
        <div class="card-body"><div class="kpis kpis-5">
          ${kpi({ label: 'Integrantes', value: d.team_size, color: '#2A3D50' })}
          ${kpi({ label: 'Tarefas da equipe', value: d.team_summary.total, color: '#2A3D50' })}
          ${kpi({ label: 'Atrasadas', value: d.team_summary.late, color: STATUS_COLOR.atrasada })}
          ${kpi({ label: 'Em conferência', value: d.team_summary.review, color: STATUS_COLOR.aguardando_conferencia })}
          ${kpi({ label: 'No prazo', value: fmtPct(d.team_summary.on_time_pct), color: STATUS_COLOR.concluida })}
        </div></div></section>` : ''}

      <div class="grid grid-3 section">
        ${fold('atrasos', d.late.length ? 'as mais críticas primeiro' : 'nenhuma atrasada', d.late.length ? nOf(d.late.length, 'atrasada', 'atrasadas') : '', html`<section class="card">
          <div class="card-head"><h2>${icon('alert')}Atrasos críticos</h2><a class="sub" href="#/tarefas?status=atrasada">Ver todas</a></div>
          ${d.late.length ? html`<ul class="rows">${d.late.map(taskMini)}</ul>` : html`<div class="card-body muted">Nenhuma tarefa atrasada. 👍</div>`}
        </section>`)}
        ${fold('proximos', d.upcoming.length ? nOf(d.upcoming.length, 'tarefa vencendo', 'tarefas vencendo') : 'nada vencendo', '', html`<section class="card">
          <div class="card-head"><h2>${icon('calendar')}Próximos 7 dias</h2><a class="sub" href="#/tarefas?due=7d">Ver todas</a></div>
          ${d.upcoming.length ? html`<ul class="rows">${d.upcoming.map(taskMini)}</ul>` : html`<div class="card-body muted">Nada vencendo nos próximos dias.</div>`}
        </section>`)}
        ${fold('atividade', nOf(d.activity.length, 'registro', 'registros'), '', html`<section class="card">
          <div class="card-head"><h2>${icon('history')}Atividade recente</h2></div>
          <div class="card-body"><ul class="timeline">${d.activity.map(a => html`<li>
            <div class="act"><a href="#/tarefas/${a.task_id}">${a.code}</a> · ${a.action}</div>
            <div class="det truncate">${a.title}</div>
            <div class="who">${a.user_name || 'Sistema'} · ${fmtDateTime(a.created_at)}</div></li>`)}</ul></div>
        </section>`)}
      </div>
      <a class="fab" href="#/tarefas/nova" aria-label="Nova tarefa">${icon('plus')}</a>`,
    mount: root => {
      bindProjectFold(root, projects.length + d.internal_areas.length);
      bindCommon(root);
      bindChecklistCards(root);
      bindEvolution(root);
      bindFolds(root, 'empresa');
    },
  };
}
