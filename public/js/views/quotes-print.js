// Mapa de cotações (PDF, A4 paisagem): o mesmo modelo da planilha — por disciplina, cada item com o bloco
// PREÇO / NOME / CNPJ / TELEFONE / NOME DO ARQUIVO / OBSERVAÇÃO / ENDEREÇO / SOLICITAÇÃO DE PREÇO / DATAS.
import { html, api, fmtDate } from '../core.js';
import { printToolbar, bindPrintToolbar, setPageFooter } from './print-common.js';

const BRL = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const money = v => (v === null || v === undefined ? '' : BRL.format(Number(v) || 0));
const ROWS = [['NOME', 'name'], ['CNPJ', 'cnpj'], ['TELEFONE', 'phone'], ['NOME DO ARQUIVO', 'file'], ['OBSERVAÇÃO', 'obs'], ['ENDEREÇO', 'address'], ['SOLICITAÇÃO DE PREÇO', 'status'], ['DATA DE ENVIO', 'sent'], ['DATA DE RECEBIMENTO', 'received']];
const pct = (n, t) => (t ? `${Math.round((n / t) * 100)}%` : '—');

export async function view({ params }) {
  const m = await api(`/projects/${params.id}/quotes/map`);
  setPageFooter(`${m.project.code} · Mapa de cotações · ${fmtDate(m.today)}`);
  const head = html`<header class="qp-head"><div><b>Mapa de cotações</b><span>${m.project.code} · ${m.project.name}</span></div>
    <div class="qp-meta">${m.project.client ? html`<span>Cliente: ${m.project.client}</span>` : ''}<span>Data do documento: ${fmtDate(m.today)}</span><span>Meta: ${m.target} propostas por item</span></div></header>`;
  const S = m.summary;
  const resumo = html`<article class="doc qp-doc">${head}
    <h2 class="qp-h">Resumo</h2>
    <table class="qp-t qp-res"><thead><tr><th>Disciplina</th><th>Itens</th><th>3 ou mais</th><th>2 propostas</th><th>1 proposta</th><th>Nenhuma</th><th>Sem solicitação</th></tr></thead>
      <tbody>${m.disciplines.map(x => html`<tr><td>${x.name}</td><td>${x.items.length}</td><td>${x.summary.buckets.tres}</td><td>${x.summary.buckets.dois}</td><td>${x.summary.buckets.um}</td><td>${x.summary.buckets.nenhuma}</td><td>${x.summary.no_request}</td></tr>`)}</tbody>
      <tfoot><tr><th>Total</th><th>${S.items}</th><th>${S.buckets.tres} (${pct(S.buckets.tres, S.items)})</th><th>${S.buckets.dois} (${pct(S.buckets.dois, S.items)})</th><th>${S.buckets.um} (${pct(S.buckets.um, S.items)})</th><th>${S.buckets.nenhuma} (${pct(S.buckets.nenhuma, S.items)})</th><th>${S.no_request}</th></tr></tfoot></table>
    <p class="qp-note">Solicitações: ${S.requests.total} enviadas · ${S.requests.recebida} recebidas · ${S.requests.enviada} aguardando${S.requests.vencida ? ` (${S.requests.vencida} com prazo vencido)` : ''} · ${S.requests.declinou} declinaram.</p></article>`;
  const disc = x => html`<article class="doc qp-doc qp-break">${head}
    <h2 class="qp-h">Planilha cotação — ${x.name}</h2>
    <p class="qp-note">Itens: ${x.items.length} · com 3 ou mais: ${x.summary.buckets.tres} · com 2: ${x.summary.buckets.dois} · com 1: ${x.summary.buckets.um} · sem proposta: ${x.summary.buckets.nenhuma}</p>
    <table class="qp-t qp-map"><thead><tr><th class="qp-c">Cód. orç.</th><th class="qp-c">Local</th><th class="qp-desc">Descrição</th><th class="qp-n">Qtde.</th><th class="qp-c">Und</th><th class="qp-lab">Dados</th><th class="qp-n">Valor mediano</th>
      ${Array.from({ length: x.cols }, (_, k) => html`<th>Empresa ${String(k + 1).padStart(2, '0')}</th>`)}</tr></thead>
      ${x.items.map(it => html`<tbody class="qp-item"><tr class="qp-price"><td rowspan="${ROWS.length + 1}" class="qp-m">${it.code || ''}</td><td rowspan="${ROWS.length + 1}" class="qp-m">${it.location || ''}</td><td rowspan="${ROWS.length + 1}" class="qp-desc qp-m"><b>${it.description}</b>${it.abc || it.notes ? html`<small>${[it.abc ? `Curva ${it.abc}` : '', it.notes].filter(Boolean).join(' · ')}</small>` : ''}</td>
          <td rowspan="${ROWS.length + 1}" class="qp-n qp-m">${it.qty != null ? String(it.qty).replace('.', ',') : ''}</td><td rowspan="${ROWS.length + 1}" class="qp-m">${it.unit || ''}</td><td class="qp-lab">PREÇO</td><td rowspan="${ROWS.length + 1}" class="qp-n qp-m"><b>${money(it.median)}</b></td>
          ${Array.from({ length: x.cols }, (_, k) => html`<td class="qp-n">${money(it.offers[k]?.price)}</td>`)}</tr>
        ${ROWS.map(([label, key]) => html`<tr><td class="qp-lab">${label}</td>${Array.from({ length: x.cols }, (_, k) => { const o = it.offers[k]; const v = o ? o[key] : ''; return html`<td class="${key === 'status' ? `qp-st qp-st-${String(v || '').startsWith('RECEBIDO') ? 'ok' : String(v || '').startsWith('ENVIADO (') ? 'late' : 'x'}` : ''}">${(key === 'sent' || key === 'received') && v ? fmtDate(v) : v || ''}</td>`; })}</tr>`)}
      </tbody>`)}</table></article>`;
  return {
    title: `Mapa de cotações · ${m.project.code}`,
    html: html`${printToolbar({ back: `#/projetos/${params.id}/cotacoes`, title: `Mapa de cotações · ${m.project.code} (${m.disciplines.length} disciplina(s))` })}
      <div class="doc-stage qp-stage">${m.disciplines.length ? html`${resumo}${m.disciplines.map(disc)}` : html`<article class="doc qp-doc"><p class="muted">Nenhum item para cotar neste projeto.</p></article>`}</div>`,
    mount: bindPrintToolbar,
  };
}
