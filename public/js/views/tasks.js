import { html, api, icon, STATUS, STATUS_ORDER, PRIORITY } from '../core.js';
import { pageHead, taskList, bindCommon, STATUS_COLOR } from './shared.js';
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
  };
  // Contagem por status sem o filtro de status (para os chips)
  const [tasks, base] = await Promise.all([
    api('/tasks', { query: f }),
    api('/tasks', { query: { ...f, status: [] } }),
  ]);
  const counts = Object.fromEntries(STATUS_ORDER.map(s => [s, base.filter(t => t.eff_status === s).length]));
  const meta = state.meta;
  const advCount = ['project', 'assignee', 'priority', 'due', 'nivel', 'stage'].filter(k => f[k]).length;
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
        </div>
        <div class="filters-adv" id="adv" ${advCount ? '' : 'hidden'}>
          <select name="project" aria-label="Projeto">${opt('', 'Todos os projetos', f.project)}${meta.projects.map(p => opt(p.id, `${p.code} · ${p.name}`, f.project))}</select>
          <select name="assignee" aria-label="Responsável">${opt('', 'Todos os responsáveis', f.assignee)}${opt('me', 'Minhas tarefas', f.assignee)}${opt('none', 'Sem responsável', f.assignee)}${meta.assignees.map(u => opt(u.id, u.name, f.assignee))}</select>
          <select name="due" aria-label="Prazo">${Object.entries(DUE).map(([k, l]) => opt(k, l, f.due))}</select>
          <select name="priority" aria-label="Prioridade">${opt('', 'Todas as prioridades', f.priority)}${Object.entries(PRIORITY).map(([k, l]) => opt(k, l, f.priority))}</select>
          <select name="stage" aria-label="Classificação">${opt('', 'Todas as classificações', f.stage)}${stageOptions}</select>
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
      root.querySelector('#clear')?.addEventListener('click', () => apply({ q: '', status: [], project: '', assignee: '', priority: '', due: '', nivel: '', stage: '' }));
    },
  };
}
