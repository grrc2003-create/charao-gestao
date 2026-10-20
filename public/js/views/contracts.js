// Contratos (liberação por usuário): faturamento global, contratos, planilha contratual e medições (boletins).
import { html, raw, api, icon, fmtDate } from '../core.js';
import { toast, sheet, confirmSheet } from '../ui.js';
import { pageHead, kpi } from './shared.js';

const BRL = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
export const money = v => BRL.format(Number(v) || 0);
const qtyFmt = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 4 });
export const qty = v => qtyFmt.format(Number(v) || 0);
const pct = v => (v === null || v === undefined ? '—' : `${String(v).replace('.', ',')}%`);

const CT_STATUS = { vigente: 'Vigente', suspenso: 'Suspenso', encerrado: 'Encerrado' };
export const CO_SHORT = { charao: 'Charão', lus: 'LuS' };
const coBadge = c => html`<span class="co-badge co-${c.company}" title="${c.company_name || ''}">${CO_SHORT[c.company] || c.company}</span>`;
const typePill = c => (c.type_name ? html`<span class="pill">${c.type_name}</span>` : html`<span class="pill pill-warn">sem tipo</span>`);
export const M_STATUS = {
  rascunho: { label: 'Rascunho', cls: 'm-draft' },
  emitida: { label: 'Emitida', cls: 'm-issued' },
  faturada: { label: 'Faturada', cls: 'm-billed' },
  recebida: { label: 'Recebida', cls: 'm-paid' },
};
export const mBadge = s => html`<span class="m-badge ${M_STATUS[s].cls}">${M_STATUS[s].label}</span>`;
const MONTHS = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
const ym = s => `${MONTHS[Number(s.slice(5, 7)) - 1]}/${s.slice(2, 4)}`;

function denied(state) {
  if (!state.meta.can.contracts) throw new Error('Acesso restrito: solicite ao administrador a liberação de Contratos (Usuários → Editar).');
}

// ---------- Painel de faturamento + contratos ----------
// Cores por papel (mesmas em todo o painel): Medido = azul, Faturado = laranja, Recebido = verde-água; saldo = trilho neutro.
const SERIES = [
  { k: 'measured', label: 'Medido', note: 'mês de referência', cls: 's-med' },
  { k: 'billed', label: 'Faturado', note: 'mês da NF', cls: 's-fat' },
  { k: 'received', label: 'Recebido', note: 'mês do pagamento', cls: 's-rec' },
];
// Valor compacto para eixos e rótulos: R$ 12 mil · R$ 1,2 mi
export const moneyShort = v => {
  const a = Math.abs(v);
  if (a >= 1e6) return `R$ ${(v / 1e6).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} mi`;
  if (a >= 1e3) return `R$ ${(v / 1e3).toLocaleString('pt-BR', { maximumFractionDigits: a >= 1e5 ? 0 : 1 })} mil`;
  return money(v);
};
const niceMax = v => {
  if (v <= 0) return 1000;
  const p = 10 ** Math.floor(Math.log10(v));
  return [1, 2, 2.5, 5, 10].map(m => m * p).find(x => x >= v);
};

// Colunas agrupadas (Medido · Faturado · Recebido) por mês, com eixo, grade e dica ao passar o mouse
function monthlyChart(series) {
  const W = 760, H = 250, L = 72, R = 8, T = 14, B = 30;
  const max = niceMax(Math.max(0, ...series.flatMap(s => [s.measured, s.billed, s.received])));
  const iw = W - L - R, ih = H - T - B;
  const band = iw / series.length;
  const bw = Math.min(14, (band - 10) / 3);
  const step = series.length <= 12 ? 1 : series.length <= 18 ? 2 : 3; // rótulos do eixo sem sobreposição
  const y = v => T + ih - (v / max) * ih;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map(f => f * max);
  // Coluna com ponta arredondada (4px) e base reta
  const col = (x, v, cls) => {
    if (!v) return '';
    const h = Math.max(1.5, (v / max) * ih);
    const r = Math.min(4, h, bw / 2);
    const yb = T + ih, yt = yb - h;
    return `<path class="${cls}" d="M${x},${yb} V${yt + r} Q${x},${yt} ${x + r},${yt} H${x + bw - r} Q${x + bw},${yt} ${x + bw},${yt + r} V${yb} Z"/>`;
  };
  const bestIdx = series.reduce((b, s, i) => (s.billed > series[b].billed ? i : b), 0);
  const svg = `<svg viewBox="0 0 ${W} ${H}" class="ct-svg" role="img" aria-label="Medido, faturado e recebido por mês">
    ${ticks.map(t => `<line class="g-grid" x1="${L}" x2="${W - R}" y1="${y(t)}" y2="${y(t)}"/><text class="g-ytick" x="${L - 8}" y="${y(t) + 4}" text-anchor="end">${moneyShort(t)}</text>`).join('')}
    ${series.map((s, i) => {
      const x0 = L + i * band + (band - (bw * 3 + 4)) / 2;
      return `<g class="g-month" data-i="${i}">
        <rect class="g-hit" x="${L + i * band}" y="${T}" width="${band}" height="${ih + B}" tabindex="0"/>
        ${col(x0, s.measured, 's-med')}${col(x0 + bw + 2, s.billed, 's-fat')}${col(x0 + 2 * (bw + 2), s.received, 's-rec')}
        ${(series.length - 1 - i) % step === 0 ? `<text class="g-xtick" x="${L + i * band + band / 2}" y="${H - 10}" text-anchor="middle">${s.label}</text>` : ''}
      </g>`;
    }).join('')}
    ${series[bestIdx].billed ? `<text class="g-peak" x="${L + bestIdx * band + band / 2}" y="${y(series[bestIdx].billed) - 6}" text-anchor="middle">${moneyShort(series[bestIdx].billed)}</text>` : ''}
    <line class="g-base" x1="${L}" x2="${W - R}" y1="${T + ih}" y2="${T + ih}"/>
  </svg>`;
  return html`<div class="ct-chart-box">${raw(svg)}<div class="ct-tip" hidden></div></div>`;
}

// Barra de composição (parte do todo) com vãos de 2px e legenda com valores
function compositionBar(parts, total, { big = false } = {}) {
  const shown = parts.filter(p => p.v > 0);
  if (!total || !shown.length) return html`<div class="ct-comp ${big ? 'is-big' : ''}"><i class="s-none" style="flex:1"></i></div>`;
  return html`<div class="ct-comp ${big ? 'is-big' : ''}" role="img" aria-label="${shown.map(p => `${p.label}: ${money(p.v)}`).join('; ')}">
    ${shown.map(p => html`<i class="${p.cls}" style="flex:${p.v}" title="${p.label}: ${money(p.v)} (${Math.round((p.v / total) * 100)}%)"></i>`)}</div>`;
}
const pipeParts = s => [
  { label: 'Recebido', v: Math.max(0, s.received), cls: 's-rec' },
  { label: 'A receber (faturado)', v: Math.max(0, s.to_receive), cls: 's-fat' },
  { label: 'Emitido aguardando faturamento', v: Math.max(0, s.to_bill), cls: 's-med' },
  { label: 'Saldo a medir', v: Math.max(0, s.balance), cls: 's-none' },
];

const delta = (cur, prev, prevYear) => {
  if (!prev) return html`<span class="ct-delta">sem base no ano anterior</span>`;
  const d = Math.round(((cur - prev) / prev) * 1000) / 10;
  return html`<span class="ct-delta ${d >= 0 ? 'is-up' : 'is-down'}">${d >= 0 ? '▲' : '▼'} ${String(Math.abs(d)).replace('.', ',')}% vs mesmo período de ${prevYear}</span>`;
};
const ACT_KINDS = [['cobrar', 'Cobrar'], ['faturar', 'Faturar'], ['medir', 'Medir'], ['encerrar', 'Encerrar'], ['vencendo', 'Vencendo']];
const SEV = { critical: { label: 'Crítico', ic: 'alert' }, serious: { label: 'Atenção', ic: 'clock' }, warning: { label: 'Pendente', ic: 'info' } };

// ---------- Comparativo anual ----------
// Uma linha por ano (jan → dez) da métrica escolhida; o ano atual em destaque na cor da métrica, os anteriores em cinza.
const MET = { billed: { label: 'Faturado', note: 'pela data da NF', color: 'var(--s-fat)' }, measured: { label: 'Medido', note: 'pelo mês de referência', color: 'var(--s-med)' }, received: { label: 'Recebido', note: 'pela data do pagamento', color: 'var(--s-rec)' } };
const MES = ['JAN', 'FEV', 'MAR', 'ABR', 'MAI', 'JUN', 'JUL', 'AGO', 'SET', 'OUT', 'NOV', 'DEZ'];
const OLD = ['#8E979F', '#C4C9CE'];
const cum = a => a.reduce((o, v, i) => (o.push((o[i - 1] || 0) + v), o), []);

