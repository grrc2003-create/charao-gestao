// Funil de Vendas: indicadores do topo (com valores totalizados) e análises (etapas, fechamentos por mês, origem,
// motivos de perda, empresa, responsável e oportunidades paradas). Tudo calculado sobre as oportunidades visíveis
// (respeita os filtros de empresa e busca).
import { html, icon } from '../core.js';
import { money } from './contracts.js';

const pct = (a, b) => (b ? Math.round((a / b) * 100) : null);
const pctTxt = v => (v === null ? '—' : `${v}%`);
const sum = l => l.reduce((s, o) => s + (o.final_value || 0), 0);
const days = (a, b) => Math.max(0, Math.round((Date.parse(a.replace(' ', 'T') + 'Z') - Date.parse(b.replace(' ', 'T') + 'Z')) / 86400e3));
const nowISO = () => new Date().toISOString().slice(0, 19).replace('T', ' ');
const MESES = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
const compact = v => (v >= 1e6 ? `R$ ${(v / 1e6).toFixed(1).replace('.', ',')} mi` : v >= 1e3 ? `R$ ${Math.round(v / 1e3)} mil` : money(v));

function split(visible, stages) {
  const kind = id => stages.find(s => s.id === id)?.kind;
  const open = visible.filter(o => !['ganho', 'perdido'].includes(kind(o.stage_id)));
  const won = visible.filter(o => kind(o.stage_id) === 'ganho');
  const lost = visible.filter(o => kind(o.stage_id) === 'perdido');
  return { open, won, lost };
}

// ---------- Indicadores do topo ----------
export function salesKpis(visible, stages) {
  const { open, won, lost } = split(visible, stages);
  const vOpen = sum(open), vWon = sum(won), vLost = sum(lost);
  const year = String(new Date().getFullYear());
  const wonYear = won.filter(o => (o.closed_at || '').startsWith(year));
  const cycle = won.filter(o => o.closed_at && o.created_at).map(o => days(o.closed_at, o.created_at));
  const avgCycle = cycle.length ? Math.round(cycle.reduce((a, b) => a + b, 0) / cycle.length) : null;
  const withDisc = won.filter(o => o.discount_pct);
  const avgDisc = withDisc.length ? withDisc.reduce((a, o) => a + o.discount_pct, 0) / withDisc.length : null;
  const k = (cls, label, value, foot, extra = '') => html`<div class="sv-kpi ${cls}"><span>${label}</span><b>${value}</b><small>${foot}</small>${extra}</div>`;
  return html`<div class="sv-kpis">
    ${k('', 'Em andamento (funil)', money(vOpen), `${open.length} oportunidade(s)${open.length ? ` · média ${money(vOpen / open.length)}` : ''}`)}
    ${k('k-won', 'Valor fechado', money(vWon), `${won.length} contrato(s)${won.length ? ` · ticket médio ${money(vWon / won.length)}` : ''}`,
      html`<em>${year}: ${money(sum(wonYear))} (${wonYear.length})</em>`)}
    ${k('k-lost', 'Valor perdido', money(vLost), `${lost.length} oportunidade(s)`)}
    ${k('k-conv', 'Conversão', pctTxt(pct(won.length, won.length + lost.length)), 'em quantidade (fechados ÷ decididos)',
      html`<em>em valor: ${pctTxt(pct(vWon, vWon + vLost))}</em>`)}
    ${k('', 'Ciclo médio de venda', avgCycle === null ? '—' : `${avgCycle} dia(s)`, 'do cadastro ao contrato fechado')}
    ${k('', 'Desconto médio', avgDisc === null ? '—' : `${String(Math.round(avgDisc * 10) / 10).replace('.', ',')}%`, withDisc.length ? `em ${withDisc.length} contrato(s) com desconto` : 'nos contratos fechados')}
  </div>`;
}

// ---------- Análises ----------
const hbars = (rows, { max, fmt = r => r.n, tone = '' } = {}) => html`<ul class="sa-bars ${tone}">${rows.map(r => html`<li title="${r.title || ''}">
  <span class="sa-bl">${r.label}</span><span class="sa-bt"><i style="width:${Math.max(3, Math.round(((r.v ?? r.n) / (max || 1)) * 100))}%"></i></span><b>${fmt(r)}</b></li>`)}</ul>`;

