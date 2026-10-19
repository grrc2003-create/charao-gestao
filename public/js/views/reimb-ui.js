// Reembolsos: cartão "Meus reembolsos" (Meu painel) e listas usadas na Folha (Administrativa).
import { html, api, icon, fmtDate, todayISO } from '../core.js';
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

export function myReimbCard(data, { bare = false } = {}) {
  const items = data.items || [];
  const card = html`<section class="card" id="my-reimb">
    <div class="card-head"><h2>${icon('wallet')}Meus reembolsos</h2>
      <button type="button" class="btn btn-primary btn-sm" data-reimb-new>${icon('plus')}Lançar reembolso</button></div>
    ${data.pending_total ? html`<div class="card-body rb-sum">Aguardando a folha: <b>${money(data.pending_total)}</b></div>` : ''}
    ${items.length ? html`<ul class="rows rb-list">${items.map(r => html`<li class="rb-row">
        <div class="grow"><div class="row-title">${r.description}</div>
          <div class="row-meta"><span>${fmtDate(r.expense_date)}</span>${filesLinks(r.files)}${r.status === 'recusado' && r.decision_note ? html`<span class="rb-why">Motivo: ${r.decision_note}</span>` : ''}</div></div>
        <div class="rb-side"><b>${money(r.amount)}</b>${sitTag(r)}
          ${r.status === 'enviado' ? html`<button type="button" class="btn btn-ghost btn-sm" data-reimb-cancel="${r.id}">Cancelar</button>` : ''}</div>
      </li>`)}</ul>`
      : html`<div class="card-body muted">Gastou algo pela empresa? Lance aqui com o comprovante: o valor entra na folha de pagamento.</div>`}
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
