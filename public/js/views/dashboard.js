import { html, api, icon, statusBadge, fmtDateTime, dueInfo, fmtPct, plural } from '../core.js';
import { pageHead, kpiBlock, donut, projectRow, userRankRow, bindCommon, kpi, STATUS_COLOR } from './shared.js';
import { deadlineSection, deadlineTable } from './deadlines.js';

export async function view({ state }) {
  const d = await api('/dashboard');
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

  return {
    title: 'Dashboard',
    html: html`
      ${pageHead({
        eyebrow: 'Visão geral da operação',
        title: `Olá, ${firstName}`,
        sub: `${plural(d.projects.filter(p => p.status === 'em_andamento').length, 'obra ativa', 'obras ativas')} · ${plural(s.total, 'tarefa visível', 'tarefas visíveis')} para o seu perfil`,
        actions: html`<a class="btn btn-ghost" href="#/relatorios">${icon('reports')}Relatórios</a><a class="btn btn-accent" href="#/tarefas/nova">${icon('plus')}Nova tarefa</a>`,
      })}
      ${kpiBlock(s, { linkBase: '#/tarefas' })}

      <div class="grid grid-dash section">
        <section class="card">
          <div class="card-head"><h2>Distribuição por status</h2><a class="sub" href="#/tarefas">Ver tarefas</a></div>
          <div class="card-body">${donut(s.by_status)}</div>
        </section>
        <section class="card">
          <div class="card-head"><h2>Conclusão por projeto</h2><a class="sub" href="#/projetos">Todos os projetos</a></div>
          <ul class="rows">${projects.map(projectRow)}</ul>
          ${d.internal_areas.length ? html`<div class="card-head" style="border-top:1px solid var(--line)"><h2>Interno (empresa)</h2><span class="sub">tarefas da própria Charão</span></div>
            <ul class="rows">${d.internal_areas.map(projectRow)}</ul>` : ''}
        </section>
      </div>

      <section class="card section">
        <div class="card-head"><h2>${icon('team')}Desempenho por usuário</h2><span class="sub">ordenado por entregas no prazo</span></div>
        ${ranking.length ? html`<ul class="rows">${ranking.map(userRankRow)}</ul>` : html`<div class="card-body muted">Sem dados de usuários para o seu perfil.</div>`}
      </section>

      ${deadlineSection(s, d.trend, {
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
        <section class="card">
          <div class="card-head"><h2>${icon('alert')}Atrasos críticos</h2><a class="sub" href="#/tarefas?status=atrasada">Ver todas</a></div>
          ${d.late.length ? html`<ul class="rows">${d.late.map(taskMini)}</ul>` : html`<div class="card-body muted">Nenhuma tarefa atrasada. 👍</div>`}
        </section>
        <section class="card">
          <div class="card-head"><h2>${icon('calendar')}Próximos 7 dias</h2><a class="sub" href="#/tarefas?due=7d">Ver todas</a></div>
          ${d.upcoming.length ? html`<ul class="rows">${d.upcoming.map(taskMini)}</ul>` : html`<div class="card-body muted">Nada vencendo nos próximos dias.</div>`}
        </section>
        <section class="card">
          <div class="card-head"><h2>${icon('history')}Atividade recente</h2></div>
          <div class="card-body"><ul class="timeline">${d.activity.map(a => html`<li>
            <div class="act"><a href="#/tarefas/${a.task_id}">${a.code}</a> · ${a.action}</div>
            <div class="det truncate">${a.title}</div>
            <div class="who">${a.user_name || 'Sistema'} · ${fmtDateTime(a.created_at)}</div></li>`)}</ul></div>
        </section>
      </div>
      <a class="fab" href="#/tarefas/nova" aria-label="Nova tarefa">${icon('plus')}</a>`,
    mount: root => bindCommon(root),
  };
}
