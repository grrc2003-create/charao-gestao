// Calendário da obra (página do projeto): feriados nacionais, estaduais e municipais, dias não trabalhados da empresa
// e da obra; a obra pode marcar que trabalha num feriado e incluir dias próprios. Carrega ao abrir.
import { html, api, icon, fmtDate } from '../core.js';
import { toast, sheet } from '../ui.js';

const SCOPE = { nacional: 'Nacional', estadual: 'Estadual', municipal: 'Municipal', empresa: 'Empresa', obra: 'Obra' };
const MONTHS = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];
const WD = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
const wd = d => WD[new Date(`${d}T00:00:00Z`).getUTCDay()];

export function calendarSection(p) {
  const local = p.uf ? `${p.municipio || 'município não informado'}/${p.uf}` : 'local da obra não informado';
  return html`<details class="card section cal-sec" data-cal>
    <summary class="card-head"><h2>${icon('calendar')}Calendário da obra</h2><span class="sub">feriados e dias não trabalhados · ${local}</span></summary>
    <div class="card-body" data-cal-body><p class="muted">Carregando…</p></div>
  </details>`;
}

function render(c) {
  const byMonth = new Map();
  for (const d of c.days) {
    const m = Number(d.date.slice(5, 7)) - 1;
    if (!byMonth.has(m)) byMonth.set(m, []);
    byMonth.get(m).push(d);
  }
  const off = c.days.filter(d => d.off).length;
  return html`
    ${!c.uf ? html`<div class="notice">${icon('info')}<span>Informe o <b>estado e o município</b> da obra em <b>Editar</b> para incluir os feriados locais. Por enquanto valem os nacionais e os da empresa.</span></div>` : ''}
    <div class="cal-tools">
      <button type="button" class="btn btn-ghost btn-sm" data-cal-year="${c.year - 1}">‹ ${c.year - 1}</button>
      <b>${c.year}</b>
      <button type="button" class="btn btn-ghost btn-sm" data-cal-year="${c.year + 1}">${c.year + 1} ›</button>
      <span class="muted" style="font-size:12.5px">${off} dia(s) não trabalhado(s) além dos fins de semana${c.settings.work_saturday ? ' (sábado é dia útil)' : ''}</span>
      ${c.can_edit ? html`<button type="button" class="btn btn-ghost btn-sm" data-cal-add>${icon('plus')}Dia não trabalhado</button>` : ''}
      ${c.can_edit && c.uf ? html`<button type="button" class="btn btn-ghost btn-sm" data-cal-sync>${icon('history')}Atualizar feriados da internet</button>` : ''}
    </div>
    ${[...byMonth.keys()].sort((a, b) => a - b).map(m => html`<div class="cal-month">${MONTHS[m]}</div>
      <ul class="cal-list">${byMonth.get(m).map(d => html`<li class="cal-day ${d.off ? '' : 'is-working'}">
        <span class="cal-date">${fmtDate(d.date).slice(0, 5)} <span class="muted">${wd(d.date)}</span></span>
        <span class="cal-name">${d.name}${d.optional && !d.off && !d.override_id ? html` <span class="muted">(trabalhado — Configurações)</span>` : ''}</span>
        <span class="cal-scope s-${d.scope}">${SCOPE[d.scope] || d.scope}</span>
        ${c.can_edit && !d.company && !(d.optional && !d.override_id && !d.off) ? html`<label class="cal-work"><input type="checkbox" data-cal-work data-id="${d.id || ''}" data-date="${d.date}" data-name="${d.name}" ${d.off ? '' : 'checked'}>obra trabalha</label>` : ''}
        ${c.can_edit && d.source === 'manual' && d.scope === 'obra' ? html`<button type="button" class="icon-btn" data-cal-rm="${d.id}" aria-label="Excluir">✕</button>` : ''}
      </li>`)}</ul>`)}
    <p class="hint" style="margin-top:10px">${c.synced_at ? `Feriados locais buscados na internet em ${new Date(c.synced_at).toLocaleDateString('pt-BR')} (base aberta “feriados-brasil”).` : ''}
      Fins de semana e dias não trabalhados não contam nos dias úteis das tarefas.</p>`;
}

export function bindCalendar(root, p) {
  const d = root.querySelector('[data-cal]');
  if (!d) return;
  const body = d.querySelector('[data-cal-body]');
  let year = new Date().getFullYear();
  const load = async () => {
    try { body.innerHTML = render(await api(`/projects/${p.id}/calendar`, { query: { year } })).toString(); bind(); } catch (e) { body.innerHTML = html`<p class="muted">${e.message}</p>`.toString(); }
  };
  const act = async (fn, msg) => { try { await fn(); if (msg) toast(msg); load(); } catch (e) { toast(e.message, 'err'); } };
  const bind = () => {
    body.querySelectorAll('[data-cal-year]').forEach(b => b.addEventListener('click', () => { year = Number(b.dataset.calYear); load(); }));
    body.querySelectorAll('[data-cal-work]').forEach(c => c.addEventListener('change', () => act(() => api(`/projects/${p.id}/calendar/days`, { method: 'PATCH',
      body: { id: c.dataset.id || null, date: c.dataset.date, name: c.dataset.name, working: c.checked } }), c.checked ? 'A obra trabalha neste dia.' : 'Dia volta a ser não trabalhado.')));
    body.querySelectorAll('[data-cal-rm]').forEach(b => b.addEventListener('click', () => act(() => api(`/projects/${p.id}/calendar/days/${b.dataset.calRm}`, { method: 'DELETE' }), 'Dia excluído.')));
    body.querySelector('[data-cal-sync]')?.addEventListener('click', () => act(async () => {
      const r = await api(`/projects/${p.id}/calendar/sync`, { method: 'POST' });
      if (!r.ok) throw new Error(r.message);
      toast(r.municipal_found ? `Feriados atualizados (${r.count}).` : 'Feriados do estado atualizados. Não encontramos feriados municipais desta cidade: inclua manualmente.', r.municipal_found ? undefined : 'warn');
    }));
    body.querySelector('[data-cal-add]')?.addEventListener('click', async () => {
      const r = await sheet({ title: 'Dia não trabalhado da obra', submitLabel: 'Incluir',
        body: html`<div class="field"><label class="req" for="cd-d">Data</label><input id="cd-d" name="date" type="date" required></div>
          <div class="field"><label class="req" for="cd-n">Motivo</label><input id="cd-n" name="name" type="text" maxlength="120" required placeholder="Ex.: Feriado municipal não listado, paralisação"></div>`,
        onSubmit: v => api(`/projects/${p.id}/calendar/days`, { method: 'POST', body: v }) });
      if (r) { toast('Dia incluído.'); load(); }
    });
  };
  try { if (sessionStorage.getItem(`charao-cal-${p.id}`) === '1') { d.open = true; load(); } } catch { /* sem armazenamento */ }
  d.addEventListener('toggle', () => { try { sessionStorage.setItem(`charao-cal-${p.id}`, d.open ? '1' : '0'); } catch { /* sem armazenamento */ } if (d.open) load(); });
}