function annualChart(annual, metric, mode, curYear, curMonth) {
  const ys = annual.slice(-3);
  const W = 760, H = 260, L = 72, R = 56, T = 16, B = 30;
  const iw = W - L - R, ih = H - T - B;
  const vals = y => {
    const a = mode === 'acum' ? cum(y[metric]) : y[metric];
    return y.year === curYear ? a.slice(0, curMonth) : a; // ano atual só até o mês corrente
  };
  const max = niceMax(Math.max(0, ...ys.flatMap(vals)));
  const x = i => L + (i / 11) * iw;
  const y = v => T + ih - (v / max) * ih;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map(f => f * max);
  const colorOf = (yy, k) => (yy.year === curYear ? MET[metric].color : OLD[Math.min(OLD.length - 1, ys.length - 2 - k)] || OLD[0]);
  const lines = ys.map((yy, k) => {
    const v = vals(yy);
    if (!v.length) return '';
    const c = colorOf(yy, k);
    const cur = yy.year === curYear;
    const pts = v.map((val, i) => `${x(i).toFixed(1)},${y(val).toFixed(1)}`).join(' ');
    const li = v.length - 1;
    return `<polyline points="${pts}" style="fill:none;stroke:${c};stroke-width:${cur ? 3 : 2}px;stroke-linejoin:round;stroke-linecap:round"/>
      ${cur ? `<circle cx="${x(li)}" cy="${y(v[li])}" r="5" style="fill:${c};stroke:#fff;stroke-width:2px"/>
        <text class="g-peak" x="${x(li) + 8}" y="${y(v[li]) + 4}">${moneyShort(v[li])}</text>` : ''}`;
  }).join('');
  const svg = `<svg viewBox="0 0 ${W} ${H}" class="ct-svg" role="img" aria-label="Comparativo anual">
    ${ticks.map(t => `<line class="g-grid" x1="${L}" x2="${W - R}" y1="${y(t)}" y2="${y(t)}"/><text class="g-ytick" x="${L - 8}" y="${y(t) + 4}" text-anchor="end">${moneyShort(t)}</text>`).join('')}
    <line class="g-base" x1="${L}" x2="${W - R}" y1="${T + ih}" y2="${T + ih}"/>
    ${MES.map((m, i) => `<text class="g-xtick" x="${x(i)}" y="${H - 10}" text-anchor="middle">${m}</text>`).join('')}
    <line class="g-cross" x1="0" x2="0" y1="${T}" y2="${T + ih}" visibility="hidden"/>
    ${lines}
    ${MES.map((m, i) => `<rect class="g-hit" data-m="${i}" x="${x(i) - iw / 22}" y="${T}" width="${iw / 11}" height="${ih}" tabindex="0"/>`).join('')}
  </svg>`;
  return { svg, ys, colorOf, vals };
}

function annualSection(d) {
  return html`<section class="card ct-annual" id="ct-annual">
    <div class="card-head"><h2>${icon('history')}Comparativo anual</h2>
      <div class="ct-ann-ctrl">
        <div class="chips" role="group" aria-label="Métrica">${Object.entries(MET).map(([k, m]) => html`<button class="chip" data-am="${k}" aria-pressed="${k === 'billed'}">${m.label}</button>`)}</div>
        <div class="chips" role="group" aria-label="Visão">${[['mes', 'Mês a mês'], ['acum', 'Acumulado no ano']].map(([k, l]) => html`<button class="chip" data-av="${k}" aria-pressed="${k === 'acum'}">${l}</button>`)}</div>
      </div></div>
    <div class="card-body"><div data-ann-body></div></div>
  </section>`;
}

function bindAnnual(root, d) {
  const sec = root.querySelector('#ct-annual');
  if (!sec) return;
  const body = sec.querySelector('[data-ann-body]');
  const curYear = d.year.year;
  const curMonth = Number(d.year.through.slice(0, 2));
  let metric = 'billed', mode = 'acum';
  const draw = () => {
    const { svg, ys, colorOf, vals } = annualChart(d.annual, metric, mode, curYear, curMonth);
    // Mesmo período (jan até o mês corrente) para comparar anos de forma justa
    const ytd = yy => yy[metric].slice(0, curMonth).reduce((s, v) => s + v, 0);
    const rows = [...d.annual].reverse();
    body.innerHTML = html`
      <ul class="ct-legend">${ys.map((yy, k) => html`<li><i class="ln-key" style="background:${raw(colorOf(yy, k))}"></i><b>${yy.year}</b>${yy.year === curYear ? html`<small>até ${MES[curMonth - 1].toLowerCase()}</small>` : ''}<span class="ct-leg-v">${moneyShort(yy.year === curYear ? ytd(yy) : yy.totals[metric])}</span></li>`)}
        <li class="ct-leg-note">${MET[metric].label} ${MET[metric].note}${mode === 'acum' ? ' · acumulado no ano' : ''}</li></ul>
      <div class="ct-chart-box">${raw(svg)}<div class="ct-tip" hidden></div></div>
      <div class="table-wrap"><table class="data ct-table ct-ann-table"><thead><tr><th>Ano</th><th class="num">Medido</th><th class="num">Faturado</th><th class="num">Recebido</th>
        <th class="num">${MET[metric].label} jan–${MES[curMonth - 1].toLowerCase()}</th><th class="num">Variação (mesmo período)</th></tr></thead>
        <tbody>${rows.map(yy => {
          const prev = d.annual.find(z => Number(z.year) === Number(yy.year) - 1);
          const a = ytd(yy), b = prev ? ytd(prev) : 0;
          const v = b ? Math.round(((a - b) / b) * 1000) / 10 : null;
          return html`<tr class="${yy.year === curYear ? 'is-cur' : ''}"><td><b>${yy.year}</b>${yy.year === curYear ? html` <small class="muted">(parcial)</small>` : ''}</td>
            <td class="num">${money(yy.totals.measured)}</td><td class="num">${money(yy.totals.billed)}</td><td class="num">${money(yy.totals.received)}</td>
            <td class="num">${money(a)}</td><td class="num">${v === null ? '—' : html`<span class="ct-var ${v >= 0 ? 'is-up' : 'is-down'}">${v >= 0 ? '▲' : '▼'} ${String(Math.abs(v)).replace('.', ',')}%</span>`}</td></tr>`;
        })}</tbody></table></div>`.toString();
    // Linha-guia + dica: o mês sob o cursor, com o valor de cada ano
    const box = body.querySelector('.ct-chart-box');
    const tip = box.querySelector('.ct-tip');
    const cross = box.querySelector('.g-cross');
    const show = r => {
      const i = Number(r.dataset.m);
      const cx = Number(r.getAttribute('x')) + Number(r.getAttribute('width')) / 2;
      cross.setAttribute('x1', cx); cross.setAttribute('x2', cx); cross.setAttribute('visibility', 'visible');
      tip.replaceChildren();
      const h = document.createElement('div'); h.className = 'ct-tip-h'; h.textContent = `${MES[i]}${mode === 'acum' ? ' · acumulado' : ''}`; tip.appendChild(h);
      [...ys].reverse().forEach(yy => {
        const k = ys.indexOf(yy);
        const v = vals(yy)[i];
        const row = document.createElement('div'); row.className = 'ct-tip-r';
        const key = document.createElement('i'); key.className = 'ln'; key.style.background = colorOf(yy, k);
        const b = document.createElement('b'); b.textContent = v === undefined ? '—' : money(v);
        const l = document.createElement('span'); l.textContent = yy.year;
        row.append(key, b, l); tip.appendChild(row);
      });
      tip.hidden = false;
      const br = box.getBoundingClientRect(), rr = r.getBoundingClientRect();
      tip.style.left = `${Math.min(br.width - tip.offsetWidth - 4, Math.max(4, rr.left - br.left + rr.width / 2 + 12))}px`;
    };
    box.querySelectorAll('.g-hit').forEach(r => { r.addEventListener('pointerenter', () => show(r)); r.addEventListener('focus', () => show(r)); });
    box.addEventListener('pointerleave', () => { tip.hidden = true; cross.setAttribute('visibility', 'hidden'); });
  };
  sec.querySelectorAll('[data-am]').forEach(b => b.addEventListener('click', () => { metric = b.dataset.am; sec.querySelectorAll('[data-am]').forEach(x => x.setAttribute('aria-pressed', String(x === b))); draw(); }));
  sec.querySelectorAll('[data-av]').forEach(b => b.addEventListener('click', () => { mode = b.dataset.av; sec.querySelectorAll('[data-av]').forEach(x => x.setAttribute('aria-pressed', String(x === b))); draw(); }));
  draw();
}

// ---------- Ranking de clientes por faturamento (período escolhido) ----------
// Uma só série (faturado, laranja): barras horizontais ordenadas, valor na ponta, % do total e recebido como texto.
const RK_PERIODS = [['ano', 'Ano atual'], ['ano_ant', 'Ano anterior'], ['12m', 'Últimos 12 meses'], ['6m', 'Últimos 6 meses'], ['3m', 'Últimos 3 meses'], ['tudo', 'Todo o período']];
function rkRange(k, ref) {
  const y = Number(ref.slice(0, 4));
  const back = n => { const d = new Date(`${ref}T12:00:00Z`); d.setUTCMonth(d.getUTCMonth() - n); return d.toISOString().slice(0, 10); };
  return { ano: [`${y}-01-01`, ref], ano_ant: [`${y - 1}-01-01`, `${y - 1}-12-31`], '12m': [back(12), ref], '6m': [back(6), ref], '3m': [back(3), ref], tudo: ['0000', '9999'] }[k];
}

function rankingSection() {
  return html`<section class="card ct-rank" id="ct-rank">
    <div class="card-head"><h2>${icon('team')}Clientes que mais faturam</h2>
      <div class="chips" role="group" aria-label="Período do ranking">${RK_PERIODS.map(([k, l]) => html`<button class="chip" data-rk="${k}" aria-pressed="${k === 'ano'}">${l}</button>`)}</div></div>
    <div class="card-body"><div data-rk-body></div></div>
  </section>`;
}

