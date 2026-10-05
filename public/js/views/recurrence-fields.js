// Campos de repetição (tarefa recorrente) e prévia ao vivo das próximas datas.
import { html, api, icon, fmtDate } from '../core.js';

const WD = [[1, 'Seg'], [2, 'Ter'], [3, 'Qua'], [4, 'Qui'], [5, 'Sex'], [6, 'Sáb'], [0, 'Dom']];
const FREQ = [['diaria', 'Diária', 'dia(s)'], ['semanal', 'Semanal', 'semana(s)'], ['mensal', 'Mensal', 'mês(es)']];

// Campos de término/antecedência/duração (reutilizados na edição da série)
export const endFields = (v = {}) => html`
  <div class="field"><span class="label">Término da recorrência</span>
    <div class="segmented seg-3">
      ${[['data', 'Em uma data', 'Última ocorrência até a data'], ['ocorrencias', 'Após N ocorrências', 'Número total de tarefas'], ['nunca', 'Sem término', 'Até encerrar manualmente']]
        .map(([k, l, d]) => html`<label><input type="radio" name="end_type" value="${k}" ${(v.end_type || 'data') === k ? 'checked' : ''}>${l}<small>${d}</small></label>`)}
    </div></div>
  <div class="form-row">
    <div class="field rec-end-data"><label for="end_date">Data de término</label><input id="end_date" name="end_date" type="date" value="${v.end_date || ''}"></div>
    <div class="field rec-end-count"><label for="end_count">Número de ocorrências</label><input id="end_count" name="end_count" type="number" min="1" max="500" inputmode="numeric" value="${v.end_count || 10}"></div>
  </div>
  <div class="form-row">
    <div class="field"><label for="lead_days">Criar cada ocorrência com quantos dias de antecedência?</label>
      <input id="lead_days" name="lead_days" type="number" min="0" max="90" inputmode="numeric" value="${v.lead_days ?? 7}">
      <span class="hint">A tarefa aparece nas listas esse número de dias antes do prazo (0 = no próprio dia).</span></div>
    <div class="field"><label for="duration_days">Duração de cada ocorrência (dias)</label>
      <input id="duration_days" name="duration_days" type="number" min="1" max="60" inputmode="numeric" value="${v.duration_days || 1}">
      <span class="hint">Define o início previsto (Gantt): prazo − duração + 1.</span></div>
  </div>`;

export const recurrenceFieldset = () => html`<fieldset class="fieldset form" id="rec-fs"><legend>Repetição</legend>
  <label class="switch"><input type="checkbox" id="rec-on">${icon('history')} <b>Repetir esta tarefa (recorrente)</b></label>
  <div id="rec-body" hidden class="form">
    <div class="field"><span class="label">Frequência</span>
      <div class="segmented seg-3">${FREQ.map(([k, l], i) => html`<label><input type="radio" name="freq" value="${k}" ${i === 1 ? 'checked' : ''}>${l}</label>`)}</div></div>
    <div class="form-row">
      <div class="field"><label for="interval">Repetir a cada</label>
        <div class="rec-inline"><input id="interval" name="interval" type="number" min="1" max="99" value="1" inputmode="numeric"><span id="rec-unit">semana(s)</span></div></div>
      <div class="field rec-mensal"><label for="month_day">No dia do mês</label><input id="month_day" name="month_day" type="number" min="1" max="31" inputmode="numeric">
        <span class="hint">Meses sem esse dia usam o último dia do mês.</span></div>
    </div>
    <div class="field rec-semanal"><span class="label">Nos dias</span>
      <div class="rec-days">${WD.map(([n, l]) => html`<label><input type="checkbox" name="weekday" value="${n}"><span>${l}</span></label>`)}</div></div>
    <label class="switch rec-diaria"><input type="checkbox" name="workdays_only">Somente dias úteis (segunda a sexta)</label>
    ${endFields()}
    <div class="rec-preview" id="rec-preview" aria-live="polite"></div>
  </div>
</fieldset>`;

