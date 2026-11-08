import { html, api, icon, PROJECT_STATUS, STATUS, STATUS_ORDER, fmtDate, fmtPct, progress, avatar } from '../core.js';
import { quotesCard } from './quotes.js';
import { evaluateAlerts, alertMap, alertsBanner, alertsSheet } from './project-alerts.js';
import { pageHead, kpi, kpiBlock, donut, taskList, bindCommon, fieldListButton, STATUS_COLOR, execKpis, execInline, scheduleLine } from './shared.js';
import { deadlineSection, deadlineTable } from './deadlines.js';
import { readOrg, saveOrg, orgControl } from './periods.js';
import { recurrenceRows } from './recurrences.js';
import { checklistSection, bindChecklistCards } from './checklist-cards.js';
import { impactRankingSection } from './deps-ui.js';
import { ganttSection, bindGanttSections } from './gantt.js';
import { calendarSheet } from './calendar-ui.js';
import { recordsCard, bindRecordsCard } from './records.js';
import { addPdfButtons } from '../section-pdf.js';
import { evolutionSection, bindEvolution } from './evolution.js';

// Listas da página do projeto ficam recolhidas: o cabeçalho diz o que há dentro e sinaliza o que é importante; um clique abre
const fold = (key, sum, flag, content) => (content && String(content).trim() ? html`<div class="pf-wrap" data-fold="${key}" data-fold-sum="${sum}" data-fold-flag="${flag || ''}">${content}</div>` : '');
function bindFolds(root, projectId) {
  const SK = k => `charao-fold-${projectId}-${k}`;
  root.querySelectorAll('[data-fold]').forEach(w => {
    const card = w.firstElementChild;
    const head = card?.querySelector(':scope > .card-head');
    if (!card || !head) return;
    card.classList.add('fold-card');
    const key = w.dataset.fold;
    let open = false;
    try { open = sessionStorage.getItem(SK(key)) === '1'; } catch { /* sem armazenamento */ }
    const info = document.createElement('span');
    info.className = 'fold-info';
    info.innerHTML = `${w.dataset.foldFlag ? `<span class="fold-flag">${w.dataset.foldFlag}</span>` : ''}<span class="fold-sum">${w.dataset.foldSum}</span><span class="fold-chev" aria-hidden="true"></span>`;
    head.querySelector('h2')?.after(info);
    head.setAttribute('role', 'button');
    head.tabIndex = 0;
    const set = v => { open = v; card.classList.toggle('is-open', open); head.setAttribute('aria-expanded', String(open)); try { sessionStorage.setItem(SK(key), open ? '1' : '0'); } catch { /* sem armazenamento */ } };
    set(open);
    head.addEventListener('click', e => { if (e.target.closest('a,button,select,input')) return; set(!open); });
    head.addEventListener('keydown', e => { if ((e.key === 'Enter' || e.key === ' ') && e.target === head) { e.preventDefault(); set(!open); } });
  });
}

