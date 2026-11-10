// Mapa de cotações (PDF, A4 paisagem): o mesmo modelo da planilha "PLANILHA COTAÇÃO" — título grande, faixa azul com o projeto,
// cabeçalho cinza e, para cada item, o bloco PREÇO / NOME / CNPJ / TELEFONE / NOME DO ARQUIVO / OBSERVAÇÃO / ENDEREÇO / SOLICITAÇÃO DE PREÇO.
import { html, api, icon, fmtDate } from '../core.js';
import { printToolbar, bindPrintToolbar, setPageFooter } from './print-common.js';
import { renderPdfPages } from '../pdf-pages.js';

const BRL = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const money = v => (v === null || v === undefined ? '' : BRL.format(Number(v) || 0));
const ROWS = [['NOME', 'name'], ['CNPJ', 'cnpj'], ['TELEFONE', 'phone'], ['NOME DO ARQUIVO', 'file'], ['OBSERVAÇÃO', 'obs'], ['ENDEREÇO', 'address'], ['SOLICITAÇÃO DE PREÇO', 'situation']];
const pct = (n, t) => (t ? `${Math.round((n / t) * 100)}%` : '—');

export async function view({ params }) {
  const m = await api(`/projects/${params.id}/quotes/map`);
  setPageFooter(`${m.project.code} · Mapa de cotações · ${fmtDate(m.today)}`);
  const head = (title, sub = '') => html`<header class="qp-head"><div class="qp-title">${title}${sub ? html`<small>${sub}</small>` : ''}</div>
    <div class="qp-meta"><div class="qp-proj">${m.project.code} · ${m.project.name}</div>
      <b>Cliente:</b><span>${m.project.client || '—'}</span><b>Endereço:</b><span>${m.project.address || '—'}</span><b>Data do documento:</b><span>${fmtDate(m.today)}</span></div></header>`;
  const S = m.summary;
  const resumo = html`<article class="doc qp-doc">${head('MAPA DE COTAÇÕES — RESUMO', `Meta: ${m.target} propostas por item`)}
    <table class="qp-t qp-res"><thead><tr><th>DISCIPLINA</th><th>ITENS</th><th>3 OU MAIS</th><th>2 PROPOSTAS</th><th>1 PROPOSTA</th><th>NENHUMA</th><th>SEM SOLICITAÇÃO</th><th>% COM 3 OU MAIS</th></tr></thead>
      <tbody>${m.disciplines.map(x => html`<tr><td>${x.name}</td><td>${x.items.length}</td><td>${x.summary.buckets.tres}</td><td>${x.summary.buckets.dois}</td><td>${x.summary.buckets.um}</td><td>${x.summary.buckets.nenhuma}</td><td>${x.summary.no_request}</td><td>${pct(x.summary.buckets.tres, x.items.length)}</td></tr>`)}</tbody>
      <tfoot><tr><th>TOTAL</th><th>${S.items}</th><th>${S.buckets.tres}</th><th>${S.buckets.dois}</th><th>${S.buckets.um}</th><th>${S.buckets.nenhuma}</th><th>${S.no_request}</th><th>${pct(S.buckets.tres, S.items)}</th></tr></tfoot></table>
    <p class="qp-note">Solicitações: ${S.requests.total} enviadas · ${S.requests.recebida} recebidas · ${S.requests.enviada} aguardando${S.requests.vencida ? ` (${S.requests.vencida} com prazo vencido)` : ''} · ${S.requests.declinou} declinaram.</p></article>`;
  const span = ROWS.length + 1;
  const disc = x => html`<article class="doc qp-doc qp-break">${head('PLANILHA COTAÇÃO', x.name.toUpperCase())}
    <table class="qp-t qp-map"><colgroup><col class="w-cod"><col class="w-cat"><col class="w-loc"><col><col class="w-qtd"><col class="w-und"><col class="w-dad"><col class="w-med">
      ${Array.from({ length: x.cols }, () => html`<col>`)}<col class="w-obs"><col class="w-cur"></colgroup>
      <thead><tr><th>CÓD ORÇ</th><th>CATEGORIA</th><th>LOCAL</th><th>DESCRIÇÃO</th><th>QTDE.</th><th>UND</th><th>DADOS</th><th>VALOR MEDIANO</th>
      ${Array.from({ length: x.cols }, (_, k) => html`<th>EMPRESA ${String(k + 1).padStart(2, '0')}</th>`)}<th>OBSERVAÇÃO</th><th>CURVA</th></tr></thead>
      ${x.items.map(it => html`<tbody class="qp-item"><tr class="qp-price">
          <td rowspan="${span}" class="qp-m">${it.code || ''}</td><td rowspan="${span}" class="qp-m">${x.name.toUpperCase()}</td><td rowspan="${span}" class="qp-m">${it.location || ''}</td>
          <td rowspan="${span}" class="qp-m">${it.description}</td><td rowspan="${span}" class="qp-m">${it.qty != null ? String(it.qty).replace('.', ',') : ''}</td><td rowspan="${span}" class="qp-m">${it.unit || ''}</td>
          <td class="qp-lab">PREÇO</td><td rowspan="${span}" class="qp-m qp-med">${money(it.median)}</td>
          ${Array.from({ length: x.cols }, (_, k) => html`<td class="qp-pr">${money(it.offers[k]?.price)}</td>`)}
          <td rowspan="${span}" class="qp-m">${it.notes || ''}</td><td rowspan="${span}" class="qp-m">${it.abc || ''}</td></tr>
        ${ROWS.map(([label, key]) => html`<tr><td class="qp-lab">${label}</td>${Array.from({ length: x.cols }, (_, k) => { const v = it.offers[k]?.[key] || ''; return html`<td class="${key === 'situation' && /VENCIDO/.test(v) ? 'qp-st-late' : ''}">${v}</td>`; })}</tr>`)}
      </tbody>`)}</table></article>`;
  // Propostas anexas: índice e uma folha para cada arquivo, com o mesmo número da linha NOME DO ARQUIVO do mapa
  const A = m.annexes || [];
  const annexIndex = html`<article class="doc qp-doc qp-break pd-proof">${head('PROPOSTAS ANEXAS', 'Índice: o nome do arquivo é o mesmo da linha NOME DO ARQUIVO do mapa')}
    <table class="qp-t qp-res qa-idx"><thead><tr><th>ID</th><th>FORNECEDOR</th><th>NOME DO ARQUIVO</th><th>REVISÃO</th><th>RECEBIDA EM</th><th>DISCIPLINA(S)</th><th>ITENS COM PREÇO</th></tr></thead>
      <tbody>${A.map(a => html`<tr><td>${a.code}</td><td>${a.supplier}</td><td>${a.name}${a.original && a.original !== a.name ? html`<small class="qa-orig">enviado como ${a.original}</small>` : ""}</td><td>${a.revision}</td><td>${a.received ? fmtDate(a.received) : '—'}</td><td>${a.disciplines.join(', ')}</td><td>${a.items}</td></tr>`)}</tbody></table></article>`;
  const annexPage = a => html`<article class="doc a4 pd-proof qa-annex">
    <header class="qa-head"><div class="qa-no">ID ${a.code}</div>
      <div class="qa-info"><b>${a.supplier}</b>${a.cnpj ? html`<span>CNPJ ${a.cnpj}</span>` : ''}
        <span>Nome do arquivo no mapa: <b>${a.name}</b> · ${a.revision}${a.received ? ` · recebida em ${fmtDate(a.received)}` : ''}</span>
        <span>${m.project.code} · ${a.disciplines.join(', ')} · ${a.items} item(ns) com preço</span></div></header>
    ${/^image\//.test(a.mime || '') ? html`<figure class="pdf-pg"><img src="/api/quote-files/${a.file_id}" alt="${a.name}"><figcaption>${a.name}</figcaption></figure>`
      : html`<div class="pd-pdf-pages qa-pages" data-pdf-pages="/api/quote-files/${a.file_id}" data-pdf-max="40" data-pdf-label="${a.name}">${icon('file')}Carregando o PDF da proposta…</div>`}
  </article>`;
  return {
    title: `Mapa de cotações · ${m.project.code}`,
    html: html`${printToolbar({ back: `#/projetos/${params.id}/cotacoes`, title: `Mapa de cotações · ${m.project.code} (${m.disciplines.length} disciplina(s))`,
        extra: A.length ? html`<a class="btn btn-ghost btn-sm" href="/api/projects/${params.id}/quotes/propostas.zip" download title="Arquivos das propostas vigentes, renomeados como Projeto-Disciplina-Fornecedor-ID (o mesmo nome da linha NOME DO ARQUIVO do mapa)">${icon('file')}Baixar propostas (.zip)</a><label class="pd-proof-opt"><input type="checkbox" id="qa-on" checked>Incluir as propostas anexas (${A.length})</label>` : '' })}
      <div class="doc-stage qp-stage" id="qp-stage">${m.disciplines.length ? html`${resumo}${m.disciplines.map(disc)}${A.length ? html`${annexIndex}${A.map(annexPage)}` : ''}` : html`<article class="doc qp-doc"><p class="muted">Nenhum item para cotar neste projeto.</p></article>`}</div>`,
    mount(root) {
      bindPrintToolbar(root, renderPdfPages(root));
      root.querySelector('#qa-on')?.addEventListener('change', e => root.querySelector('#qp-stage').classList.toggle('pd-noproof', !e.target.checked));
    },
  };
}
