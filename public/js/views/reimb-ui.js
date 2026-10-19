// Reembolsos: cartão "Meus reembolsos" (Meu painel) e listas usadas na Folha (Administrativa).
import { html, api, icon, fmtDate, todayISO } from '../core.js';
import { pageHead } from './shared.js';
import { toast, sheet, confirmSheet, readAttachments } from '../ui.js';

const BRL = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
export const money = v => BRL.format(Number(v) || 0);
const refLabel = ref => (ref ? `${ref.slice(5, 7)}/${ref.slice(0, 4)}` : '');
export const SIT = {
  enviado: ['Aguardando a folha', 'rb-wait'],
  incluido: ['Incluído na folha', 'rb-in'],
  pago: ['Pago na folha', 'rb-paid'],
  recusado: ['Recusado', 'rb-no'],
  cancelado: ['Cancelado', 'rb-off'],
};
export const sitTag = r => html`<span class="rb-st ${SIT[r.situation][1]}">${SIT[r.situation][0]}${r.month_ref && ['incluido', 'pago'].includes(r.situation) ? ` ${refLabel(r.month_ref)}` : ''}</span>`;
export const filesLinks = files => (files?.length ? html`<span class="rb-files">${files.map((f, i) => html`<a href="/api/reimbursement-files/${f.id}" target="_blank" rel="noopener" title="${f.original_name || 'Comprovante'}">${icon(f.mime === 'application/pdf' ? 'file' : 'image')}${files.length > 1 ? i + 1 : 'Comprovante'}</a>`)}</span>` : '');

const isOpen = r => r.situation === 'enviado' || r.situation === 'incluido';
const row = r => html`<li class="rb-row">
        <div class="grow"><div class="row-title">${r.description}</div>
          <div class="row-meta"><span>${fmtDate(r.expense_date)}</span>${filesLinks(r.files)}${r.status === 'recusado' && r.decision_note ? html`<span class="rb-why">Motivo: ${r.decision_note}</span>` : ''}</div></div>
        <div class="rb-side"><b>${money(r.amount)}</b>${sitTag(r)}
          ${r.status === 'enviado' ? html`<button type="button" class="btn btn-ghost btn-sm" data-reimb-cancel="${r.id}">Cancelar</button>` : ''}</div>
      </li>`;

// Meu painel: só os reembolsos em aberto (aguardando a folha ou incluídos em folha ainda não paga)
export function myReimbCard(data, { bare = false } = {}) {
  const items = (data.items || []).filter(isOpen);
  const closed = (data.items || []).length - items.length;
  const card = html`<section class="card" id="my-reimb">
    <div class="card-head"><h2>${icon('wallet')}Meus reembolsos</h2>
      <div class="rb-head-acts">${(data.items || []).length ? html`<a class="btn btn-ghost btn-sm" href="#/painel/reembolsos">${icon('history')}Histórico</a>` : ''}
        <button type="button" class="btn btn-primary btn-sm" data-reimb-new>${icon('plus')}Lançar reembolso</button></div></div>
    ${data.pending_total ? html`<div class="card-body rb-sum">Aguardando a folha: <b>${money(data.pending_total)}</b></div>` : ''}
    ${items.length ? html`<ul class="rows rb-list">${items.map(row)}</ul>`
      : html`<div class="card-body muted">${closed ? 'Nenhum reembolso em aberto. Os já pagos estão no Histórico.' : 'Gastou algo pela empresa? Lance aqui com o comprovante: o valor entra na folha de pagamento.'}</div>`}
  </section>`;
  return bare ? card : html`<div class="grid grid-dash section">${card}</div>`;
}

export function bindMyReimbCard(root, render) {
  root.querySelector('[data-reimb-new]')?.addEventListener('click', () => sheet({
    title: 'Lançar reembolso',
    body: html`<div class="form-row">
        <div class="field"><label class="req" for="rb-d">Data da despesa</label><input type="date" id="rb-d" name="expense_date" required max="${todayISO()}" value="${todayISO()}"></div>
        <div class="field"><label class="req" for="rb-v">Valor (R$)</label><input type="text" id="rb-v" name="amount" inputmode="decimal" required placeholder="0,00"></div>
      </div>
      <div class="field"><label class="req" for="rb-t">Descrição</label><input type="text" id="rb-t" name="description" maxlength="300" required placeholder="Ex.: material de escritório, combustível, estacionamento"></div>
      <div class="field"><span class="sub-label req">Comprovante (foto ou PDF)</span>
        <label class="btn btn-ghost rb-pick">${icon('camera')}<span data-rb-fname>Tirar foto ou escolher arquivo</span><input type="file" id="rb-f" accept="image/*,application/pdf,.pdf" multiple hidden></label>
        <span class="hint">Nota fiscal, cupom ou recibo. Pode tirar a foto pelo celular.</span></div>
      <p class="muted" style="margin:0">O reembolso é pago junto com a folha, depois de conferido.</p>`,
    submitLabel: 'Enviar reembolso',
    async onSubmit(d, form) {
      const input = form.querySelector('#rb-f');
      if (!input.files?.length) throw new Error('Anexe o comprovante (foto ou PDF).');
      const files = await readAttachments(input.files);
      await api('/reimbursements', { method: 'POST', body: { expense_date: d.expense_date, amount: /,/.test(d.amount) ? String(d.amount).replace(/\./g, '').replace(',', '.') : String(d.amount), description: d.description, files } });
      toast('Reembolso enviado. Ele entra na próxima folha.');
      render();
    },
  }));
  root.querySelectorAll('[data-reimb-cancel]').forEach(b => b.addEventListener('click', async () => {
    if (!(await confirmSheet('Cancelar reembolso', 'O reembolso deixa de aguardar a folha.', 'Cancelar reembolso', true))) return;
    try { await api(`/reimbursements/${b.dataset.reimbCancel}/cancel`, { method: 'POST' }); toast('Reembolso cancelado.'); render(); } catch (e) { toast(e.message, 'error'); }
  }));
}

