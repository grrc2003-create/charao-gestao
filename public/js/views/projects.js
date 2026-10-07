import { html, api, icon, PROJECT_STATUS, fmtDate, fmtPct, progress, todayISO } from '../core.js';
import { toast } from '../ui.js';
import { pageHead, stackBar, bindCommon, STATUS_COLOR } from './shared.js';

export async function list({ state, query, setQuery }) {
  const projects = await api('/projects');
  const canCreate = state.meta.can.manage_projects;
  const filter = query.get('status') || 'ativos';
  const groups = {
    ativos: p => ['planejamento', 'em_andamento', 'pausado'].includes(p.status),
    concluidos: p => p.status === 'concluido',
    todos: () => true,
  };

  const card = p => html`<a class="card proj-card" href="#/projetos/${p.id}" data-status="${p.status}">
    <div class="card-body" style="display:grid;gap:10px">
      <div style="display:flex;justify-content:space-between;gap:8px;align-items:center">
        <span class="mono muted" style="font-weight:600">${p.code}</span>${p.kind === 'interno' ? html`<span class="pill pill-orange">Interno</span>` : html`<span class="pill ${p.status === 'em_andamento' ? '' : 'pill-sand'}">${PROJECT_STATUS[p.status]}</span>`}</div>
      <div><h2 style="font-size:16px">${p.name}</h2><div class="muted" style="font-size:13px">${p.client}</div></div>
      <div style="display:flex;align-items:center;gap:10px"><div style="flex:1">${progress(p.summary.completion_pct ?? 0)}</div><b>${fmtPct(p.summary.completion_pct ?? 0)}</b></div>
      ${stackBar(p.summary.by_status)}
      <div class="stat-inline"><span><b>${p.summary.total}</b> tarefas</span><span><b>${p.summary.in_progress}</b> em andamento</span>
        <span style="color:${p.summary.late ? STATUS_COLOR.atrasada : ''}"><b style="color:inherit">${p.summary.late}</b> atrasadas</span></div>
      ${p.lead_name || p.start_date || p.end_date ? html`<div class="stat-inline">${p.lead_name ? html`<span>${icon('user')} ${p.lead_name}</span>` : ''}${p.start_date || p.end_date ? html`<span>${icon('calendar')} ${fmtDate(p.start_date)} → ${fmtDate(p.end_date)}</span>` : ''}</div>` : ''}
    </div></a>`;

  return {
    title: 'Projetos',
    html: html`
      ${pageHead({
        eyebrow: 'Cadastro e acompanhamento',
        title: 'Projetos',
        sub: 'Obras recebem código PRJ-000 e áreas internas da empresa INT-000; as tarefas seguem a sequência do código (ex.: PRJ-000-00000).',
        actions: canCreate ? html`<a class="btn btn-ghost" href="#/projetos/novo?tipo=interno">${icon('plus')}Nova área interna</a><a class="btn btn-accent" href="#/projetos/novo">${icon('plus')}Novo projeto</a>` : '',
      })}
      <div class="chips" role="group" aria-label="Filtrar projetos" style="margin-bottom:14px">
        ${[['ativos', 'Ativos'], ['concluidos', 'Concluídos'], ['todos', 'Todos']].map(([k, l]) =>
          html`<button class="chip" data-filter="${k}" aria-pressed="${filter === k}">${l}<span class="n">${projects.filter(groups[k]).length}</span></button>`)}
      </div>
      ${(() => {
        const shown = projects.filter(groups[filter]);
        const obras = shown.filter(p => p.kind !== 'interno');
        const internas = shown.filter(p => p.kind === 'interno');
        return html`<div class="grid grid-3" id="proj-grid">${obras.map(card)}</div>
          ${!obras.length && projects.length ? html`<p class="muted">Nenhuma obra neste filtro.</p>` : ''}
          ${internas.length ? html`<div class="page-head section" style="margin-bottom:10px"><div><div class="eyebrow">Empresa</div><h2>Interno (empresa)</h2>
            <p>Tarefas da própria Charão, não vinculadas a obras. Use as classificações como departamentos.</p></div></div>
            <div class="grid grid-3">${internas.map(card)}</div>` : ''}`;
      })()}
      ${!projects.length ? html`<div class="card empty-state"><p>Nenhum projeto liberado para o seu usuário.</p></div>` : ''}
      ${canCreate ? html`<a class="fab" href="#/projetos/novo" aria-label="Novo projeto">${icon('plus')}</a>` : ''}`,
    mount(root, ctx) {
      bindCommon(root);
      root.querySelectorAll('[data-filter]').forEach(b => b.addEventListener('click', () => {
        setQuery({ status: b.dataset.filter });
        ctx.render();
      }));
    },
  };
}

