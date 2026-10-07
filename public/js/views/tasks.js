import { html, api, icon, STATUS, STATUS_ORDER, PRIORITY } from '../core.js';
import { sheet } from '../ui.js';
import { pageHead, taskList, bindCommon, STATUS_COLOR, projectOptions } from './shared.js';
import { readOrg, saveOrg, orgControl } from './periods.js';

const DUE = { '': 'Qualquer prazo', vencidas: 'Vencidas', hoje: 'Vencem hoje', '7d': 'Próximos 7 dias', '30d': 'Próximos 30 dias', sem_prazo: 'Sem prazo', reagendadas: 'Reagendadas', ja_atrasadas: 'Ficaram atrasadas alguma vez', corretivas: 'Repactuadas após vencer', cronicas: 'Crônicas (muitos reagendamentos)', concluidas_atraso: 'Concluídas com atraso' };

export async function view({ state, query, setQuery }) {
  const f = {
    q: query.get('q') || '',
    status: query.getAll('status'),
    project: query.get('project') || '',
    assignee: query.get('assignee') || '',
    priority: query.get('priority') || '',
    due: query.get('due') || '',
    nivel: query.get('nivel') || '',
    stage: query.get('stage') || '',
    org: readOrg(query),
    kind: query.get('kind') || '',
    tipo: query.get('tipo') || '',
  };
  // Contagem por status sem o filtro de status (para os chips)
  const [tasks, base, cancelled] = await Promise.all([
    api('/tasks', { query: f }),
    api('/tasks', { query: { ...f, status: [] } }),
    api('/tasks', { query: { ...f, status: ['cancelada'] } }),
  ]);
  const counts = Object.fromEntries(STATUS_ORDER.map(s => [s, base.filter(t => t.eff_status === s).length]));
  const meta = state.meta;
  const advCount = ['project', 'assignee', 'priority', 'due', 'nivel', 'stage', 'kind', 'tipo'].filter(k => f[k]).length;
  const opt = (v, l, cur) => html`<option value="${v}" ${cur === String(v) ? 'selected' : ''}>${l}</option>`;
  // Classificações: do projeto escolhido, ou agrupadas por projeto
  const selProject = meta.projects.find(p => String(p.id) === f.project);
  const stageOptions = selProject
    ? html`${selProject.stages.map(s => opt(s.id, s.name, f.stage))}`
    : html`${meta.projects.filter(p => p.stages.length).map(p => html`<optgroup label="${p.code} · ${p.name}">${p.stages.map(s => opt(s.id, s.name, f.stage))}</optgroup>`)}`;

  return {
    title: 'Tarefas',
    html: html`
      ${pageHead({
        eyebrow: 'Execução e pendências',
        title: 'Tarefas',
        sub: 'Busque, filtre e acompanhe as tarefas de todos os projetos liberados para você.',
        actions: html`
          ${f.project ? html`<a class="btn btn-ghost" href="#/imprimir/campo?project=${f.project}${f.stage ? `&stage=${f.stage}` : ''}">${icon('checklist')}Lista de campo</a>` : ''}
          ${f.assignee && f.assignee !== 'none' && !f.project ? html`<a class="btn btn-ghost" href="#/imprimir/campo?user=${f.assignee === 'me' ? state.user.id : f.assignee}">${icon('checklist')}Lista de campo</a>` : ''}
          <button type="button" class="btn btn-ghost" id="emit-report">${icon('reports')}Emitir relatório</button>
          <a class="btn btn-ghost" href="#/recorrencias${f.project ? `?project=${f.project}` : ''}">${icon('history')}Recorrentes</a>
          <a class="btn btn-ghost" href="#/tarefas/nova?tipo=checklist${f.project ? `&projeto=${f.project}` : ''}">${icon('checklist')}Novo check-list</a>
          <a class="btn btn-accent" href="#/tarefas/nova${f.project ? `?projeto=${f.project}` : ''}">${icon('plus')}Nova tarefa</a>`,
      })}
      <form class="toolbar" id="filters" role="search">
        <div style="display:flex;gap:8px">
          <label class="search" style="flex:1">${icon('search')}<span class="sr-only">Buscar</span>
            <input type="search" name="q" value="${f.q}" placeholder="Buscar por código, título, projeto ou responsável" autocomplete="off"></label>
          <button type="button" class="btn btn-ghost filters-toggle" id="toggle-adv" aria-expanded="${advCount > 0}">${icon('filter')}${advCount ? `Filtros (${advCount})` : 'Filtros'}</button>
        </div>
        <div class="chips" role="group" aria-label="Filtrar por status">
          <button type="button" class="chip" data-st="" aria-pressed="${!f.status.length}">Todas<span class="n">${base.length}</span></button>
          ${STATUS_ORDER.map(s => html`<button type="button" class="chip" data-st="${s}" aria-pressed="${f.status.includes(s)}" style="--c:${STATUS_COLOR[s]}"><span class="dot"></span>${STATUS[s].label}<span class="n">${counts[s]}</span></button>`)}
          ${cancelled.length || f.status.includes('cancelada') ? html`<button type="button" class="chip chip-cancel" data-st="cancelada" aria-pressed="${f.status.includes('cancelada')}" style="--c:#5D6670" title="Canceladas não entram em indicadores nem relatórios"><span class="dot"></span>Canceladas<span class="n">${cancelled.length}</span></button>` : ''}
        </div>
        <div class="filters-adv" id="adv" ${advCount ? '' : 'hidden'}>
          <select name="project" aria-label="Projeto">${opt('', 'Todos os projetos', f.project)}${projectOptions(meta.projects, f.project, opt)}</select>
          <select name="assignee" aria-label="Responsável">${opt('', 'Todos os responsáveis', f.assignee)}${opt('me', 'Minhas tarefas', f.assignee)}${opt('none', 'Sem responsável', f.assignee)}${meta.assignees.map(u => opt(u.id, u.name, f.assignee))}</select>
          <select name="due" aria-label="Prazo">${Object.entries(DUE).map(([k, l]) => opt(k, l, f.due))}</select>
          <select name="priority" aria-label="Prioridade">${opt('', 'Todas as prioridades', f.priority)}${Object.entries(PRIORITY).map(([k, l]) => opt(k, l, f.priority))}</select>
          <select name="stage" aria-label="Classificação">${opt('', 'Todas as classificações', f.stage)}${stageOptions}</select>
          ${meta.projects.some(p => p.kind === 'interno') ? html`<select name="kind" aria-label="Obras ou interno">${opt('', 'Obras e interno', f.kind)}${opt('obra', 'Somente obras', f.kind)}${opt('interno', 'Somente interno (empresa)', f.kind)}</select>` : ''}
          <select name="tipo" aria-label="Tarefas ou check-lists">${opt('', 'Tarefas e check-lists', f.tipo)}${opt('tarefa', 'Somente tarefas', f.tipo)}${opt('checklist', 'Somente check-lists', f.tipo)}</select>
          <select name="nivel" aria-label="Tipo">${opt('', 'Tarefas e subtarefas', f.nivel)}${opt('principais', 'Somente tarefas principais', f.nivel)}${opt('subtarefas', 'Somente subtarefas', f.nivel)}</select>
          ${advCount || f.q || f.status.length ? html`<button type="button" class="btn btn-ghost btn-sm" id="clear">${icon('x')}Limpar</button>` : ''}
        </div>
      </form>
      <div class="result-count"><span>${tasks.length} ${tasks.length === 1 ? 'tarefa' : 'tarefas'}${f.org ? ' · organizadas pelo prazo' : ''}</span>${orgControl(f.org)}</div>
      ${taskList(tasks, { groupBy: f.org })}
      <a class="fab" href="#/tarefas/nova${f.project ? `?projeto=${f.project}` : ''}" aria-label="Nova tarefa">${icon('plus')}</a>`,
    mount(root, ctx) {
      bindCommon(root);
      const form = root.querySelector('#filters');
      form.addEventListener('submit', e => e.preventDefault());
      const apply = patch => { setQuery({ ...f, ...patch }); ctx.render(); };
      root.querySelectorAll('[data-org]').forEach(b => b.addEventListener('click', () => { saveOrg(b.dataset.org); apply({ org: b.dataset.org }); }));
      let timer;
      const qInput = form.q;
      qInput.addEventListener('input', () => {
        clearTimeout(timer);
        timer = setTimeout(() => apply({ q: qInput.value.trim() }), 350);
      });
      if (f.q) { qInput.focus(); qInput.setSelectionRange(qInput.value.length, qInput.value.length); }
      root.querySelectorAll('[data-st]').forEach(b => b.addEventListener('click', () => {
        const s = b.dataset.st;
        if (!s) return apply({ status: [] });
        const set = new Set(f.status);
        set.has(s) ? set.delete(s) : set.add(s);
        apply({ status: [...set] });
      }));
      // Ao trocar de projeto, a classificação anterior (de outro projeto) deixa de valer
      form.querySelectorAll('select').forEach(sel => sel.addEventListener('change', () =>
        apply(sel.name === 'project' ? { project: sel.value, stage: '' } : { [sel.name]: sel.value })));
      root.querySelector('#toggle-adv').addEventListener('click', e => {
        const adv = root.querySelector('#adv');
        adv.hidden = !adv.hidden;
        e.currentTarget.setAttribute('aria-expanded', String(!adv.hidden));
      });
      // Relatório A4 com exatamente os filtros aplicados na lista
      root.querySelector('#emit-report').addEventListener('click', async () => {
        const reportable = tasks.filter(t => t.eff_status !== 'cancelada').length;
        const LV = [['resumo', 'Resumo', 'Indicadores e panorama'], ['detalhado', 'Detalhado', 'Indicadores + lista das tarefas'], ['completo', 'Completo com fotos', 'Tudo + registros, fotos e PDFs']];
        const GR = [['classificacao', 'Por classificação'], ['nenhum', 'Por status e prazo'], ['dia', 'Por dia'], ['semana', 'Por semana'], ['mes', 'Por mês']];
        const r = await sheet({
          title: 'Emitir relatório das tarefas',
          submitLabel: 'Gerar relatório',
          body: html`<p class="muted" style="margin:0 0 10px">${reportable} ${reportable === 1 ? 'tarefa' : 'tarefas'} com os filtros atuais${f.status.includes('cancelada') ? ' (canceladas não entram em relatórios)' : ''}.</p>
            <div class="field"><span class="label">Nível de detalhe</span>
              <div class="segmented seg-3">${LV.map(([k, l, d]) => html`<label><input type="radio" name="level" value="${k}" ${k === 'detalhado' ? 'checked' : ''}>${l}<small>${d}</small></label>`)}</div></div>
            <div class="field"><label for="rg">Organização</label>
              <select id="rg" name="group">${GR.map(([k, l]) => opt(k, l, f.org || 'classificacao'))}</select></div>
            <label class="switch"><input type="checkbox" name="gantt" checked>Incluir cronograma (Gantt)</label>`,
        });
        if (!r) return;
        const qs = new URLSearchParams({ type: 'tarefas', level: r.level, group: r.group });
        if (!r.gantt) qs.set('gantt', '0');
        for (const k of ['q', 'project', 'assignee', 'priority', 'due', 'nivel', 'stage', 'kind', 'tipo']) if (f[k]) qs.set(k, f[k]);
        const st = f.status.filter(s => s !== 'cancelada');
        if (st.length) qs.set('status', st.join(','));
        ctx.navigate(`/imprimir/relatorio?${qs}`);
      });
      root.querySelector('#clear')?.addEventListener('click', () => apply({ q: '', status: [], project: '', assignee: '', priority: '', due: '', nivel: '', stage: '', kind: '', tipo: '' }));
    },
  };
}
