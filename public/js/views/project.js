import { html, api, icon, PROJECT_STATUS, STATUS, STATUS_ORDER, fmtDate, fmtPct, progress, avatar } from '../core.js';
import { pageHead, kpiBlock, donut, taskList, bindCommon, fieldListButton, STATUS_COLOR } from './shared.js';

export async function view({ params, query, setQuery, render }) {
  const p = await api(`/projects/${params.id}`);
  const active = query.get('status') || '';
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
        eyebrow: `${p.code} · ${PROJECT_STATUS[p.status]}`,
        title: p.name,
        sub: `${p.client}${p.location ? ` · ${p.location}` : ''}`,
        actions: html`
          ${p.can_edit ? html`<a class="btn btn-ghost" href="#/projetos/${p.id}/editar">${icon('edit')}Editar</a>` : ''}
          <a class="btn btn-ghost" href="#/imprimir/relatorio?type=projeto&id=${p.id}&level=detalhado">${icon('print')}Relatório</a>
          ${p.can_create_task ? html`<a class="btn btn-primary" href="#/tarefas/nova?projeto=${p.id}">${icon('plus')}Nova tarefa</a>` : ''}`,
      })}

      ${kpiBlock(p.summary)}

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

      <section class="section" id="proj-tasks">
        <div class="page-head" style="margin-bottom:10px">
          <div><h2>Tarefas do projeto</h2><p>${tasks.length} de ${p.tasks.length} tarefas${stageObj ? ` · classificação: ${stageObj.name}` : ''}${active ? ` · filtro: ${STATUS[active].label}` : ''}</p></div>
          <div class="page-actions">${fieldListButton(`project=${p.id}${stage ? `&stage=${stage}` : ''}`)}</div>
        </div>
        ${p.stages.length > 1 ? html`<div class="filters-adv" style="display:grid;grid-template-columns:minmax(0,320px);margin-bottom:10px">
          <select id="stage-filter" aria-label="Filtrar por classificação"><option value="">Todas as classificações</option>
            ${p.stages.map(s => html`<option value="${s.id}" ${stage === s.id ? 'selected' : ''}>${s.name} (${s.summary.total})</option>`)}</select></div>` : ''}
        <div class="chips" role="group" aria-label="Filtrar por status" style="margin-bottom:12px">
          <button class="chip" data-st="" aria-pressed="${!active}">Todas<span class="n">${inStage.length}</span></button>
          ${STATUS_ORDER.map(s => html`<button class="chip" data-st="${s}" aria-pressed="${active === s}" style="--c:${STATUS_COLOR[s]}"><span class="dot"></span>${STATUS[s].label}<span class="n">${stageCounts[s]}</span></button>`)}
        </div>
        ${taskList(tasks, { showProject: false })}
      </section>
      ${p.can_create_task ? html`<a class="fab" href="#/tarefas/nova?projeto=${p.id}" aria-label="Nova tarefa">${icon('plus')}</a>` : ''}`,
    mount(root) {
      bindCommon(root);
      root.querySelectorAll('[data-st]').forEach(b => b.addEventListener('click', () => { setQuery({ status: b.dataset.st, stage: stage || '' }); render(); }));
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