function bindRanking(root, d) {
  const sec = root.querySelector('#ct-rank');
  if (!sec) return;
  const body = sec.querySelector('[data-rk-body]');
  const ref = `${d.year.year}-${d.year.through}`;
  let expanded = false, cur = 'ano';
  const draw = k => {
    if (k !== cur) expanded = false;
    cur = k;
    const [a, b] = rkRange(k, ref);
    const by = new Map();
    for (const n of d.billing.filter(x => x.nf_date >= a && x.nf_date <= b)) {
      if (!by.has(n.client)) by.set(n.client, { client: n.client, total: 0, received: 0, nfs: 0, contracts: new Set() });
      const c = by.get(n.client);
      c.total += n.total; c.received += n.received; c.nfs++; c.contracts.add(n.contract);
    }
    const rows = [...by.values()].sort((x, y) => y.total - x.total);
    const total = rows.reduce((s, r) => s + r.total, 0);
    const max = Math.max(1, ...rows.map(r => r.total));
    const top = expanded ? rows.slice() : rows.slice(0, 10);
    const rest = expanded ? [] : rows.slice(10);
    if (rest.length) top.push({ client: `Outros (${rest.length})`, total: rest.reduce((s, r) => s + r.total, 0), received: rest.reduce((s, r) => s + r.received, 0), nfs: rest.reduce((s, r) => s + r.nfs, 0), contracts: new Set(), other: true });
    const label = k === 'tudo' ? 'todo o período' : `${a.split('-').reverse().join('/')} a ${b.split('-').reverse().join('/')}`;
    body.innerHTML = (rows.length ? html`
      <div class="ct-rk-head"><span>Faturado (pela data do faturamento) · ${label}</span><b>${money(total)}</b><small>${rows.length} cliente(s)</small></div>
      <ol class="ct-rk-list">${top.map((r, i) => html`<li class="${r.other ? 'is-other' : ''}">${r.other
        ? html`<button type="button" class="ct-rk-a" data-rk-more title="Ver os outros ${rest.length} clientes">`
        : html`<a class="ct-rk-a" href="#/contratos/cliente?nome=${encodeURIComponent(r.client)}" title="Abrir ${r.client}">`}
        <span class="ct-rk-pos">${r.other ? '' : `${i + 1}º`}</span>
        <div class="ct-rk-main">
          <div class="ct-rk-name"><b>${r.client}</b><span>${r.nfs} lanç. · recebido ${money(r.received)}</span></div>
          <div class="ct-rk-bar"><i style="width:calc((100% - 120px) * ${Math.max(0.015, r.total / max).toFixed(4)})"></i><em>${money(r.total)}</em></div>
        </div>
        <span class="ct-rk-share">${String(total ? Math.round((r.total / total) * 1000) / 10 : 0).replace('.', ',')}%</span>${r.other ? html`</button>` : html`</a>`}</li>`)}</ol>
      ${expanded && rows.length > 10 ? html`<button type="button" class="ct-rk-less" data-rk-less>Mostrar só os 10 maiores</button>` : ''}`
      : html`<p class="muted" style="margin:0">Nenhuma nota fiscal emitida neste período.</p>`).toString();
  };
  sec.querySelectorAll('[data-rk]').forEach(b => b.addEventListener('click', () => { sec.querySelectorAll('[data-rk]').forEach(x => x.setAttribute('aria-pressed', String(x === b))); draw(b.dataset.rk); }));
  // "Outros (N)" abre a lista completa; cada cliente abre a tela do cliente
  body.addEventListener('click', e => {
    if (e.target.closest('[data-rk-more]')) { expanded = true; draw(cur); }
    else if (e.target.closest('[data-rk-less]')) { expanded = false; draw(cur); }
  });
  draw('ano');
}

// ---------- Linha de contrato e tabela com filtros (painel e tela do cliente) ----------
// "Concluído" = 100% medido e nada pendente (sem boletim aguardando faturamento e nada a receber)
const isFull = c => c.summary.value > 0 && c.summary.balance <= 0.005 && c.summary.to_bill <= 0.005 && c.summary.to_receive <= 0.005;
const contractRow = c => {
  const s = c.summary;
  return html`<a class="ct-row" href="#/contratos/${c.id}" data-st="${c.status}" data-full="${isFull(c) ? 1 : 0}">
    <div class="ct-row-id"><span class="ct-row-tags"><span class="mono">${c.code}</span>${coBadge(c)}${typePill(c)}</span><b>${c.client}</b><small>${c.title}</small></div>
    <div class="ct-row-bar">${compositionBar(pipeParts(s), s.value)}
      <div class="ct-row-meta"><span><b>${pct(s.pct)}</b> medido</span>${s.last ? html`<span>último ${s.last.code} ${mBadge(s.last.status)}</span>` : html`<span>sem medições</span>`}${s.drafts ? html`<span class="m-badge m-draft">rascunho</span>` : ''}</div></div>
    <div class="ct-row-nums"><span><small>Contratado</small><b>${money(s.value)}</b></span><span><small>A receber</small><b>${money(s.to_receive)}</b>${s.to_bill > 0.005 ? html`<em class="ct-row-nf">+ ${money(s.to_bill)} aguardando faturamento</em>` : ''}</span><span><small>Saldo a medir</small><b>${money(s.balance)}</b></span></div>
    <span class="chev">${icon('chevron')}</span></a>`;
};
const contractTable = (contracts, { filter, hideFull, title = 'Contratos', emptyText = 'Nenhum contrato cadastrado. Comece em “Novo contrato”.' }) => html`<section class="card ct-list-card">
  <div class="card-head"><h2>${icon('contract')}${title}</h2>
    <div class="ct-list-filters">
      <div class="chips" role="group" aria-label="Filtrar contratos por situação">${[['vigente', 'Vigentes'], ['suspenso', 'Suspensos'], ['encerrado', 'Encerrados'], ['todos', 'Todos']].map(([k, l]) =>
        html`<button type="button" class="chip" data-ctf="${k}" aria-pressed="${filter === k}">${l}<span class="n" data-ctn="${k}"></span></button>`)}</div>
      <button type="button" class="chip ct-full-chip" data-ctfull aria-pressed="${hideFull}" title="Oculta os contratos 100% medidos sem nada pendente (nenhum boletim aguardando faturamento e nada a receber)">${icon('check')}Ocultar 100% medidos e recebidos<span class="n" data-ctn-full></span></button>
    </div></div>
  <ul class="ct-port-legend is-inline">${pipeParts({ received: 1, to_receive: 1, to_bill: 1, balance: 1 }).map(p => html`<li><i class="k ${p.cls}"></i><span>${p.label}</span></li>`)}</ul>
  ${contracts.length ? html`<div class="ct-rows">${contracts.map(contractRow)}</div><div class="card-body muted" data-ct-empty hidden>Nenhum contrato neste filtro.</div>`
    : html`<div class="card-body muted">${emptyText}</div>`}
</section>`;
// Filtros da tabela: só mexem nas linhas da tabela (sem recarregar a página)
function bindContractTable(root, state, onChange = () => {}) {
  const rows = [...root.querySelectorAll('.ct-rows .ct-row')];
  const apply = () => {
    const { filter, hideFull } = state;
    const passSt = r => filter === 'todos' || r.dataset.st === filter;
    let n = 0;
    for (const r of rows) { const on = passSt(r) && !(hideFull && r.dataset.full === '1'); r.hidden = !on; if (on) n++; }
    root.querySelector('[data-ct-empty]')?.toggleAttribute('hidden', n > 0);
    root.querySelectorAll('[data-ctn]').forEach(el => {
      const k = el.dataset.ctn;
      el.textContent = rows.filter(r => (k === 'todos' || r.dataset.st === k) && !(hideFull && r.dataset.full === '1')).length;
    });
    const full = root.querySelector('[data-ctn-full]');
    if (full) full.textContent = rows.filter(r => r.dataset.full === '1' && (filter === 'todos' || r.dataset.st === filter)).length;
    root.querySelectorAll('[data-ctf]').forEach(x => x.setAttribute('aria-pressed', String(x.dataset.ctf === filter)));
    root.querySelector('[data-ctfull]')?.setAttribute('aria-pressed', String(hideFull));
    onChange(state);
  };
  root.querySelectorAll('[data-ctf]').forEach(b => b.addEventListener('click', () => { state.filter = b.dataset.ctf; apply(); }));
  root.querySelector('[data-ctfull]')?.addEventListener('click', () => { state.hideFull = !state.hideFull; apply(); });
  apply();
}

