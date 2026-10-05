// Configurações gerais (Gestor e Administrador). Organizada em seções para receber novos cadastros no futuro.
import { html, api, icon } from '../core.js';
import { toast } from '../ui.js';
import { pageHead } from './shared.js';

const reasonItem = r => html`<li class="stage-item reason-item ${r.active ? '' : 'is-inactive'}" data-id="${r.id || ''}">
  <span class="stage-move"><button type="button" class="icon-btn" data-move="-1" aria-label="Mover para cima">▲</button><button type="button" class="icon-btn" data-move="1" aria-label="Mover para baixo">▼</button></span>
  <input type="text" maxlength="120" value="${r.name}" aria-label="Texto da justificativa" required>
  <label class="reason-active" title="Inativas não aparecem para novos reagendamentos"><input type="checkbox" data-active ${r.active ? 'checked' : ''}><span>Ativa</span></label>
  <span class="stage-count">${r.use_count ? `usada ${r.use_count}x` : 'nunca usada'}</span>
  <button type="button" class="icon-btn" data-rm ${r.use_count ? 'disabled' : ''} aria-label="Excluir justificativa"
    title="${r.use_count ? 'Já usada: inative em vez de excluir' : 'Excluir'}">✕</button></li>`;

export async function view({ state }) {
  if (!state.meta.can.manage_settings) throw new Error('Apenas gestores e administradores acessam as configurações.');
  const [reasons, general] = await Promise.all([api('/settings/reasons', { query: { all: '1' } }), api('/settings/general')]);

  return {
    title: 'Configurações',
    html: html`
      ${pageHead({ eyebrow: 'Cadastros gerais do sistema', title: 'Configurações',
        sub: 'Cadastros válidos para todos os projetos. As classificações (Grupo/Local/Etapa) continuam no cadastro de cada projeto.' })}
      <section class="card" style="max-width:900px;margin-bottom:16px">
        <div class="card-head"><h2>${icon('alert')}Indicadores de prazo</h2></div>
        <form class="card-body form" id="general-form" novalidate>
          <div class="field" style="max-width:420px"><label for="chronic">Tarefa crônica a partir de quantos reagendamentos?</label>
            <input id="chronic" name="chronic_reschedule_threshold" type="number" min="2" max="10" step="1" inputmode="numeric" value="${general.chronic_reschedule_threshold}">
            <span class="hint">Tarefas reagendadas este número de vezes ou mais são destacadas como <b>crônicas</b> no Dashboard, nas listas e nos relatórios. Entre 2 e 10.</span></div>
          <div class="form-error" hidden></div>
          <div class="form-actions" style="justify-content:flex-start"><button type="submit" class="btn btn-primary">${icon('check')}Salvar</button></div>
        </form>
      </section>
      <section class="card" id="reasons-card" style="max-width:900px">
        <div class="card-head"><h2>${icon('reschedule')}Justificativas de reagendamento</h2><span class="sub">${reasons.filter(r => r.active).length} ativa(s)</span></div>
        <form class="card-body form" id="reasons-form" novalidate>
          <p class="muted" style="margin:0">Ao alterar o prazo de uma tarefa já com prazo definido, é obrigatório escolher uma destas justificativas.
            A ordem abaixo é a ordem da lista suspensa. Justificativas já usadas não podem ser excluídas — inative-as para que não apareçam mais.</p>
          <ul class="stage-list" id="reason-list">${reasons.map(reasonItem)}</ul>
          <div class="stage-add">
            <input type="text" id="reason-new" maxlength="120" placeholder="Nova justificativa (ex.: Interdição da via de acesso)" aria-label="Nova justificativa">
            <button type="button" class="btn btn-ghost" id="reason-add">${icon('plus')}Adicionar</button>
          </div>
          <div class="form-error" hidden></div>
          <div class="form-actions"><button type="submit" class="btn btn-primary">${icon('check')}Salvar justificativas</button></div>
        </form>
      </section>`,
    mount(root, ctx) {
      const gf = root.querySelector('#general-form');
      gf.addEventListener('submit', async e => {
        e.preventDefault();
        const gerr = gf.querySelector('.form-error');
        gerr.hidden = true;
        try {
          await api('/settings/general', { method: 'PUT', body: { chronic_reschedule_threshold: Number(gf.chronic.value) } });
          toast('Limite de tarefa crônica salvo.');
        } catch (ex) { gerr.textContent = ex.message; gerr.hidden = false; }
      });
      const f = root.querySelector('#reasons-form');
      const list = root.querySelector('#reason-list');
      const input = root.querySelector('#reason-new');
      const err = f.querySelector('.form-error');
      const add = () => {
        const name = input.value.replace(/\s+/g, ' ').trim();
        if (!name) return input.focus();
        if ([...list.querySelectorAll('input[type=text]')].some(i => i.value.trim().toLowerCase() === name.toLowerCase())) {
          toast('Essa justificativa já existe.', 'warn');
          return input.select();
        }
        list.insertAdjacentHTML('beforeend', reasonItem({ name, active: 1, use_count: 0 }).toString());
        input.value = '';
        input.focus();
      };
      root.querySelector('#reason-add').addEventListener('click', add);
      input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); add(); } });
      list.addEventListener('click', e => {
        const li = e.target.closest('.reason-item');
        if (!li) return;
        if (e.target.closest('[data-rm]')) li.remove();
        const mv = e.target.closest('[data-move]');
        if (mv) {
          const sib = Number(mv.dataset.move) < 0 ? li.previousElementSibling : li.nextElementSibling;
          if (sib) Number(mv.dataset.move) < 0 ? sib.before(li) : sib.after(li);
        }
      });
      list.addEventListener('change', e => {
        if (e.target.matches('[data-active]')) e.target.closest('.reason-item').classList.toggle('is-inactive', !e.target.checked);
      });
      f.addEventListener('submit', async e => {
        e.preventDefault();
        err.hidden = true;
        const payload = [...list.querySelectorAll('.reason-item')].map(li => ({
          id: li.dataset.id ? Number(li.dataset.id) : null,
          name: li.querySelector('input[type=text]').value,
          active: li.querySelector('[data-active]').checked,
        }));
        try {
          await api('/settings/reasons', { method: 'PUT', body: { reasons: payload } });
          toast('Justificativas salvas.');
          ctx.render();
        } catch (ex) {
          err.textContent = ex.message;
          err.hidden = false;
        }
      });
    },
  };
}
