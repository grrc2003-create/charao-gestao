import { html, api, icon, avatar, ROLE, SCOPE, fmtPct, fmtDateTime } from '../core.js';
import { toast, sheet } from '../ui.js';
import { pageHead, bindCommon, STATUS_COLOR } from './shared.js';

export async function list({ state }) {
  const users = await api('/users');
  const isAdmin = state.meta.can.manage_users;
  const byRole = r => users.filter(u => u.role === r);
  const row = u => html`<li><a class="row-link rank" href="#/usuarios/${u.id}">
    ${avatar(u.name)}
    <div class="grow">
      <div class="row-title">${u.name} <span class="pill ${u.role === 'admin' ? 'pill-orange' : u.role === 'gestor' ? '' : 'pill-sand'}">${ROLE[u.role]}</span>
        ${!u.active ? html`<span class="pill" style="color:var(--st-atrasada)">Inativo</span>` : ''}</div>
      <div class="row-meta"><span>${u.job_title || '—'}</span>${u.manager_name ? html`<span>Gestor: ${u.manager_name}</span>` : ''}
        ${u.team_size ? html`<span>${u.team_size} na equipe</span>` : ''}
        ${isAdmin ? html`<span>${u.access_scope === 'total' ? 'Acesso total' : u.access_scope === 'proprias' ? 'Só tarefas próprias' : 'Acesso por projeto'}</span>` : ''}</div>
    </div>
    <div class="rank-metrics">
      <div class="ok"><b>${fmtPct(u.stats.on_time_pct)}</b>no prazo</div>
      <div><b>${u.stats.done}</b>concluídas</div>
      <div class="late"><b>${u.stats.late}</b>atrasadas</div>
      <div><b>${u.stats.assigned}</b>atribuídas</div>
    </div><span class="chev">${icon('chevron')}</span></a></li>`;

  return {
    title: 'Usuários',
    html: html`
      ${pageHead({
        eyebrow: isAdmin ? 'Acessos, perfis e equipes' : 'Sua equipe',
        title: 'Usuários',
        sub: isAdmin ? 'Gerencie logins individuais, perfis (Administrador, Gestor, Colaborador), hierarquia e restrição por projeto.'
          : 'Você visualiza o próprio perfil e os integrantes da equipe sob sua gestão.',
        actions: isAdmin ? html`<a class="btn btn-ghost" href="#/configuracoes">${icon('settings')}Configurações</a><a class="btn btn-ghost" href="#/auditoria">${icon('shield')}Auditoria</a><a class="btn btn-accent" href="#/usuarios/novo">${icon('plus')}Novo usuário</a>`
          : state.meta.can.manage_settings ? html`<a class="btn btn-ghost" href="#/configuracoes">${icon('settings')}Configurações</a>` : '',
      })}
      ${['admin', 'gestor', 'colaborador'].filter(r => byRole(r).length).map(r => html`<section class="card section">
        <div class="card-head"><h2>${ROLE[r]}es</h2><span class="sub">${byRole(r).length}</span></div>
        <ul class="rows">${byRole(r).map(row)}</ul></section>`)}
      ${isAdmin ? html`<a class="fab" href="#/usuarios/novo" aria-label="Novo usuário">${icon('plus')}</a>` : ''}`,
    mount: root => bindCommon(root),
  };
}