// Nome dos comprovantes escolhidos (na folha de lançamento)
document.addEventListener('change', e => {
  if (e.target.id !== 'rb-f') return;
  const n = e.target.files?.length || 0;
  const span = e.target.closest('.rb-pick')?.querySelector('[data-rb-fname]');
  if (span) span.textContent = n ? (n === 1 ? e.target.files[0].name : `${n} arquivos escolhidos`) : 'Tirar foto ou escolher arquivo';
});

// ---------- Histórico (Meu painel → Histórico) ----------
const MONTHS = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
const monthName = ym => `${MONTHS[Number(ym.slice(5, 7)) - 1]} de ${ym.slice(0, 4)}`;
export async function history({ render }) {
  const data = await api('/reimbursements/me');
  const items = data.items || [];
  const open = items.filter(isOpen);
  const paid = items.filter(r => r.situation === 'pago');
  const other = items.filter(r => r.situation === 'recusado' || r.situation === 'cancelado');
  const byMonth = new Map();
  for (const r of [...paid].sort((a, b) => (b.month_ref || '').localeCompare(a.month_ref || '') || b.expense_date.localeCompare(a.expense_date))) {
    if (!byMonth.has(r.month_ref)) byMonth.set(r.month_ref, []);
    byMonth.get(r.month_ref).push(r);
  }
  const total = list => list.reduce((s, r) => s + r.amount, 0);
  const first = [...byMonth.keys()][0];
  return {
    title: 'Histórico de reembolsos',
    html: html`
      ${pageHead({ back: { href: '#/painel', label: 'Meu painel' }, eyebrow: 'Meu painel', title: 'Histórico de reembolsos', sub: 'Valores pagos por mês (folha em que entraram), em aberto e recusados.' })}
      <div class="rb-kpis section">
        <div><span>Pago no total</span><b>${money(total(paid))}</b></div>
        <div><span>Em aberto</span><b>${money(total(open))}</b></div>
        <div><span>Reembolsos pagos</span><b>${paid.length}</b></div>
      </div>
      ${open.length ? html`<section class="card section"><div class="card-head"><h2>${icon('clock')}Em aberto</h2><span class="sub">${money(total(open))}</span></div><ul class="rows rb-list">${open.map(row)}</ul></section>` : ''}
      ${byMonth.size ? [...byMonth].map(([ref, list]) => html`<details class="card section rb-month" ${ref === first ? 'open' : ''}>
          <summary class="card-head"><h2>${icon('check')}Pago na folha de ${monthName(ref)}</h2><span class="sub"><b>${money(total(list))}</b> · ${list.length} reembolso(s)</span></summary>
          <ul class="rows rb-list">${list.map(row)}</ul></details>`)
        : html`<div class="empty-state"><h2>Nenhum reembolso pago ainda</h2><p>Quando a folha em que o reembolso entrou for fechada, ele aparece aqui no mês do pagamento.</p></div>`}
      ${other.length ? html`<details class="card section rb-month"><summary class="card-head"><h2>${icon('x')}Recusados e cancelados</h2><span class="sub">${other.length}</span></summary><ul class="rows rb-list">${other.map(row)}</ul></details>` : ''}`,
    mount(root) { bindMyReimbCard(root, render); },
  };
}

// Recusar (Folha)
export function rejectSheet(r, done) {
  sheet({
    title: 'Recusar reembolso',
    body: html`<p class="muted" style="margin-top:0">${r.user_name || ''} · ${r.description} · ${money(r.amount)}</p>
      <div class="field"><label class="req" for="rj-n">Motivo (a pessoa vê no Meu painel)</label><textarea id="rj-n" name="note" rows="3" maxlength="500" required></textarea></div>`,
    submitLabel: 'Recusar',
    danger: true,
    async onSubmit(d) {
      if (!String(d.note || '').trim()) throw new Error('Informe o motivo.');
      await api(`/reimbursements/${r.id}/reject`, { method: 'POST', body: { note: d.note } });
      toast('Reembolso recusado.');
      done();
    },
  });
}
