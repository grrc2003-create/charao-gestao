// Recibos da Folha (A4): um demonstrativo por página, no modelo da planilha, com o logo da empresa da pessoa.
import { html, api, fmtDate, icon } from '../core.js';
import { printToolbar, bindPrintToolbar, setPageFooter } from './print-common.js';
import { renderPdfPages } from '../pdf-pages.js';
import { money, refLabel, refLong } from './payroll.js';
import { loadSignatures, sigLine, sigInfo, bindSignatures, signedDate } from './signatures.js';

const d2 = d => (d ? fmtDate(d) : '—');
const short = d => (d ? `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(2, 4)}` : '');

// Logo do recibo: o da empresa da pessoa (só um). A Ludimila Siqueira usa a versão com o símbolo em cima.
const RECEIPT_LOGO = { lus: '/assets/logo-lus.png' };
const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : '—');
// Valor no estilo da planilha: "R$" à esquerda e o número à direita; zero vira "–"
const cell = v => html`<td class="fdm-rs">R$</td><td class="fdm-v ${v < 0 ? 'fdm-neg' : ''}">${v ? money(v).replace(/^-?R\$\s?/, v < 0 ? '−' : '') : '–'}</td>`;

function receipt(m, e) {
  const c = e.calc;
  const pro = e.kind === 'profissional';
  const co = m.companies[e.company] || m.companies.charao;
  const logo = RECEIPT_LOGO[e.company] || co.logo;
  const per = `${short(m.benefit.start)} – ${short(m.benefit.end)}`;
  // [descrição, detalhe (cinza), período, peso, valor]
  const lines = [
    [pro ? 'Valor Mensal – Proporcional aos dias trabalhados' : 'Bolsa – Proporcional aos dias trabalhados', `${c.worked_days} de ${c.business_days} dias úteis`, `${short(c.start)} – ${short(c.end)}`, pct(c.worked_days, c.business_days), c.base],
    ...(pro ? [] : [
      ['Vale Transporte – Adiantamento', `${c.vt_days} dias × 2 × ${money(m.vt_fare)}`, per, '', c.vt_base],
      ...(c.ho_discount ? [['Desconto de VT – home office no mês anterior', `${c.ho_days} dia(s)`, '', '', -c.ho_discount]] : []),
      ...(c.vt_adjust ? [['Vale Transporte – diferença', '', '', '', c.vt_adjust]] : []),
      ['Vale Alimentação – Adiantamento', `${c.vr_days} dias × ${money(m.vr_daily)}`, per, '', c.vr_base],
      ...(c.vr_adjust ? [['Vale Alimentação – diferença', '', '', '', c.vr_adjust]] : []),
    ]),
    ...(e.requests || []).map(r => [`Reembolso – ${r.description}`, 'comprovante', short(r.expense_date), '', r.amount]),
    ...(c.reimb_manual || !(e.requests || []).length ? [['Outros', e.reimbursement_note || '', '', '', c.reimb_manual ?? c.reimbursement]] : []),
  ];
  const obs = [c.reimbursement ? `Reembolso: ${money(c.reimbursement)}${e.reimbursement_note ? ` (${e.reimbursement_note})` : ''}${(e.requests || []).length ? ` · ${e.requests.length} lançado(s) pela pessoa` : ''}` : '', e.notes || ''].filter(Boolean).join('\n');
  return html`<article class="doc a4 pd-sheet rc-doc fdm-doc fdm-co-${m.companies[e.company] ? e.company : 'charao'}">
    <header class="fdm-head">
      <img src="${logo}" alt="${co.name}" class="fdm-logo">
      <div class="fdm-title"><h1>DEMONSTRATIVO</h1><span>Folha ${refLabel(m.ref)} · ${co.name}</span></div>
      <span class="fdm-spacer"></span>
    </header>
    <div class="fdm-top">
      <table class="fdm-t fdm-info">
        <thead><tr><th colspan="2">Informações de Contrato</th></tr></thead>
        <tbody>
          <tr><th>Colaborador</th><td><b>${e.name}</b></td></tr>
          <tr><th>Turno</th><td>${e.shift || '—'}</td></tr>
          <tr><th>Função</th><td>${e.job_title || '—'}</td></tr>
          <tr><th>${pro ? 'Valor mensal' : 'Bolsa'}</th><td>${money(e.monthly_value)}</td></tr>
          <tr><th>PIX</th><td>${e.pix || '—'}</td></tr>
        </tbody>
      </table>
      <div class="fdm-side">
        <table class="fdm-t fdm-dates">
          <tbody>
            <tr><th>INÍCIO</th><td>${d2(c.start)}</td></tr>
            <tr><th>FIM</th><td>${d2(c.end)}</td></tr>
            <tr><th>FALTAS</th><td>${c.absences || 0}</td></tr>
            <tr><th>Dias em HO</th><td>${c.ho_days || 0}</td></tr>
          </tbody>
        </table>
        <table class="fdm-t fdm-worked">
          <thead><tr><th>DIAS TRABALHADOS</th></tr></thead>
          <tbody><tr><td>${c.worked_days} ${c.worked_days === 1 ? 'Dia' : 'Dias'}</td></tr></tbody>
        </table>
      </div>
    </div>
    <table class="fdm-t fdm-lines">
      <thead><tr><th class="fdm-desc" colspan="2">Demonstrativo</th><th class="fdm-peso">Peso</th><th colspan="2" class="fdm-sub">Subtotal</th></tr></thead>
      <tbody>${lines.map(([desc, det, period, peso, v]) => html`<tr>
        <td class="fdm-desc"><b>${desc}</b>${det ? html`<small>${det}</small>` : ''}</td>
        <td class="fdm-per">${period}</td><td class="fdm-peso">${peso}</td>${cell(v)}</tr>`)}</tbody>
    </table>
    <table class="fdm-t fdm-total"><tbody><tr><th>TOTAL</th>${cell(c.total)}</tr></tbody></table>
    <div class="fdm-obs"><b>Observação</b><div class="fdm-obs-box">${obs}</div></div>
    <div class="fdm-sign">
      <div>${sigLine(SIG, sigD(m, e))}${e.name}${sigInfo(SIG, sigD(m, e))}</div>
      <div><span class="sig-line">${signedDate(SIG, sigD(m, e)) ? html`<b class="sig-date">${signedDate(SIG, sigD(m, e))}</b>` : ''}</span>Data</div>
    </div>
    <p class="fdm-foot">Pagamento referente à bolsa/valor de ${refLong(m.bolsa.start.slice(0, 7))} e ao adiantamento de VT/VR de ${refLong(m.ref)}${m.pay_date ? ` · pagamento previsto em ${d2(m.pay_date)}` : ''}${e.cost_center ? ` · Centro de custo ${e.cost_center}` : ''}.</p>
  </article>`;
}

