import { html, api, icon, PROJECT_STATUS, STATUS, STATUS_ORDER, fmtDate, fmtPct, progress, avatar } from '../core.js';
import { pageHead, kpiBlock, donut, taskList, bindCommon, fieldListButton, STATUS_COLOR } from './shared.js';
import { deadlineSection, deadlineTable } from './deadlines.js';
import { readOrg, saveOrg, orgControl } from './periods.js';
import { recurrenceRows } from './recurrences.js';
import { checklistSection, bindChecklistCards } from './checklist-cards.js';
import { impactRankingSection } from './deps-ui.js';

export async function view({ params, query, setQuery, render }) {
  const [p, impactRank] = await Promise.all([api(`/projects/${params.id}`), api('/impact-ranking', { query: { project: params.id } }).catch(() => [])]);
  const active = query.get('status') || '';
  const org = readOrg(query);
  const stage = Number(query.get('stage')) || 0;
  const stageObj = p.stages.find(s => s.id === stage);
  const inStage = stage ? p.tasks.filter(t => t.stage_id === stage) : p.tasks;
  const tasks = active ? inStage.filter(t => t.eff_status === active) : inStage;
  const stageCounts = Object.fromEntries(STATUS_ORDER.map(s => [s, inStage.filter(t => t.eff_status === s).length]));
  const usedStages = p.stages.filter(s => s.summary.total || !s.is_default);
  const daysLeft = p.end_date ? Math.round((Date.parse(p.end_date) - Date.now()) / 86400e3) : null;
  const elapsed = p.start_date && p.end_date
    ? Math.max(0, Math.min(100, Math.round(((Date.now() - Date.parse(p.start_date)) / (Date.parse(p.end_date) - Date.parse(p.start_date))) * 100)))
    : null;

  return {
    title: `${p.code} · ${p.name}`,
    html: html`
      ${pageHead({
        back: { href: '#/projetos', label: 'Projetos' },
        eyebrow: p.kind === 'interno' ? `${p.code} · Interno (empresa)` : `${p.code} · ${PROJECT_STATUS[p.status]}`,
        title: p.name,
        sub: `${p.client}${p.location ? ` · ${p.location}` : ''}`,
        actions: html`
          ${p.can_edit ? html`<a class="btn btn-ghost" href="#/projetos/${p.id}/editar">${icon('edit')}Editar</a>` : ''}
          <a class="btn btn-ghost" href="#/imprimir/relatorio?type=projeto&id=${p.id}&level=detalhado">${icon('print')}Relatório</a>
          ${p.can_create_task ? html`<a class="btn btn-primary" href="#/tarefas/nova?projeto=${p.id}">${icon('plus')}Nova tarefa</a>` : ''}`,
      })}

      ${kpiBlock(p.summary)}
      ${checklistSection(p.checklists || [], { title: 'Check-lists do projeto', linkAll: `#/tarefas?tipo=checklist&project=${p.id}` })}

      <div class="grid grid-dash section">
        <section class="card">
          <div class="card-head"><h2>Andamento</h2></div>
          <div class="card-body" style="display:grid;gap:16px">
            ${donut(p.summary.by_status, { linkBase: `#/projetos/${p.id}`, size: 150 })}
            <div>
              <div class="sub-label">Prazo do projeto</div>
              <div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:6px"><span>${fmtDate(p.start_date)}</span>
                <b>${daysLeft === null ? '—' : daysLeft >= 0 ? `${daysLeft} dias restantes` : `${-daysLeft} dias além do previsto`}</b><span>${fmtDate(p.end_date)}</span></div>
              ${elapsed !== null ? html`${progress(elapsed, 'Tempo decorrido')}<div class="muted" style="font-size:12px;margin-top:4px">${elapsed}% do prazo decorrido · ${fmtPct(p.summary.completion_pct ?? 0)} das tarefas concluídas</div>` : ''}
            </div>
            <dl class="kv">
              <dt>Responsável técnico</dt><dd>${p.lead_name || '—'}</dd>
              <dt>Equipe</dt><dd>${p.members.map(m => m.name).join(', ') || '—'}</dd>
              ${p.actual_end_date ? html`<dt>Término real</dt><dd>${fmtDate(p.actual_end_date)}</dd>` : ''}
            </dl>
            ${p.description ? html`<div><div class="sub-label">Escopo</div><div class="text-content" style="font-size:14px">${p.description}</div></div>` : ''}
          </div>
        </section>
        <section class="card">
          <div class="card-head"><h2>Desempenho por responsável</h2><span class="sub">neste projeto</span></div>
          <ul class="rows">${p.people.map(u => html`<li>${u.id ? html`<a class="row-link" href="#/usuarios/${u.id}">${personRow(u)}</a>` : html`<div class="row-link">${personRow(u)}</div>`}</li>`)}</ul>
          ${!p.people.length ? html`<div class="card-body muted">Sem tarefas atribuídas.</div>` : ''}
        </section>
      </div>

      ${usedStages.length > 1 || (usedStages.length === 1 && !usedStages[0].is_default) ? html`<section class="card section">
        <div class="card-head"><h2>Andamento por classificação</h2><span class="sub">Grupo / Local / Etapa · toque para filtrar</span></div>
        <ul class="rows">${usedStages.map(s => html`<li><button type="button" class="row-link proj-row stage-row ${stage === s.id ? 'is-active' : ''}" data-stage="${stage === s.id ? '' : s.id}">
          <div class="grow"><div class="row-title"><span class="stage-tag">${s.name}</span>${s.is_default ? html`<span class="muted" style="font-size:12px">sem classificação específica</span>` : ''}</div>
            ${progress(s.summary.completion_pct ?? 0, `Conclusão de ${s.name}`)}
            <div class="proj-stats"><span><b>${s.summary.total}</b> tarefas</span><span><b>${s.summary.in_progress}</b> em andamento</span>
              <span style="color:${s.summary.late ? STATUS_COLOR.atrasada : ''}"><b style="color:inherit">${s.summary.late}</b> atrasadas</span><span><b>${s.summary.done}</b> concluídas</span></div></div>
          <div class="proj-pct">${fmtPct(s.summary.completion_pct ?? 0)}</div></button></li>`)}</ul>
      </section>` : ''}

      ${impactRankingSection(impactRank, { sub: 'neste projeto' })}
      ${deadlineSection(p.summary, p.trend, {
        chronicMin: p.chronic_min || 3,
        sub: 'neste projeto',
        extra: usedStages.length > 1 ? html`<div><div class="sub-label">Por classificação (Grupo/Local/Etapa)</div>
          ${deadlineTable(usedStages.filter(s => s.summary.with_due).map(s => ({ label: s.name, s: s.summary })), 'Classificação')}</div>` : '',
      })}

      <section class="card section">
        <div class="card-head"><h2>${icon('history')}Tarefas recorrentes</h2>
          <a class="sub" href="#/recorrencias?project=${p.id}">${p.recurrences.filter(r => r.active).length} ativa(s) · ver todas</a></div>
        ${p.recurrences.filter(r => r.active).length ? recurrenceRows(p.recurrences.filter(r => r.active).slice(0, 5))
          : html`<div class="card-body muted" style="font-size:13.5px">Nenhuma tarefa recorrente ativa. Para criar, use <b>Nova tarefa</b> e ative <b>Repetir esta tarefa</b>.</div>`}
      </section>

      <section class="section" id="proj-tasks">
        <div class="page-head" style="margin-bottom:10px">
          <div><h2>Tarefas do projeto</h2><p>${tasks.length} de ${p.tasks.length} tarefas${p.cancelled_count ? html` · <a href="#/tarefas?project=${p.id}&status=cancelada">${p.cancelled_count} cancelada(s)</a>` : ''}${stageObj ? ` · classificação: ${stageObj.name}` : ''}${active ? ` · filtro: ${STATUS[active].label}` : ''}</p></div>
          <div class="page-actions">${fieldListButton(`project=${p.id}${stage ? `&stage=${stage}` : ''}${org ? `&org=${org}` : ''}`)}</div>
        </div>
        ${p.stages.length > 1 ? html`<div class="filters-adv" style="display:grid;grid-template-columns:minmax(0,320px);margin-bottom:10px">
          <select id="stage-filter" aria-label="Filtrar por classificação"><option value="">Todas as classificações</option>
            ${p.stages.map(s => html`<option value="${s.id}" ${stage === s.id ? 'selected' : ''}>${s.name} (${s.summary.total})</option>`)}</select></div>` : ''}
        <div class="chips" role="group" aria-label="Filtrar por status" style="margin-bottom:12px">
          <button class="chip" data-st="" aria-pressed="${!active}">Todas<span class="n">${inStage.length}</span></button>
          ${STATUS_ORDER.map(s => html`<button class="chip" data-st="${s}" aria-pressed="${active === s}" style="--c:${STATUS_COLOR[s]}"><span class="dot"></span>${STATUS[s].label}<span class="n">${stageCounts[s]}</span></button>`)}
        </div>
        <div class="result-count" style="margin-top:-2px"><span></span>${orgControl(org)}</div>
        ${taskList(tasks, { showProject: false, groupBy: org })}
      </section>
      ${p.can_create_task ? html`<a class="fab" href="#/tarefas/nova?projeto=${p.id}" aria-label="Nova tarefa">${icon('plus')}</a>` : ''}`,
    mount(root) {
      bindCommon(root);
      bindChecklistCards(root);
      root.querySelectorAll('[data-st]').forEach(b => b.addEventListener('click', () => { setQuery({ status: b.dataset.st, stage: stage || '', org }); render(); }));
      root.querySelectorAll('[data-org]').forEach(b => b.addEventListener('click', () => {
        saveOrg(b.dataset.org);
        setQuery({ status: active, stage: stage || '', org: b.dataset.org });
        render().then(() => document.getElementById('proj-tasks')?.scrollIntoView({ block: 'start' }));
      }));
      const goStage = v => { setQuery({ status: active, stage: v }); render().then(() => document.getElementById('proj-tasks')?.scrollIntoView({ block: 'start' })); };
      root.querySelector('#stage-filter')?.addEventListener('change', e => goStage(e.target.value));
      root.querySelectorAll('[data-stage]').forEach(b => b.addEventListener('click', () => goStage(b.dataset.stage)));
      // Links da rosca/legenda filtram a lista dentro do próprio projeto
      root.querySelectorAll(`a[href^="#/projetos/${p.id}?status="]`).forEach(a => a.addEventListener('click', e => {
        e.preventDefault();
        setQuery({ status: new URLSearchParams(a.getAttribute('href').split('?')[1]).get('status'), stage: stage || '' });
        render();
      }));
    },
  };
}

const personRow = u => html`${avatar(u.name, 'sm')}<div class="grow"><div class="row-title">${u.name}</div>
  <div class="row-meta"><span>${u.summary.total} tarefas</span><span>${u.summary.done} concluídas</span>
  <span style="color:${u.summary.late ? STATUS_COLOR.atrasada : ''}">${u.summary.late} atrasadas</span><span>${fmtPct(u.summary.on_time_pct)} no prazo</span></div></div>
  <b style="font-variant-numeric:tabular-nums">${fmtPct(u.summary.completion_pct ?? 0)}</b>`;
