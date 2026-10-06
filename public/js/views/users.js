import { html, api, icon, avatar, ROLE, SCOPE, fmtPct, fmtDateTime, roleLabel } from '../core.js';
import { toast, sheet } from '../ui.js';
import { pageHead, bindCommon, STATUS_COLOR } from './shared.js';

export async function list({ state }) {
  const users = await api('/users');
  const isAdmin = state.meta.can.manage_users;
  const byRole = r => users.filter(u => (r === 'terceirizado' ? u.is_external : !u.is_external && u.role === r));
  const row = u => html`<li><a class="row-link rank" href="#/usuarios/${u.id}">
    ${avatar(u.name)}
    <div class="grow">
      <div class="row-title">${u.name} <span class="pill ${u.is_external ? 'pill-ext' : u.role === 'admin' ? 'pill-orange' : u.role === 'gestor' ? '' : 'pill-sand'}">${roleLabel(u)}</span>
        ${!u.active ? html`<span class="pill" style="color:var(--st-atrasada)">Inativo</span>` : ''}</div>
      <div class="row-meta"><span>${u.job_title || '—'}</span>${u.company ? html`<span>${u.company}</span>` : ''}
        ${u.manager_name ? html`<span>${u.is_external ? 'Líder' : 'Gestor'}: ${u.manager_name}</span>` : ''}
        ${u.team_size ? html`<span>${u.team_size} na equipe</span>` : ''}
        ${isAdmin ? html`<span>${u.is_external && !u.login_enabled ? 'Sem login' : u.access_scope === 'total' ? 'Acesso total' : u.access_scope === 'proprias' ? 'Só tarefas próprias' : 'Acesso por projeto'}</span>` : ''}</div>
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
        actions: isAdmin ? html`<a class="btn btn-ghost" href="#/configuracoes">${icon('settings')}Configurações</a><a class="btn btn-ghost" href="#/auditoria">${icon('shield')}Auditoria</a><a class="btn btn-ghost" href="#/usuarios/novo?perfil=terceirizado">${icon('plus')}Novo terceirizado</a><a class="btn btn-accent" href="#/usuarios/novo">${icon('plus')}Novo usuário</a>`
          : state.meta.can.manage_settings ? html`<a class="btn btn-ghost" href="#/configuracoes">${icon('settings')}Configurações</a>` : '',
      })}
      ${['admin', 'gestor', 'colaborador', 'terceirizado'].filter(r => byRole(r).length).map(r => html`<section class="card section">
        <div class="card-head"><h2>${ROLE[r]}${r === 'terceirizado' ? 's' : 'es'}</h2><span class="sub">${r === 'terceirizado' ? `${byRole(r).length} · sem login: o líder registra e confere` : byRole(r).length}</span></div>
        <ul class="rows">${byRole(r).map(row)}</ul></section>`)}
      ${isAdmin ? html`<a class="fab" href="#/usuarios/novo" aria-label="Novo usuário">${icon('plus')}</a>` : ''}`,
    mount: root => bindCommon(root),
  };
}

