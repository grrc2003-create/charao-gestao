// Lista do mês do Financeiro: cada despesa é um check (a confirmar → vai ter / não vai ter → pago).
// Usada na tarefa "Contas do mês" e na visão do mês do Financeiro.
import { html, api, icon, fmtDate, todayISO } from '../core.js';
import { toast, sheet, confirmSheet, readAttachments } from '../ui.js';

const BRL = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const money = v => BRL.format(Number(v) || 0);
const parseNum = v => { const s = String(v ?? '').trim(); if (!s) return ''; const n = Number(s.includes(',') ? s.replace(/\./g, '').replace(',', '.') : s); return Number.isFinite(n) ? n : ''; };
export const CHECK = {
  a_confirmar: { label: 'A confirmar', ic: 'clock', cls: 'ck-todo' },
  vai_ter: { label: 'Vai ter · a pagar', ic: 'calendar', cls: 'ck-yes' },
  pago: { label: 'Pago', ic: 'check', cls: 'ck-paid' },
  pago_aguardando: { label: 'Pago · aguardando Mais Controle', ic: 'check', cls: 'ck-paid' },
  nao_vai_ter: { label: 'Não vai ter no mês', ic: 'x', cls: 'ck-no' },
};
export const checkBadge = st => html`<span class="ck-badge ${CHECK[st]?.cls || ''}">${icon(CHECK[st]?.ic || 'clock')}${CHECK[st]?.label || st}</span>`;
const fileLinks = files => (files || []).length ? html`<span class="ck-files">${files.map((f, i) => html`<a href="${f.src === 'item' ? '/api/finance-item-files/' : '/api/files/'}${f.id}" target="_blank" rel="noopener">${icon(f.mime === 'application/pdf' ? 'file' : 'image')}${files.length > 1 ? `comprovante ${i + 1}` : 'comprovante'}</a>`)}</span>` : '';

// Barra de avanço com as quantidades (vai ter conta meio)
export const checkProgress = s => html`<div class="ck-prog" role="img" aria-label="Avanço ${s.pct}%">
    <div class="ck-bar"><i class="ck-b-done" style="width:${s.total ? (s.resolved / s.total) * 100 : 0}%"></i><i class="ck-b-yes" style="width:${s.total ? (s.vai_ter / s.total) * 100 : 0}%"></i></div>
    <div class="ck-leg"><b>${s.pct}%</b><span>${s.resolved} de ${s.total} resolvido(s)</span>${s.a_confirmar ? html`<span class="ck-l-todo">${s.a_confirmar} a confirmar</span>` : ''}${s.vai_ter ? html`<span class="ck-l-yes">${s.vai_ter} a pagar</span>` : ''}</div></div>`;

// Botões de cada check
export const checkActions = i => {
  if (i.check === 'a_confirmar') return html`<button type="button" class="btn btn-primary btn-sm" data-ck-yes="${i.id}">${icon('check')}Vai ter</button><button type="button" class="btn btn-ghost btn-sm" data-ck-no="${i.id}">Não vai ter</button>`;
  if (i.check === 'vai_ter') return html`<button type="button" class="btn btn-success btn-sm" data-ck-pay="${i.id}">${icon('check')}Pagar</button><button type="button" class="btn btn-ghost btn-sm" data-ck-unyes="${i.id}">desfazer</button>`;
  if (i.check === 'pago' || i.check === 'nao_vai_ter') return html`<button type="button" class="btn btn-ghost btn-sm" data-ck-unpay="${i.id}">desfazer</button>`;
  return '';
};
const row = i => html`<li class="ck-row ${CHECK[i.check]?.cls || ''}">
    <div class="ck-main"><b>${i.title}</b><small>${i.category}${i.payee ? ` · ${i.payee}` : ''} · vence ${fmtDate(i.due_date)}</small>${i.reason ? html`<small class="ck-reason">${i.reason}</small>` : ''}</div>
    <div class="ck-val"><b>${money(i.check === 'pago' || i.check === 'nao_vai_ter' ? i.paid_amount : i.amount_expected)}</b>${i.check === 'pago' && i.paid_date ? html`<small>pago em ${fmtDate(i.paid_date)}</small>` : i.variable && i.check !== 'nao_vai_ter' ? html`<small>${i.estimated ? 'valor estimado' : 'valor variável'}</small>` : ''}</div>
    <div class="ck-st">${checkBadge(i.check)}${fileLinks(i.files)}</div>
    <div class="ck-act">${checkActions(i)}</div></li>`;

// Seção da tarefa "Contas do mês"
export const monthChecksSection = d => html`<section class="card block ck-card" aria-labelledby="blk-ck">
    <header class="block-head"><span class="step">${icon('check')}</span><h2 id="blk-ck">Lista do mês · ${d.label}${d.assignee_name ? ` · ${d.assignee_name}` : ''}</h2></header>
    <div class="block-body">
      ${checkProgress(d.summary)}
      <p class="muted ck-help">Marque em cada despesa se <b>vai ter</b> ou <b>não vai ter</b> neste mês e registre o pagamento. A tarefa avança com os checks e conclui sozinha quando todos estiverem resolvidos.</p>
      ${d.items.length ? html`<ul class="ck-list">${d.items.map(row)}</ul>` : html`<p class="muted">Nenhuma despesa nesta lista.</p>`}
    </div></section>`;

