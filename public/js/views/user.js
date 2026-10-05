// Tela individual do usuário: indicadores, comportamento operacional, tarefas próprias e visão da equipe.
import { html, api, icon, avatar, ROLE, SCOPE, STATUS, STATUS_ORDER, fmtPct } from '../core.js';
import { pageHead, kpi, donut, taskList, bindCommon, fieldListButton, userRankRow, STATUS_COLOR } from './shared.js';
import { deadlineSection, deadlineTable } from './deadlines.js';
import { readOrg, saveOrg, orgControl } from './periods.js';

export async function view({ params, query, setQuery, render, state }) {
  const d = await api(`/users/${params.id}`);
  const u = d.user;
  const s = d.stats;
  const org = readOrg(query);
  const tab = query.get('tab') || 'tarefas';
  const st = query.get('status') || '';
  const isMe = u.id === state.user.id;
  const filtered = st ? d.tasks.filter(t => t.eff_status === st) : d.tasks;
  const fmtDays = v => String(v).replace('.', ',');

  const tabs = [
    ['tarefas', `Tarefas atribuídas (${d.tasks.length})`],
    ...(d.team.length ? [['equipe', `Equipe (${d.team.length})`]] : []),
    ['criadas', `Criadas para outros (${d.created_tasks.length})`],
  ];

  const tabContent = {
    tarefas: html`
      <div class="page-head" style="margin-bottom:10px"><div><h2>Tarefas de ${u.name.split(' ')[0]}</h2><p>${filtered.length} tarefa(s)${st ? ` · ${STATUS[st].label}` : ''}</p></div>
        <div class="page-actions">${fieldListButton(`user=${u.id}${org ? `&org=${org}` : ''}`)}</div></div>
      <div class="chips" role="group" aria-label="Filtrar por status" style="margin-bottom:12px">
        <button class="chip" data-st="" aria-pressed="${!st}">Todas<span class="n">${d.tasks.length}</span></button>
        ${STATUS_ORDER.map(k => html`<button class="chip" data-st="${k}" aria-pressed="${st === k}" style="--c:${STATUS_COLOR[k]}"><span class="dot"></span>${STATUS[k].label}<span class="n">${s.by_status[k]}</span></button>`)}
      </div>
      <div class="result-count"><span></span>${orgControl(org)}</div>
      ${taskList(filtered, { showAssignee: false, empty: 'Nenhuma tarefa atribuída.', groupBy: org })}`,
    equipe: d.team_summary ? html`
      <div class="kpis kpis-5" style="margin-bottom:14px">
        ${kpi({ label: 'Tarefas da equipe', value: d.team_summary.total, color: '#2A3D50' })}
        ${kpi({ label: 'Concluídas', value: d.team_summary.done, color: STATUS_COLOR.concluida, foot: fmtPct(d.team_summary.completion_pct) })}
        ${kpi({ label: 'Atrasadas', value: d.team_summary.late, color: STATUS_COLOR.atrasada })}
        ${kpi({ label: 'Em conferência', value: d.team_summary.review, color: STATUS_COLOR.aguardando_conferencia })}
        ${kpi({ label: 'Entregas no prazo', value: fmtPct(d.team_summary.on_time_pct), color: STATUS_COLOR.concluida })}
      </div>
      <section class="card"><div class="card-head"><h2>Integrantes</h2><span class="sub">as tarefas são de responsabilidade de cada integrante</span></div>
        <ul class="rows">${[...d.team].sort((a, b) => (b.stats.on_time_pct ?? -1) - (a.stats.on_time_pct ?? -1)).map((m, i) => userRankRow({ ...m }, i))}</ul></section>
      <div class="page-head section" style="margin-bottom:10px"><div><h2>Tarefas da equipe</h2><p>${d.team_tasks.length} tarefa(s)</p></div>
        <div class="page-actions"><a class="btn btn-ghost" href="#/imprimir/relatorio?type=equipe&id=${u.id}&level=detalhado">${icon('print')}Relatório da equipe</a></div></div>
      <div class="result-count"><span></span>${orgControl(org)}</div>
      ${taskList(d.team_tasks, { groupBy: org })}` : '',
    criadas: taskList(d.created_tasks, { empty: 'Nenhuma tarefa criada para outros responsáveis.' }),
  };

  return {
    title: u.name,
    html: html`
      ${pageHead({
        back: { href: '#/usuarios', label: 'Usuários' },
        title: '',
      })}
      <section class="card card-pad">
        <div class="profile-head">
          ${avatar(u.name, 'lg')}
          <div style="flex:1;min-width:0">
            <h1>${u.name}</h1>
            <div class="muted">${u.job_title || '—'}</div>
            <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:6px">
              <span class="pill ${u.role === 'admin' ? 'pill-orange' : ''}">${ROLE[u.role]}</span>
              ${u.manager_name ? html`<span class="pill pill-sand">Gestor: ${u.manager_name}</span>` : ''}
              ${d.team.length ? html`<span class="pill pill-sand">${d.team.length} na equipe</span>` : ''}
              ${!u.active ? html`<span class="pill" style="color:var(--st-atrasada)">Inativo</span>` : ''}
            </div>
          </div>
          <div class="page-actions" style="align-self:flex-start">
            ${d.can_edit ? html`<a class="btn btn-ghost btn-sm" href="#/usuarios/${u.id}/editar">${icon('edit')}Editar</a>` : ''}
            ${isMe ? html`<a class="btn btn-ghost btn-sm" href="#/conta">${icon('key')}Minha conta</a>` : ''}
          </div>
        </div>
        ${u.email ? html`<hr class="divider"><dl class="kv"><dt>E-mail</dt><dd>${u.email}</dd>${u.phone ? html`<dt>Telefone</dt><dd>${u.phone}</dd>` : ''}
          ${d.can_edit ? html`<dt>Acesso</dt><dd>${SCOPE[u.access_scope]}</dd>` : ''}</dl>` : ''}
      </section>

      <div class="kpis section">
        ${kpi({ label: 'Pontualidade', value: fmtPct(s.on_time_pct), hero: true, pct: s.on_time_pct ?? 0, foot: `${s.on_time} de ${s.delivered} entregas no prazo` })}
        ${kpi({ label: 'Tarefas atribuídas', value: s.assigned, color: '#2A3D50', foot: `${s.open + s.in_progress} em aberto` })}
        ${kpi({ label: 'Concluídas no prazo', value: s.on_time, color: STATUS_COLOR.concluida, foot: `${s.done} concluídas no total` })}
        ${kpi({ label: 'Atrasadas', value: s.late, color: STATUS_COLOR.atrasada, foot: `${s.late_deliveries} entrega(s) fora do prazo` })}
        ${kpi({ label: 'Média de atraso', value: fmtDays(s.avg_delay_days), unit: ' dias', color: STATUS_COLOR.aguardando_conferencia, foot: 'entregas tardias e atrasos ativos' })}
        ${kpi({ label: 'Origem das tarefas', value: s.self_created, unit: ` próprias`, color: '#707E8B', foot: `${s.assigned_by_manager} atribuídas por gestor · ${s.created_by_user} criadas no total` })}
      </div>

      <div class="grid grid-dash section">
        <section class="card"><div class="card-head"><h2>Distribuição das tarefas</h2></div>
          <div class="card-body">${donut(s.by_status, { linkBase: `#/usuarios/${u.id}`, size: 150 })}</div></section>
        <section class="card"><div class="card-head"><h2>${icon('info')}Resumo do comportamento operacional</h2></div>
          <div class="card-body"><ul class="behavior">${s.behavior.map(b => html`<li>${b}</li>`)}</ul>
          ${d.team_summary ? html`<hr class="divider"><div class="sub-label">Visão de gestor</div>
            <div class="stat-inline"><span>Equipe: <b>${d.team.length}</b> pessoas</span><span><b>${d.team_summary.total}</b> tarefas</span>
            <span><b>${fmtPct(d.team_summary.on_time_pct)}</b> no prazo</span><span style="color:${d.team_summary.late ? STATUS_COLOR.atrasada : ''}"><b style="color:inherit">${d.team_summary.late}</b> atrasadas</span></div>` : ''}
          <div class="page-actions" style="margin-top:14px">
            <a class="btn btn-ghost btn-sm" href="#/imprimir/relatorio?type=usuario&id=${u.id}&level=detalhado">${icon('print')}Relatório individual</a>
          </div></div></section>
      </div>

      ${deadlineSection(s, d.trend, {
        chronicMin: d.chronic_min || 3,
        sub: 'tarefas atribuídas a este usuário',
        extra: d.team.length ? html`<div><div class="sub-label">Equipe sob gestão</div>
          ${deadlineTable(d.team.filter(m => m.stats.with_due).map(m => ({ label: m.name, s: m.stats, href: `#/usuarios/${m.id}` })), 'Integrante')}</div>` : '',
      })}

      <section class="section">
        <div class="tabs" role="tablist">${tabs.map(([k, l]) => html`<button role="tab" data-tab="${k}" aria-selected="${tab === k}">${l}</button>`)}</div>
        ${tabContent[tab] || tabContent.tarefas}
      </section>`,
    mount(root) {
      bindCommon(root);
      root.querySelectorAll('[data-tab]').forEach(b => b.addEventListener('click', () => { setQuery({ tab: b.dataset.tab }); render(); }));
      root.querySelectorAll('[data-st]').forEach(b => b.addEventListener('click', () => { setQuery({ tab: 'tarefas', status: b.dataset.st, org }); render(); }));
      root.querySelectorAll('[data-org]').forEach(b => b.addEventListener('click', () => { saveOrg(b.dataset.org); setQuery({ tab, status: st, org: b.dataset.org }); render(); }));
      root.querySelectorAll(`a[href^="#/usuarios/${u.id}?status="]`).forEach(a => a.addEventListener('click', e => {
        e.preventDefault();
        setQuery({ tab: 'tarefas', status: new URLSearchParams(a.getAttribute('href').split('?')[1]).get('status') });
        render();
      }));
    },
  };
}
