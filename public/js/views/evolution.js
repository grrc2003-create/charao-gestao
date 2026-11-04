// Corrida dos indicadores: gráfico de linhas com as carinhas na ponta, mês a mês. O indicador é escolhido nos botões
// (a legenda geral), e a classificação ao lado liga e desliga cada pessoa.
import { html, api, icon, avatar } from '../core.js';

const svg = 'http://www.w3.org/2000/svg';
const pad = { left: 40, right: 22, top: 22, bottom: 38 }; // embaixo cabem o mês e a carinha de quem está no zero
const PALETTE = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948']; // ordem fixa e validada
const NEUTRAL = '#6E7A86', OVERALL = '#2A3D50';
const MAX_ON = PALETTE.length;
const MONTH = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];

const num = v => String(v).replace('.', ',');
const pct = v => (v === null || v === undefined ? '—' : `${num(v)}%`);
const dec = v => (v === null || v === undefined ? '—' : num(v));
const INDICATORS = [
  { key: 'on_time', label: 'No prazo', fmt: pct, max: 100, best: 'high', help: 'Das entregas feitas até o fim de cada mês, quantas foram no prazo.' },
  { key: 'done', label: 'Concluídas', fmt: dec, best: 'high', count: true, help: 'Tarefas concluídas até o fim de cada mês.' },
  { key: 'late', label: 'Atrasadas', fmt: dec, best: 'low', count: true, help: 'Tarefas em aberto com o prazo vencido no fim de cada mês (não acumula: é a foto do mês).' },
  { key: 'assigned', label: 'Atribuídas', fmt: dec, best: 'high', neutral: true, count: true, help: 'Tarefas sob responsabilidade da pessoa até o fim de cada mês.' },
  { key: 'exec', label: 'Dias úteis/exec.', fmt: dec, best: 'low', help: 'Média de dias úteis do início à conclusão, nas entregas feitas até o fim de cada mês.' },
  { key: 'early', label: 'Antecipadas', fmt: dec, best: 'high', count: true, help: 'Entregas antes do prazo até o fim de cada mês.' },
  { key: 'filling', label: 'Atr. preench.', fmt: dec, best: 'low', count: true, help: 'Conclusões registradas depois do dia real, até o fim de cada mês.' },
];

let chosen = 'on_time'; // vale enquanto o sistema estiver aberto
const monthLabel = ym => `${MONTH[Number(ym.slice(5, 7)) - 1]}/${ym.slice(2, 4)}`;

export const evolutionSection = ({ scope, id = null, sub = 'mês a mês, acumulado até o fim de cada mês' }) => html`<section class="card section ev-card" data-ev-scope="${scope}" data-ev-id="${id ?? ''}">
  <div class="card-head"><h2>${icon('team')}Corrida dos indicadores</h2><span class="sub">${sub}</span></div>
  <div class="card-body" data-ev-body>Carregando…</div></section>`;

// Escala do eixo Y: até 5 linhas, em números redondos
function niceMax(v) {
  if (v <= 4) return 4;
  const step = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * step >= v) return m * step;
  return 10 * step;
}

