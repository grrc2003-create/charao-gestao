// Recibos da Folha de Campo (A4, dois por página com linha de corte): um por profissional/empreiteiro da folha,
// para assinar que recebeu a quantia. Valor em número e por extenso, referência (diárias/serviço ou empreitada),
// obra, folha e período, forma de pagamento (PIX), local e data, assinatura com nome e CPF/CNPJ.
// Opções na barra: data e local do recibo, valor (o que a empresa paga na folha ou o já pago) e quem entra.
import { html, api, fmtDate, todayISO, icon } from '../core.js';
import { printToolbar, bindPrintToolbar, setPageFooter } from './print-common.js';
import { renderPdfPages } from '../pdf-pages.js';
import { loadSignatures, sigLine, sigInfo, bindSignatures, signedDate } from './signatures.js';

const BRL = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const money = v => BRL.format(Number(v) || 0);
const n2 = v => String(Math.round((Number(v) || 0) * 100) / 100).replace('.', ',');
const MESES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
const dataExtenso = d => `${Number(d.slice(8, 10))} de ${MESES[Number(d.slice(5, 7)) - 1]} de ${d.slice(0, 4)}`;

// Valor por extenso em reais (até 999 milhões)
const UN = ['', 'um', 'dois', 'três', 'quatro', 'cinco', 'seis', 'sete', 'oito', 'nove', 'dez', 'onze', 'doze', 'treze', 'quatorze', 'quinze', 'dezesseis', 'dezessete', 'dezoito', 'dezenove'];
const DEZ = ['', '', 'vinte', 'trinta', 'quarenta', 'cinquenta', 'sessenta', 'setenta', 'oitenta', 'noventa'];
const CEN = ['', 'cento', 'duzentos', 'trezentos', 'quatrocentos', 'quinhentos', 'seiscentos', 'setecentos', 'oitocentos', 'novecentos'];
function ate999(n) {
  if (n === 0) return '';
  if (n === 100) return 'cem';
  const c = Math.floor(n / 100), r = n % 100, parts = [];
  if (c) parts.push(CEN[c]);
  if (r) parts.push(r < 20 ? UN[r] : DEZ[Math.floor(r / 10)] + (r % 10 ? ` e ${UN[r % 10]}` : ''));
  return parts.join(' e ');
}
function inteiroExtenso(n) {
  if (n === 0) return 'zero';
  const mi = Math.floor(n / 1e6), mil = Math.floor((n % 1e6) / 1000), resto = n % 1000;
  const parts = [];
  if (mi) parts.push({ t: `${ate999(mi)} ${mi === 1 ? 'milhão' : 'milhões'}`, v: mi });
  if (mil) parts.push({ t: mil === 1 ? 'mil' : `${ate999(mil)} mil`, v: mil });
  if (resto) parts.push({ t: ate999(resto), v: resto });
  // "e" antes do último grupo quando ele é menor que 100 ou centena redonda (ex.: mil e cem, um milhão e quinhentos mil)
  const last = parts.at(-1);
  if (parts.length > 1 && (last.v < 100 || last.v % 100 === 0)) return `${parts.slice(0, -1).map(p => p.t).join(' ')} e ${last.t}`;
  return parts.map(p => p.t).join(' ');
}
export function reaisExtenso(v) {
  const cents = Math.round(Math.abs(Number(v) || 0) * 100);
  const r = Math.floor(cents / 100), c = cents % 100;
  const de = r && r % 1e6 === 0 ? ' de' : '';
  const reais = r ? `${inteiroExtenso(r)}${de} ${r === 1 ? 'real' : 'reais'}` : '';
  const cent = c ? `${inteiroExtenso(c)} ${c === 1 ? 'centavo' : 'centavos'}` : '';
  return [reais, cent].filter(Boolean).join(' e ') || 'zero real';
}

const COMPANY = 'Charão Engenharia & Construção';
const PREFS = 'charao-recibos';