export async function list({ state, query, setQuery, render }) {
  denied(state);
  const months = query.get('meses') || '12';
  const empresa = query.get('empresa') || '', tipo = query.get('tipo') || '';
  const d = await api('/contracts/dashboard', { query: { meses: months, empresa, tipo } });
  // Filtros da tabela de contratos (situação e "ocultar 100% medidos"): só mexem na tabela, sem recarregar a página
  let filter = query.get('status') || 'vigente';
  let hideFull = query.get('medidos') !== '1';
  const qs = (over = {}) => ({ meses: months, empresa, tipo, status: filter, medidos: hideFull ? '' : '1', ...over });
  const t = d.totals;
  const Y = d.year;

  // Carteira: só contratos vigentes (recebido + a receber + aguardando faturamento + saldo = contratado)
  const vig = d.contracts.filter(c => c.status === 'vigente');
  const vsum = k => vig.reduce((x, c) => x + (c.summary[k] || 0), 0);
  const port = { received: vsum('received'), to_receive: vsum('to_receive'), to_bill: vsum('to_bill'), balance: vsum('balance') };
  const portTotal = port.received + port.to_receive + port.to_bill + Math.max(0, port.balance);
  const agingMax = Math.max(1, ...d.aging.map(a => a.total));
  const sumSeries = k => d.series.reduce((s, x) => s + x[k], 0);

  return {
    title: 'Contratos',
    html: html`
      ${pageHead({
        eyebrow: 'Acesso restrito · liberação por usuário',
        title: 'Contratos e faturamento',
        actions: html`${d.area_id ? html`<a class="btn btn-ghost" href="#/projetos/${d.area_id}">${icon('tasks')}Tarefas de contratos</a>` : ''}<a class="btn btn-ghost" href="#/contratos/importar-bms">${icon('file')}Importar BMs</a><a class="btn btn-accent" href="#/contratos/novo">${icon('plus')}Novo contrato</a>`,
      })}
      <div class="ct-filter" role="group" aria-label="Filtrar o painel">
        <div class="chips" role="group" aria-label="Empresa">${[['', 'Todas as empresas', d.companies.reduce((s, x) => s + x.contracts, 0)], ...d.companies.map(x => [x.key, CO_SHORT[x.key] || x.name, x.contracts])].map(([k, l, n]) =>
          html`<button class="chip ${k ? `co-chip co-${k}` : ''}" data-emp="${k}" aria-pressed="${empresa === k}" title="${d.companies.find(x => x.key === k)?.name || ''}">${l}<span class="n">${n}</span></button>`)}</div>
        <label class="ct-filter-type"><span>Tipo</span><select id="ct-tipo" aria-label="Tipo de contrato"><option value="">Todos os tipos</option>
          ${d.types.map(t => html`<option value="${t.id}" ${String(tipo) === String(t.id) ? 'selected' : ''}>${t.name} (${t.contracts})</option>`)}</select></label>
        ${empresa || tipo ? html`<span class="ct-filter-on">Mostrando: ${[empresa ? d.companies.find(x => x.key === empresa)?.name : '', tipo ? d.types.find(t => String(t.id) === String(tipo))?.name : ''].filter(Boolean).join(' · ')}
          <button type="button" class="btn btn-ghost btn-sm" data-emp-clear>Limpar</button></span>` : ''}
      </div>
      <div class="ct-dash">
        <section class="card ct-hero">
          <div class="ct-hero-main">
            <div class="ct-hero-label">Faturado em ${Y.year} <small>até ${Y.through.split('-').reverse().join('/')}</small></div>
            <div class="ct-hero-value">${money(Y.billed)}</div>
            ${delta(Y.billed, Y.billed_prev, Y.prev)}
            <div class="ct-hero-sub">
              <span><i class="k s-rec"></i>Recebido no ano <b>${money(Y.received)}</b></span>
              <span><i class="k s-med"></i>Medido no ano <b>${money(Y.measured)}</b></span>
            </div>
          </div>
          <div class="ct-hero-port">
            <div class="ct-port-head"><b>Carteira de contratos vigentes</b><span>${money(t.value)} · ${t.active} contrato(s)</span></div>
            ${compositionBar(pipeParts(port), portTotal, { big: true })}
            <ul class="ct-port-legend">${pipeParts(port).map(p => html`<li><i class="k ${p.cls}"></i><span>${p.label}</span><b>${money(p.v)}</b><small>${portTotal ? Math.round((p.v / portTotal) * 100) : 0}%</small></li>`)}</ul>
          </div>
        </section>

        <div class="ct-tiles">
          ${[['Contratado (vigentes)', money(t.value), `${t.active} de ${t.contracts} contrato(s)`],
            ['Medido (total)', money(t.measured), 'boletins emitidos'],
            ['Faturado (total)', money(t.billed), `${money(t.to_bill)} aguardando faturamento`],
            ['Recebido (total)', money(t.received), ''],
            ['A receber', money(t.to_receive), 'faturado e não recebido'],
            ['Saldo a medir', money(t.balance), t.drafts ? `${t.drafts} medição(ões) em rascunho` : 'contratos vigentes']]
            .map(([l, v, f]) => html`<div class="ct-tile"><span>${l}</span><b>${v}</b>${f ? html`<small>${f}</small>` : ''}</div>`)}
        </div>

        <section class="card ct-month">
          <div class="card-head"><h2>${icon('reports')}Faturamento mensal</h2>
            <div class="chips" role="group" aria-label="Período">${['6', '12', '24'].map(n => html`<button class="chip" data-meses="${n}" aria-pressed="${months === n}">${n} meses</button>`)}</div></div>
          <div class="card-body">
            <ul class="ct-legend">${SERIES.map(s => html`<li><i class="k ${s.cls}"></i>${s.label}<small>${s.note}</small><b>${moneyShort(sumSeries(s.k))}</b></li>`)}</ul>
            ${monthlyChart(d.series)}
            <details class="ct-table-view"><summary>Ver tabela</summary>
              <div class="table-wrap"><table class="data ct-table"><thead><tr><th>Mês</th><th class="num">Medido</th><th class="num">Faturado</th><th class="num">Recebido</th></tr></thead>
              <tbody>${d.series.map(s => html`<tr><td>${s.label}</td><td class="num">${money(s.measured)}</td><td class="num">${money(s.billed)}</td><td class="num">${money(s.received)}</td></tr>`)}</tbody></table></div></details>
          </div>
        </section>

        ${annualSection(d)}
        ${rankingSection()}

        <div class="ct-two">
          <section class="card">
            <div class="card-head"><h2>${icon('clock')}A receber por antiguidade</h2><span class="sub">dias desde o faturamento</span></div>
            <div class="card-body ct-aging">
              ${d.aging.map((a, i) => html`<div class="ct-age ${i === 3 && a.total ? 'is-crit' : ''}">
                <span class="ct-age-l">${i === 3 && a.total ? html`${icon('alert')} ` : ''}${a.label}</span>
                <div class="ct-age-bar"><i style="width:${(a.total / agingMax) * 100}%"></i></div>
                <span class="ct-age-v"><b>${money(a.total)}</b><small>${a.count} boletim(ns)</small></span></div>`)}
              ${!t.to_receive ? html`<p class="muted" style="margin:6px 0 0">Nada faturado em aberto.</p>` : ''}
            </div>
          </section>
          <section class="card">
            <div class="card-head"><h2>${icon('alert')}Próximas ações</h2><span class="sub">${d.actions.length} pendência(s)</span></div>
            ${d.actions.length ? (() => {
              // Avisos iguais (sem medição, 100% medido) viram uma linha só, que abre a lista de contratos
              const items = [];
              const groups = new Map();
              for (const a of d.actions) {
                if (!a.group) { items.push({ ...a, list: [a] }); continue; }
                if (!groups.has(a.group)) { const g = { ...a, list: [] }; groups.set(a.group, g); items.push(g); }
                groups.get(a.group).list.push(a);
              }
              const kinds = ACT_KINDS.filter(([k]) => items.some(i => i.kind === k));
              const row = i => html`<li class="sev-${i.severity}" data-act="${i.kind}">${i.list.length > 1 ? html`<details class="ct-act-group"><summary>
                  <span class="ct-sev">${icon(SEV[i.severity].ic)}${SEV[i.severity].label}</span>
                  <span class="ct-act-t"><b>${i.text}</b><small>${i.list.length} contratos</small></span>${icon('chevron')}</summary>
                  <ul>${i.list.map(a => html`<li><a href="${a.href}"><span class="mono">${a.code}</span><span>${a.client}</span>${icon('chevron')}</a></li>`)}</ul></details>`
                : html`<a href="${i.href}"><span class="ct-sev">${icon(SEV[i.severity].ic)}${SEV[i.severity].label}</span>
                  <span class="ct-act-t"><b>${i.text}</b><small>${i.client} · ${i.code}</small></span>${icon('chevron')}</a>`}</li>`;
              return html`${kinds.length > 1 ? html`<div class="chips ct-act-chips" role="group" aria-label="Filtrar ações"><button type="button" class="chip" data-actf="" aria-pressed="true">Todas<span class="n">${items.length}</span></button>
                  ${kinds.map(([k, l]) => html`<button type="button" class="chip" data-actf="${k}" aria-pressed="false">${l}<span class="n">${items.filter(i => i.kind === k).length}</span></button>`)}</div>` : ''}
                <ul class="ct-actions">${items.map(row)}</ul>
                <button type="button" class="ct-act-more" data-actmore hidden></button>`;
            })()
              : html`<div class="card-body muted">Tudo em dia: medições mensais lançadas, boletins faturados e recebimentos em dia.</div>`}
          </section>
        </div>

        ${d.by_client.length > 1 ? (() => {
          // Ranking de clientes: barra proporcional ao contratado (o maior cliente = barra cheia), com a composição dentro
          const cl = d.by_client.map(b => ({ ...b, open: b.balance > 0.005 || b.to_bill > 0.005 || b.to_receive > 0.005, pct: b.value ? Math.min(100, Math.round((b.measured / b.value) * 1000) / 10) : 0 }))
            .sort((a, b) => b.value - a.value);
          const max = Math.max(1, ...cl.map(b => b.value));
          const row = (b, i) => html`<li class="ct-cl-li" data-open="${b.open ? 1 : 0}" data-rank="${i}"><a class="ct-cl" href="#/contratos/cliente?nome=${encodeURIComponent(b.client)}" title="Abrir ${b.client}">
            <div class="ct-cl-id"><b title="${b.client}">${b.client}</b><small>${b.contracts} contrato(s) · ${String(b.pct).replace('.', ',')}% medido</small></div>
            <div class="ct-cl-bar"><div class="ct-cl-fill" style="width:${Math.max(1.5, (b.value / max) * 100).toFixed(2)}%">${compositionBar(pipeParts({ received: b.received, to_receive: b.to_receive, to_bill: b.to_bill, balance: b.balance }), b.value)}</div></div>
            <div class="ct-cl-num"><b class="ct-cl-val">${money(b.value)}</b><span class="ct-cl-sub"><small>${b.balance > 0.005 ? html`saldo a medir <span>${money(b.balance)}</span>` : 'todo medido'}</small>${b.to_bill > 0.005 ? html`<small>aguardando faturamento <span>${money(b.to_bill)}</span></small>` : ''}${b.to_receive > 0.005 ? html`<small>a receber <span>${money(b.to_receive)}</span></small>` : ''}</span></div>
          </a></li>`;
          return html`<section class="card ct-cli-card">
            <div class="card-head"><h2>${icon('team')}Por cliente</h2>
              <div class="chips" role="group" aria-label="Filtrar clientes">
                <button type="button" class="chip" data-clf="open" aria-pressed="true" title="Clientes com saldo a medir, boletim aguardando faturamento ou valor a receber">Em aberto<span class="n">${cl.filter(b => b.open).length}</span></button>
                <button type="button" class="chip" data-clf="all" aria-pressed="false">Todos<span class="n">${cl.length}</span></button></div></div>
            <div class="card-body">
              <p class="ct-cl-hint">Barra proporcional ao valor contratado (o maior cliente ocupa a barra inteira) · cores: ${pipeParts({ received: 1, to_receive: 1, to_bill: 1, balance: 1 }).map(p => html`<i class="k ${p.cls}"></i>${p.label.replace(' (faturado)', '').toLowerCase()} `)}</p>
              <ol class="ct-cl-list">${cl.map(row)}</ol>
              <p class="muted ct-cl-empty" hidden>Nenhum cliente em aberto.</p>
              <button type="button" class="btn btn-ghost btn-sm ct-cl-more" data-clmore hidden></button>
            </div>
          </section>`;
        })() : ''}

        ${contractTable(d.contracts, { filter, hideFull })}
      </div>`,
    mount(root) {
      // Próximas ações: filtro por tipo e "+N pendências" (só este quadro)
      const actList = root.querySelector('.ct-actions');
      if (actList) {
        const lis = [...actList.children];
        const more = root.querySelector('[data-actmore]');
        let kind = '', all = false;
        const drawAct = () => {
          const pass = lis.filter(li => !kind || li.dataset.act === kind);
          lis.forEach(li => { li.hidden = true; });
          pass.forEach((li, i) => { li.hidden = !all && i >= 8; });
          more.hidden = pass.length <= 8;
          more.textContent = all ? 'Mostrar menos' : `+ ${pass.length - 8} pendência(s) — ver todas`;
          root.querySelectorAll('[data-actf]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.actf === kind)));
        };
        root.querySelectorAll('[data-actf]').forEach(b => b.addEventListener('click', () => { kind = b.dataset.actf; drawAct(); }));
        more.addEventListener('click', () => { all = !all; drawAct(); });
        drawAct();
      }
      // Por cliente: filtro e "ver todos" só nesta lista
      const cliCard = root.querySelector('.ct-cli-card');
      if (cliCard) {
        let clf = 'open', expanded = false;
        const TOP = 10;
        const items = [...cliCard.querySelectorAll('.ct-cl-li')];
        const more = cliCard.querySelector('[data-clmore]');
        const drawCli = () => {
          const pass = items.filter(li => clf === 'all' || li.dataset.open === '1');
          items.forEach(li => { li.hidden = true; });
          pass.forEach((li, i) => { li.hidden = !expanded && i >= TOP; });
          cliCard.querySelector('.ct-cl-empty').hidden = pass.length > 0;
          more.hidden = pass.length <= TOP;
          more.textContent = expanded ? 'Mostrar só os 10 maiores' : `Ver todos (${pass.length})`;
          cliCard.querySelectorAll('[data-clf]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.clf === clf)));
        };
        cliCard.querySelectorAll('[data-clf]').forEach(b => b.addEventListener('click', () => { clf = b.dataset.clf; drawCli(); }));
        more.addEventListener('click', () => { expanded = !expanded; drawCli(); });
        drawCli();
      }
      // Tabela de contratos: filtra só as linhas da tabela (o restante do painel não muda)
      const tbl = { filter, hideFull };
      bindContractTable(root, tbl, st => { filter = st.filter; hideFull = st.hideFull; setQuery(qs()); });
      root.querySelectorAll('[data-meses]').forEach(b => b.addEventListener('click', () => { setQuery(qs({ meses: b.dataset.meses })); render(); }));
      root.querySelectorAll('[data-emp]').forEach(b => b.addEventListener('click', () => { setQuery(qs({ empresa: b.dataset.emp })); render(); }));
      root.querySelector('#ct-tipo')?.addEventListener('change', e => { setQuery(qs({ tipo: e.target.value })); render(); });
      root.querySelector('[data-emp-clear]')?.addEventListener('click', () => { setQuery(qs({ empresa: '', tipo: '' })); render(); });
      bindAnnual(root, d);
      bindRanking(root, d);
      // Dica do gráfico: mês + os três valores (valor em destaque, série em seguida)
      const box = root.querySelector('.ct-chart-box');
      const tip = box?.querySelector('.ct-tip');
      const show = g => {
        const s = d.series[Number(g.dataset.i)];
        box.querySelectorAll('.g-month.is-on').forEach(x => x.classList.remove('is-on'));
        g.classList.add('is-on');
        tip.replaceChildren();
        const h = document.createElement('div'); h.className = 'ct-tip-h'; h.textContent = s.label; tip.appendChild(h);
        for (const se of SERIES) {
          const row = document.createElement('div'); row.className = 'ct-tip-r';
          const k = document.createElement('i'); k.className = `ln ${se.cls}`;
          const v = document.createElement('b'); v.textContent = money(s[se.k]);
          const l = document.createElement('span'); l.textContent = se.label;
          row.append(k, v, l); tip.appendChild(row);
        }
        tip.hidden = false;
        const br = box.getBoundingClientRect(), gr = g.querySelector('.g-hit').getBoundingClientRect();
        const left = Math.min(br.width - tip.offsetWidth - 4, Math.max(4, gr.left - br.left + gr.width / 2 - tip.offsetWidth / 2));
        tip.style.left = `${left}px`;
      };
      box?.querySelectorAll('.g-month').forEach(g => {
        g.addEventListener('pointerenter', () => show(g));
        g.querySelector('.g-hit').addEventListener('focus', () => show(g));
      });
      box?.addEventListener('pointerleave', () => { tip.hidden = true; box.querySelectorAll('.g-month.is-on').forEach(x => x.classList.remove('is-on')); });
    },
  };
}

// ---------- Tela do cliente: totais e todos os contratos dele ----------
export async function client({ state, query, setQuery }) {
  denied(state);
  const name = query.get('nome') || '';
  const all = await api('/contracts');
  const cs = all.filter(c => c.client === name);
  if (!cs.length) throw new Error('Cliente não encontrado nos contratos.');
  const sum = k => cs.reduce((x, c) => x + (c.summary[k] || 0), 0);
  const value = sum('value'), measured = sum('measured'), balance = cs.reduce((x, c) => x + Math.max(0, c.summary.balance || 0), 0);
  const companies = [...new Set(cs.map(c => CO_SHORT[c.company] || c.company))];
  const types = [...new Set(cs.map(c => c.type_name).filter(Boolean))];
  const tbl = { filter: query.get('status') || 'todos', hideFull: query.get('medidos') === '0' ? false : query.get('medidos') === '1' };
  return {
    title: name,
    html: html`${pageHead({ back: { href: '#/contratos', label: 'Contratos' }, eyebrow: `Cliente · ${companies.join(' · ')}${types.length ? ` · ${types.join(', ')}` : ''}`, title: name,
        sub: `${cs.length} contrato(s) · ${cs.filter(c => c.status === 'vigente').length} vigente(s)` })}
      <div class="ct-dash">
      <div class="kpis kpis-6 ct-kpis">
        ${kpi({ label: 'Contratado', value: money(value), color: '#2A3D50', foot: `${cs.length} contrato(s)` })}
        ${kpi({ label: 'Medido', value: money(sum('measured_total')), color: '#2F6FB3', foot: value ? `${pct(Math.round((measured / value) * 1000) / 10)} do contratado` : '' })}
        ${kpi({ label: 'Faturado', value: money(sum('billed')), color: '#8E6CB0' })}
        ${kpi({ label: 'Recebido', value: money(sum('received')), color: '#2E8B57' })}
        ${kpi({ label: 'A receber', value: money(sum('to_receive')), color: '#C0392B', foot: sum('to_bill') > 0.005 ? `+ ${money(sum('to_bill'))} aguardando faturamento` : 'faturado e não recebido' })}
        ${kpi({ label: 'Saldo a medir', value: money(balance), color: '#707E8B' })}
      </div>
      <div class="ct-client-comp card"><div class="card-body">${compositionBar(pipeParts({ received: sum('received'), to_receive: sum('to_receive'), to_bill: sum('to_bill'), balance }), sum('received') + sum('to_receive') + sum('to_bill') + balance, { big: true })}
        <ul class="ct-port-legend is-inline">${pipeParts({ received: sum('received'), to_receive: sum('to_receive'), to_bill: sum('to_bill'), balance }).map(p => html`<li><i class="k ${p.cls}"></i><span>${p.label}</span><b>${money(p.v)}</b></li>`)}</ul></div></div>
      ${contractTable(cs, { ...tbl, title: 'Contratos do cliente', emptyText: 'Nenhum contrato.' })}
      </div>`,
    mount(root) {
      bindContractTable(root, tbl, st => setQuery({ nome: name, status: st.filter, medidos: st.hideFull ? '1' : '0' }));
    },
  };
}

// ---------- Cadastro / edição ----------
const itemRow = (i = {}) => html`<tr class="ct-item" data-id="${i.id || ''}">
  <td class="mono ct-seq"></td>
  <td><input type="text" data-f="description" maxlength="300" value="${i.description || ''}" placeholder="Descrição do item" aria-label="Descrição" required></td>
  <td><input type="text" data-f="unit" maxlength="12" value="${i.unit || 'vb'}" aria-label="Unidade" class="ct-unit"></td>
  <td><input type="text" data-f="unit_price" inputmode="decimal" value="${i.unit_price !== undefined ? String(i.unit_price).replace('.', ',') : ''}" placeholder="0,00" aria-label="Preço unitário" class="ct-num"></td>
  <td><input type="text" data-f="quantity" inputmode="decimal" value="${i.quantity !== undefined ? String(i.quantity).replace('.', ',') : ''}" placeholder="0" aria-label="Quantidade" class="ct-num"></td>
  <td class="num ct-value"></td>
  <td><label class="ct-add" title="Item incluído por aditivo"><input type="checkbox" data-f="additive" ${i.additive ? 'checked' : ''}>Aditivo</label></td>
  <td><button type="button" class="icon-btn" data-rm-item ${i.used ? 'disabled' : ''} title="${i.used ? 'Item já medido: não pode ser removido' : 'Remover item'}" aria-label="Remover item">✕</button></td>
</tr>`;
const parseNum = v => { const s = String(v ?? '').trim(); if (!s) return 0; const n = Number(s.includes(',') ? s.replace(/\./g, '').replace(',', '.') : s); return Number.isFinite(n) ? n : 0; };

export async function form({ params, state, navigate }) {
  denied(state);
  const editing = !!params.id;
  const [c, ctypes] = await Promise.all([editing ? api(`/contracts/${params.id}`) : { status: 'vigente', items: [{}], bulletin_prefix: '', company: 'charao' },
    api('/settings/contract-types', { query: { all: '1' } }).catch(() => [])]);
  const projects = state.meta.projects || [];
  const opt = (val, label, cur) => html`<option value="${val}" ${String(cur ?? '') === String(val) ? 'selected' : ''}>${label}</option>`;
  return {
    title: editing ? `Editar ${c.code}` : 'Novo contrato',
    html: html`
      ${pageHead({ back: { href: editing ? `#/contratos/${c.id}` : '#/contratos', label: editing ? c.code : 'Contratos' }, eyebrow: editing ? c.code : 'Código gerado automaticamente (CT-000)', title: editing ? 'Editar contrato' : 'Novo contrato' })}
      <form class="card card-pad form" id="ct-form" novalidate style="max-width:1000px">
        <fieldset class="fieldset form"><legend>Empresa e tipo</legend>
          <div class="segmented ct-company" role="radiogroup" aria-label="Empresa">
            <label><input type="radio" name="company" value="charao" ${c.company !== 'lus' ? 'checked' : ''}>Charão<small>Charão Engenharia & Construção</small></label>
            <label><input type="radio" name="company" value="lus" ${c.company === 'lus' ? 'checked' : ''}>LuS<small>Ludimila Siqueira Arquitetura & Design</small></label>
          </div>
          <div class="field" style="max-width:420px"><label for="type_id">Tipo de contrato</label><select id="type_id" name="type_id"><option value="">Sem tipo</option>
            ${ctypes.filter(t => t.active || t.id === c.type_id).map(t => opt(t.id, `${t.name}${t.active ? '' : ' (inativo)'}`, c.type_id))}</select>
            <span class="hint">Os tipos são cadastrados em <b>Configurações → Tipos de contrato</b>. O boletim sai com o logo e o nome da empresa escolhida.</span></div>
        </fieldset>
        <fieldset class="fieldset form"><legend>Contrato</legend>
          <div class="form-row">
            <div class="field"><label class="req" for="client">Cliente</label><input id="client" name="client" maxlength="160" required value="${c.client || ''}"></div>
            <div class="field"><label for="client_doc">CNPJ/CPF do cliente</label><input id="client_doc" name="client_doc" maxlength="30" value="${c.client_doc || ''}"></div>
          </div>
          <div class="form-row">
            <div class="field"><label class="req" for="title">Objeto</label><input id="title" name="title" maxlength="200" required value="${c.title || ''}" placeholder="Ex.: Gerenciamento de obra"></div>
            <div class="field"><label for="number">Nº do contrato</label><input id="number" name="number" maxlength="60" value="${c.number || ''}"></div>
          </div>
          <div class="field"><label for="scope">Escopo (aparece no boletim)</label><textarea id="scope" name="scope" rows="2" maxlength="2000">${c.scope || ''}</textarea></div>
          <div class="form-row form-row-3">
            <div class="field"><label for="start_date">Início</label><input id="start_date" name="start_date" type="date" value="${c.start_date || ''}"></div>
            <div class="field"><label for="end_date">Término</label><input id="end_date" name="end_date" type="date" value="${c.end_date || ''}"></div>
            <div class="field"><label for="status">Situação</label><select id="status" name="status">${Object.entries(CT_STATUS).map(([k, l]) => opt(k, l, c.status))}</select></div>
          </div>
          <div class="form-row">
            <div class="field"><label class="req" for="bulletin_prefix">Prefixo do boletim</label><input id="bulletin_prefix" name="bulletin_prefix" maxlength="10" required value="${c.bulletin_prefix || ''}" placeholder="Ex.: ORBE" style="text-transform:uppercase">
              <span class="hint">Numeração dos boletins: prefixo + sequência + ano (ex.: ORBE0036.26).</span></div>
            <div class="field"><label for="project_id">Obra/projeto relacionado</label><select id="project_id" name="project_id"><option value="">—</option>${projects.map(p => opt(p.id, `${p.code} · ${p.name}`, c.project_id))}</select></div>
          </div>
          <div class="field"><label for="payment_info">Dados para pagamento (rodapé do boletim)</label><textarea id="payment_info" name="payment_info" rows="3" maxlength="1000" placeholder="Banco, agência, conta, CNPJ/PIX">${c.payment_info || ''}</textarea></div>
          <div class="field"><label for="notes">Observações internas</label><textarea id="notes" name="notes" rows="2" maxlength="3000">${c.notes || ''}</textarea></div>
        </fieldset>
        <fieldset class="fieldset form"><legend>Planilha contratual (itens e aditivos)</legend>
          <div class="table-wrap"><table class="data ct-items"><thead><tr><th>Item</th><th>Descrição</th><th>Unid.</th><th class="num">Preço unit. (R$)</th><th class="num">Quantidade</th><th class="num">Valor</th><th></th><th></th></tr></thead>
            <tbody id="ct-items">${(c.items.length ? c.items : [{}]).map(itemRow)}</tbody>
            <tfoot><tr><td colspan="5" class="num"><b>Valor do contrato</b></td><td class="num"><b id="ct-total"></b></td><td colspan="2"></td></tr></tfoot></table></div>
          <div><button type="button" class="btn btn-ghost btn-sm" id="ct-add-item">${icon('plus')}Incluir item</button></div>
          <span class="hint">Aditivos: inclua um novo item e marque “Aditivo”. Itens já medidos não podem ser removidos.</span>
        </fieldset>
        <div class="form-error" hidden></div>
        <div class="form-actions"><a class="btn btn-ghost" href="${editing ? `#/contratos/${c.id}` : '#/contratos'}">Cancelar</a>
          <button class="btn btn-primary" type="submit">${icon('check')}${editing ? 'Salvar contrato' : 'Cadastrar contrato'}</button></div>
      </form>`,
    mount(root) {
      const f = root.querySelector('#ct-form');
      const tb = root.querySelector('#ct-items');
      const recalc = () => {
        let total = 0;
        [...tb.querySelectorAll('.ct-item')].forEach((tr, k) => {
          tr.querySelector('.ct-seq').textContent = k + 1;
          const v = parseNum(tr.querySelector('[data-f=unit_price]').value) * parseNum(tr.querySelector('[data-f=quantity]').value);
          tr.querySelector('.ct-value').textContent = money(v);
          total += v;
        });
        root.querySelector('#ct-total').textContent = money(total);
      };
      tb.addEventListener('input', recalc);
      tb.addEventListener('click', e => { if (e.target.closest('[data-rm-item]')) { e.target.closest('tr').remove(); recalc(); } });
      root.querySelector('#ct-add-item').addEventListener('click', () => { tb.insertAdjacentHTML('beforeend', itemRow({}).toString()); recalc(); tb.lastElementChild.querySelector('input').focus(); });
      recalc();
      f.addEventListener('submit', async e => {
        e.preventDefault();
        const data = Object.fromEntries(new FormData(f));
        data.items = [...tb.querySelectorAll('.ct-item')].map(tr => ({
          id: tr.dataset.id ? Number(tr.dataset.id) : null,
          description: tr.querySelector('[data-f=description]').value,
          unit: tr.querySelector('[data-f=unit]').value,
          unit_price: tr.querySelector('[data-f=unit_price]').value,
          quantity: tr.querySelector('[data-f=quantity]').value,
          additive: tr.querySelector('[data-f=additive]').checked,
        }));
        const err = f.querySelector('.form-error');
        err.hidden = true;
        try {
          let id = c.id;
          if (editing) await api(`/contracts/${id}`, { method: 'PUT', body: data });
          else id = (await api('/contracts', { method: 'POST', body: data })).id;
          toast(editing ? 'Contrato atualizado.' : 'Contrato cadastrado.');
          navigate(`/contratos/${id}`);
        } catch (ex) { err.textContent = ex.message; err.hidden = false; }
      });
    },
  };
}

// ---------- Contrato: itens e medições ----------
export async function view({ params, state, navigate }) {
  denied(state);
  const c = await api(`/contracts/${params.id}`);
  const s = c.summary;
  const today = new Date();
  const nextRef = (() => {
    const last = c.measurements.at(-1)?.ref_month;
    if (!last) return `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`;
    let [y, m] = last.split('-').map(Number);
    m++; if (m > 12) { m = 1; y++; }
    return `${y}-${String(m).padStart(2, '0')}`;
  })();
  return {
    title: `${c.code} · ${c.client}`,
    html: html`
      ${pageHead({ back: { href: '#/contratos', label: 'Contratos' }, eyebrow: `${c.code} · ${CT_STATUS[c.status]} · ${CO_SHORT[c.company] || ''}${c.type_name ? ` · ${c.type_name}` : ''}`, title: c.client, sub: `${c.title}${c.number ? ` · contrato ${c.number}` : ''}${c.start_date ? ` · ${fmtDate(c.start_date)} → ${fmtDate(c.end_date)}` : ''}`,
        actions: html`<a class="btn btn-ghost" href="#/contratos/${c.id}/editar">${icon('edit')}Editar</a>${c.status !== 'encerrado' ? html`<button type="button" class="btn btn-accent" id="new-m">${icon('plus')}Nova medição</button>` : ''}` })}
      <div class="kpis kpis-6 ct-kpis">
        ${kpi({ label: 'Valor do contrato', value: money(s.value), color: '#2A3D50', foot: `${c.items.length} item(ns)` })}
        ${kpi({ label: 'Medido', value: money(s.measured_total), color: '#2F6FB3', foot: `${pct(s.pct)} do contrato` })}
        ${kpi({ label: 'Faturado', value: money(s.billed), color: '#8E6CB0' })}
        ${kpi({ label: 'Recebido', value: money(s.received), color: '#2E8B57' })}
        ${kpi({ label: 'A receber', value: money(s.to_receive), color: '#C0392B' })}
        ${kpi({ label: 'Saldo a medir', value: money(s.balance), color: '#707E8B' })}
      </div>
      <section class="card section">
        <div class="card-head"><h2>${icon('file')}Medições (boletins)</h2><span class="sub">${c.measurements.length} medição(ões)</span></div>
        ${c.measurements.length ? html`<div class="table-wrap"><table class="data ct-table"><thead><tr><th>Boletim</th><th>Referência</th><th>Período</th><th class="num">A faturar</th><th>Situação</th><th>NF</th><th>Recebido</th></tr></thead>
          <tbody>${[...c.measurements].reverse().map(m => html`<tr data-href="#/medicoes/${m.id}" tabindex="0"><td class="mono"><b>${m.code}</b></td><td>${ym(m.ref_month)}</td><td class="nowrap">${fmtDate(m.period_start)} → ${fmtDate(m.period_end)}</td>
            <td class="num">${money(m.total)}</td><td>${mBadge(m.status)}</td><td>${m.nf_number ? html`${m.nf_number}<div class="t-sub">${fmtDate(m.nf_date)}</div>` : ['faturada', 'recebida'].includes(m.status) ? html`<span class="muted">sem NF</span>${m.nf_date ? html`<div class="t-sub">${fmtDate(m.nf_date)}</div>` : ''}` : '—'}</td>
            <td>${m.paid_date ? html`${money(m.paid_amount ?? m.total)}<div class="t-sub">${fmtDate(m.paid_date)}</div>` : '—'}</td></tr>`)}</tbody></table></div>`
          : html`<div class="card-body muted">Nenhuma medição ainda. Use “Nova medição”.</div>`}
      </section>
      <section class="card section">
        <div class="card-head"><h2>Planilha contratual</h2><span class="sub">medido = boletins emitidos</span></div>
        <div class="table-wrap"><table class="data ct-table"><thead><tr><th>Item</th><th>Descrição</th><th>Unid.</th><th class="num">Preço unit.</th><th class="num">Qtd. contrato</th><th class="num">Valor</th><th class="num">Qtd. medida</th><th class="num">Saldo (qtd.)</th><th class="num">Saldo (R$)</th></tr></thead>
          <tbody>${c.items.map(i => html`<tr><td class="mono">${i.seq}</td><td>${i.description}${i.additive ? html` <span class="pill pill-sand">Aditivo</span>` : ''}</td><td>${i.unit}</td><td class="num">${money(i.unit_price)}</td>
            <td class="num">${qty(i.quantity)}</td><td class="num">${money(i.value)}</td><td class="num">${qty(i.measured_qty)}</td><td class="num ${i.balance_qty < 0 ? 'is-neg' : ''}">${qty(i.balance_qty)}</td><td class="num ${i.balance_value < 0 ? 'is-neg' : ''}">${money(i.balance_value)}</td></tr>`)}</tbody></table></div>
      </section>
      ${c.scope || c.payment_info || c.notes ? html`<section class="card section"><div class="card-body"><dl class="kv">
        ${c.scope ? html`<dt>Escopo</dt><dd>${c.scope}</dd>` : ''}${c.payment_info ? html`<dt>Pagamento</dt><dd style="white-space:pre-line">${c.payment_info}</dd>` : ''}
        ${c.project_code ? html`<dt>Obra</dt><dd><a href="#/projetos/${c.project_id}">${c.project_code} · ${c.project_name}</a></dd>` : ''}${c.notes ? html`<dt>Observações</dt><dd style="white-space:pre-line">${c.notes}</dd>` : ''}</dl></div></section>` : ''}`,
    mount(root) {
      root.querySelectorAll('tr[data-href]').forEach(tr => tr.addEventListener('click', () => (location.hash = tr.dataset.href)));
      root.querySelector('#new-m')?.addEventListener('click', async () => {
        const [y, m] = nextRef.split('-').map(Number);
        const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
        const r = await sheet({
          title: 'Nova medição',
          submitLabel: 'Criar medição',
          body: html`<div class="field"><label class="req" for="nm-ref">Mês de referência</label><input type="month" id="nm-ref" name="ref_month" required value="${nextRef}"></div>
            <div class="form-row"><div class="field"><label for="nm-ps">Período medido — de</label><input type="date" id="nm-ps" name="period_start" value="${nextRef}-01"></div>
              <div class="field"><label for="nm-pe">até</label><input type="date" id="nm-pe" name="period_end" value="${nextRef}-${String(last).padStart(2, '0')}"></div></div>
            <span class="hint">A medição nasce em rascunho, com as quantidades zeradas e os descontos/acréscimos da medição anterior (para preencher o valor do mês).</span>`,
          onSubmit: d => api(`/contracts/${c.id}/measurements`, { method: 'POST', body: d }),
        });
        if (r?.id) { toast('Medição criada.'); navigate(`/medicoes/${r.id}`); }
      });
    },
  };
}

// ---------- Medição (boletim) ----------
export async function measurement({ params, query, state, render, navigate }) {
  denied(state);
  const m = await api(`/measurements/${params.id}`);
  const c = m.contract;
  const T = m.totals;
  // Correção (administrador): edita boletim já emitido mantendo situação, NF e recebimento
  const correcting = m.can.correct && query?.get('corrigir') === '1';
  const edit = m.can.edit || correcting;
  const qIn = r => html`<input type="text" inputmode="decimal" class="ct-num m-qty" data-item="${r.item_id}" value="${r.qty ? String(r.qty).replace('.', ',') : ''}" placeholder="0" aria-label="Quantidade medida — ${r.description}">`;
  const adjRow = a => html`<tr class="m-adj" data-adj>
    <td>${edit ? html`<input type="text" data-a="description" maxlength="200" value="${a.description || ''}" placeholder="Ex.: Desconto AMIL" aria-label="Descrição" required>` : a.description}</td>
    <td class="num">${money(a.prev || 0)}</td>
    <td class="num">${edit ? html`<input type="text" inputmode="decimal" class="ct-num" data-a="amount" value="${a.amount ? String(a.amount).replace('.', ',') : ''}" placeholder="−0,00" aria-label="Valor">` : money(a.amount)}</td>
    <td class="num">${money(a.acc || 0)}</td>
    ${edit ? html`<td><button type="button" class="icon-btn" data-rm-adj aria-label="Remover">✕</button></td>` : ''}</tr>`;
  return {
    title: `Boletim ${m.code}`,
    html: html`
      ${pageHead({ back: { href: `#/contratos/${c.id}`, label: c.code }, eyebrow: `${c.client} · ${c.code}`, title: html`Medição ${m.ref_label} · ${m.code}`,
        sub: html`Período ${fmtDate(m.period_start)} → ${fmtDate(m.period_end)} · ${mBadge(m.status)}${m.nf_number ? html` · NF ${m.nf_number} (${fmtDate(m.nf_date)})` : ['faturada', 'recebida'].includes(m.status) ? html` · sem NF${m.nf_date ? ` (faturado em ${fmtDate(m.nf_date)})` : ''}` : ''}${m.paid_date ? html` · recebido ${money(m.paid_amount)} em ${fmtDate(m.paid_date)}` : ''}`,
        actions: html`<a class="btn btn-ghost" href="#/imprimir/medicao/${m.id}">${icon('print')}Boletim (PDF)</a>
          ${!correcting && m.can.issue ? html`<button type="button" class="btn btn-primary" data-ma="issue">${icon('send')}Emitir</button>` : ''}
          ${!correcting && m.can.bill ? html`<button type="button" class="btn btn-primary" data-ma="bill">${icon('file')}Registrar faturamento</button>` : ''}
          ${!correcting && m.can.receive ? html`<button type="button" class="btn btn-success" data-ma="receive">${icon('check')}Registrar recebimento</button>` : ''}
          ${!correcting && m.can.reopen ? html`<button type="button" class="btn btn-ghost" data-ma="reopen">${icon('history')}Reabrir</button>` : ''}
          ${!correcting && m.can.undo ? html`<button type="button" class="btn btn-ghost" data-ma="undo">${icon('history')}${m.status === 'recebida' ? 'Desfazer recebimento' : 'Desfazer faturamento'}</button>` : ''}
          ${!correcting && m.can.delete ? html`<button type="button" class="btn btn-ghost" data-ma="delete">${icon('trash')}Excluir rascunho</button>` : ''}
          ${m.can.correct && !correcting ? html`<a class="btn btn-ghost" href="#/medicoes/${m.id}?corrigir=1">${icon('edit')}Corrigir medição</a>` : ''}` })}
      ${correcting ? html`<div class="notice notice-warn m-correct-note">${icon('alert')}<span><b>Corrigindo o boletim ${m.code} (${M_STATUS[m.status].label}).</b> Situação, NF e recebimento ficam como estão; as medições seguintes recalculam o acumulado e o saldo.
        A correção exige motivo e fica registrada na auditoria. <a href="#/medicoes/${m.id}">Cancelar</a></span></div>` : ''}
      <div class="kpis kpis-4 ct-kpis">
        ${kpi({ label: 'Medição do mês', value: money(T.measured), color: '#2F6FB3' })}
        ${kpi({ label: 'Descontos / acréscimos', value: money(T.adj), color: '#B7791F' })}
        ${kpi({ label: 'Total a faturar', value: money(T.to_bill), color: '#2A3D50', hero: true })}
        ${kpi({ label: 'Saldo contratual', value: money(T.balance), color: '#707E8B', foot: `acumulado ${money(T.acc_total)}` })}
      </div>
      <form id="m-form" novalidate>
        ${edit ? html`<section class="card section"><div class="card-body form"><div class="form-row form-row-3">
          <div class="field"><label for="m-ref">Mês de referência</label><input type="month" id="m-ref" name="ref_month" value="${m.ref_month}" ${correcting ? 'disabled title="O mês de referência define o número do boletim e não muda na correção"' : ''}></div>
          <div class="field"><label for="m-ps">Período — de</label><input type="date" id="m-ps" name="period_start" value="${m.period_start || ''}"></div>
          <div class="field"><label for="m-pe">até</label><input type="date" id="m-pe" name="period_end" value="${m.period_end || ''}"></div></div></div></section>` : ''}
        <section class="card section">
          <div class="card-head"><h2>Itens medidos</h2><span class="sub">${edit ? 'informe a quantidade medida no período' : 'quantidades e valores do boletim'}</span></div>
          <div class="table-wrap"><table class="data ct-table m-table">
            <thead><tr><th rowspan="2">Item</th><th rowspan="2">Descrição</th><th rowspan="2">Unid.</th><th rowspan="2" class="num">Preço unit.</th>
              <th colspan="2" class="c">Contrato</th><th colspan="2" class="c">Acumulado anterior</th><th colspan="2" class="c m-hl">Medição</th><th colspan="2" class="c">Acumulado atual</th><th colspan="2" class="c">Saldo</th></tr>
              <tr>${[0, 1, 2, 3, 4].map(k => html`<th class="num ${k === 2 ? 'm-hl' : ''}">Qtd.</th><th class="num ${k === 2 ? 'm-hl' : ''}">Valor</th>`)}</tr></thead>
            <tbody>${m.rows.map(r => html`<tr class="${r.exceeded ? 'is-exceeded' : ''}" data-row="${r.item_id}" data-price="${r.unit_price}" data-prev="${r.prev_qty}" data-cq="${r.contract_qty}">
              <td class="mono">${r.seq}</td><td>${r.description}${r.additive ? html` <span class="pill pill-sand">Aditivo</span>` : ''}</td><td>${r.unit}</td><td class="num">${money(r.unit_price)}</td>
              <td class="num">${qty(r.contract_qty)}</td><td class="num">${money(r.contract_value)}</td>
              <td class="num">${qty(r.prev_qty)}</td><td class="num">${money(r.prev_value)}</td>
              <td class="num m-hl">${edit ? qIn(r) : qty(r.qty)}</td><td class="num m-hl" data-v="value">${money(r.value)}</td>
              <td class="num" data-v="acc_qty">${qty(r.acc_qty)}</td><td class="num" data-v="acc_value">${money(r.acc_value)}</td>
              <td class="num" data-v="bal_qty">${qty(r.bal_qty)}</td><td class="num" data-v="bal_value">${money(r.bal_value)}</td></tr>`)}</tbody>
            <tfoot><tr><td colspan="5"><b>Medição</b></td><td class="num">${money(T.contract)}</td><td></td><td class="num">${money(T.prev)}</td><td></td><td class="num m-hl"><b id="t-measured">${money(T.measured)}</b></td><td></td><td class="num">${money(T.acc)}</td><td></td><td class="num">${money(T.balance)}</td></tr></tfoot>
          </table></div>
          ${m.rows.some(r => r.exceeded) ? html`<div class="card-body"><div class="notice notice-warn">${icon('alert')}<span>Há itens com quantidade acumulada acima do contratado (saldo negativo). Avalie um aditivo.</span></div></div>` : ''}
        </section>
        <section class="card section">
          <div class="card-head"><h2>Descontos / acréscimos</h2><span class="sub">valores negativos = desconto</span></div>
          <div class="table-wrap"><table class="data ct-table"><thead><tr><th>Descrição</th><th class="num">Acumulado anterior</th><th class="num">Neste boletim</th><th class="num">Acumulado atual</th>${edit ? html`<th></th>` : ''}</tr></thead>
            <tbody id="m-adjs">${m.adjustments.filter(a => edit ? a.id !== null : true).map(adjRow)}</tbody></table></div>
          ${edit ? html`<div class="card-body"><button type="button" class="btn btn-ghost btn-sm" id="m-add-adj">${icon('plus')}Incluir desconto/acréscimo</button></div>` : ''}
        </section>
        <section class="card section"><div class="card-body form">
          <div class="field"><label for="m-notes">Observações do boletim</label>${edit ? html`<textarea id="m-notes" name="notes" rows="2" maxlength="2000">${m.notes || ''}</textarea>` : html`<div>${m.notes || '—'}</div>`}</div>
          ${correcting ? html`<div class="field"><label class="req" for="m-reason">Motivo da correção</label><textarea id="m-reason" name="reason" rows="2" maxlength="500" required placeholder="Ex.: quantidade do item 2 lançada errada no boletim"></textarea></div>
            ${m.status === 'recebida' ? html`<div class="field"><span class="lbl">Valor recebido (hoje ${money(m.paid_amount)})</span><div class="segmented">
              <label><input type="radio" name="paid" value="keep" checked>Manter ${money(m.paid_amount)}<small>o recebimento não muda</small></label>
              <label><input type="radio" name="paid" value="total">Acompanhar o novo total<small>valor recebido = total corrigido do boletim</small></label></div></div>` : ''}
            <div class="form-actions" style="justify-content:flex-start"><a class="btn btn-ghost" href="#/medicoes/${m.id}">Cancelar</a><button type="submit" class="btn btn-primary">${icon('check')}Salvar correção</button></div>`
          : edit ? html`<div class="form-actions" style="justify-content:flex-start"><button type="submit" class="btn btn-primary">${icon('check')}Salvar medição</button></div>` : ''}
        </div></section>
      </form>`,
    mount(root) {
      const f = root.querySelector('#m-form');
      const collect = () => ({
        ref_month: f.ref_month?.value, period_start: f.period_start?.value, period_end: f.period_end?.value, notes: f.notes?.value,
        lines: Object.fromEntries([...root.querySelectorAll('.m-qty')].map(i => [i.dataset.item, i.value])),
        adjustments: [...root.querySelectorAll('[data-adj]')].map(tr => ({ description: tr.querySelector('[data-a=description]').value, amount: tr.querySelector('[data-a=amount]').value })).filter(a => a.description.trim()),
      });
      // Recalcula a linha ao digitar (prévia; o servidor confirma ao salvar)
      root.querySelectorAll('.m-qty').forEach(inp => inp.addEventListener('input', () => {
        const tr = inp.closest('tr');
        const price = Number(tr.dataset.price), prev = Number(tr.dataset.prev), cq = Number(tr.dataset.cq);
        const q = parseNum(inp.value);
        tr.querySelector('[data-v=value]').textContent = money(q * price);
        tr.querySelector('[data-v=acc_qty]').textContent = qty(prev + q);
        tr.querySelector('[data-v=acc_value]').textContent = money((prev + q) * price);
        tr.querySelector('[data-v=bal_qty]').textContent = qty(cq - prev - q);
        tr.querySelector('[data-v=bal_value]').textContent = money((cq - prev - q) * price);
        tr.classList.toggle('is-exceeded', prev + q > cq + 1e-9);
        root.querySelector('#t-measured').textContent = money([...root.querySelectorAll('.m-qty')].reduce((s, i) => s + parseNum(i.value) * Number(i.closest('tr').dataset.price), 0));
      }));
      root.querySelector('#m-add-adj')?.addEventListener('click', () => {
        root.querySelector('#m-adjs').insertAdjacentHTML('beforeend', adjRow({ description: '', prev: 0, amount: 0, acc: 0 }).toString());
        root.querySelector('#m-adjs').lastElementChild.querySelector('input').focus();
      });
      root.querySelector('#m-adjs')?.addEventListener('click', e => { if (e.target.closest('[data-rm-adj]')) e.target.closest('tr').remove(); });
      const save = () => api(`/measurements/${m.id}`, { method: 'PUT', body: collect() });
      f.addEventListener('submit', async e => {
        e.preventDefault();
        if (correcting) {
          const reason = f.reason.value.trim();
          if (!reason) { toast('Informe o motivo da correção.', 'err'); return f.reason.focus(); }
          const body = { ...collect(), reason, paid: f.querySelector('[name=paid]:checked')?.value || 'keep' };
          delete body.ref_month;
          try { await api(`/measurements/${m.id}/correction`, { method: 'PUT', body }); toast('Medição corrigida.'); navigate(`/medicoes/${m.id}`); } catch (ex) { toast(ex.message, 'err'); }
          return;
        }
        try { await save(); toast('Medição salva.'); render(); } catch (ex) { toast(ex.message, 'err'); }
      });
      const act = async (a, body) => {
        try {
          const r = await api(`/measurements/${m.id}/actions/${a}`, { method: 'POST', body });
          if (r.deleted) { toast('Rascunho excluído.'); return navigate(`/contratos/${r.contract_id}`); }
          toast({ issue: 'Medição emitida.', bill: 'Faturamento registrado.', receive: 'Recebimento registrado.', reopen: 'Medição reaberta.', undo: 'Desfeito.' }[a] || 'Feito.');
          render();
        } catch (ex) { toast(ex.message, 'err'); }
      };
      root.querySelectorAll('[data-ma]').forEach(b => b.addEventListener('click', async () => {
        const a = b.dataset.ma;
        if (a === 'issue') {
          if (edit) { try { await save(); } catch (ex) { return toast(ex.message, 'err'); } }
          const fresh = await api(`/measurements/${m.id}`);
          if (await confirmSheet('Emitir medição', `Emitir o boletim ${fresh.code} com total a faturar de ${money(fresh.totals.to_bill)}? Depois de emitida, a medição só pode ser corrigida reabrindo-a.`, 'Emitir')) act('issue');
        } else if (a === 'bill') {
          setTimeout(() => {
            const cb = document.querySelector('#nonf');
            cb?.addEventListener('change', () => {
              document.querySelector('#nf-field').hidden = cb.checked;
              document.querySelector('#nfd-label').textContent = cb.checked ? 'Data do faturamento/cobrança' : 'Data da NF';
            });
          }, 60);
          const r = await sheet({ title: 'Registrar faturamento', submitLabel: 'Registrar',
            body: html`<label class="check-row m-nonf"><input type="checkbox" name="no_nf" value="1" id="nonf"> Sem nota fiscal <small>(cobrança sem NF)</small></label>
              <div class="form-row"><div class="field" id="nf-field"><label class="req" for="nf">Nº da nota fiscal</label><input id="nf" name="nf_number" maxlength="40"></div>
              <div class="field"><label for="nfd" id="nfd-label">Data da NF</label><input type="date" id="nfd" name="nf_date" value="${new Date().toISOString().slice(0, 10)}"></div></div>
              <span class="hint">Valor faturado: <b>${money(T.to_bill)}</b>.</span>` });
          if (r) act('bill', { ...r, no_nf: r.no_nf === '1' });
        } else if (a === 'receive') {
          const r = await sheet({ title: 'Registrar recebimento', submitLabel: 'Registrar',
            body: html`<div class="form-row"><div class="field"><label for="pd">Data do recebimento</label><input type="date" id="pd" name="paid_date" value="${new Date().toISOString().slice(0, 10)}"></div>
              <div class="field"><label for="pa">Valor recebido (R$)</label><input id="pa" name="paid_amount" inputmode="decimal" value="${String(T.to_bill).replace('.', ',')}"></div></div>
              <span class="hint">Em branco = valor do boletim (${money(T.to_bill)}).${m.status === 'emitida' ? ' Boletim sem faturamento registrado: o recebimento é lançado sem nota fiscal e a data do recebimento vale como data de faturamento.' : ''}</span>` });
          if (r) act('receive', { ...r, paid_amount: r.paid_amount ? parseNum(r.paid_amount) : '' });
        } else if (a === 'delete') {
          if (await confirmSheet('Excluir rascunho', `Excluir a medição ${m.code}? A numeração será reaproveitada.`, 'Excluir', true)) act('delete');
        } else if (a === 'reopen') {
          if (await confirmSheet('Reabrir medição', 'A medição volta para rascunho para correção. Deseja reabrir?', 'Reabrir')) act('reopen');
        } else if (a === 'undo') {
          if (await confirmSheet('Desfazer', m.status === 'recebida' ? 'Desfazer o registro de recebimento?' : 'Desfazer o faturamento (NF)?', 'Desfazer')) act('undo');
        }
      }));
    },
  };
}