function chart(card, d) {
  const body = card.querySelector('[data-ev-body]');
  const scope = d.scope;
  if (!d.months.length || !d.people.length) { body.innerHTML = `<div class="ev-empty">Ainda não há tarefas para acompanhar aqui.</div>`; return; }
  // A cor acompanha a pessoa em todos os indicadores: as 8 com mais tarefas têm cor própria e começam ligadas
  const last = d.months.length - 1;
  const ranked = [...d.people].sort((a, b) => b.series.assigned[last] - a.series.assigned[last] || a.name.localeCompare(b.name, 'pt-BR'));
  const runners = ranked.map((p, i) => ({ ...p, uid: String(p.id ?? 0), color: scope === 'usuario' ? PALETTE[0] : PALETTE[i] || NEUTRAL, on: i < MAX_ON }));

  body.innerHTML = html`
    <div class="ev-inds" role="group" aria-label="Escolha o indicador do gráfico"></div>
    <div class="ev-note"><span><span data-ev-help></span>${scope === 'usuario' ? '' : html`<span class="no-print"> Toque em um nome para ligar ou desligar.</span>`}</span>
      <button type="button" class="btn btn-ghost btn-sm no-print" data-ev-play>${icon('history')}Correr de novo</button></div>
    <div class="ev-body">
      <div class="ev-plot" role="img"><svg aria-hidden="true"></svg><div class="ev-month"></div></div>
      <ul class="ev-legend"></ul>
    </div>`.toString();

  const inds = body.querySelector('.ev-inds'), plot = body.querySelector('.ev-plot'), box = plot.querySelector('svg'),
    monthTag = plot.querySelector('.ev-month'), legend = body.querySelector('.ev-legend'), help = body.querySelector('[data-ev-help]');
  const ind = () => INDICATORS.find(i => i.key === chosen);

  // Referência: na empresa e no projeto só nos percentuais e médias (a soma de todos não cabe na mesma escala das pessoas);
  // na tela do usuário sempre, com a média por pessoa nas contagens.
  const refSeries = i => {
    if (scope === 'usuario') return i.count ? d.overall.per_person[i.key] : d.overall.series[i.key];
    return i.count ? null : d.overall.series[i.key];
  };
  const refLabel = i => (scope === 'usuario' && i.count ? `${d.overall.label} (média por pessoa)` : d.overall.label);

  inds.innerHTML = INDICATORS.map(i => {
    const main = scope === 'usuario' ? d.people[0].series[i.key][last] : d.overall.series[i.key][last];
    const cmp = scope === 'usuario' ? refSeries(i)[last] : null;
    // Pior que a média: destaque no quadro, com o sinal e o texto (não só a cor). Atribuídas não é melhor nem pior.
    const worse = cmp !== null && main !== null && !i.neutral && (i.best === 'high' ? main < cmp : main > cmp);
    const who = d.overall.label === 'Empresa' ? 'empresa' : 'visível';
    return html`<button type="button" class="ev-ind ${worse ? 'is-worse' : ''}" data-ev-ind="${i.key}" aria-pressed="${String(i.key === chosen)}" title="${worse ? `Pior que a média da ${who === 'empresa' ? 'empresa' : 'parte visível para você'}` : ''}"><b>${i.fmt(main)}</b>${i.label}${cmp !== null ? html`<small>${worse ? '▼ pior que ' : ''}${who} ${i.fmt(cmp)}</small>` : ''}</button>`.toString();
  }).join('');

  // ---------- Desenho ----------
  let W = 0, H = 0, yMax = 100, t = last, raf = 0, ticks = [];
  const X = m => (last ? pad.left + (m / last) * (W - pad.left - pad.right) : pad.left + (W - pad.left - pad.right) / 2);
  const Y = v => H - pad.bottom - (v / yMax) * (H - pad.top - pad.bottom);
  const el = (name, attrs, parent = box) => {
    const e = document.createElementNS(svg, name);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    parent.appendChild(e);
    return e;
  };
  let lines = [], ref = null, heads = new Map();

  function frame() {
    W = plot.clientWidth; H = plot.clientHeight;
    const i = ind();
    const shown = runners.filter(r => r.on);
    const rs = refSeries(i);
    const top = Math.max(0, ...shown.flatMap(r => r.series[i.key].filter(v => v !== null)), ...(rs || []).filter(v => v !== null));
    yMax = i.max || niceMax(top);
    box.textContent = '';
    box.setAttribute('viewBox', `0 0 ${W} ${H}`);
    const nTicks = 4;
    ticks = Array.from({ length: nTicks + 1 }, (_, k) => (yMax * k) / nTicks);
    for (const v of ticks) {
      el('line', { x1: pad.left, x2: W - pad.right, y1: Y(v), y2: Y(v), stroke: v ? '#EEF0F2' : '#D5D9DD', 'stroke-width': 1 });
      const tx = el('text', { x: pad.left - 8, y: Y(v) + 4, 'text-anchor': 'end' });
      tx.textContent = i.max ? `${v}%` : num(Math.round(v * 10) / 10);
    }
    const every = Math.ceil(d.months.length / Math.max(2, Math.floor((W - pad.left - pad.right) / 46)));
    d.months.forEach((ym, m) => {
      if ((last - m) % every) return;
      const tx = el('text', { x: X(m), y: H - 6, 'text-anchor': 'middle' });
      tx.textContent = monthLabel(ym);
    });
    ref = rs ? el('path', { fill: 'none', stroke: OVERALL, 'stroke-width': 2, 'stroke-dasharray': '5 4', 'stroke-linecap': 'round' }) : null;
    lines = shown.map(r => ({ r, path: el('path', { fill: 'none', stroke: r.color, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }) }));
    lines.forEach(l => { l.dots = el('g', { fill: l.r.color }); });
    box.__cross = el('line', { y1: pad.top, y2: H - pad.bottom, stroke: '#46535F', 'stroke-width': 1, visibility: 'hidden' });
    // Carinhas: reaproveita as que já existem para não recarregar as fotos
    const want = new Set(shown.map(r => r.uid));
    for (const [uid, h] of heads) if (!want.has(uid)) { h.remove(); heads.delete(uid); }
    for (const r of shown) {
      if (heads.has(r.uid)) continue;
      const h = document.createElement('div');
      h.className = 'ev-head';
      h.style.setProperty('--c', r.color);
      h.innerHTML = avatar(r.name, 'sm', r.id).toString();
      plot.appendChild(h);
      heads.set(r.uid, h);
    }
    if (rs && !heads.has('ref')) {
      const h = document.createElement('div');
      h.className = 'ev-head is-overall';
      h.style.setProperty('--c', OVERALL);
      h.textContent = (scope === 'projeto' ? 'P' : 'E');
      plot.appendChild(h);
      heads.set('ref', h);
    } else if (!rs && heads.has('ref')) { heads.get('ref').remove(); heads.delete('ref'); }
    paint(t);
  }

  // Valor da série no instante t (entre dois meses, interpolado); null antes de a pessoa ter dados
  const at = (s, t) => {
    const a = Math.floor(t), b = Math.min(last, a + 1);
    if (s[a] === null) return s[b] !== null && t >= b ? s[b] : null;
    if (s[b] === null) return s[a];
    return s[a] + (s[b] - s[a]) * (t - a);
  };
  const pathOf = (s, t) => {
    let out = '';
    for (let m = 0; m <= Math.floor(t); m++) if (s[m] !== null) out += `${out ? 'L' : 'M'}${X(m).toFixed(1)} ${Y(s[m]).toFixed(1)}`;
    const v = at(s, t);
    if (v !== null && t > Math.floor(t)) out += `${out ? 'L' : 'M'}${X(t).toFixed(1)} ${Y(v).toFixed(1)}`;
    return out;
  };

  // Empate: as carinhas ficam lado a lado, para trás na linha, em vez de uma sobre a outra
  const offs = new Map();
  function placeHeads(t, smooth) {
    const i = ind();
    const list = lines.map(l => ({ uid: l.r.uid, v: at(l.r.series[i.key], t) }));
    const rs = refSeries(i);
    if (rs) list.push({ uid: 'ref', v: at(rs, t) });
    const visible = list.filter(x => x.v !== null).map(x => ({ ...x, y: Y(x.v) })).sort((a, b) => a.y - b.y);
    let groupY = -99, n = 0;
    for (const x of visible) {
      if (x.y - groupY < 16) n++; else { groupY = x.y; n = 0; }
      const want = n * 20;
      const prev = offs.get(x.uid) ?? want;
      const o = smooth ? prev + (want - prev) * 0.25 : want;
      offs.set(x.uid, o);
      const h = heads.get(x.uid);
      h.style.display = '';
      h.style.transform = `translate(${Math.max(pad.left, X(t) - o).toFixed(1)}px, ${x.y.toFixed(1)}px)`;
    }
    for (const x of list) if (x.v === null) heads.get(x.uid).style.display = 'none';
  }

  function drawLegend(m) {
    const i = ind();
    const order = [...runners].sort((a, b) => {
      const va = a.series[i.key][m], vb = b.series[i.key][m];
      if (va === null || vb === null) return (va === null) - (vb === null) || a.name.localeCompare(b.name, 'pt-BR');
      return (i.best === 'high' ? vb - va : va - vb) || a.name.localeCompare(b.name, 'pt-BR');
    });
    const rs = refSeries(i);
    const fixed = rs ? html`<li class="ev-fixed"><span class="ev-key is-dash" style="--c:${OVERALL}"></span><span class="ev-name">${refLabel(i)}</span><b>${i.fmt(rs[m])}</b></li>` : '';
    const row = (r, pos) => (scope === 'usuario'
      ? html`<li class="ev-fixed" style="border:0"><span class="ev-key" style="--c:${r.color}"></span>${avatar(r.name, 'sm', r.id)}<span class="ev-name">${r.name}</span><b>${i.fmt(r.series[i.key][m])}</b></li>`
      : html`<li><button type="button" data-ev-who="${r.uid}" aria-pressed="${String(r.on)}" title="Ligar ou desligar no gráfico"><span class="ev-pos">${pos + 1}</span><span class="ev-key" style="--c:${r.color}"></span>${avatar(r.name, 'sm', r.id)}<span class="ev-name">${r.name}</span><b>${i.fmt(r.series[i.key][m])}</b></button></li>`);
    legend.innerHTML = `${fixed}${order.map((r, p) => row(r, p).toString()).join('')}`;
    legend.__m = m;
  }

  function paint(t, smooth = false) {
    const i = ind();
    const rs = refSeries(i);
    if (ref) ref.setAttribute('d', pathOf(rs, t));
    for (const l of lines) {
      const s = l.r.series[i.key];
      l.path.setAttribute('d', pathOf(s, t));
      l.dots.textContent = '';
      for (let m = 0; m <= Math.floor(t); m++) if (s[m] !== null) el('circle', { cx: X(m), cy: Y(s[m]), r: 2.5 }, l.dots);
    }
    placeHeads(t, smooth);
    const m = Math.round(t);
    monthTag.textContent = t < last ? monthLabel(d.months[m]) : '';
    if (legend.__m !== m || legend.__i !== i.key || legend.__dirty) { drawLegend(m); legend.__i = i.key; legend.__dirty = false; }
  }

  const stop = () => { cancelAnimationFrame(raf); raf = 0; };
  function finish() { stop(); t = last; if (plot.clientWidth !== W) frame(); else paint(t); }
  function run() {
    stop(); tipOff();
    if (matchMedia('(prefers-reduced-motion: reduce)').matches || !last) { finish(); return; }
    const total = Math.min(4500, Math.max(1800, last * 500));
    const t0 = performance.now();
    const step = now => {
      if (!card.isConnected) return stop();
      t = Math.min(last, ((now - t0) / total) * last);
      paint(t, true);
      if (t < last) raf = requestAnimationFrame(step);
      else finish();
    };
    t = 0; paint(0);
    raf = requestAnimationFrame(step);
  }

  // ---------- Leitura de um mês: a linha vertical procura o mês mais próximo e a janela lista todos ----------
  let tip = null;
  function tipOff() { tip?.remove(); tip = null; if (box.__cross) box.__cross.setAttribute('visibility', 'hidden'); }
  function tipAt(clientX) {
    if (raf) return;
    const rect = plot.getBoundingClientRect();
    const m = last ? Math.max(0, Math.min(last, Math.round(((clientX - rect.left - pad.left) / (W - pad.left - pad.right)) * last))) : 0;
    const i = ind();
    if (!tip) { tip = document.createElement('div'); tip.className = 'ev-tip'; plot.appendChild(tip); }
    tip.textContent = '';
    const h4 = document.createElement('h4');
    h4.textContent = `${monthLabel(d.months[m])} · ${i.label}`;
    tip.appendChild(h4);
    const addRow = (color, dashed, value, name) => {
      const row = document.createElement('div');
      const key = document.createElement('i');
      key.style.setProperty('--c', color);
      if (dashed) key.className = 'is-dash';
      const b = document.createElement('b'); b.textContent = i.fmt(value);
      const sp = document.createElement('span'); sp.textContent = name;
      row.append(key, b, sp);
      tip.appendChild(row);
    };
    const rs = refSeries(i);
    if (rs) addRow('#C9D2DA', true, rs[m], refLabel(i));
    lines.map(l => l.r).sort((a, b) => (b.series[i.key][m] ?? -1) - (a.series[i.key][m] ?? -1)).forEach(r => addRow(r.color, false, r.series[i.key][m], r.name.split(' ').slice(0, 2).join(' ')));
    box.__cross.setAttribute('x1', X(m)); box.__cross.setAttribute('x2', X(m)); box.__cross.setAttribute('visibility', 'visible');
    const x = X(m), tw = tip.offsetWidth;
    tip.style.left = `${x + 12 + tw > W ? Math.max(0, x - 12 - tw) : x + 12}px`;
  }
  plot.addEventListener('pointermove', e => tipAt(e.clientX));
  plot.addEventListener('pointerdown', e => tipAt(e.clientX));
  plot.addEventListener('pointerleave', e => { if (e.pointerType === 'mouse') tipOff(); });
  const outside = e => {
    if (!card.isConnected) { document.removeEventListener('pointerdown', outside); return; }
    if (!plot.contains(e.target)) tipOff();
  };
  document.addEventListener('pointerdown', outside);

  // ---------- Controles ----------
  const setHelp = () => {
    const i = ind();
    help.textContent = `${i.help}${scope === 'usuario' && i.count ? ` ${refLabel(i).replace(' (média por pessoa)', '')}: média por pessoa com tarefas.` : ''} O último ponto é o número de hoje.`;
    plot.setAttribute('aria-label', `Gráfico de ${i.label} mês a mês. Os valores estão na lista ao lado.`);
  };
  inds.addEventListener('click', e => {
    const b = e.target.closest('[data-ev-ind]');
    if (!b) return;
    chosen = b.dataset.evInd;
    inds.querySelectorAll('[data-ev-ind]').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
    setHelp();
    legend.__dirty = true;
    frame();
    run();
  });
  legend.addEventListener('click', e => {
    const b = e.target.closest('[data-ev-who]');
    if (!b) return;
    const r = runners.find(x => x.uid === b.dataset.evWho);
    r.on = !r.on;
    legend.__dirty = true;
    finish();
    frame();
  });
  body.querySelector('[data-ev-play]').addEventListener('click', () => run());
  // O PDF sai sempre com a corrida terminada
  card.addEventListener('click', e => { if (e.target.closest('.sec-pdf')) { tipOff(); finish(); } }, true);
  window.addEventListener('beforeprint', () => { if (card.isConnected) { tipOff(); finish(); } }, { once: true });

  setHelp();
  frame();
  new ResizeObserver(() => { if (plot.clientWidth !== W && !raf) frame(); }).observe(plot);
  // A corrida começa quando o quadro aparece na tela
  const seen = new IntersectionObserver(es => { if (es.some(x => x.isIntersecting)) { seen.disconnect(); run(); } }, { threshold: 0.35 });
  seen.observe(plot);
}

export function bindEvolution(root) {
  root.querySelectorAll('[data-ev-scope]').forEach(async card => {
    const id = card.dataset.evId;
    try {
      const d = await api('/evolution', { query: { scope: card.dataset.evScope, ...(id ? { id } : {}) } });
      if (card.isConnected) chart(card, d);
    } catch (err) {
      if (card.isConnected) card.querySelector('[data-ev-body]').textContent = `Não foi possível carregar o gráfico: ${err.message || 'tente de novo'}.`;
    }
  });
}
