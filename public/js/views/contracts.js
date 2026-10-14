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
        <text class="g-xtick" x="${L + i * band + band / 2}" y="${H - 10}" text-anchor="middle">${s.label}</text>
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
  { label: 'Emitido aguardando NF', v: Math.max(0, s.to_bill), cls: 's-med' },
  { label: 'Saldo a medir', v: Math.max(0, s.balance), cls: 's-none' },
];

const delta = (cur, prev, prevYear) => {
  if (!prev) return html`<span class="ct-delta">sem base no ano anterior</span>`;
  const d = Math.round(((cur - prev) / prev) * 1000) / 10;
  return html`<span class="ct-delta ${d >= 0 ? 'is-up' : 'is-down'}">${d >= 0 ? '▲' : '▼'} ${String(Math.abs(d)).replace('.', ',')}% vs mesmo período de ${prevYear}</span>`;
};
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

export async function list({ state, query, setQuery, render }) {
  denied(state);
  const months = query.get('meses') || '12';
  const d = await api('/contracts/dashboard', { query: { meses: months } });
  const t = d.totals;
  const Y = d.year;
  const filter = query.get('status') || 'vigente';
  const shown = d.contracts.filter(c => filter === 'todos' || c.status === filter);
  const port = { received: t.received, to_receive: t.to_receive, to_bill: t.to_bill, balance: t.balance };
  const portTotal = port.received + port.to_receive + port.to_bill + Math.max(0, port.balance);
  const agingMax = Math.max(1, ...d.aging.map(a => a.total));
  const sumSeries = k => d.series.reduce((s, x) => s + x[k], 0);

  const contractRow = c => {
    const s = c.summary;
    return html`<a class="ct-row" href="#/contratos/${c.id}">
      <div class="ct-row-id"><span class="mono">${c.code}</span><b>${c.client}</b><small>${c.title}</small></div>
      <div class="ct-row-bar">${compositionBar(pipeParts(s), s.value)}
        <div class="ct-row-meta"><span><b>${pct(s.pct)}</b> medido</span>${s.last ? html`<span>último ${s.last.code} ${mBadge(s.last.status)}</span>` : html`<span>sem medições</span>`}${s.drafts ? html`<span class="m-badge m-draft">rascunho</span>` : ''}</div></div>
      <div class="ct-row-nums"><span><small>Contratado</small><b>${money(s.value)}</b></span><span><small>A receber</small><b>${money(s.to_receive)}</b></span><span><small>Saldo a medir</small><b>${money(s.balance)}</b></span></div>
      <span class="chev">${icon('chevron')}</span></a>`;
  };

  return {
    title: 'Contratos',
    html: html`
      ${pageHead({
        eyebrow: 'Acesso restrito · liberação por usuário',
        title: 'Contratos e faturamento',
        actions: html`${d.area_id ? html`<a class="btn btn-ghost" href="#/projetos/${d.area_id}">${icon('tasks')}Tarefas de contratos</a>` : ''}<a class="btn btn-accent" href="#/contratos/novo">${icon('plus')}Novo contrato</a>`,
      })}
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
            ['Faturado (total)', money(t.billed), `${money(t.to_bill)} aguardando NF`],
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

        <div class="ct-two">
          <section class="card">
            <div class="card-head"><h2>${icon('clock')}A receber por antiguidade</h2><span class="sub">dias desde a NF</span></div>
            <div class="card-body ct-aging">
              ${d.aging.map((a, i) => html`<div class="ct-age ${i === 3 && a.total ? 'is-crit' : ''}">
                <span class="ct-age-l">${i === 3 && a.total ? html`${icon('alert')} ` : ''}${a.label}</span>
                <div class="ct-age-bar"><i style="width:${(a.total / agingMax) * 100}%"></i></div>
                <span class="ct-age-v"><b>${money(a.total)}</b><small>${a.count} NF</small></span></div>`)}
              ${!t.to_receive ? html`<p class="muted" style="margin:6px 0 0">Nenhuma nota fiscal em aberto.</p>` : ''}
            </div>
          </section>
          <section class="card">
            <div class="card-head"><h2>${icon('alert')}Próximas ações</h2><span class="sub">${d.actions.length} pendência(s)</span></div>
            ${d.actions.length ? html`<ul class="ct-actions">${d.actions.slice(0, 8).map(a => html`<li class="sev-${a.severity}"><a href="${a.href}">
              <span class="ct-sev">${icon(SEV[a.severity].ic)}${SEV[a.severity].label}</span>
              <span class="ct-act-t"><b>${a.text}</b><small>${a.client} · ${a.code}</small></span>${icon('chevron')}</a></li>`)}</ul>
              ${d.actions.length > 8 ? html`<div class="card-body muted" style="font-size:12.5px">+ ${d.actions.length - 8} pendência(s)</div>` : ''}`
              : html`<div class="card-body muted">Tudo em dia: medições do mês passado lançadas, boletins faturados e recebimentos em dia.</div>`}
          </section>
        </div>

        ${d.by_client.length > 1 ? html`<section class="card">
          <div class="card-head"><h2>${icon('team')}Por cliente</h2><span class="sub">composição da carteira de cada cliente</span></div>
          <div class="card-body ct-clients">${d.by_client.map(b => html`<div class="ct-client"><div class="ct-client-h"><b>${b.client}</b><span>${money(b.value)} · ${b.contracts} contrato(s)</span></div>
            ${compositionBar(pipeParts({ received: b.received, to_receive: b.to_receive, to_bill: Math.max(0, b.measured - b.billed), balance: Math.max(0, b.value - b.measured) }), b.value)}</div>`)}</div>
        </section>` : ''}

        <section class="card">
          <div class="card-head"><h2>${icon('contract')}Contratos</h2>
            <div class="chips" role="group" aria-label="Filtrar contratos">${[['vigente', 'Vigentes'], ['suspenso', 'Suspensos'], ['encerrado', 'Encerrados'], ['todos', 'Todos']].map(([k, l]) =>
              html`<button class="chip" data-ctf="${k}" aria-pressed="${filter === k}">${l}<span class="n">${k === 'todos' ? d.contracts.length : d.contracts.filter(c => c.status === k).length}</span></button>`)}</div></div>
          <ul class="ct-port-legend is-inline">${pipeParts(port).map(p => html`<li><i class="k ${p.cls}"></i><span>${p.label}</span></li>`)}</ul>
          ${shown.length ? html`<div class="ct-rows">${shown.map(contractRow)}</div>`
            : html`<div class="card-body muted">${d.contracts.length ? 'Nenhum contrato neste filtro.' : 'Nenhum contrato cadastrado. Comece em “Novo contrato”.'}</div>`}
        </section>
      </div>`,
    mount(root) {
      root.querySelectorAll('[data-ctf]').forEach(b => b.addEventListener('click', () => { setQuery({ status: b.dataset.ctf, meses: months }); render(); }));
      root.querySelectorAll('[data-meses]').forEach(b => b.addEventListener('click', () => { setQuery({ status: filter, meses: b.dataset.meses }); render(); }));
      bindAnnual(root, d);
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
  const c = editing ? await api(`/contracts/${params.id}`) : { status: 'vigente', items: [{}], bulletin_prefix: '' };
  const projects = state.meta.projects || [];
  const opt = (val, label, cur) => html`<option value="${val}" ${String(cur ?? '') === String(val) ? 'selected' : ''}>${label}</option>`;
  return {
    title: editing ? `Editar ${c.code}` : 'Novo contrato',
    html: html`
      ${pageHead({ back: { href: editing ? `#/contratos/${c.id}` : '#/contratos', label: editing ? c.code : 'Contratos' }, eyebrow: editing ? c.code : 'Código gerado automaticamente (CT-000)', title: editing ? 'Editar contrato' : 'Novo contrato' })}
      <form class="card card-pad form" id="ct-form" novalidate style="max-width:1000px">
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
      ${pageHead({ back: { href: '#/contratos', label: 'Contratos' }, eyebrow: `${c.code} · ${CT_STATUS[c.status]}`, title: c.client, sub: `${c.title}${c.number ? ` · contrato ${c.number}` : ''}${c.start_date ? ` · ${fmtDate(c.start_date)} → ${fmtDate(c.end_date)}` : ''}`,
        actions: html`<a class="btn btn-ghost" href="#/contratos/${c.id}/editar">${icon('edit')}Editar</a>${c.status !== 'encerrado' ? html`<button type="button" class="btn btn-accent" id="new-m">${icon('plus')}Nova medição</button>` : ''}` })}
      <div class="kpis kpis-6">
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
            <td class="num">${money(m.total)}</td><td>${mBadge(m.status)}</td><td>${m.nf_number ? html`${m.nf_number}<div class="t-sub">${fmtDate(m.nf_date)}</div>` : '—'}</td>
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
export async function measurement({ params, state, render, navigate }) {
  denied(state);
  const m = await api(`/measurements/${params.id}`);
  const c = m.contract;
  const T = m.totals;
  const edit = m.can.edit;
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
        sub: html`Período ${fmtDate(m.period_start)} → ${fmtDate(m.period_end)} · ${mBadge(m.status)}${m.nf_number ? html` · NF ${m.nf_number} (${fmtDate(m.nf_date)})` : ''}${m.paid_date ? html` · recebido ${money(m.paid_amount)} em ${fmtDate(m.paid_date)}` : ''}`,
        actions: html`<a class="btn btn-ghost" href="#/imprimir/medicao/${m.id}">${icon('print')}Boletim (PDF)</a>
          ${m.can.issue ? html`<button type="button" class="btn btn-primary" data-ma="issue">${icon('send')}Emitir</button>` : ''}
          ${m.can.bill ? html`<button type="button" class="btn btn-primary" data-ma="bill">${icon('file')}Registrar faturamento</button>` : ''}
          ${m.can.receive ? html`<button type="button" class="btn btn-success" data-ma="receive">${icon('check')}Registrar recebimento</button>` : ''}
          ${m.can.reopen ? html`<button type="button" class="btn btn-ghost" data-ma="reopen">${icon('history')}Reabrir</button>` : ''}
          ${m.can.undo ? html`<button type="button" class="btn btn-ghost" data-ma="undo">${icon('history')}${m.status === 'recebida' ? 'Desfazer recebimento' : 'Desfazer faturamento'}</button>` : ''}
          ${m.can.delete ? html`<button type="button" class="btn btn-ghost" data-ma="delete">${icon('trash')}Excluir rascunho</button>` : ''}` })}
      <div class="kpis kpis-4">
        ${kpi({ label: 'Medição do mês', value: money(T.measured), color: '#2F6FB3' })}
        ${kpi({ label: 'Descontos / acréscimos', value: money(T.adj), color: '#B7791F' })}
        ${kpi({ label: 'Total a faturar', value: money(T.to_bill), color: '#2A3D50', hero: true })}
        ${kpi({ label: 'Saldo contratual', value: money(T.balance), color: '#707E8B', foot: `acumulado ${money(T.acc_total)}` })}
      </div>
      <form id="m-form" novalidate>
        ${edit ? html`<section class="card section"><div class="card-body form"><div class="form-row form-row-3">
          <div class="field"><label for="m-ref">Mês de referência</label><input type="month" id="m-ref" name="ref_month" value="${m.ref_month}"></div>
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
          ${edit ? html`<div class="form-actions" style="justify-content:flex-start"><button type="submit" class="btn btn-primary">${icon('check')}Salvar medição</button></div>` : ''}
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
          const r = await sheet({ title: 'Registrar faturamento', submitLabel: 'Registrar',
            body: html`<div class="form-row"><div class="field"><label class="req" for="nf">Nº da nota fiscal</label><input id="nf" name="nf_number" maxlength="40" required></div>
              <div class="field"><label for="nfd">Data da NF</label><input type="date" id="nfd" name="nf_date" value="${new Date().toISOString().slice(0, 10)}"></div></div>
              <span class="hint">Valor faturado: <b>${money(T.to_bill)}</b>.</span>` });
          if (r) act('bill', r);
        } else if (a === 'receive') {
          const r = await sheet({ title: 'Registrar recebimento', submitLabel: 'Registrar',
            body: html`<div class="form-row"><div class="field"><label for="pd">Data do recebimento</label><input type="date" id="pd" name="paid_date" value="${new Date().toISOString().slice(0, 10)}"></div>
              <div class="field"><label for="pa">Valor recebido (R$)</label><input id="pa" name="paid_amount" inputmode="decimal" value="${String(T.to_bill).replace('.', ',')}"></div></div>
              <span class="hint">Em branco = valor do boletim (${money(T.to_bill)}).</span>` });
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
