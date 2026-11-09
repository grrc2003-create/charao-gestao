// Meu painel: comprovantes dos pagamentos que a própria pessoa recebeu da Charão / LuS.
import { html, icon, fmtDate } from '../core.js';

const BRL = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const money = v => BRL.format(Number(v) || 0);
const refLabel = ref => `${ref.slice(5, 7)}/${ref.slice(0, 4)}`;

const title = i => (i.kind === 'folha' ? `Folha ${refLabel(i.ref)}` : `Folha de Campo · ${i.project_code} ${i.sheet}`);
const sub = i => (i.kind === 'folha' ? i.company_name || ''
  : `${i.project_name} · ${fmtDate(i.start_date, 'short')} a ${fmtDate(i.end_date, 'short')}`);
// Por que não há arquivo para abrir
const noFile = i => (i.shared ? 'Pago junto com outras pessoas: o comprovante fica com o financeiro'
  : i.by_finance ? 'Pago pelo Financeiro: o comprovante fica com o financeiro' : 'Pagamento registrado sem arquivo de comprovante');

const row = i => html`<li class="mr-row">
  <div class="mr-main"><b>${title(i)}</b>${sub(i) ? html`<small>${sub(i)}</small>` : ''}
    ${i.notes ? html`<small>${i.notes}</small>` : ''}
    ${i.files.length ? '' : html`<small class="mr-none">${noFile(i)}</small>`}</div>
  <div class="mr-val"><b>${money(i.amount)}</b><small>${i.date ? `pago em ${fmtDate(i.date)}` : 'pago'}${i.kind === 'folha' && !i.complete ? ` · parcial de ${money(i.total)}` : ''}</small></div>
  <div class="mr-acts">
    ${i.files.map((f, n) => html`<a class="btn btn-ghost btn-sm" href="${f.url}" target="_blank" rel="noopener" title="${f.original_name || 'Comprovante'}">${icon('file')}Comprovante${i.files.length > 1 ? ` ${n + 1}` : ''}</a>`)}
    ${i.kind === 'folha' ? html`<a class="btn btn-ghost btn-sm" href="#/imprimir/meu-recibo/${i.month_id}">${icon('print')}Recibo</a>` : ''}
  </div></li>`;

export const receiptsSummary = items => {
  const n = items.length;
  return `${n} ${n === 1 ? 'pagamento recebido' : 'pagamentos recebidos'}${items[0]?.date ? ` · último em ${fmtDate(items[0].date)}` : ''}`;
};

export function myReceiptsCard(items) {
  if (!items?.length) return '';
  return html`<section class="card mr-card"><div class="card-head"><h2>${icon('wallet')}Meus comprovantes</h2></div>
    <ul class="mr-list">${items.map(row)}</ul></section>`;
}