export function salesAnalytics(visible, stages) {
  if (!visible.length) return '';
  const { open, won, lost } = split(visible, stages);
  const now = nowISO();

  // 1) Funil por etapa (abertas): quantidade e valor
  const openStages = stages.filter(s => !['ganho', 'perdido'].includes(s.kind));
  const funnel = openStages.map(s => { const l = open.filter(o => o.stage_id === s.id); return { label: s.name, n: l.length, v: sum(l), title: `${l.length} oportunidade(s) · ${money(sum(l))}` }; });
  const fMax = Math.max(...funnel.map(r => r.v), 1);

  // 2) Fechados por mês (últimos 12 meses)
  const base = new Date();
  const months = Array.from({ length: 12 }, (_, i) => { const d = new Date(base.getFullYear(), base.getMonth() - 11 + i, 1); return { key: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`, label: MESES[d.getMonth()], y: d.getFullYear() }; });
  for (const m of months) { const l = won.filter(o => (o.closed_at || '').startsWith(m.key)); m.n = l.length; m.v = sum(l); m.lost = lost.filter(o => (o.closed_at || '').startsWith(m.key)).length; }
  const mMax = Math.max(...months.map(m => m.v), 1);
  const best = months.reduce((a, m) => (m.v > a.v ? m : a), months[0]);
  const total12 = months.reduce((a, m) => a + m.v, 0);

  // 3) Origem: oportunidades, fechadas, conversão e valor fechado
  const group = (keyFn, labelFn) => {
    const m = new Map();
    for (const o of visible) { const k = keyFn(o); if (!m.has(k)) m.set(k, { label: labelFn(o), all: [], won: [], lost: [], open: [] }); const g = m.get(k); g.all.push(o); g[open.includes(o) ? 'open' : won.includes(o) ? 'won' : 'lost'].push(o); }
    return [...m.values()].sort((a, b) => sum(b.won) - sum(a.won) || b.all.length - a.all.length);
  };
  const table = (rows, first) => html`<div class="table-wrap"><table class="data sa-t"><thead><tr><th>${first}</th><th class="num">Andamento</th><th class="num">Fechado</th><th class="num">Conv.</th></tr></thead>
    <tbody>${rows.map(g => html`<tr><td>${g.label}<small>${g.all.length} oportunidade(s)</small></td><td class="num" data-l="Andamento">${money(sum(g.open))}<small>${g.open.length}</small></td>
      <td class="num" data-l="Fechado">${money(sum(g.won))}<small>${g.won.length}</small></td><td class="num" data-l="Conversão">${pctTxt(pct(g.won.length, g.won.length + g.lost.length))}</td></tr>`)}</tbody></table></div>`;
  const bySource = group(o => o.source_id || 0, o => o.source_name || 'Sem origem');
  const byCompany = group(o => o.company, o => o.company_name || o.company);
  const byOwner = group(o => o.owner_id || 0, o => o.owner_name || 'Sem responsável');

  // 4) Motivos de perda
  const lr = new Map();
  for (const o of lost) { const k = o.lost_reason_name || 'Sem motivo'; const x = lr.get(k) || { label: k, n: 0, v: 0 }; x.n++; x.v += o.final_value || 0; lr.set(k, x); }
  const reasons = [...lr.values()].sort((a, b) => b.n - a.n);

  // 5) Paradas há mais tempo (abertas, por dias na etapa atual)
  const stale = open.map(o => ({ o, d: o.stage_since ? days(now, o.stage_since) : 0 })).sort((a, b) => b.d - a.d).slice(0, 6);

  return html`<details class="sa-wrap" id="sa-wrap" open>
    <summary><h2>${icon('reports')}Análises do funil</h2><span class="muted">${visible.length} oportunidade(s) consideradas · respeita os filtros</span></summary>
    <div class="sa-grid">
      <section class="card sa-card"><div class="card-head"><h2>Funil por etapa</h2><span class="sub">em andamento · ${money(sum(open))}</span></div>
        <div class="card-body">${hbars(funnel, { max: fMax, fmt: r => html`${money(r.v)}<small>${r.n} oport.</small>` })}
          <p class="sa-note">Fechados: <b>${won.length}</b> (${money(sum(won))}) · Perdidos: <b>${lost.length}</b> (${money(sum(lost))})</p></div></section>

      <section class="card sa-card"><div class="card-head"><h2>Contratos fechados por mês</h2><span class="sub">12 meses · ${money(total12)}</span></div>
        <div class="card-body"><div class="sa-cols" role="img" aria-label="Valor fechado por mês nos últimos 12 meses">
          ${months.map(m => html`<div class="sa-col" title="${m.label}/${m.y}: ${money(m.v)} · ${m.n} fechado(s)${m.lost ? ` · ${m.lost} perdido(s)` : ''}">
            <span class="sa-cv">${m.v ? compact(m.v) : ''}</span><span class="sa-cb"><i style="height:${m.v ? Math.max(4, Math.round((m.v / mMax) * 100)) : 0}%"></i></span><span class="sa-cl">${m.label}</span></div>`)}</div>
          <p class="sa-note">${best.v ? html`Melhor mês: <b>${best.label}/${best.y}</b> com ${money(best.v)} (${best.n} contrato(s)).` : 'Nenhum contrato fechado nos últimos 12 meses.'}</p></div></section>

      <section class="card sa-card"><div class="card-head"><h2>Origem das oportunidades</h2><span class="sub">de onde vêm os contratos</span></div>
        <div class="card-body">${table(bySource, 'Origem')}</div></section>

      <section class="card sa-card"><div class="card-head"><h2>Motivos de perda</h2><span class="sub">${lost.length} perdida(s) · ${money(sum(lost))}</span></div>
        <div class="card-body">${reasons.length ? hbars(reasons, { max: Math.max(...reasons.map(r => r.n)), tone: 'is-lost', fmt: r => html`${r.n}<small>${money(r.v)}</small>` })
          : html`<p class="muted">Nenhuma oportunidade perdida.</p>`}</div></section>

      ${byCompany.length > 1 ? html`<section class="card sa-card"><div class="card-head"><h2>Por empresa</h2><span class="sub">Charão × LuS</span></div>
        <div class="card-body">${table(byCompany, 'Empresa')}</div></section>` : ''}

      <section class="card sa-card"><div class="card-head"><h2>Por responsável</h2><span class="sub">carteira de cada um</span></div>
        <div class="card-body">${table(byOwner, 'Responsável')}</div></section>

      <section class="card sa-card"><div class="card-head"><h2>${icon('clock')}Paradas há mais tempo</h2><span class="sub">em andamento, dias na etapa atual</span></div>
        <div class="card-body">${stale.length ? html`<ul class="sa-stale">${stale.map(({ o, d }) => html`<li><a href="#/vendas/${o.id}"><span class="mono">${o.code}</span> <b>${o.client}</b>
            <small>${o.stage_name}${o.final_value ? ` · ${money(o.final_value)}` : ''}</small></a><span class="sa-days ${d >= 30 ? 'is-late' : d >= 15 ? 'is-warn' : ''}">${d} dia(s)</span></li>`)}</ul>`
          : html`<p class="muted">Nenhuma oportunidade em andamento.</p>`}</div></section>
    </div></details>`;
}

// Lembra se as análises ficaram abertas ou fechadas
export function bindAnalytics(root) {
  const d = root.querySelector('#sa-wrap');
  if (!d) return;
  // Padrão: aberta no computador e recolhida no celular; depois vale a escolha da pessoa
  let saved = null;
  try { saved = localStorage.getItem('charao-sa-open'); } catch { /* sem armazenamento */ }
  d.open = saved === null ? !matchMedia('(max-width: 760px)').matches : saved === '1';
  d.addEventListener('toggle', () => { try { localStorage.setItem('charao-sa-open', d.open ? '1' : '0'); } catch { /* sem armazenamento */ } });
}
