// Campos de repetição (tarefa recorrente) e prévia ao vivo das próximas datas.
import { html, api, icon, fmtDate } from '../core.js';

const WD = [[1, 'Seg'], [2, 'Ter'], [3, 'Qua'], [4, 'Qui'], [5, 'Sex'], [6, 'Sáb'], [0, 'Dom']];
const FREQ = [['diaria', 'Diária', 'dia(s)'], ['semanal', 'Semanal', 'semana(s)'], ['mensal', 'Mensal', 'mês(es)'], ['anual', 'Anual', 'ano(s)']];
export const MONTHS = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];
const monthOpts = (cur, empty) => html`${empty ? html`<option value="">${empty}</option>` : ''}${MONTHS.map((m, i) => html`<option value="${i + 1}" ${Number(cur) === i + 1 ? 'selected' : ''}>${m}</option>`)}`;
// Período de cada ocorrência (mensal e anual): início na data da regra + N dias úteis ou corridos = término
export const periodFields = (v = {}) => html`<div class="rec-period">
  <div class="form-row">
    <div class="field"><label for="period_days">Duração do período (dias)</label><input id="period_days" name="period_days" type="number" min="1" max="366" inputmode="numeric" value="${v.period_days || 5}"></div>
    <div class="field"><span class="label">Contar em</span>
      <div class="segmented"><label><input type="radio" name="period_day_type" value="uteis" ${v.period_day_type !== 'corridos' ? 'checked' : ''}>Dias úteis<small>calendário da obra</small></label>
        <label><input type="radio" name="period_day_type" value="corridos" ${v.period_day_type === 'corridos' ? 'checked' : ''}>Dias corridos<small>todos os dias</small></label></div></div>
  </div>
  <span class="hint">O dia de início conta como o 1º dia; o término (prazo) é calculado. Em dias úteis, se o início cair em fim de semana, feriado ou folga do responsável, a contagem começa no próximo dia útil.</span>
</div>`;

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
      <span class="hint rec-lead-hint">A tarefa aparece nas listas esse número de dias antes do prazo (0 = no próprio dia).</span></div>
    <div class="field rec-dur"><label for="duration_days">Duração de cada ocorrência (dias)</label>
      <input id="duration_days" name="duration_days" type="number" min="1" max="60" inputmode="numeric" value="${v.duration_days || 1}">
      <span class="hint">Define o início previsto (Gantt): prazo − duração + 1.</span></div>
  </div>`;

export const recurrenceFieldset = () => html`<fieldset class="fieldset form" id="rec-fs"><legend>Repetição</legend>
  <label class="switch"><input type="checkbox" id="rec-on">${icon('history')} <b>Repetir esta tarefa (recorrente)</b></label>
  <div id="rec-body" hidden class="form">
    <div class="field"><span class="label">Frequência</span>
      <div class="segmented seg-4">${FREQ.map(([k, l], i) => html`<label><input type="radio" name="freq" value="${k}" ${i === 1 ? 'checked' : ''}>${l}</label>`)}</div></div>
    <div class="form-row">
      <div class="field"><label for="interval">Repetir a cada</label>
        <div class="rec-inline"><input id="interval" name="interval" type="number" min="1" max="99" value="1" inputmode="numeric"><span id="rec-unit">semana(s)</span></div></div>
      <div class="field rec-md"><label for="month_day" id="md-label">Prazo: dia do mês</label><input id="month_day" name="month_day" type="number" min="1" max="31" inputmode="numeric">
        <span class="hint">Meses sem esse dia usam o último dia do mês.</span></div>
      <div class="field rec-anual"><label for="year_month" id="ym-label">Prazo: mês</label><select id="year_month" name="year_month">${monthOpts(null, '—')}</select></div>
    </div>
    <div class="field rec-md"><span class="label">Como definir cada ocorrência</span>
      <div class="segmented"><label><input type="radio" name="period_mode" value="prazo" checked>Pelo prazo<small>dia do vencimento</small></label>
        <label><input type="radio" name="period_mode" value="inicio">Início + dias<small>úteis ou corridos até o término</small></label></div></div>
    <div class="rec-md rec-per">${periodFields()}</div>
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
  const perOn = () => ['mensal', 'anual'].includes(val('freq')) && val('period_mode') === 'inicio';
  const read = () => ({
    freq: val('freq'),
    interval: Number(form.interval.value || 1),
    weekdays: [...form.querySelectorAll('[name=weekday]:checked')].map(c => Number(c.value)),
    month_day: form.month_day.value ? Number(form.month_day.value) : null,
    year_month: form.year_month.value ? Number(form.year_month.value) : null,
    ...(perOn() ? { period_days: Number(form.period_days.value || 0) || null, period_day_type: val('period_day_type') || 'uteis' } : { period_days: null, period_day_type: null }),
    project_id: form.project_id?.value || null,
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
    body.querySelectorAll('.rec-md').forEach(e => (e.style.display = f === 'mensal' || f === 'anual' ? '' : 'none'));
    body.querySelectorAll('.rec-anual').forEach(e => (e.style.display = f === 'anual' ? '' : 'none'));
    // Início + dias: a data da regra é o INÍCIO de cada ocorrência; o término sai da contagem de dias
    const per = perOn();
    const what = per ? 'Início' : 'Prazo';
    root.querySelector('#md-label').textContent = f === 'anual' ? `${what}: dia` : `${what}: dia do mês`;
    root.querySelector('#ym-label').textContent = `${what}: mês`;
    const dl = root.querySelector('#due-label');
    if (dl) dl.textContent = per ? 'Início da 1ª ocorrência' : 'Prazo da 1ª ocorrência';
    body.querySelectorAll('.rec-per').forEach(e => (e.style.display = per ? '' : 'none'));
    body.querySelectorAll('.rec-dur').forEach(e => (e.style.display = per ? 'none' : ''));
    const lh = body.querySelector('.rec-lead-hint');
    if (lh) lh.textContent = per ? 'A tarefa aparece nas listas esse número de dias antes do início do período (0 = no próprio dia).' : 'A tarefa aparece nas listas esse número de dias antes do prazo (0 = no próprio dia).';
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
    if (d && (f === 'mensal' || f === 'anual') && !form.month_day.value) form.month_day.value = Number(d.slice(8, 10));
    if (d && f === 'anual' && !form.year_month.value) form.year_month.value = String(Number(d.slice(5, 7)));
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
          <div class="rec-dates">${p.periods ? p.periods.map(x => html`<span>${fmtDate(x.start)} → ${fmtDate(x.due)}</span>`) : p.next.map(d => html`<span>${fmtDate(d)}</span>`)}${p.total === null || p.total > p.next.length ? html`<span class="muted">…</span>` : ''}</div>`.toString();
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
  form.addEventListener('input', e => { if (on.checked && ['interval', 'month_day', 'period_days', 'end_count', 'end_date', 'due_date'].includes(e.target.name)) { sync(); refresh(); } });
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