// Ações (delegadas): vai ter (valor do mês nas variáveis), não vai ter (motivo opcional), pagar (data, valor, comprovante), desfazer
export function bindChecks(root, items, done) {
  const byId = new Map(items.map(i => [i.id, i]));
  root.addEventListener('click', async e => {
    let b = e.target.closest('[data-ck-yes],[data-ck-no],[data-ck-pay],[data-ck-unyes],[data-ck-unpay],[data-ck-ask]');
    if (!b) return;
    // Visão do mês: um botão só pergunta "vai ter ou não?" (Sim/Não, sem padrão)
    if (b.dataset.ckAsk) {
      const it0 = byId.get(Number(b.dataset.ckAsk));
      const r = await sheet({
        title: it0 ? it0.title : 'Despesa do mês', submitLabel: 'Continuar',
        body: html`<p class="muted" style="margin-top:0">Esta despesa vai acontecer neste mês?</p>
          <div class="segmented" role="radiogroup" aria-label="Vai ter neste mês?">
            <label><input type="radio" name="ck" value="sim" required>Vai ter<small>Fica a pagar na lista do mês</small></label>
            <label><input type="radio" name="ck" value="nao" required>Não vai ter<small>Resolvida sem pagamento (R$ 0,00)</small></label></div>`,
        onSubmit: d => { if (!d.ck) throw new Error('Escolha "Vai ter" ou "Não vai ter".'); return d; },
      });
      if (!r) return;
      b = { dataset: r.ck === 'sim' ? { ckYes: b.dataset.ckAsk } : { ckNo: b.dataset.ckAsk } };
    }
    const id = Number(b.dataset.ckYes || b.dataset.ckNo || b.dataset.ckPay || b.dataset.ckUnyes || b.dataset.ckUnpay);
    const it = byId.get(id);
    if (!it) return;
    try {
      if (b.dataset.ckYes) {
        if (it.variable) {
          const r = await sheet({
            title: `Vai ter · ${it.title}`, submitLabel: 'Confirmar',
            body: html`<div class="field"><label class="req" for="ck-v">Valor deste mês (R$)</label><input type="text" id="ck-v" name="amount" required inputmode="decimal" value="${String(it.amount_expected).replace('.', ',')}">
              ${it.previous_amount != null ? html`<span class="hint">Mês anterior: ${money(it.previous_amount)}</span>` : ''}</div>`,
            onSubmit: d => api(`/finance/items/${id}/confirm`, { method: 'POST', body: { amount: parseNum(d.amount) } }),
          });
          if (!r) return;
        } else await api(`/finance/items/${id}/confirm`, { method: 'POST', body: {} });
        toast(`${it.title}: vai ter neste mês.`);
      } else if (b.dataset.ckNo) {
        const r = await sheet({
          title: `Não vai ter · ${it.title}`, submitLabel: 'Confirmar',
          body: html`<p class="muted" style="margin-top:0">A despesa fica resolvida neste mês sem pagamento (real R$ 0,00).</p>
            <div class="field"><label for="ck-r">Motivo (opcional)</label><input type="text" id="ck-r" name="reason" maxlength="500" placeholder="Ex.: sem consumo no mês"></div>`,
          onSubmit: d => api(`/finance/items/${id}/skip`, { method: 'POST', body: { reason: d.reason } }),
        });
        if (!r) return;
        toast(`${it.title}: não vai ter neste mês.`);
      } else if (b.dataset.ckPay) {
        const r = await sheet({
          title: `Pagar · ${it.title}`, submitLabel: 'Registrar pagamento',
          body: html`<div class="form-row"><div class="field"><label class="req" for="ck-d">Data do pagamento</label><input type="date" id="ck-d" name="paid_date" required max="${todayISO()}" value="${todayISO()}"></div>
              <div class="field"><label for="ck-pv">Valor pago (R$)</label><input type="text" id="ck-pv" name="paid_amount" inputmode="decimal" value="${String(it.amount_expected).replace('.', ',')}"></div></div>
            <div class="field"><label for="ck-f">Comprovante (foto ou PDF)</label><input type="file" id="ck-f" accept="image/*,application/pdf,.pdf" multiple></div>
            <div class="field"><label for="ck-n">Observação</label><input type="text" id="ck-n" name="notes" maxlength="1000"></div>`,
          onSubmit: async (d, form) => {
            const files = await readAttachments(form.querySelector('#ck-f').files || []);
            return api(`/finance/items/${id}/pay`, { method: 'POST', body: { paid_date: d.paid_date, paid_amount: parseNum(d.paid_amount), notes: d.notes, files: files.map(f => ({ data: f.data, name: f.name })) } });
          },
        });
        if (!r) return;
        toast('Pagamento registrado.');
      } else if (b.dataset.ckUnyes) {
        await api(`/finance/items/${id}/unconfirm`, { method: 'POST' });
        toast('Voltou a confirmar.');
      } else if (b.dataset.ckUnpay) {
        if (!(await confirmSheet('Desfazer', `"${it.title}" volta a ficar pendente neste mês.`, 'Desfazer'))) return;
        await api(`/finance/items/${id}/unpay`, { method: 'POST' });
        toast('Desfeito.');
      }
      done();
    } catch (ex) { toast(ex.message, 'error'); }
  });
}
