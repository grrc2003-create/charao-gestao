// Avanço parcial (%) opcional: barra e janela para informar (tarefa, subtarefa e item de check-list)
import { html } from '../core.js';
import { sheet } from '../ui.js';

export const pctBar = (pct, { small = false } = {}) => html`<span class="pg ${small ? 'pg-sm' : ''}" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct ?? 0}">
  <i style="width:${pct ?? 0}%"></i></span>`;

// Retorna { progress: número | null } ou null (cancelado)
export function progressSheet({ title = 'Avanço da tarefa', current = null, what = 'a tarefa' } = {}) {
  const v = current ?? 0;
  return sheet({
    title,
    submitLabel: 'Salvar avanço',
    body: html`<div class="pg-edit">
      <div class="pg-val"><input type="number" name="progress" id="pg-n" min="0" max="100" step="1" inputmode="numeric" value="${v}" aria-label="Avanço em %"><span>%</span></div>
      <input type="range" id="pg-r" min="0" max="100" step="5" value="${v}" aria-label="Avanço">
      <div class="chips pg-quick">${[0, 25, 50, 75, 90].map(n => html`<button type="button" class="chip" data-pg="${n}">${n}%</button>`)}</div>
      <span class="hint">Opcional. Mostra quanto d${what === 'o item' ? 'o item' : 'a tarefa'} já foi executad${what === 'o item' ? 'o' : 'a'} e preenche a barra no Gantt.
        Informar mais de 0% coloca ${what} em andamento. Concluir continua sendo pela entrega${what === 'o item' ? ' (Conforme)' : ' e conferência'}.</span>
      ${current !== null ? html`<label class="switch"><input type="checkbox" name="clear" value="1">Remover o avanço (voltar a "não informado")</label>` : ''}
    </div>`,
    onSubmit: data => ({ progress: data.clear ? null : data.progress === '' ? null : Number(data.progress) }),
  });
}

// Liga o número, a régua e os atalhos da janela (chamar logo depois de abrir)
export function bindProgressSheet() {
  const n = document.querySelector('#pg-n');
  const r = document.querySelector('#pg-r');
  if (!n || !r) return;
  n.addEventListener('input', () => { r.value = n.value; });
  r.addEventListener('input', () => { n.value = r.value; });
  document.querySelectorAll('[data-pg]').forEach(b => b.addEventListener('click', () => { n.value = r.value = b.dataset.pg; }));
}
