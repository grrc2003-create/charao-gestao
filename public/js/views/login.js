import { html, api } from '../core.js';

// Contas de demonstração (somente quando o servidor está em modo demo). Senha em README/seed.
const DEMO = [
  ['ana@charao.eng.br', 'Ana Charão', 'Administradora'],
  ['ricardo@charao.eng.br', 'Ricardo Menezes', 'Gestor · acesso total'],
  ['juliana@charao.eng.br', 'Juliana Prates', 'Gestora · 2 projetos'],
  ['marcos@charao.eng.br', 'Marcos Silva', 'Colaborador'],
  ['bruno@charao.eng.br', 'Bruno Costa', 'Colab. · só tarefas próprias'],
  ['camila@charao.eng.br', 'Camila Rocha', 'Colaboradora'],
];

export function render(state) {
  return html`<div class="login-wrap">
    <section class="login-art" aria-hidden="true">
      <div><img src="/assets/icon.svg" alt="" width="56" style="border-radius:12px"></div>
      <div>
        <h2>Controle de obras, tarefas e comprovações em um só lugar.</h2>
        <div class="accent"></div>
        <p>Acompanhe o andamento de cada projeto, a pontualidade das equipes e as evidências de execução — no escritório ou no canteiro.</p>
        <ul><li>Tarefas com comprovação por foto e descrição</li><li>Conferência e histórico rastreável</li><li>Relatórios A4 e listas de campo para impressão</li></ul>
      </div>
      <small>Charão Engenharia & Construção</small>
    </section>
    <section class="login-panel">
      <div class="login-card">
        <img class="logo" src="/assets/logo.webp" alt="Charão Engenharia & Construção">
        <h1>Entrar</h1>
        <p class="muted">Use seu e-mail corporativo e senha.</p>
        <form class="form" id="login-form" novalidate>
          <div class="field"><label for="email">E-mail</label><input id="email" name="email" type="email" autocomplete="username" required></div>
          <div class="field"><label for="password">Senha</label><input id="password" name="password" type="password" autocomplete="current-password" required></div>
          <div class="form-error" hidden></div>
          <button class="btn btn-primary btn-block" type="submit">Entrar</button>
        </form>
        ${state.demo ? html`<div class="demo-users card card-pad">
          <div class="notice notice-proto"><span>Ambiente de <b>demonstração</b> com dados fictícios. Toque em um perfil para preencher o e-mail; a senha de teste está no README do projeto.</span></div>
          <div class="grid-demo">${DEMO.map(([e, n, r]) => html`<button type="button" data-email="${e}"><b>${n}</b><small>${r}</small></button>`)}</div>
        </div>` : ''}
      </div>
    </section></div>`;
}

export function mount(root, { onLogin }) {
  const form = root.querySelector('#login-form');
  const err = form.querySelector('.form-error');
  root.querySelectorAll('[data-email]').forEach(b => b.addEventListener('click', () => {
    form.email.value = b.dataset.email;
    form.password.focus();
  }));
  form.addEventListener('submit', async e => {
    e.preventDefault();
    err.hidden = true;
    const btn = form.querySelector('button[type=submit]');
    btn.disabled = true;
    try {
      const r = await api('/auth/login', { method: 'POST', body: { email: form.email.value, password: form.password.value } });
      await onLogin(r.user);
    } catch (ex) {
      err.textContent = ex.message;
      err.hidden = false;
      btn.disabled = false;
    }
  });
  form.email.focus();
}