// Comprovante(s) do pagamento registrado na folha, na página seguinte ao recibo: sai tudo num PDF só para enviar à pessoa
const isImg = f => /^image\//.test(f.mime || '');
function proofPage(m, e) {
  const pays = e.payments || [];
  if (!pays.length) return '';
  const files = pays.flatMap(p => (p.files || []).map(f => ({ ...f, paid_date: p.paid_date })));
  const pdfs = files.filter(f => !isImg(f));
  return html`<article class="doc a4 pd-sheet pd-proof">
    <header class="pd-proof-head"><h1>Comprovante de pagamento</h1><span>${e.name} · Folha ${refLabel(m.ref)}</span></header>
    <table class="pd-proof-t"><thead><tr><th>Data</th><th>Valor pago</th><th>Observação</th></tr></thead>
      <tbody>${pays.map(p => html`<tr><td>${d2(p.paid_date)}</td><td>${money(p.amount)}</td><td>${p.notes || '—'}</td></tr>`)}</tbody>
      <tfoot><tr><th>Total pago</th><th>${money(pays.reduce((a, p) => a + p.amount, 0))}</th><th>de ${money(e.calc.total)}</th></tr></tfoot></table>
    ${files.filter(isImg).map(f => html`<figure class="pd-proof-img"><img src="/api/payroll-pay-files/${f.id}" alt="Comprovante ${f.original_name || ''}"><figcaption>${f.original_name || 'comprovante'} · ${d2(f.paid_date)}</figcaption></figure>`)}
    ${pdfs.map(f => html`<figure class="pd-proof-img pd-proof-pdfpg"><div class="pd-pdf-pages" data-pdf-pages="/api/payroll-pay-files/${f.id}">${icon('file')}Carregando o PDF do comprovante…</div>
      <figcaption>${f.original_name || 'comprovante.pdf'} · ${d2(f.paid_date)} · <a class="no-print" href="/api/payroll-pay-files/${f.id}" target="_blank" rel="noopener">abrir o PDF</a></figcaption></figure>`)}
    ${!files.length ? html`<p class="muted">Pagamento registrado sem arquivo de comprovante.</p>` : ''}
  </article>`;
}

