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
        <span class="mono muted" style="font-weight:600">${p.code}</span><span class="pill ${p.status === 'em_andamento' ? '' : 'pill-sand'}">${PROJECT_STATUS[p.status]}</span></div>
      <div><h2 style="font-size:16px">${p.name}</h2><div class="muted" style="font-size:13px">${p.client}</div></div>
      <div style="display:flex;align-items:center;gap:10px"><div style="flex:1">${progress(p.summary.completion_pct ?? 0)}</div><b>${fmtPct(p.summary.completion_pct ?? 0)}</b></div>
      ${stackBar(p.summary.by_status)}
      <div class="stat-inline"><span><b>${p.summary.total}</b> tarefas</span><span><b>${p.summary.in_progress}</b> em andamento</span>
        <span style="color:${p.summary.late ? STATUS_COLOR.atrasada : ''}"><b style="color:inherit">${p.summary.late}</b> atrasadas</span></div>
      <div class="stat-inline"><span>${icon('user')} ${p.lead_name || '—'}</span><span>${icon('calendar')} ${fmtDate(p.start_date)} → ${fmtDate(p.end_date)}</span></div>
    </div></a>`;

  return {
    title: 'Projetos',
    html: html`
      ${pageHead({
        eyebrow: 'Cadastro e acompanhamento',
        title: 'Projetos',
        sub: 'Cada projeto recebe um código único (PRJ-000) e suas tarefas seguem a sequência PRJ-000-00000.',
        actions: canCreate ? html`<a class="btn btn-accent" href="#/projetos/novo">${icon('plus')}Novo projeto</a>` : '',
      })}
      <div class="chips" role="group" aria-label="Filtrar projetos" style="margin-bottom:14px">
        ${[['ativos', 'Ativos'], ['concluidos', 'Concluídos'], ['todos', 'Todos']].map(([k, l]) =>
          html`<button class="chip" data-filter="${k}" aria-pressed="${filter === k}">${l}<span class="n">${projects.filter(groups[k]).length}</span></button>`)}
      </div>
      <div class="grid grid-3" id="proj-grid">${projects.filter(groups[filter]).map(card)}</div>
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

export async function form({ params, state, navigate, reloadMeta }) {
  const editing = !!params.id;
  if (!state.meta.can.manage_projects) throw new Error('Seu perfil não pode cadastrar ou editar projetos.');
  const [p, users] = await Promise.all([
    editing ? api(`/projects/${params.id}`) : Promise.resolve(null),
    api('/users/directory'),
  ]);
  const v = p || { status: 'planejamento', start_date: todayISO(), members: [] };
  const memberIds = new Set((v.members || []).map(m => m.id));
  const active = users.filter(u => u.active);
  const opt = (val, label, cur) => html`<option value="${val}" ${String(cur ?? '') === String(val) ? 'selected' : ''}>${label}</option>`;

  return {
    title: editing ? `Editar ${p.code}` : 'Novo projeto',
    html: html`
      ${pageHead({
        back: { href: editing ? `#/projetos/${p.id}` : '#/projetos', label: editing ? p.code : 'Projetos' },
        eyebrow: editing ? p.code : 'Código gerado automaticamente',
        title: editing ? 'Editar projeto' : 'Novo projeto',
      })}
      <form class="card card-pad form" id="proj-form" novalidate style="max-width:860px">
        <fieldset class="fieldset form"><legend>Identificação</legend>
          <div class="field"><label class="req" for="name">Nome do projeto</label><input id="name" name="name" type="text" maxlength="160" required value="${v.name || ''}"></div>
          <div class="form-row">
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
        <fieldset class="fieldset form"><legend>Equipe / responsáveis</legend>
          <span class="hint">Integrantes da equipe do projeto. O acesso ao sistema é controlado separadamente em <b>Usuários → Permissões</b>.</span>
          <div class="checks">${active.map(u => html`<label><input type="checkbox" name="member" value="${u.id}" ${memberIds.has(u.id) ? 'checked' : ''}>${u.name}<span class="muted" style="font-size:12px">${u.job_title || ''}</span></label>`)}</div>
        </fieldset>
        <div class="form-error" hidden></div>
        <div class="form-actions">
          <a class="btn btn-ghost" href="${editing ? `#/projetos/${p.id}` : '#/projetos'}">Cancelar</a>
          <button class="btn btn-primary" type="submit">${icon('check')}${editing ? 'Salvar alterações' : 'Cadastrar projeto'}</button>
        </div>
      </form>`,
    mount(root) {
      const f = root.querySelector('#proj-form');
      const err = f.querySelector('.form-error');
      f.addEventListener('submit', async e => {
        e.preventDefault();
        const data = Object.fromEntries(new FormData(f));
        data.member_ids = [...f.querySelectorAll('[name=member]:checked')].map(c => Number(c.value));
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
