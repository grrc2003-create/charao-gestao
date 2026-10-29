// Boletim de medição para impressão / PDF — mesmo layout da planilha usada pela Charão:
// Contrato · Acumulado anterior · Medição · Acumulado atual · Saldo contratual, descontos/acréscimos e total a faturar.
import { html, api, fmtDate } from '../core.js';
import { printToolbar, bindPrintToolbar, setPageFooter } from './print-common.js';
import { money, qty } from './contracts.js';

export async function view({ params, state }) {
  if (!state.meta.can.contracts) throw new Error('Acesso restrito a Contratos.');
  const m = await api(`/measurements/${params.id}`);
  const c = m.contract;
  const T = m.totals;
  const v = n => (n ? money(n) : '–');
  const q = n => (n ? qty(n) : '–');
  const minRows = Math.max(0, 6 - m.rows.length);
  const adjs = m.adjustments.length ? m.adjustments : [];
  // Boletim de outra empresa (ex.: LuS): nada da Charão no documento, no rodapé nem no nome do PDF
  const own = (c.company || 'charao') === 'charao';
  return {
    title: `Boletim ${m.code}`,
    docTitle: own ? null : `Boletim ${m.code} - ${c.client} - ${c.company_name}`,
    html: html`${printToolbar({ back: `#/medicoes/${m.id}`, title: `Boletim de medição ${m.code} — ${c.client}` })}
    <div class="doc-stage">
      <article class="doc a4 bm-doc bm-co-${c.company || 'charao'}">
        <header class="bm-head">
          <img src="${c.company_logo || '/assets/logo.webp'}" alt="${c.company_name || 'Charão Engenharia & Construção'}" class="bm-logo bm-logo-${c.company || 'charao'}">
          <div class="bm-title">
            <div class="bm-kicker">BOLETIM DE MEDIÇÃO${m.status === 'rascunho' ? ' · RASCUNHO' : ''}</div>
            <h1>MEDIÇÃO ${m.ref_label}</h1>
            <div class="bm-client"><b>${c.client}</b>${c.client_doc ? ` · ${c.client_doc}` : ''}${c.number ? ` · Contrato ${c.number}` : ''} · ${c.code}</div>
          </div>
          <table class="bm-meta">
            <tr><th colspan="2">PERÍODO MEDIDO</th><th>Nº DE BOLETIM</th></tr>
            <tr><td>${fmtDate(m.period_start)}</td><td>${fmtDate(m.period_end)}</td><td class="mono"><b>${m.code}</b></td></tr>
          </table>
        </header>
        <div class="bm-scope"><b>Objeto:</b> ${c.title}${c.scope ? html` · <b>Escopo:</b> ${c.scope}` : ''}</div>
        <table class="bm-table">
          <thead>
            <tr><th rowspan="2" class="bm-item">ITEM</th><th rowspan="2">DESCRIÇÃO</th><th rowspan="2">UNID.</th><th rowspan="2">PREÇO UNITÁRIO (R$)</th>
              <th colspan="2">CONTRATO</th><th colspan="2">ACUMULADO ANTERIOR</th><th colspan="2" class="bm-hl">MEDIÇÃO</th><th colspan="2">ACUMULADO ATUAL</th><th colspan="2">SALDO CONTRATUAL</th></tr>
            <tr>${[0, 1, 2, 3, 4].map(k => html`<th class="${k === 2 ? 'bm-hl' : ''}">QUANTIDADE</th><th class="${k === 2 ? 'bm-hl' : ''}">VALOR</th>`)}</tr>
          </thead>
          <tbody>
            ${m.rows.map(r => html`<tr><td class="c">${r.seq}</td><td class="bm-desc">${r.additive ? 'Aditivo - ' : ''}${r.description}</td><td class="c">${r.unit}</td><td class="n">${money(r.unit_price)}</td>
              <td class="n">${q(r.contract_qty)}</td><td class="n">${v(r.contract_value)}</td><td class="n">${q(r.prev_qty)}</td><td class="n">${v(r.prev_value)}</td>
              <td class="n bm-hl">${q(r.qty)}</td><td class="n bm-hl">${v(r.value)}</td><td class="n">${q(r.acc_qty)}</td><td class="n">${v(r.acc_value)}</td>
              <td class="n">${q(r.bal_qty)}</td><td class="n">${v(r.bal_value)}</td></tr>`)}
            ${Array.from({ length: minRows }, () => html`<tr class="bm-empty">${Array.from({ length: 14 }, () => html`<td></td>`)}</tr>`)}
            <tr class="bm-sub"><td colspan="5">MEDIÇÃO</td><td class="n">${money(T.contract)}</td><td></td><td class="n">${money(T.prev)}</td><td class="bm-hl"></td><td class="n bm-hl">${money(T.measured)}</td><td></td><td class="n">${money(T.acc)}</td><td></td><td class="n">${money(T.balance)}</td></tr>
            <tr class="bm-sub"><td colspan="5">DESCONTOS / ACRÉSCIMOS</td><td></td><td></td><td class="n">${money(T.adj_prev)}</td><td class="bm-hl"></td><td class="n bm-hl">${money(T.adj)}</td><td></td><td class="n">${money(T.adj_acc)}</td><td colspan="2"></td></tr>
            ${adjs.map((a, k) => html`<tr><td class="c">${k + 1}</td><td class="bm-desc">${a.description}</td><td class="c">${a.unit}</td><td></td><td colspan="3"></td><td class="n">${v(a.prev)}</td>
              <td class="bm-hl"></td><td class="n bm-hl">${v(a.amount)}</td><td></td><td class="n">${v(a.acc)}</td><td colspan="2"></td></tr>`)}
            <tr class="bm-total"><td colspan="5"></td><td class="n">${money(T.contract)}</td><td></td><td class="n">${money(T.prev_total)}</td><td class="bm-hl">TOTAL A FATURAR</td><td class="n bm-hl"><b>${money(T.to_bill)}</b></td><td></td><td class="n">${money(T.acc_total)}</td><td></td><td class="n">${money(T.balance)}</td></tr>
          </tbody>
        </table>
        <div class="bm-foot">
          <div class="bm-obs"><b>OBSERVAÇÕES:</b> ${m.notes || ''}</div>
          ${c.payment_info ? html`<div class="bm-pay"><b>CONTA PARA PAGAMENTO</b><div>${c.payment_info}</div></div>` : ''}
        </div>
        <div class="bm-sign">
          <div><span></span>${c.company_name || 'Charão Engenharia & Construção'}</div>
          <div><span></span>${c.client}</div>
        </div>
      </article>
    </div>`,
    mount(root) {
      bindPrintToolbar(root);
      setPageFooter(`Boletim ${m.code} · ${c.client} · ${own ? 'emitido pelo Charão Gestão' : c.company_name}`);
    },
  };
}
