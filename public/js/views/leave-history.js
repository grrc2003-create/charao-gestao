// Histórico de ausências e férias: minhas solicitações, as que aprovei e (administrador) todas as aprovadas, com exclusão.
import { html, api, icon, fmtDate } from '../core.js';
import { toast, sheet } from '../ui.js';
import { pageHead } from './shared.js';
import { KIND, MK, pill } from './absence-ui.js';
import { reqPill } from './vacation-ui.js';

const DECIDED = { aprovada: 'Aprovada por', recusada: 'Recusada por', cancelada: 'Cancelada por' };
const typeLabel = r => (r.type === 'ausencia' ? KIND[r.kind] : r.label);
const period = r => (r.type === 'ausencia'
  ? html`<b>${fmtDate(r.start_date)}</b>${r.makeup_date ? html` · repõe em <b>${fmtDate(r.makeup_date)}</b>` : ''}`
  : html`<b>${fmtDate(r.start_date)} a ${fmtDate(r.end_date)}</b> · ${r.days} dia(s)`);
const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

const row = (r, { showName, canDelete }) => html`<li class="lh-row">
  <div class="lh-main">
    ${showName ? html`<b class="lh-name">${r.user_name}</b>` : ''}
    <span class="lh-what"><span class="lh-type lh-${r.type}">${typeLabel(r)}</span>${period(r)}</span>
    ${r.note ? html`<small>“${r.note}”</small>` : ''}
    <small>${DECIDED[r.status] && r.decided_by_name ? html`${DECIDED[r.status]} ${r.decided_by_name}${r.decided_at ? ` em ${fmtDate(r.decided_at)}` : ''}` : `Solicitada em ${fmtDate(r.created_at)}`}${r.decision_note ? ` · ${r.decision_note}` : ''}</small>
  </div>
  <div class="lh-side">
    ${reqPill(r.status)}${r.status === 'aprovada' && r.makeup_status ? pill(MK[r.makeup_status]) : ''}
    ${canDelete && r.status === 'aprovada' ? html`<button type="button" class="btn btn-ghost btn-sm lh-del" data-lh-del="${r.key}">${icon('trash')}Excluir</button>` : ''}
  </div></li>`;

export async function view({ query, setQuery, render }) {
  const d = await api('/leave-history');
  const tabs = [['minhas', 'Minhas solicitações', d.mine], ...(d.approved.length || d.can_delete ? [['aprovei', 'Que aprovei', d.approved]] : []), ...(d.all ? [['todas', 'Todas as aprovadas', d.all]] : [])];
  const f = { aba: tabs.some(t => t[0] === query.get('aba')) ? query.get('aba') : 'minhas', tipo: ['ausencia', 'ferias'].includes(query.get('tipo')) ? query.get('tipo') : '', ano: query.get('ano') || '', q: (query.get('q') || '').trim() };
  const base = tabs.find(t => t[0] === f.aba)[2];
  const years = [...new Set(base.map(r => r.start_date.slice(0, 4)))].sort().reverse();
  const list = base.filter(r => (!f.tipo || r.type === f.tipo) && (!f.ano || r.start_date.startsWith(f.ano)) && (!f.q || norm(`${r.user_name} ${r.note}`).includes(norm(f.q))));
  const showName = f.aba !== 'minhas';
  const chip = (k, v, label, n) => html`<button type="button" class="chip" data-f="${k}" data-v="${v}" aria-pressed="${f[k] === v}">${label}${n === undefined ? '' : html`<span class="n">${n}</span>`}</button>`;
  return {
    title: 'Ausências e férias',
    html: html`
      ${pageHead({ back: { href: '#/painel', label: 'Meu painel' }, eyebrow: 'Meu painel', title: 'Histórico de ausências e férias', sub: 'Confira as suas solicitações e as que você aprovou.' })}
      <div class="chips lh-tabs" role="group" aria-label="Ver">${tabs.map(([k, l, a]) => chip('aba', k, l, a.length))}</div>
      <form class="toolbar lh-filters" id="lh-f" role="search">
        <div class="chips" role="group" aria-label="Tipo">${chip('tipo', '', 'Tudo')}${chip('tipo', 'ausencia', 'Ausências')}${chip('tipo', 'ferias', 'Férias / recesso')}</div>
        <div class="lh-frow">
          ${showName ? html`<label class="search">${icon('search')}<span class="sr-only">Buscar pessoa</span><input type="search" name="q" value="${f.q}" placeholder="Buscar pessoa ou motivo" autocomplete="off"></label>` : ''}
          <select name="ano" aria-label="Ano"><option value="">Todos os anos</option>${years.map(y => html`<option ${f.ano === y ? 'selected' : ''}>${y}</option>`)}</select>
        </div>
      </form>
      ${list.length ? html`<section class="card section"><ul class="lh-list">${list.map(r => row(r, { showName, canDelete: d.can_delete }))}</ul></section>`
        : html`<div class="empty-state"><h2>Nada por aqui</h2><p>${base.length ? 'Nenhuma solicitação com estes filtros.' : f.aba === 'minhas' ? 'Você ainda não fez nenhuma solicitação.' : 'Nenhuma solicitação aprovada ainda.'}</p></div>`}`,
    mount(root) {
      const go = patch => { setQuery({ ...f, ...patch }); render(); };
      root.querySelectorAll('[data-f]').forEach(b => b.addEventListener('click', () => go(b.dataset.f === 'aba' ? { aba: b.dataset.v, q: '', ano: '' } : { [b.dataset.f]: b.dataset.v })));
      const form = root.querySelector('#lh-f');
      form.addEventListener('submit', e => e.preventDefault());
      form.ano.addEventListener('change', () => go({ ano: form.ano.value }));
      let t;
      form.q?.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => go({ q: form.q.value.trim() }), 400); });
      if (f.q && form.q) { form.q.focus(); form.q.setSelectionRange(f.q.length, f.q.length); }
      root.querySelectorAll('[data-lh-del]').forEach(b => b.addEventListener('click', async () => {
        const r = base.find(x => x.key === b.dataset.lhDel);
        if (!r) return;
        const done = await sheet({
          title: 'Excluir solicitação aprovada', danger: true, submitLabel: 'Excluir definitivamente',
          body: html`<p style="margin-top:0"><b>${r.user_name}</b> · ${typeLabel(r)} · ${period(r)}</p>
            <p class="muted">A exclusão não pode ser desfeita. ${r.type === 'ausencia' ? 'O dia deixa de contar como falta e sai dos descontos das folhas ainda abertas; a tarefa de confirmação de presença em aberto é cancelada.' : 'Os dias voltam para o saldo da pessoa.'}
              Folhas já fechadas e prazos de tarefas já alterados não mudam. Fica o registro na Auditoria.</p>
            <div class="field"><label class="req" for="lh-why">Motivo da exclusão</label><textarea id="lh-why" name="note" rows="2" required maxlength="1000"></textarea></div>`,
          onSubmit: x => api(`/${r.type === 'ausencia' ? 'absences' : 'vacations'}/${r.id}/delete`, { method: 'POST', body: x }),
        });
        if (done) { toast('Solicitação excluída.'); render(); }
      }));
    },
  };
}
