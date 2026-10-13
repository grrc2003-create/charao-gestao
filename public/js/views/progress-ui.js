// Avanço parcial (%) opcional: barra e janela para informar (tarefa, subtarefa e item de check-list)
import { html, icon, todayISO } from '../core.js';
import { sheet } from '../ui.js';

export const pctBar = (pct, { small = false } = {}) => html`<span class="pg ${small ? 'pg-sm' : ''}" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct ?? 0}">
  <i style="width:${pct ?? 0}%"></i></span>`;

// Retorna { progress: número | null } ou null (cancelado)
// Campo "Data de início" pedido quando a tarefa ainda não tem início (avanço, envio e conclusão)
export const startField = () => html`<div class="field start-ask"><label class="req" for="sd">Data de início</label>
  <input type="date" id="sd" name="start_date" required max="${todayISO()}">
  <span class="hint">Esta tarefa está sem data de início. Informe quando a execução começou — obrigatório para dar avanço ou concluir.</span></div>`;

// finish: o que acontece ao chegar a 100% ([{ k: 'submit'|'conclude', label, warn }]); vazio = aviso at100
// Campo opcional "terminou antes de hoje?" (envio): a data vai para autorização de quem confere
export const doneDateField = (t, { superior = false } = {}) => html`<div class="field done-ask"><label for="dd">${superior ? 'Data em que terminou (se foi antes de hoje)' : 'Terminou antes de hoje? Informe o dia'}</label>
  <input type="date" id="dd" name="done_date" max="${todayISO()}" ${t.start_date ? html`min="${t.start_date}"` : ''}>
  <span class="hint">${superior ? 'Opcional. Fica registrada como a data da conclusão, com os dias de atraso de preenchimento.'
    : 'Opcional. Se a execução terminou antes de hoje, informe o dia: ele precisa ser autorizado por quem confere. Autorizado, conta para o prazo e fica registrado o atraso de preenchimento.'}</span></div>`;

export function progressSheet({ title = 'Avanço da tarefa', current = null, what = 'a tarefa', askStart = false, finish = [], at100 = '', doneField = '' } = {}) {
  const v = current ?? 0;
  return sheet({
    title,
    submitLabel: 'Salvar avanço',
    body: html`<div class="pg-edit">${askStart ? startField() : ''}
      <div class="pg-val"><input type="number" name="progress" id="pg-n" min="0" max="100" step="1" inputmode="numeric" value="${v}" aria-label="Avanço em %"><span>%</span></div>
      <input type="range" id="pg-r" min="0" max="100" step="5" value="${v}" aria-label="Avanço">
      <div class="chips pg-quick">${[0, 25, 50, 75, 90, 100].map(n => html`<button type="button" class="chip" data-pg="${n}">${n}%</button>`)}</div>
      <span class="hint">Opcional. Mostra quanto d${what === 'o item' ? 'o item' : 'a tarefa'} já foi executad${what === 'o item' ? 'o' : 'a'} e preenche a barra no Gantt.
        Informar mais de 0% coloca ${what} em andamento.${what === 'o item' ? ' O item é concluído ao ser marcado Conforme.' : ' Com 100%, a tarefa sai da execução (conferência ou conclusão).'}</span>
      <div class="pg-100" hidden>
        ${finish.length ? html`<div class="notice">${icon('info')}<span><b>100% = execução terminada.</b> Ao salvar, o status muda para:</span></div>
          ${finish.map((f, i) => html`<label class="switch pg-finish"><input type="radio" name="finish" value="${f.k}" ${i === 0 ? 'checked' : ''}><span>${f.label}</span></label>
            ${f.warn ? html`<span class="hint pg-warn">${f.warn}</span>` : ''}`)}${doneField}`
        : html`<div class="notice">${icon('info')}<span>${at100 || 'Com 100%, o status não muda automaticamente.'}</span></div>`}
      </div>
      ${current !== null ? html`<label class="switch"><input type="checkbox" name="clear" value="1">Remover o avanço (voltar a "não informado")</label>` : ''}
    </div>`,
    onSubmit: data => ({ progress: data.clear ? null : data.progress === '' ? null : Number(data.progress), ...(data.start_date ? { start_date: data.start_date } : {}), ...(data.finish ? { finish: data.finish } : {}), ...(data.done_date ? { done_date: data.done_date } : {}) }),
  });
}

// Liga o número, a régua e os atalhos da janela (chamar logo depois de abrir)
export function bindProgressSheet() {
  const n = document.querySelector('#pg-n');
  const r = document.querySelector('#pg-r');
  if (!n || !r) return;
  // Aviso de 100%: mostra para qual status a tarefa vai
  const box = document.querySelector('.pg-100');
  const sync = () => { if (box) box.hidden = Number(n.value) !== 100; };
  n.addEventListener('input', () => { r.value = n.value; sync(); });
  r.addEventListener('input', () => { n.value = r.value; sync(); });
  document.querySelectorAll('[data-pg]').forEach(b => b.addEventListener('click', () => { n.value = r.value = b.dataset.pg; sync(); }));
  sync();
}
