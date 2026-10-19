// Exclusão permanente de pessoa (administrador): só sem tarefas e sem registros que precisam ficar no histórico.
import { html, api, icon } from '../core.js';
import { toast, sheet } from '../ui.js';

export const deleteButton = () => html`<div class="ud-zone"><div><b>Excluir permanentemente</b><span class="muted">Só para quem não tem tarefas nem outros registros. Para quem já trabalhou no sistema, use “Inativo”.</span></div>
  <button type="button" class="btn btn-ghost btn-sm ud-btn" data-user-delete>${icon('trash')}Excluir pessoa</button></div>`;

export function bindDeleteButton(root, userId, done) {
  root.querySelector('[data-user-delete]')?.addEventListener('click', async () => {
    let info;
    try { info = await api(`/users/${userId}/deletion`); } catch (e) { return toast(e.message, 'error'); }
    if (!info.can_delete) {
      return sheet({
        title: 'Não é possível excluir',
        body: html`<p class="muted" style="margin-top:0">${info.reasons[0] || `${info.name} tem dados que precisam ficar no histórico:`}</p>
          ${info.blockers.length ? html`<ul class="ud-list">${info.blockers.map(b => html`<li><span>${b.label}</span><b>${b.count}</b></li>`)}</ul>
          <p class="muted">Em vez de excluir, marque a pessoa como <b>Inativa</b>: ela deixa de acessar e de aparecer nas listas, e o histórico é preservado.</p>` : ''}`,
        submitLabel: 'Entendi',
      });
    }
    const r = await sheet({
      title: `Excluir ${info.name}`,
      danger: true,
      body: html`<p style="margin-top:0">A pessoa será <b>apagada permanentemente</b>. Isso não pode ser desfeito.</p>
        <ul class="ud-list muted"><li>Sem tarefas registradas</li><li>Sessões, liberações de projeto, férias e foto são removidas</li>
          ${info.subordinates ? html`<li>${info.subordinates} pessoa(s) subordinada(s) passam para o gestor dela</li>` : ''}<li>Na auditoria, as ações antigas ficam com o nome registrado</li></ul>
        <label class="pr-se-check"><input type="checkbox" name="confirm"> Confirmo a exclusão permanente</label>`,
      submitLabel: 'Excluir permanentemente',
      async onSubmit(d, form) {
        if (!form.querySelector('[name=confirm]').checked) throw new Error('Marque a confirmação para excluir.');
        await api(`/users/${userId}`, { method: 'DELETE' });
        return { ok: true };
      },
    });
    if (r) { toast('Pessoa excluída permanentemente.'); done(); }
  });
}