// Liga o comportamento; retorna { enabled(), read() } para o envio do formulário
export function bindRecurrence(root, form, { onToggle } = {}) {
  const on = root.querySelector('#rec-on');
  const body = root.querySelector('#rec-body');
  const preview = root.querySelector('#rec-preview');
  const val = n => form.querySelector(`[name=${n}]:checked`)?.value;
  const read = () => ({
    freq: val('freq'),
    interval: Number(form.interval.value || 1),
    weekdays: [...form.querySelectorAll('[name=weekday]:checked')].map(c => Number(c.value)),
    month_day: form.month_day.value ? Number(form.month_day.value) : null,
    workdays_only: form.workdays_only.checked,
    start_date: form.due_date.value,
    end_type: val('end_type'),
    end_date: form.end_date.value,
    end_count: Number(form.end_count.value || 0),
    lead_days: Number(form.lead_days.value || 0),
    duration_days: Number(form.duration_days.value || 1),
  });
  const sync = () => {
    const f = val('freq');
    body.querySelectorAll('.rec-semanal').forEach(e => (e.style.display = f === 'semanal' ? '' : 'none'));
    body.querySelectorAll('.rec-mensal').forEach(e => (e.style.display = f === 'mensal' ? '' : 'none'));
    body.querySelectorAll('.rec-diaria').forEach(e => (e.style.display = f === 'diaria' ? '' : 'none'));
    root.querySelector('#rec-unit').textContent = FREQ.find(x => x[0] === f)[2];
    const et = val('end_type');
    body.querySelector('.rec-end-data').style.display = et === 'data' ? '' : 'none';
    body.querySelector('.rec-end-count').style.display = et === 'ocorrencias' ? '' : 'none';
    // Valores padrão a partir do prazo da 1ª ocorrência
    const d = form.due_date.value;
    if (d && f === 'semanal' && !form.querySelector('[name=weekday]:checked')) {
      const wd = new Date(Date.parse(d + 'T00:00:00Z')).getUTCDay();
      form.querySelector(`[name=weekday][value="${wd}"]`).checked = true;
    }
    if (d && f === 'mensal' && !form.month_day.value) form.month_day.value = Number(d.slice(8, 10));
  };
  let timer;
  const refresh = () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      if (!on.checked) return;
      if (!form.due_date.value) { preview.innerHTML = html`<span class="muted">Informe o prazo da 1ª ocorrência para ver as próximas datas.</span>`.toString(); return; }
      try {
        const p = await api('/recurrences/preview', { method: 'POST', body: read() });
        preview.innerHTML = html`<b>${p.description}</b>${p.total && read().end_type === 'data' ? html` · <span>${p.total} ocorrência(s) no total</span>` : ''}
          <div class="rec-dates">${p.next.map(d => html`<span>${fmtDate(d)}</span>`)}${p.total === null || p.total > p.next.length ? html`<span class="muted">…</span>` : ''}</div>`.toString();
      } catch (e) {
        preview.innerHTML = html`<span class="due-late">${e.message}</span>`.toString();
      }
    }, 250);
  };
  on.addEventListener('change', () => {
    body.hidden = !on.checked;
    onToggle?.(on.checked);
    sync();
    refresh();
  });
  form.addEventListener('change', () => { if (on.checked) { sync(); refresh(); } });
  form.addEventListener('input', e => { if (on.checked && ['interval', 'month_day', 'end_count', 'end_date', 'due_date'].includes(e.target.name)) refresh(); });
  return { enabled: () => on.checked, read };
}

// Ligação apenas dos campos de término (edição da série)
export function bindEndFields(form) {
  const sync = () => {
    const et = form.querySelector('[name=end_type]:checked')?.value;
    form.querySelector('.rec-end-data').style.display = et === 'data' ? '' : 'none';
    form.querySelector('.rec-end-count').style.display = et === 'ocorrencias' ? '' : 'none';
  };
  form.addEventListener('change', sync);
  sync();
}