// Assinatura eletrônica do funcionário no recibo
let SIG = null;
const sigD = (m, e) => ({ type: 'folha', key: `${m.id}:${e.id}`, slot: 'funcionario', label: `Funcionário · ${e.name}`, name: e.name, userId: e.user_id || '' });
const loadSig = (m, only) => loadSignatures((only ? m.entries.filter(e => e.id === only) : m.entries)
  .map(e => ({ type: 'folha', key: `${m.id}:${e.id}`, fp: `${e.name}|${Number(e.calc?.total || 0).toFixed(2)}|${m.ref}` })));

export async function view({ params, query }) {
  const m = await api(`/payroll/months/${params.id}`);
  const only = Number(query.get('pessoa')) || null;
  SIG = await loadSig(m, only);
  return page(m, only, query, `#/folha/${m.id}`);
}

// Meu painel: recibo da própria pessoa (o servidor devolve só o lançamento dela)
export async function mine({ params, query }) {
  const m = await api(`/me/receipts/folha/${params.id}`);
  SIG = await loadSig(m, m.entries[0].id);
  return page(m, m.entries[0].id, query, '#/painel');
}

function page(m, only, query, back) {
  const list = only ? m.entries.filter(e => e.id === only) : m.entries;
  if (!list.length) throw new Error('Nenhum recibo para imprimir.');
  setPageFooter(`Folha ${refLabel(m.ref)} · Demonstrativo de pagamento`);
  const hasProof = list.some(e => (e.payments || []).length);
  // Recibo de uma pessoa: o comprovante entra por padrão; recibos de todos: só se pedir (?comprovante=1)
  const withProof = hasProof && (only ? query.get('comprovante') !== '0' : query.get('comprovante') === '1');
  return {
    title: `Recibos · Folha ${refLabel(m.ref)}`,
    html: html`${printToolbar({ back, title: only ? `Recibo · ${list[0].name}` : `Recibos · Folha ${refLabel(m.ref)} (${list.length})`,
        extra: hasProof ? html`<label class="pd-proof-opt"><input type="checkbox" id="pd-proof-on" ${withProof ? 'checked' : ''}>Incluir comprovante de pagamento</label>` : '' })}
      <div class="doc-stage pd-stage ${withProof ? '' : 'pd-noproof'}" id="pd-stage">${list.map(e => html`${receipt(m, e)}${proofPage(m, e)}`)}</div>
      ${m.status === 'aberta' ? html`<p class="no-print muted" style="text-align:center">Folha aberta: os valores ainda podem mudar até o fechamento.</p>` : ''}`,
    mount(root, ctx) {
      bindSignatures(root, SIG, () => ctx.render());
      bindPrintToolbar(root, renderPdfPages(root));
      root.querySelector('#pd-proof-on')?.addEventListener('change', e => root.querySelector('#pd-stage').classList.toggle('pd-noproof', !e.target.checked));
    },
  };
}