export async function form({ params, query, state, navigate, reloadMeta }) {
  if (!state.meta.can.manage_users) throw new Error('Apenas administradores gerenciam usuários.');
  const editing = !!params.id;
  const [detail, users, projects] = await Promise.all([
    editing ? api(`/users/${params.id}`) : Promise.resolve(null),
    api('/users'),
    api('/projects'),
  ]);
  const u = detail?.user || { role: 'colaborador', access_scope: 'projetos', project_ids: [], active: 1, is_external: query.get('perfil') === 'terceirizado' ? 1 : 0 };
  const ext = !!u.is_external;
  const hadLogin = editing && !!u.login_enabled;
  // Líderes possíveis de terceirizado: qualquer usuário interno ativo
  const leaders = users.filter(x => x.id !== u.id && x.active && !x.is_external);
  const projectSet = new Set(u.project_ids || []);
  const opt = (val, label, cur) => html`<option value="${val}" ${String(cur ?? '') === String(val) ? 'selected' : ''}>${label}</option>`;
  const managers = users.filter(x => x.id !== u.id && x.active && x.role !== 'colaborador' && !x.is_external);
  const leaderOptions = isExt => (isExt ? leaders : managers).map(m => opt(m.id, `${m.name} · ${roleLabel(m)}`, u.manager_id));

  return {
    title: editing ? `Editar ${u.name}` : ext ? 'Novo terceirizado' : 'Novo usuário',
    html: html`
      ${pageHead({
        back: { href: editing ? `#/usuarios/${u.id}` : '#/usuarios', label: editing ? u.name : 'Usuários' },
        eyebrow: 'Administração de acesso',
        title: editing ? (ext ? 'Editar terceirizado' : 'Editar usuário e permissões') : ext ? 'Novo terceirizado' : 'Novo usuário',
      })}
      <div class="notice ext-only" style="max-width:860px;margin-bottom:14px" ${ext ? '' : 'hidden'}>${icon('info')}<span id="ext-notice"></span></div>
      <form class="card card-pad form" id="user-form" novalidate style="max-width:860px">
        <fieldset class="fieldset form"><legend>Dados do usuário</legend>
          <div class="form-row">
            <div class="field"><label class="req" for="name">Nome completo</label><input id="name" name="name" type="text" maxlength="120" required value="${u.name || ''}"></div>
            <div class="field"><label for="email" id="email-label">E-mail (login)</label><input id="email" name="email" type="email" maxlength="160" value="${u.email || ''}" autocomplete="off"></div>
          </div>
          <div class="field ext-only" ${ext ? '' : 'hidden'}><label for="company">Empresa terceirizada</label><input id="company" name="company" type="text" maxlength="160" value="${u.company || ''}" placeholder="Ex.: Empreiteira Alfa"></div>
          <div class="form-row">
            <div class="field"><label for="job_title">Cargo / função</label><input id="job_title" name="job_title" type="text" maxlength="120" value="${u.job_title || ''}"></div>
            <div class="field"><label for="phone">Telefone</label><input id="phone" name="phone" type="tel" maxlength="40" value="${u.phone || ''}"></div>
          </div>
          <label class="switch ext-only" ${ext ? '' : 'hidden'}><input type="checkbox" name="login_enabled" id="login_enabled" ${hadLogin ? 'checked' : ''}>Dar acesso ao sistema (login) — passa a seguir as regras de Colaborador</label>
          ${!editing || (ext && !hadLogin) ? html`<div class="field" id="pw-field"><label class="req" for="password">Senha provisória</label><input id="password" name="password" type="password" minlength="8" autocomplete="new-password">
            <span class="hint">Mínimo de 8 caracteres com letras e números. O usuário deverá trocá-la no primeiro acesso.</span></div>` : ''}
        </fieldset>

        <fieldset class="fieldset form"><legend>Perfil e hierarquia</legend>
          <div class="segmented ${editing ? 'seg-3' : 'seg-4'}">
            ${[['admin', 'Controle total, usuários e permissões'], ['gestor', 'Gerencia projetos e confere tarefas da equipe'], ['colaborador', 'Executa e cria tarefas nos projetos liberados'],
              ['terceirizado', 'Responsável por tarefas, com líder; login opcional']]
              .filter(([k]) => !editing || (ext ? k === 'terceirizado' : k !== 'terceirizado'))
              .map(([k, d]) => html`<label><input type="radio" name="role" value="${k}" ${(ext ? k === 'terceirizado' : u.role === k) ? 'checked' : ''}>${ROLE[k]}<small>${d}</small></label>`)}
          </div>
          ${editing ? html`<span class="hint">${ext ? 'Um terceirizado continua terceirizado; o acesso ao sistema pode ser ligado ou desligado acima.' : 'Usuários internos não podem ser convertidos em terceirizados.'}</span>` : ''}
          <div class="field"><label for="manager_id" id="manager-label" class="${ext ? 'req' : ''}">${ext ? 'Líder (obrigatório)' : 'Gestor direto'}</label>
            <select id="manager_id" name="manager_id"><option value="">${ext ? 'Selecione o líder' : 'Sem gestor'}</option>${leaderOptions(ext)}</select>
            <span class="hint" id="manager-hint">${ext ? 'Colaborador, gestor ou administrador responsável pelo terceirizado.' : 'O gestor acompanha as tarefas e o desempenho deste usuário, mas não se torna responsável por elas.'}</span></div>
        </fieldset>

        <fieldset class="fieldset form" id="scope-fs"><legend>Acesso a dados</legend>
          <div class="segmented seg-3" id="scope-seg">${Object.entries(SCOPE).map(([k, l]) => html`<label><input type="radio" name="access_scope" value="${k}" ${u.access_scope === k ? 'checked' : ''}>
            ${k === 'total' ? 'Total' : k === 'projetos' ? 'Por projeto' : 'Somente próprias'}<small>${l}</small></label>`)}</div>
          <div class="field" id="proj-access"><span class="label">Projetos liberados</span>
            <div class="checks">${projects.map(p => html`<label><input type="checkbox" name="project" value="${p.id}" ${projectSet.has(p.id) ? 'checked' : ''}><span class="mono muted">${p.code}</span>${p.name}</label>`)}</div>
            <span class="hint" id="proj-hint"></span></div>
        </fieldset>

        ${editing ? html`<fieldset class="fieldset form"><legend>Situação</legend>
          <label class="switch"><input type="checkbox" name="active" ${u.active ? 'checked' : ''}>Usuário ativo (pode fazer login)</label>
          <div style="display:flex;gap:8px;flex-wrap:wrap" ${ext && !hadLogin ? 'hidden' : ''}><button type="button" class="btn btn-ghost btn-sm" id="reset-pw">${icon('key')}Redefinir senha</button></div>
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
      const managerSel = f.querySelector('#manager_id');
      let lastExt = ext;
      const sync = () => {
        const role = f.querySelector('[name=role]:checked')?.value;
        const isExt = role === 'terceirizado';
        const hasLogin = !isExt || f.querySelector('#login_enabled').checked;
        root.querySelectorAll('.ext-only').forEach(e => (e.hidden = !isExt));
        root.querySelector('#email-label').textContent = hasLogin ? 'E-mail (login)' : 'E-mail (contato, opcional)';
        root.querySelector('#email-label').classList.toggle('req', hasLogin);
        const pw = root.querySelector('#pw-field');
        if (pw) pw.hidden = !hasLogin;
        root.querySelector('#ext-notice').innerHTML = hasLogin
          ? '<b>Terceirizado com acesso ao sistema.</b> Segue as mesmas regras de um Colaborador: faz login, registra a execução das próprias tarefas e envia para conferência. O líder acompanha como gestor direto.'
          : '<b>Terceirizado sem login.</b> Serve para ser responsável por tarefas. O <b>líder</b> conduz a tarefa: registra a execução em nome dele (descrição, fotos), aprova ou devolve a entrega e acompanha o desempenho.';
        root.querySelector('#proj-hint').textContent = isExt
          ? 'O terceirizado só aparece (e só pode ser responsável) nos projetos marcados.'
          : 'Usuários veem apenas dados dos projetos marcados. Administradores sempre têm acesso total.';
        root.querySelector('#manager-label').textContent = isExt ? 'Líder (obrigatório)' : 'Gestor direto';
        root.querySelector('#manager-label').classList.toggle('req', isExt);
        root.querySelector('#manager-hint').textContent = isExt ? 'Colaborador, gestor ou administrador responsável pelo terceirizado.'
          : 'O gestor acompanha as tarefas e o desempenho deste usuário, mas não se torna responsável por elas.';
        if (isExt !== lastExt) {
          managerSel.innerHTML = html`<option value="">${isExt ? 'Selecione o líder' : 'Sem gestor'}</option>${leaderOptions(isExt)}`.toString();
          lastExt = isExt;
        }
        const scope = f.querySelector('[name=access_scope]:checked')?.value;
        root.querySelector('#scope-fs').style.display = role === 'admin' ? 'none' : '';
        root.querySelector('#scope-seg').style.display = hasLogin ? '' : 'none';
        root.querySelector('#proj-access').style.display = hasLogin && scope === 'total' ? 'none' : '';
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
        if (data.role === 'terceirizado' || (editing && ext)) data.login_enabled = f.querySelector('#login_enabled').checked;
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