export async function form({ params, state, navigate, reloadMeta }) {
  if (!state.meta.can.manage_users) throw new Error('Apenas administradores gerenciam usuários.');
  const editing = !!params.id;
  const [detail, users, projects] = await Promise.all([
    editing ? api(`/users/${params.id}`) : Promise.resolve(null),
    api('/users'),
    api('/projects'),
  ]);
  const u = detail?.user || { role: 'colaborador', access_scope: 'projetos', project_ids: [], active: 1 };
  const projectSet = new Set(u.project_ids || []);
  const opt = (val, label, cur) => html`<option value="${val}" ${String(cur ?? '') === String(val) ? 'selected' : ''}>${label}</option>`;
  const managers = users.filter(x => x.id !== u.id && x.active && x.role !== 'colaborador');

  return {
    title: editing ? `Editar ${u.name}` : 'Novo usuário',
    html: html`
      ${pageHead({
        back: { href: editing ? `#/usuarios/${u.id}` : '#/usuarios', label: editing ? u.name : 'Usuários' },
        eyebrow: 'Administração de acesso',
        title: editing ? 'Editar usuário e permissões' : 'Novo usuário',
      })}
      <form class="card card-pad form" id="user-form" novalidate style="max-width:860px">
        <fieldset class="fieldset form"><legend>Dados do usuário</legend>
          <div class="form-row">
            <div class="field"><label class="req" for="name">Nome completo</label><input id="name" name="name" type="text" maxlength="120" required value="${u.name || ''}"></div>
            <div class="field"><label class="req" for="email">E-mail (login)</label><input id="email" name="email" type="email" maxlength="160" required value="${u.email || ''}" autocomplete="off"></div>
          </div>
          <div class="form-row">
            <div class="field"><label for="job_title">Cargo / função</label><input id="job_title" name="job_title" type="text" maxlength="120" value="${u.job_title || ''}"></div>
            <div class="field"><label for="phone">Telefone</label><input id="phone" name="phone" type="tel" maxlength="40" value="${u.phone || ''}"></div>
          </div>
          ${!editing ? html`<div class="field"><label class="req" for="password">Senha provisória</label><input id="password" name="password" type="password" minlength="8" required autocomplete="new-password">
            <span class="hint">Mínimo de 8 caracteres com letras e números. O usuário deverá trocá-la no primeiro acesso.</span></div>` : ''}
        </fieldset>

        <fieldset class="fieldset form"><legend>Perfil e hierarquia</legend>
          <div class="segmented seg-3">
            ${[['admin', 'Controle total, usuários e permissões'], ['gestor', 'Gerencia projetos e confere tarefas da equipe'], ['colaborador', 'Executa e cria tarefas nos projetos liberados']].map(([k, d]) =>
              html`<label><input type="radio" name="role" value="${k}" ${u.role === k ? 'checked' : ''}>${ROLE[k]}<small>${d}</small></label>`)}
          </div>
          <div class="field"><label for="manager_id">Gestor direto</label>
            <select id="manager_id" name="manager_id"><option value="">Sem gestor</option>${managers.map(m => opt(m.id, `${m.name} · ${ROLE[m.role]}`, u.manager_id))}</select>
            <span class="hint">O gestor acompanha as tarefas e o desempenho deste usuário, mas não se torna responsável por elas.</span></div>
        </fieldset>

        <fieldset class="fieldset form" id="scope-fs"><legend>Acesso a dados</legend>
          <div class="segmented seg-3">${Object.entries(SCOPE).map(([k, l]) => html`<label><input type="radio" name="access_scope" value="${k}" ${u.access_scope === k ? 'checked' : ''}>
            ${k === 'total' ? 'Total' : k === 'projetos' ? 'Por projeto' : 'Somente próprias'}<small>${l}</small></label>`)}</div>
          <div class="field" id="proj-access"><span class="label">Projetos liberados</span>
            <div class="checks">${projects.map(p => html`<label><input type="checkbox" name="project" value="${p.id}" ${projectSet.has(p.id) ? 'checked' : ''}><span class="mono muted">${p.code}</span>${p.name}</label>`)}</div>
            <span class="hint">Usuários veem apenas dados dos projetos marcados. Administradores sempre têm acesso total.</span></div>
        </fieldset>

        ${editing ? html`<fieldset class="fieldset form"><legend>Situação</legend>
          <label class="switch"><input type="checkbox" name="active" ${u.active ? 'checked' : ''}>Usuário ativo (pode fazer login)</label>
          <div style="display:flex;gap:8px;flex-wrap:wrap"><button type="button" class="btn btn-ghost btn-sm" id="reset-pw">${icon('key')}Redefinir senha</button></div>
          <span class="hint">Alterar permissões ou desativar encerra as sessões ativas do usuário. Último acesso: ${fmtDateTime(u.last_login_at)}</span>
        </fieldset>` : ''}

        <div class="form-error" hidden></div>
        <div class="form-actions">
          <a class="btn btn-ghost" href="${editing ? `#/usuarios/${u.id}` : '#/usuarios'}">Cancelar</a>
          <button class="btn btn-primary" type="submit">${icon('check')}${editing ? 'Salvar' : 'Criar usuário'}</button>
        </div>
      </form>`,
    mount(root) {
      const f = root.querySelector('#user-form');
      const err = f.querySelector('.form-error');
      const sync = () => {
        const role = f.querySelector('[name=role]:checked')?.value;
        const scope = f.querySelector('[name=access_scope]:checked')?.value;
        root.querySelector('#scope-fs').style.display = role === 'admin' ? 'none' : '';
        root.querySelector('#proj-access').style.display = scope === 'total' ? 'none' : '';
      };
      f.addEventListener('change', sync);
      sync();
      root.querySelector('#reset-pw')?.addEventListener('click', async () => {
        const r = await sheet({
          title: `Redefinir senha de ${u.name}`,
          body: html`<div class="field"><label class="req" for="np">Nova senha provisória</label><input id="np" name="password" type="password" minlength="8" required autocomplete="new-password">
            <span class="hint">O usuário será desconectado e deverá trocar a senha no próximo acesso.</span></div>`,
          submitLabel: 'Redefinir',
          onSubmit: d => api(`/users/${u.id}/password`, { method: 'POST', body: d }),
        });
        if (r) toast('Senha redefinida.');
      });
      f.addEventListener('submit', async e => {
        e.preventDefault();
        const data = Object.fromEntries(new FormData(f));
        data.project_ids = [...f.querySelectorAll('[name=project]:checked')].map(c => Number(c.value));
        delete data.project;
        if (editing) data.active = f.querySelector('[name=active]').checked;
        err.hidden = true;
        try {
          let id = u.id;
          if (editing) await api(`/users/${id}`, { method: 'PUT', body: data });
          else id = (await api('/users', { method: 'POST', body: data })).id;
          await reloadMeta();
          toast(editing ? 'Usuário atualizado.' : 'Usuário criado.');
          navigate(`/usuarios/${id}`);
        } catch (ex) {
          err.textContent = ex.message;
          err.hidden = false;
          err.scrollIntoView({ block: 'center', behavior: 'smooth' });
        }
      });
    },
  };
}
