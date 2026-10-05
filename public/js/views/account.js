import { html, api, icon, avatar, ROLE, SCOPE } from '../core.js';
import { toast } from '../ui.js';
import { pageHead } from './shared.js';
import { logout } from '../app.js';

export async function view({ state, navigate }) {
  const u = state.user;
  return {
    title: 'Minha conta',
    html: html`
      ${pageHead({ eyebrow: 'Perfil e segurança', title: 'Minha conta' })}
      <div class="grid grid-2">
        <section class="card card-pad">
          <div class="profile-head">${avatar(u.name, 'lg')}<div><h2>${u.name}</h2><div class="muted">${u.job_title || ''}</div>
            <span class="pill" style="margin-top:6px">${ROLE[u.role]}</span></div></div>
          <hr class="divider">
          <dl class="kv"><dt>E-mail</dt><dd>${u.email}</dd><dt>Acesso</dt><dd>${SCOPE[u.access_scope]}</dd></dl>
          <div class="page-actions" style="margin-top:16px">
            <a class="btn btn-ghost" href="#/usuarios/${u.id}">${icon('dashboard')}Meu desempenho</a>
            <button type="button" class="btn btn-warn" id="logout">${icon('logout')}Sair</button>
          </div>
        </section>
        <section class="card card-pad">
          <h2 style="margin-bottom:4px">Alterar senha</h2>
          ${u.must_change_password ? html`<div class="notice notice-proto" style="margin:8px 0">${icon('alert')}<span>Sua senha é provisória. Defina uma senha pessoal.</span></div>` : html`<p class="muted">Use ao menos 8 caracteres, com letras e números.</p>`}
          <form class="form" id="pw-form" novalidate>
            <div class="field"><label for="current">Senha atual</label><input id="current" name="current" type="password" autocomplete="current-password" required></div>
            <div class="field"><label for="password">Nova senha</label><input id="password" name="password" type="password" autocomplete="new-password" minlength="8" required></div>
            <div class="field"><label for="confirm">Confirmar nova senha</label><input id="confirm" name="confirm" type="password" autocomplete="new-password" required></div>
            <div class="form-error" hidden></div>
            <div class="form-actions"><button class="btn btn-primary" type="submit">${icon('key')}Salvar nova senha</button></div>
          </form>
        </section>
      </div>`,
    mount(root) {
      root.querySelector('#logout').addEventListener('click', logout);
      const f = root.querySelector('#pw-form');
      const err = f.querySelector('.form-error');
      f.addEventListener('submit', async e => {
        e.preventDefault();
        err.hidden = true;
        if (f.password.value !== f.confirm.value) { err.textContent = 'A confirmação não confere.'; err.hidden = false; return; }
        try {
          await api('/auth/password', { method: 'POST', body: { current: f.current.value, password: f.password.value } });
          state.user.must_change_password = 0;
          toast('Senha alterada com sucesso.');
          f.reset();
          navigate('/');
        } catch (ex) { err.textContent = ex.message; err.hidden = false; }
      });
    },
  };
}