const stageItem = s => html`<li class="stage-item" data-id="${s.id || ''}">
  <span class="stage-move"><button type="button" class="icon-btn" data-move="-1" aria-label="Mover para cima">▲</button><button type="button" class="icon-btn" data-move="1" aria-label="Mover para baixo">▼</button></span>
  <input type="text" maxlength="60" value="${s.name}" aria-label="Nome da classificação" required>
  <span class="stage-count">${s.task_count ? `${s.task_count} tarefa(s)` : 'sem tarefas'}</span>
  <button type="button" class="icon-btn" data-rm ${s.task_count ? 'disabled' : ''} aria-label="Remover classificação"
    title="${s.task_count ? 'Possui tarefas: reclassifique-as antes de remover' : 'Remover'}">✕</button></li>`;

export async function form({ params, query, state, navigate, reloadMeta }) {
  const editing = !!params.id;
  if (!state.meta.can.manage_projects) throw new Error('Seu perfil não pode cadastrar ou editar projetos.');
  const [p, users, templates] = await Promise.all([
    editing ? api(`/projects/${params.id}`) : Promise.resolve(null),
    api('/users/directory'),
    api('/settings/specialties').catch(() => []),
  ]);
  const kind = p ? p.kind : query.get('tipo') === 'interno' ? 'interno' : 'obra';
  const v = p || (kind === 'interno'
    ? { status: 'em_andamento', members: [], client: 'Charão Engenharia e Construção' }
    : { status: 'planejamento', start_date: todayISO(), members: [] });
  const isInt = kind === 'interno';
  const memberIds = new Set((v.members || []).map(m => m.id));
  const active = users.filter(u => u.active);
  const opt = (val, label, cur) => html`<option value="${val}" ${String(cur ?? '') === String(val) ? 'selected' : ''}>${label}</option>`;

  return {
    title: editing ? `Editar ${p.code}` : 'Novo projeto',
    html: html`
      ${pageHead({
        back: { href: editing ? `#/projetos/${p.id}` : '#/projetos', label: editing ? p.code : 'Projetos' },
        eyebrow: editing ? `${p.code} · ${isInt ? 'Área interna da empresa' : 'Obra'}` : `Código gerado automaticamente (${isInt ? 'INT-000' : 'PRJ-000'})`,
        title: editing ? (isInt ? 'Editar área interna' : 'Editar projeto') : (isInt ? 'Nova área interna da empresa' : 'Novo projeto'),
      })}
      <form class="card card-pad form" id="proj-form" novalidate style="max-width:860px">
        ${!editing ? html`<fieldset class="fieldset form"><legend>Tipo</legend>
          <div class="segmented">
            <label><input type="radio" name="kind" value="obra" ${!isInt ? 'checked' : ''}>Obra / projeto<small>Para um cliente, código PRJ-000</small></label>
            <label><input type="radio" name="kind" value="interno" ${isInt ? 'checked' : ''}>Área interna da empresa<small>Tarefas da própria Charão, código INT-000</small></label>
          </div></fieldset>` : ''}
        <fieldset class="fieldset form"><legend>Identificação</legend>
          <div class="field"><label class="req" for="name" id="name-label">${isInt ? 'Nome da área' : 'Nome do projeto'}</label><input id="name" name="name" type="text" maxlength="160" required value="${v.name || ''}"
            placeholder="${isInt ? 'Ex.: Charão — Interno, Manutenção de frota' : ''}"></div>
          <div class="form-row obra-only" ${isInt ? 'hidden' : ''}>
            <div class="field"><label class="req" for="client">Cliente</label><input id="client" name="client" type="text" maxlength="160" required value="${v.client || ''}"></div>
            <div class="field"><label for="location">Local da obra</label><input id="location" name="location" type="text" maxlength="200" value="${v.location || ''}"></div>
          </div>
          <div class="field"><label for="description">Escopo / descrição</label><textarea id="description" name="description" maxlength="3000">${v.description || ''}</textarea></div>
        </fieldset>
        <fieldset class="fieldset form"><legend>Andamento e datas</legend>
          <div class="form-row">
            <div class="field"><label for="status">Status</label><select id="status" name="status">${Object.entries(PROJECT_STATUS).map(([k, l]) => opt(k, l, v.status))}</select></div>
            <div class="field"><label for="lead_id">Responsável técnico</label><select id="lead_id" name="lead_id"><option value="">—</option>${active.map(u => opt(u.id, `${u.name}${u.job_title ? ` · ${u.job_title}` : ''}`, v.lead_id))}</select>
              <span class="hint">O responsável técnico recebe acesso ao projeto.</span></div>
          </div>
          <div class="form-row form-row-3">
            <div class="field"><label for="start_date">Início</label><input id="start_date" name="start_date" type="date" value="${v.start_date || ''}"></div>
            <div class="field"><label for="end_date">Previsão de término</label><input id="end_date" name="end_date" type="date" value="${v.end_date || ''}"></div>
            <div class="field"><label for="actual_end_date">Término real</label><input id="actual_end_date" name="actual_end_date" type="date" value="${v.actual_end_date || ''}"></div>
          </div>
        </fieldset>
        <fieldset class="fieldset form"><legend>Classificação das tarefas (Grupo/Local/Etapa)</legend>
          <span class="hint">Cadastre as opções que aparecerão na lista suspensa ao criar tarefas deste projeto (ex.: Fundação, Bloco A, 2º pavimento, Instalações). Tarefas sem classificação ficam em <b>Geral</b>.</span>
          <ul class="stage-list" id="stage-list">
            <li class="stage-item stage-default"><span class="stage-handle" aria-hidden="true">•</span><input type="text" value="Geral" disabled aria-label="Classificação padrão">
              <span class="stage-count">${(p?.stages || []).find(s => s.is_default)?.task_count ?? 0} tarefa(s) · padrão</span></li>
            ${(p?.stages || []).filter(s => !s.is_default).map(s => stageItem(s))}
          </ul>
          <div class="stage-add">
            <input type="text" id="stage-new" maxlength="60" placeholder="Nova classificação (ex.: Fundação)" aria-label="Nova classificação">
            <button type="button" class="btn btn-ghost" id="stage-add-btn">${icon('plus')}Adicionar</button>
          </div>
        </fieldset>
        <fieldset class="fieldset form"><legend>Especialidades do check-list</legend>
          <div class="field"><label for="specialty_template_id">Modelo de especialidades</label>
            <select id="specialty_template_id" name="specialty_template_id"><option value="">Nenhum (itens sem especialidade)</option>
              ${templates.map(tp => opt(tp.id, tp.name, v.specialty_template_id))}</select>
            <span class="hint" id="spec-preview"></span>
            <span class="hint">Os modelos são cadastrados em <b>Configurações → Especialidades do check-list</b>. Trocar o modelo não altera os itens já cadastrados.</span></div>
        </fieldset>
        <fieldset class="fieldset form"><legend>Equipe do projeto (acesso)</legend>
          <span class="hint">Quem estiver marcado <b>vê este projeto e pode ser responsável pelas tarefas dele</b>. É a mesma liberação de <b>Usuários → Permissões</b>: marcar libera, desmarcar retira.</span>
          <div class="checks">${active.map(u => {
            const full = u.role === 'admin' || u.access_scope === 'total';
            return html`<label><input type="checkbox" name="member" value="${u.id}" ${memberIds.has(u.id) || full ? 'checked' : ''} ${full ? 'disabled' : ''}>${u.name}
              <span class="muted" style="font-size:12px">${full ? 'acesso a todos os projetos' : u.is_external ? `Terceirizado${u.company ? ` · ${u.company}` : ''}` : u.job_title || ''}</span></label>`;
          })}</div>
        </fieldset>
        <div class="form-error" hidden></div>
        <div class="form-actions">
          <a class="btn btn-ghost" href="${editing ? `#/projetos/${p.id}` : '#/projetos'}">Cancelar</a>
          <button class="btn btn-primary" type="submit">${icon('check')}${editing ? 'Salvar alterações' : 'Cadastrar projeto'}</button>
        </div>
      </form>`,
    mount(root) {
      const f = root.querySelector('#proj-form');
      // Troca de tipo (somente na criação): área interna não exige cliente nem local
      f.querySelectorAll('[name=kind]').forEach(r => r.addEventListener('change', () => {
        const interno = f.querySelector('[name=kind]:checked').value === 'interno';
        f.querySelectorAll('.obra-only').forEach(e => (e.hidden = interno));
        root.querySelector('#name-label').textContent = interno ? 'Nome da área' : 'Nome do projeto';
        if (interno && !f.client.value) f.client.value = 'Charão Engenharia e Construção';
      }));
      // Prévia das especialidades do modelo escolhido
      const tplSel = root.querySelector('#specialty_template_id');
      const showSpecs = () => {
        const tp = templates.find(x => String(x.id) === tplSel.value);
        root.querySelector('#spec-preview').textContent = tp ? tp.items.join(' · ') : '';
      };
      tplSel.addEventListener('change', showSpecs);
      showSpecs();
      const list = root.querySelector('#stage-list');
      const newInput = root.querySelector('#stage-new');
      const addStage = () => {
        const name = newInput.value.replace(/\s+/g, ' ').trim();
        if (!name) return newInput.focus();
        const exists = [...list.querySelectorAll('input')].some(i => i.value.trim().toLowerCase() === name.toLowerCase());
        if (exists) { toast('Essa classificação já existe.', 'warn'); return newInput.select(); }
        list.insertAdjacentHTML('beforeend', stageItem({ name, task_count: 0 }).toString());
        newInput.value = '';
        newInput.focus();
      };
      root.querySelector('#stage-add-btn').addEventListener('click', addStage);
      newInput.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); addStage(); } });
      list.addEventListener('click', e => {
        const li = e.target.closest('.stage-item');
        if (!li) return;
        if (e.target.closest('[data-rm]')) li.remove();
        const mv = e.target.closest('[data-move]');
        if (mv) {
          const dir = Number(mv.dataset.move);
          const sib = dir < 0 ? li.previousElementSibling : li.nextElementSibling;
          if (sib && !sib.classList.contains('stage-default')) dir < 0 ? sib.before(li) : sib.after(li);
        }
      });
      const err = f.querySelector('.form-error');
      f.addEventListener('submit', async e => {
        e.preventDefault();
        const data = Object.fromEntries(new FormData(f));
        data.member_ids = [...f.querySelectorAll('[name=member]:checked:not(:disabled)')].map(c => Number(c.value));
        data.stages = [...f.querySelectorAll('.stage-item:not(.stage-default)')].map(li => ({ id: li.dataset.id ? Number(li.dataset.id) : null, name: li.querySelector('input').value }));
        delete data.member;
        err.hidden = true;
        try {
          let id = p?.id;
          if (editing) await api(`/projects/${id}`, { method: 'PUT', body: data });
          else id = (await api('/projects', { method: 'POST', body: data })).id;
          await reloadMeta();
          toast(editing ? 'Projeto atualizado.' : 'Projeto cadastrado.');
          navigate(`/projetos/${id}`);
        } catch (ex) {
          err.textContent = ex.message;
          err.hidden = false;
          err.scrollIntoView({ block: 'center', behavior: 'smooth' });
        }
      });
    },
  };
}
