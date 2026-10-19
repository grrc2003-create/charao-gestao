// Meu painel: o dashboard da própria pessoa — indicadores, planejamento da semana, atrasadas e próximos dias;
// para quem tem equipe abaixo, a análise de desempenho da equipe. Atalho para a Visão da empresa (se liberada).
import { html, api, icon, statusBadge, dueInfo, fmtPct } from '../core.js';
import { pageHead, kpi, execKpis, userRankRow, stackBar, bindCommon, STATUS_COLOR } from './shared.js';
import { deadlineTable } from './deadlines.js';
import { checklistSection, bindChecklistCards } from './checklist-cards.js';
import { weekPlanSection, bindWeekPlan } from './week-plan.js';
import { myVacationCard, bindMyVacationCard } from './vacation-ui.js';
import { myReimbCard, bindMyReimbCard } from './reimb-ui.js';

const dec = v => String(v ?? '—').replace('.', ',');

export async function view({ state, query, setQuery, render }) {
  const me = state.user;
  const [d, vac, reimb] = await Promise.all([api(`/users/${me.id}`), api('/vacations/me').catch(() => null), api('/reimbursements/me').catch(() => null)]);
  const s = d.stats;
  const first = me.name.split(' ')[0];
  const can = state.meta.can;
  const sec = k => !can.sections || can.sections.includes(k);
  const week = /^\d{4}-\d{2}-\d{2}$/.test(query.get('semana') || '') ? query.get('semana') : '';
  const open = d.tasks.filter(t => !t.delivered && !t.cancelled_at);
  const late = open.filter(t => t.eff_status === 'atrasada').sort((a, b) => b.days_late - a.days_late);
  const soon = open.filter(t => t.eff_status !== 'atrasada' && t.days_to_due !== null && t.days_to_due <= 7).sort((a, b) => a.days_to_due - b.days_to_due);
  const review = d.tasks.filter(t => t.eff_status === 'aguardando_conferencia');

  const taskRow = (t, who = false) => {
    const due = dueInfo(t);
    return html`<li><a class="row-link" href="#/tarefas/${t.id}"><div class="grow">
      <div class="row-title"><span class="mono muted" style="font-size:12px">${t.code}</span></div>
      <div class="truncate" style="font-weight:600">${t.title}</div>
      <div class="row-meta">${who ? html`<span>${t.assignee_name || 'Sem responsável'}</span>` : html`<span>${t.project_code}</span>`}<span class="${due.cls}">${due.text}</span></div></div>
      ${statusBadge(t.eff_status, { short: true })}</a></li>`;
  };

  // ---------- Equipe ----------
  const team = d.team || [];
  const ts = d.team_summary;
  const teamOpen = (d.team_tasks || []).filter(t => !t.delivered && !t.cancelled_at);
  const teamLate = teamOpen.filter(t => t.eff_status === 'atrasada').sort((a, b) => b.days_late - a.days_late);
  const byMember = [...team].sort((a, b) => b.stats.late - a.stats.late || (b.stats.open + b.stats.in_progress) - (a.stats.open + a.stats.in_progress));
  const maxLoad = Math.max(1, ...team.map(m => m.stats.assigned));
  const memberRow = m => {
    const st = m.stats;
    const openN = st.open + st.in_progress + st.late;
    return html`<li><a class="row-link tm-row" href="#/usuarios/${m.id}">
      <div class="tm-name"><b>${m.name}</b><small>${m.job_title || ''}</small></div>
      <div class="tm-bar"><div style="width:${Math.max(4, (st.assigned / maxLoad) * 100)}%">${stackBar(st.by_status)}</div>
        <small>${st.assigned} tarefa(s) · ${openN} em aberto${st.review ? ` · ${st.review} em conferência` : ''}</small></div>
      <div class="tm-nums">
        <span class="${st.late ? 'is-late' : ''}"><b>${st.late}</b>atrasadas</span>
        <span><b>${fmtPct(st.on_time_pct)}</b>no prazo</span>
        <span><b>${dec(st.exec_work_days_avg ?? st.exec_days_avg)}</b>dias/exec.</span>
        <span><b>${st.early || 0}</b>antecip.</span>
      </div>
      <span class="chev">${icon('chevron')}</span></a></li>`;
  };
  const teamSection = team.length ? html`
    <div class="page-head section" style="margin-bottom:10px"><div><div class="eyebrow">Equipe abaixo de você</div><h2>${icon('team')} Desempenho da equipe</h2>
      <p>${team.length} integrante(s) · as tarefas são de responsabilidade de cada integrante</p></div></div>
    <div class="kpis kpis-5">
      ${kpi({ label: 'Tarefas da equipe', value: ts.total, color: '#2A3D50', foot: `${ts.open + ts.in_progress + ts.late} em aberto` })}
      ${kpi({ label: 'Atrasadas', value: ts.late, color: STATUS_COLOR.atrasada, foot: ts.late ? `${teamLate.length} tarefa(s) para cobrar` : 'nenhuma atrasada' })}
      ${kpi({ label: 'Em conferência', value: ts.review, color: STATUS_COLOR.aguardando_conferencia, foot: 'aguardando aprovação' })}
      ${kpi({ label: 'Entregas no prazo', value: fmtPct(ts.on_time_pct), color: STATUS_COLOR.concluida, foot: `${ts.on_time} de ${ts.delivered} entregas` })}
      ${kpi({ label: 'Média de execução', value: dec(ts.exec_days_avg), unit: ts.exec_days_avg !== null ? ' dias' : '', color: '#707E8B', foot: `${ts.early || 0} antecipada(s) · ${ts.filling_delays || 0} atraso(s) de preenchimento` })}
    </div>
    <section class="card section"><div class="card-head"><h2>Carga e situação por integrante</h2><span class="sub">barra = tarefas por situação · ordenado por atrasadas</span></div>
      <ul class="rows">${byMember.map(memberRow)}</ul></section>
    <div class="grid grid-dash section">
      <section class="card"><div class="card-head"><h2>${icon('alert')}Atrasadas da equipe</h2><span class="sub">${teamLate.length}</span></div>
        ${teamLate.length ? html`<ul class="rows">${teamLate.slice(0, 8).map(t => taskRow(t, true))}</ul>` : html`<div class="card-body muted">Nenhuma tarefa atrasada na equipe. 👍</div>`}</section>
      <section class="card"><div class="card-head"><h2>${icon('team')}Ranking da equipe</h2><span class="sub">entregas no prazo</span></div>
        <ul class="rows">${[...team].sort((a, b) => (b.stats.on_time_pct ?? -1) - (a.stats.on_time_pct ?? -1)).map((m, i) => userRankRow(m, i))}</ul></section>
    </div>
    ${team.some(m => m.stats.with_due) ? html`<section class="card section"><div class="card-head"><h2>Prazos e repactuações da equipe</h2></div><div class="card-body">
      ${deadlineTable(team.filter(m => m.stats.with_due).map(m => ({ label: m.name, s: m.stats, href: `#/usuarios/${m.id}` })), 'Integrante')}</div></section>` : ''}` : '';

  return {
    title: 'Meu painel',
    html: html`
      ${pageHead({
        eyebrow: 'Meu painel',
        title: `Olá, ${first}`,
        sub: `${open.length} tarefa(s) em aberto · ${late.length} atrasada(s) · ${soon.length} vencendo em 7 dias${team.length ? ` · equipe de ${team.length}` : ''}`,
        actions: html`${sec('dashboard') ? html`<a class="btn btn-ghost" href="#/empresa">${icon('dashboard')}Visão da empresa</a>` : ''}
          <a class="btn btn-ghost" href="#/painel/desempenho">${icon('user')}Meu desempenho completo</a>`,
      })}
      <div class="kpis kpis-6">
        ${kpi({ label: 'Em aberto', value: open.length, color: '#2A3D50', foot: `${s.in_progress} em andamento` })}
        ${kpi({ label: 'Atrasadas', value: late.length, color: STATUS_COLOR.atrasada, foot: late.length && s.avg_delay_days ? `atraso médio ${dec(s.avg_delay_days)} dia(s)` : '' })}
        ${kpi({ label: 'Vencem em 7 dias', value: soon.length, color: '#C99100' })}
        ${kpi({ label: 'Em conferência', value: review.length, color: STATUS_COLOR.aguardando_conferencia })}
        ${kpi({ label: 'Pontualidade', value: fmtPct(s.on_time_pct), color: STATUS_COLOR.concluida, foot: `${s.on_time} de ${s.delivered} entregas` })}
        ${kpi({ label: 'Concluídas', value: s.done, color: '#707E8B', foot: `${s.assigned} atribuídas` })}
      </div>
      ${execKpis(s)}
      ${weekPlanSection(d, { week, canPlan: (d.plan_projects || []).length > 0, firstName: first })}
      <div class="grid grid-dash section">
        <section class="card"><div class="card-head"><h2>${icon('alert')}Minhas atrasadas</h2><span class="sub">${late.length}</span></div>
          ${late.length ? html`<ul class="rows">${late.slice(0, 8).map(t => taskRow(t))}</ul>` : html`<div class="card-body muted">Nenhuma tarefa atrasada. 👍</div>`}</section>
        <section class="card"><div class="card-head"><h2>${icon('calendar')}Próximos 7 dias</h2><span class="sub">${soon.length}</span></div>
          ${soon.length ? html`<ul class="rows">${soon.slice(0, 8).map(t => taskRow(t))}</ul>` : html`<div class="card-body muted">Nada vencendo nos próximos dias.</div>`}</section>
      </div>
      ${vac ? myVacationCard(vac, me) : ''}
      ${reimb ? myReimbCard(reimb) : ''}
      ${checklistSection(d.checklists || [], { title: 'Meus check-lists', linkAll: '' })}
      ${teamSection}`,
    mount(root) {
      bindCommon(root);
      bindChecklistCards(root);
      if (vac) bindMyVacationCard(root, vac, render);
      if (reimb) bindMyReimbCard(root, render);
      bindWeekPlan(root, { d, user: d.user, meta: state.meta, week, render, setWeek: w => setQuery({ semana: w }) });
    },
  };
}