export async function view({ params, query, setQuery, render, navigate }) {
  const [p, impactRank, recs, quotes, alertConf] = await Promise.all([api(`/projects/${params.id}`), api('/impact-ranking', { query: { project: params.id } }).catch(() => []),
    api(`/projects/${params.id}/records`).catch(() => null), api(`/projects/${params.id}/quotes/summary`).catch(() => null), api(`/projects/${params.id}/alerts`).catch(() => ({ alerts: [] }))]);
  // Alertas dos indicadores (limites definidos neste projeto)
  const alerts = evaluateAlerts(p, quotes, alertConf);
  const alertsBy = alertMap(alerts);
  const qOk = quotes?.enabled;
  const plural = (n, a, b) => `${n} ${n === 1 ? a : b}`;
  const clOpen = (p.checklists || []).filter(c => c.eff_status !== 'concluida');
  const clNc = clOpen.reduce((n, c) => n + (c.nc_open || 0), 0);
  const clLate = clOpen.filter(c => c.eff_status === 'atrasada').length;
  const rs = recs?.summary;
  const stLate = p.stages.filter(s => s.summary.total || !s.is_default).reduce((n, s) => n + (s.summary.late || 0), 0);
  const impEnd = (impactRank || []).filter(r => r.project_end_days > 0).length;
  const pplLate = p.people.filter(u => u.summary.late).length;
  const qPct = qOk && quotes.items ? Math.round((quotes.buckets.tres / quotes.items) * 100) : null;
  const qWorst = ['cot_tres_pct', 'cot_sem', 'cot_vencidas'].map(k => alertsBy[k]).filter(Boolean).sort((a, b) => (a.level === b.level ? 0 : a.level === 'crit' ? -1 : 1))[0];
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
        eyebrow: p.kind === 'interno' ? `${p.code} · Interno (empresa)` : `${p.code}${p.type_name ? ` · ${p.type_name}` : ''} · ${PROJECT_STATUS[p.status]}`,
        title: p.name,
        sub: `${p.client}${p.location ? ` · ${p.location}` : ''}`,
        actions: html`
          ${p.can_edit ? html`<a class="btn btn-ghost" href="#/projetos/${p.id}/editar">${icon('edit')}Editar</a>` : ''}
          <a class="btn btn-ghost" href="#/imprimir/relatorio?type=projeto&id=${p.id}&level=detalhado">${icon('print')}Relatório</a>
          <a class="btn btn-ghost" href="#/imprimir/historia/${p.id}">${icon('history')}História</a>
          <a class="btn btn-ghost" href="#/projetos/${p.id}/vinculos">${icon('share')}Mapa de vínculos</a>
          <button type="button" class="btn btn-ghost" data-cal-open>${icon('calendar')}Calendário</button>
          ${alertConf?.can_edit ? html`<button type="button" class="btn btn-ghost" data-pa-edit>${icon('alert')}Alertas</button>` : ''}
          ${p.can_create_task ? html`<a class="btn btn-ghost" href="#/projetos/${p.id}/importar">${icon('file')}Importar planejamento</a><a class="btn btn-primary" href="#/tarefas/nova?projeto=${p.id}">${icon('plus')}Nova tarefa</a>` : ''}`,
      })}

      ${p.schedule ? html`<section class="card section sch-card"><div class="card-head"><h2>${icon('calendar')}Prazo do projeto</h2><span class="sub">pelas tarefas e subtarefas</span></div>
        <div class="card-body"><div class="stat-inline sch-line">${scheduleLine(p)}</div>
          ${p.schedule.impacting.length ? html`<details class="sch-det"><summary>Tarefas reagendadas que mudaram o fim do projeto (prazo original ${fmtDate(p.schedule.end_original)})</summary>
            <ul>${p.schedule.impacting.map(x => html`<li><a href="#/tarefas/${x.id}"><span class="mono">${x.code}</span> ${x.title}</a><b class="${x.days > 0 ? 'is-late' : 'is-early'}">${x.days > 0 ? `+${x.days}` : x.days} d</b></li>`)}</ul></details>`
            : html`<p class="muted" style="margin:6px 0 0;font-size:12.5px">${p.schedule.rescheduled_tasks ? `${p.schedule.rescheduled_tasks} tarefa(s) reagendada(s), sem mudar o fim do projeto.` : 'Nenhum reagendamento mudou o fim do projeto.'}</p>`}</div></section>` : ''}
      ${alertsBanner(alerts, alertConf, alertConf?.can_edit)}
      ${kpiBlock(p.summary, { alerts: alertsBy })}
      ${execKpis(p.summary, { alerts: alertsBy, extra: qOk ? kpi({ alert: qWorst, label: 'Cotações com 3+ propostas', value: qPct === null ? '—' : `${qPct}%`, href: `#/projetos/${p.id}/cotacoes`, color: '#3B6D11',
        foot: quotes.items ? `${quotes.buckets.tres} de ${quotes.items} itens · ${quotes.buckets.nenhuma} sem proposta${quotes.requests.vencida ? ` · ${quotes.requests.vencida} solicitação(ões) vencida(s)` : ''}` : 'nenhum item cadastrado ainda' }) : '' })}
      ${qOk ? quotesCard(quotes, p.id) : ''}
      ${recs ? fold('registros', rs ? `${plural(rs.total, 'registro', 'registros')} · ${plural(rs.vigentes, 'definição vigente', 'definições vigentes')}${rs.open ? ` · ${plural(rs.open, 'pendência', 'pendências')}` : ''}` : '', rs?.late ? `${plural(rs.late, 'pendência atrasada', 'pendências atrasadas')}` : '', recordsCard(recs)) : ''}
      ${fold('checklists', `${plural(clOpen.length, 'check-list em andamento', 'check-lists em andamento')} · ${(p.checklists || []).length - clOpen.length} concluído(s)`, [clNc ? `${clNc} NC em aberto` : '', clLate ? `${plural(clLate, 'atrasado', 'atrasados')}` : ''].filter(Boolean).join(' · '), checklistSection(p.checklists || [], { title: 'Check-lists do projeto', linkAll: `#/tarefas?tipo=checklist&project=${p.id}` }))}

      <div class="grid grid-dash grid-one section">
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
      </div>

      ${evolutionSection({ scope: 'projeto', id: p.id, sub: 'neste projeto' })}
      ${fold('desempenho', plural(p.people.length, 'pessoa', 'pessoas'), pplLate ? `${plural(pplLate, 'pessoa com atraso', 'pessoas com atraso')}` : '', html`<section class="card section">
        <div class="card-head"><h2>Desempenho por responsável</h2><span class="sub">neste projeto</span></div>
        <ul class="rows">${p.people.map(u => html`<li>${u.id ? html`<a class="row-link" href="#/usuarios/${u.id}">${personRow(u)}</a>` : html`<div class="row-link">${personRow(u)}</div>`}</li>`)}</ul>
        ${!p.people.length ? html`<div class="card-body muted">Sem tarefas atribuídas.</div>` : ''}
      </section>`)}

      ${usedStages.length > 1 || (usedStages.length === 1 && !usedStages[0].is_default) ? fold('classificacao', plural(usedStages.length, 'classificação', 'classificações'), stLate ? `${plural(stLate, 'tarefa atrasada', 'tarefas atrasadas')}` : '', html`<section class="card section">
        <div class="card-head"><h2>Andamento por classificação</h2><span class="sub">Grupo / Local / Etapa · toque para filtrar</span></div>
        <ul class="rows">${usedStages.map(s => html`<li><button type="button" class="row-link proj-row stage-row ${stage === s.id ? 'is-active' : ''}" data-stage="${stage === s.id ? '' : s.id}">
          <div class="grow"><div class="row-title"><span class="stage-tag">${s.name}</span>${s.is_default ? html`<span class="muted" style="font-size:12px">sem classificação específica</span>` : ''}</div>
            ${progress(s.summary.completion_pct ?? 0, `Conclusão de ${s.name}`)}
            <div class="proj-stats"><span><b>${s.summary.total}</b> tarefas</span><span><b>${s.summary.in_progress}</b> em andamento</span>
              <span style="color:${s.summary.late ? STATUS_COLOR.atrasada : ''}"><b style="color:inherit">${s.summary.late}</b> atrasadas</span><span><b>${s.summary.done}</b> concluídas</span></div>
            ${execInline(s.summary)}</div>
          <div class="proj-pct">${fmtPct(s.summary.completion_pct ?? 0)}</div></button></li>`)}</ul>
      </section>`) : ''}

      ${ganttSection({ id: `p${p.id}`, url: `/gantt?project=${p.id}`, sub: 'tarefas do projeto por classificação · setas = dependências · vermelho = caminho crítico' })}
      ${fold('impacto', plural((impactRank || []).length, 'tarefa causou atrasos em outras', 'tarefas causaram atrasos em outras'), impEnd ? `${impEnd} ${impEnd === 1 ? 'empurrou' : 'empurraram'} o fim do projeto` : '', impactRankingSection(impactRank, { sub: 'neste projeto' }))}
      ${deadlineSection(p.summary, p.trend, {
        link: { scope: 'projeto', id: p.id },
        distBy: p.dist_by,
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
      bindEvolution(root);
      // Botão "PDF" em cada quadro: imprime só aquele visual
      addPdfButtons(root, { title: `${p.code} · ${p.name}`, sub: p.client });
      bindGanttSections(root, url => api(url));
      root.querySelector('[data-cal-open]')?.addEventListener('click', () => calendarSheet(p));
      if (recs) bindRecordsCard(root, recs, navigate);
      bindChecklistCards(root);
      bindFolds(root, p.id);
      root.querySelectorAll('[data-pa-edit]').forEach(b => b.addEventListener('click', () => alertsSheet(p, quotes, alertConf, () => render())));
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

const personRow = u => html`${avatar(u.name, 'sm', u.id)}<div class="grow"><div class="row-title">${u.name}</div>
  <div class="row-meta"><span>${u.summary.total} tarefas</span><span>${u.summary.done} concluídas</span>
  <span style="color:${u.summary.late ? STATUS_COLOR.atrasada : ''}">${u.summary.late} atrasadas</span><span>${fmtPct(u.summary.on_time_pct)} no prazo</span></div>
  ${execInline(u.summary)}</div>
  <b style="font-variant-numeric:tabular-nums">${fmtPct(u.summary.completion_pct ?? 0)}</b>`;