export async function view({ params, query, setQuery, render }) {
  const s = await api(`/field/sheets/${params.id}`);
  if (!s.can.money) throw new Error('Os recibos ficam com quem tem a seção Folha de Campo liberada.');
  const data = query.get('data') || todayISO();
  // Quem paga, documento, logo, local e observação: editáveis; a última escolha fica guardada neste navegador
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(PREFS) || '{}') || {}; } catch { /* sem armazenamento */ }
  const pref = k => (query.has(k) ? query.get(k) : saved[k] ?? '');
  const pagador = pref('pag') || COMPANY;
  const pagDoc = pref('pagdoc');
  const showLogo = pref('logo') !== '0';
  const obs = pref('obs');
  const local = pref('local');
  const modo = query.get('valor') === 'pago' ? 'pago' : 'folha';
  const off = new Set((query.get('sem') || '').split(',').filter(Boolean));
  // Quem recebe na folha: pessoas (diárias) e empreitadas medidas
  const all = [
    ...s.people.map(e => ({ line: `p${e.id}`, name: e.name, doc: e.doc, pix: e.pix, pix_type: e.pix_type, company: e.company, paid: e.paid_amount || 0, payments: e.payments || [],
      ref: `${n2(e.diarias)} diária(s)${e.role ? ` de ${e.role.toLowerCase()}` : ''}${e.service ? `, serviço "${e.service}"` : ''}` })),
    ...s.contracts.map(c => ({ line: `c${c.id}`, name: c.worker_name, doc: c.doc, pix: c.pix, pix_type: c.pix_type, company: c.company, paid: c.paid_amount || 0, payments: c.payments || [],
      ref: `empreitada "${c.service}" (${n2(c.pct)}% executado nesta folha)` })),
  ].map(x => ({ ...x, amount: modo === 'pago' ? Math.min(x.paid, x.company) : x.company })).filter(x => x.amount > 0.004);
  // Recibo de uma pessoa (?pessoa=p12): só ela, com o comprovante do pagamento na página seguinte (desmarcável)
  const only = query.get('pessoa') || '';
  const list = only ? all.filter(x => x.line === only) : all.filter(x => !off.has(x.line));
  const hasProof = list.some(x => x.payments.length);
  const withProof = hasProof && (only ? query.get('comprovante') !== '0' : query.get('comprovante') === '1');
  const go = over => {
    const q = { data, local, pag: pagador === COMPANY ? '' : pagador, pagdoc: pagDoc, logo: showLogo ? '' : '0', obs, valor: modo === 'pago' ? 'pago' : '', sem: [...off].join(','), pessoa: only, comprovante: query.get('comprovante') || '', ...over };
    try { localStorage.setItem(PREFS, JSON.stringify({ local: q.local, pag: q.pag, pagdoc: q.pagdoc, logo: q.logo, obs: q.obs })); } catch { /* sem armazenamento */ }
    setQuery(q); render();
  };
  const periodo = `${fmtDate(s.start_date)} a ${fmtDate(s.end_date)}`;
  // Assinatura eletrônica de quem recebe (uma por recibo)
  const sigD = x => ({ type: 'campo', key: `${s.id}:${x.line}`, slot: 'recebedor', label: `Recebedor · ${x.name}`, name: x.name, doc: x.doc || '' });
  const S = await loadSignatures(list.map(x => ({ type: 'campo', key: `${s.id}:${x.line}`, fp: `${x.name}|${Number(x.amount).toFixed(2)}|${x.ref}|${periodo}` })));
  const recibo = (x, i) => html`<section class="rc-card">
    <header class="rc-head ${showLogo ? '' : 'rc-nologo'}">${showLogo ? html`<img src="/assets/logo.webp" alt="Charão Engenharia & Construção" class="rc-logo">` : ''}
      <div class="rc-title"><b>RECIBO</b><span>Nº ${s.project.code}-${s.code}-${String(i + 1).padStart(2, '0')}</span></div>
      <div class="rc-val">${money(x.amount)}</div></header>
    <p class="rc-text">Recebi de <b>${pagador}</b>${pagDoc ? ` (CPF/CNPJ ${pagDoc})` : ''} a importância de <b>${money(x.amount)}</b> (<i>${reaisExtenso(x.amount)}</i>),
      referente a ${x.ref}, na obra <b>${s.project.code} · ${s.project.name}</b>${s.project.client ? ` (${s.project.client})` : ''}, folha <b>${s.code}</b>, período de ${periodo}.</p>
    <p class="rc-pay">${x.pix ? html`Forma de pagamento: PIX${x.pix_type ? ` (${x.pix_type})` : ''} ${x.pix}` : 'Forma de pagamento: ____________________'}</p>
    ${obs ? html`<p class="rc-obs">${obs}</p>` : ''}
    <p class="rc-date">${local ? `${local}, ` : '____________________, '}${dataExtenso(data)}.</p>
    <div class="rc-sign">${sigLine(S, sigD(x))}<b>${x.name}</b><small>${x.doc ? `CPF/CNPJ: ${x.doc}` : 'CPF/CNPJ: ______________________'}</small>${sigInfo(S, sigD(x))}</div>
  </section>`;
  const pages = [];
  for (let i = 0; i < list.length; i += 2) pages.push(list.slice(i, i + 2));
  const isImg = f => /^image\//.test(f.mime || '');
  const proofPage = x => {
    if (!x.payments.length) return '';
    const files = x.payments.flatMap(p => (p.files || []).map(f => ({ ...f, paid_date: p.paid_date })));
    const pdfs = files.filter(f => !isImg(f));
    return html`<article class="doc a4 pd-proof">
      <header class="pd-proof-head"><h1>Comprovante de pagamento</h1><span>${x.name} · ${s.project.code} · ${s.code} (${periodo})</span></header>
      <table class="pd-proof-t"><thead><tr><th>Data</th><th>Valor pago</th><th>Observação</th></tr></thead>
        <tbody>${x.payments.map(p => html`<tr><td>${fmtDate(p.paid_date)}</td><td>${money(p.amount)}</td><td>${p.notes || '—'}</td></tr>`)}</tbody>
        <tfoot><tr><th>Total pago</th><th>${money(x.payments.reduce((a, p) => a + p.amount, 0))}</th><th>de ${money(x.company)}</th></tr></tfoot></table>
      ${files.filter(isImg).map(f => html`<figure class="pd-proof-img"><img src="/api/field-pay-files/${f.id}" alt="Comprovante ${f.original_name || ''}"><figcaption>${f.original_name || 'comprovante'} · ${fmtDate(f.paid_date)}</figcaption></figure>`)}
      ${pdfs.map(f => html`<figure class="pd-proof-img pd-proof-pdfpg"><div class="pd-pdf-pages" data-pdf-pages="/api/field-pay-files/${f.id}">${icon('file')}Carregando o PDF do comprovante…</div>
        <figcaption>${f.original_name || 'comprovante.pdf'} · ${fmtDate(f.paid_date)} · <a class="no-print" href="/api/field-pay-files/${f.id}" target="_blank" rel="noopener">abrir o PDF</a></figcaption></figure>`)}
      ${!files.length ? html`<p class="muted">Pagamento registrado sem arquivo de comprovante.</p>` : ''}
    </article>`;
  };
  const extra = html`<details class="fr-opts rc-txt" ${pagador !== COMPANY || pagDoc || !showLogo || obs ? 'open' : ''}><summary>Texto do recibo</summary><div class="fr-optl">
      <label class="pt-opt">Quem paga <input type="text" id="rc-pag" value="${pagador}" maxlength="120" placeholder="${COMPANY}"></label>
      <label class="pt-opt">CPF/CNPJ de quem paga <input type="text" id="rc-pagdoc" value="${pagDoc}" maxlength="30" placeholder="opcional"></label>
      <label class="pt-opt"><input type="checkbox" id="rc-logo" ${showLogo ? 'checked' : ''}>Logo da Charão</label>
      <label class="pt-opt rc-obs-in">Observação <input type="text" id="rc-obs" value="${obs}" maxlength="300" placeholder="Ex.: referente ao adiantamento combinado…"></label>
      ${pagador !== COMPANY || pagDoc || !showLogo || obs ? html`<button type="button" class="btn btn-ghost btn-sm" id="rc-reset">Voltar ao padrão</button>` : ''}
    </div></details>
    <label class="pt-opt">Data <input type="date" id="rc-data" value="${data}"></label>
    <label class="pt-opt">Local <input type="text" id="rc-local" value="${local}" placeholder="Cidade" maxlength="60"></label>
    <label class="pt-opt">Valor <select id="rc-valor"><option value="">O que a empresa paga na folha</option><option value="pago" ${modo === 'pago' ? 'selected' : ''}>Só o já pago</option></select></label>
    ${hasProof ? html`<label class="pt-opt"><input type="checkbox" id="rc-proof" ${withProof ? 'checked' : ''}>Incluir comprovante de pagamento</label>` : ''}
    ${only ? html`<a class="btn btn-ghost btn-sm" href="#/campo/recibos/${s.id}">Recibos de todos</a>` : html`<details class="fr-opts rc-who"><summary>Quem recebe (${list.length} de ${all.length})</summary><div class="fr-optl">${all.map(x => html`<label class="pt-opt"><input type="checkbox" data-rc="${x.line}" ${off.has(x.line) ? '' : 'checked'}>${x.name} · ${money(x.amount)}</label>`)}</div></details>`}`;
  return {
    title: `Recibos ${s.project.code} ${s.code}`,
    html: html`${printToolbar({ back: `#/campo/${s.id}`, title: only && list[0] ? `Recibo — ${list[0].name} · ${s.project.code} · ${s.code}` : `Recibos — ${s.project.code} · ${s.code} (${periodo})`, extra })}
    <div class="doc-stage">${pages.length ? pages.map((pg, k) => html`<article class="doc a4 rc-doc">${pg.map((x, j) => html`${j ? html`<div class="rc-cut" aria-hidden="true"><span>✂ recortar</span></div>` : ''}${recibo(x, k * 2 + j)}`)}</article>`)
      : html`<article class="doc a4 rc-doc"><p class="muted">${all.length ? 'Nenhum profissional escolhido.' : modo === 'pago' ? 'Ninguém com pagamento registrado nesta folha.' : 'Nenhum valor a pagar nesta folha.'}</p></article>`}${withProof ? list.map(proofPage) : ''}</div>`,
    mount(root) {
      bindSignatures(root, S, () => render());
      bindPrintToolbar(root, renderPdfPages(root));
      setPageFooter(`Recibos · ${s.project.code} · ${s.code}`);
      root.querySelector('#rc-data').addEventListener('change', e => go({ data: e.target.value || todayISO() }));
      root.querySelector('#rc-local').addEventListener('change', e => go({ local: e.target.value.trim() }));
      root.querySelector('#rc-pag').addEventListener('change', e => { const v = e.target.value.trim(); go({ pag: !v || v === COMPANY ? '' : v }); });
      root.querySelector('#rc-pagdoc').addEventListener('change', e => go({ pagdoc: e.target.value.trim() }));
      root.querySelector('#rc-logo').addEventListener('change', e => go({ logo: e.target.checked ? '' : '0' }));
      root.querySelector('#rc-obs').addEventListener('change', e => go({ obs: e.target.value.trim() }));
      root.querySelector('#rc-reset')?.addEventListener('click', () => go({ pag: '', pagdoc: '', logo: '', obs: '' }));
      root.querySelector('#rc-valor').addEventListener('change', e => go({ valor: e.target.value }));
      root.querySelector('#rc-proof')?.addEventListener('change', e => go({ comprovante: e.target.checked ? (only ? '' : '1') : (only ? '0' : '') }));
      root.querySelectorAll('[data-rc]').forEach(c => c.addEventListener('change', () => {
        if (c.checked) off.delete(c.dataset.rc); else off.add(c.dataset.rc);
        go({ sem: [...off].join(',') });
      }));
    },
  };
}
