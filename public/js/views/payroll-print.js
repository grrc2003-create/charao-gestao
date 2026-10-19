// Recibos da Folha (A4): um demonstrativo por página, com o logo da empresa da pessoa.
import { html, api, fmtDate } from '../core.js';
import { printToolbar, bindPrintToolbar, setPageFooter } from './print-common.js';
import { money, refLabel, refLong } from './payroll.js';

const d2 = d => (d ? fmtDate(d) : '—');
const short = d => (d ? `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(2, 4)}` : '');

function receipt(m, e) {
  const c = e.calc;
  const pro = e.kind === 'profissional';
  const co = m.companies[e.company] || m.companies.charao;
  const per = `${short(m.benefit.start)} – ${short(m.benefit.end)}`;
  const lines = [
    [pro ? 'Valor mensal — proporcional aos dias trabalhados' : 'Bolsa — proporcional aos dias trabalhados', `${short(c.start)} – ${short(c.end)}`, `${c.worked_days}/${c.business_days} dias`, c.base],
    ...(pro ? [] : [
      ['Vale transporte — adiantamento', per, `${c.vt_days} dias × 2 × ${money(m.vt_fare)}`, c.vt_base],
      ...(c.ho_discount ? [['Desconto de VT — home office no mês anterior', '', `${c.ho_days} dia(s)`, -c.ho_discount]] : []),
      ...(c.vt_adjust ? [['Vale transporte — diferença', '', '', c.vt_adjust]] : []),
      ['Vale alimentação — adiantamento', per, `${c.vr_days} dias × ${money(m.vr_daily)}`, c.vr_base],
      ...(c.vr_adjust ? [['Vale alimentação — diferença', '', '', c.vr_adjust]] : []),
    ]),
    ...(e.requests || []).map(r => [`Reembolso — ${r.description}`, short(r.expense_date), 'comprovante', r.amount]),
    ...(c.reimb_manual || !(e.requests || []).length ? [['Outros — reembolso', e.reimbursement_note || '', '', c.reimb_manual ?? c.reimbursement]] : []),
  ];
  const obs = [c.reimbursement ? `Reembolso: ${money(c.reimbursement)}${e.reimbursement_note ? ` (${e.reimbursement_note})` : ''}${(e.requests || []).length ? ` · ${e.requests.length} lançado(s) pela pessoa` : ''}` : '', e.notes || ''].filter(Boolean).join('\n');
  return html`<article class="doc a4 pd-sheet rc-doc">
    <header class="rc-head">
      <img src="${co.logo}" alt="${co.name}" class="rc-logo">
      <div class="rc-title"><div class="r-kicker">Demonstrativo de pagamento</div><h1>Folha ${refLabel(m.ref)}</h1><div class="muted">${co.name}</div></div>
    </header>
    <div class="r-rule"></div>
    <h3 class="r-h">Informações de contrato</h3>
    <div class="rc-info">
      <dl>
        <dt>Colaborador</dt><dd><b>${e.name}</b></dd>
        <dt>Função</dt><dd>${e.job_title || '—'}</dd>
        <dt>Turno</dt><dd>${e.shift || '—'}</dd>
        <dt>${pro ? 'Valor mensal' : 'Bolsa'}</dt><dd>${money(e.monthly_value)}</dd>
        <dt>PIX</dt><dd>${e.pix || '—'}</dd>
      </dl>
      <dl>
        <dt>Início</dt><dd>${d2(c.start)}</dd>
        <dt>Fim</dt><dd>${d2(c.end)}</dd>
        <dt>Faltas</dt><dd>${c.absences}</dd>
        <dt>Dias em HO</dt><dd>${c.ho_days}</dd>
        <dt>Dias trabalhados</dt><dd>${c.worked_days} de ${c.business_days} dias úteis</dd>
      </dl>
    </div>
    <h3 class="r-h">Demonstrativo</h3>
    <table class="r-table rc-table"><thead><tr><th>Descrição</th><th>Referência</th><th>Base</th><th class="num">Valor</th></tr></thead>
      <tbody>${lines.map(([a, b, base, v]) => html`<tr><td>${a}</td><td class="small">${b}</td><td class="small">${base}</td><td class="num nowrap ${v < 0 ? 'rc-neg' : ''}">${money(v)}</td></tr>`)}</tbody>
      <tfoot><tr><td colspan="3"><b>TOTAL</b></td><td class="num nowrap"><b>${money(c.total)}</b></td></tr></tfoot></table>
    ${obs ? html`<h3 class="r-h">Observação</h3><p class="r-p pre">${obs}</p>` : ''}
    <div class="rc-sign">
      <div><span></span>${e.name}</div>
      <div><span></span>Data</div>
    </div>
    <p class="muted small rc-foot">Pagamento referente à bolsa/valor de ${refLong(m.bolsa.start.slice(0, 7))} e ao adiantamento de VT/VR de ${refLong(m.ref)}${m.pay_date ? ` · pagamento previsto em ${d2(m.pay_date)}` : ''}${e.cost_center ? ` · Centro de custo ${e.cost_center}` : ''}.</p>
  </article>`;
}

export async function view({ params, query }) {
  const m = await api(`/payroll/months/${params.id}`);
  const only = Number(query.get('pessoa')) || null;
  const list = only ? m.entries.filter(e => e.id === only) : m.entries;
  if (!list.length) throw new Error('Nenhum recibo para imprimir.');
  setPageFooter(`Folha ${refLabel(m.ref)} · Demonstrativo de pagamento`);
  return {
    title: `Recibos · Folha ${refLabel(m.ref)}`,
    html: html`${printToolbar({ back: `#/folha/${m.id}`, title: only ? `Recibo · ${list[0].name}` : `Recibos · Folha ${refLabel(m.ref)} (${list.length})` })}
      <div class="doc-stage pd-stage">${list.map(e => receipt(m, e))}</div>
      ${m.status === 'aberta' ? html`<p class="no-print muted" style="text-align:center">Folha aberta: os valores ainda podem mudar até o fechamento.</p>` : ''}`,
    mount: bindPrintToolbar,
  };
}
