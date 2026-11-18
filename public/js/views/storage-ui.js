// Configurações → Espaço e uso (só administradores): disco de dados do Render e repositório do GitHub
import { html, api, icon, fmtDate, fmtDateTime } from '../core.js';

export function fmtBytes(b) {
  if (b === null || b === undefined) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0, v = Math.abs(b);
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${b < 0 ? '-' : ''}${v.toLocaleString('pt-BR', { maximumFractionDigits: v < 10 && i ? 1 : 0 })} ${u[i]}`;
}
const LEVEL = { ok: 'Tranquilo', atencao: 'Atenção', critico: 'Crítico' };
const pctTxt = p => `${String(p).replace('.', ',')}%`;

const meter = (pct, lvl, label) => html`<div class="st-meter st-${lvl}" role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}" aria-label="${label}"><span style="width:${Math.min(100, pct)}%"></span></div>`;

// Linha do que o sistema ocupa por dia (últimos 30 dias)
function spark(hist) {
  if (hist.length < 2) return '';
  const W = 280, H = 56, P = 4;
  const ys = hist.map(h => h.bytes);
  const min = Math.min(...ys), max = Math.max(...ys);
  const x = i => P + (i * (W - 2 * P)) / (hist.length - 1);
  const y = v => (max === min ? H / 2 : H - P - ((v - min) * (H - 2 * P)) / (max - min));
  const pts = hist.map((h, i) => `${x(i).toFixed(1)},${y(h.bytes).toFixed(1)}`).join(' ');
  const last = hist[hist.length - 1];
  return html`<figure class="st-spark"><svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" role="img" aria-label="Espaço ocupado pelo sistema nos últimos ${hist.length} dias: de ${fmtBytes(hist[0].bytes)} para ${fmtBytes(last.bytes)}">
    <polyline points="${pts}" fill="none" stroke="var(--navy)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
    <circle cx="${x(hist.length - 1)}" cy="${y(last.bytes)}" r="4" fill="var(--orange-700)" stroke="var(--surface)" stroke-width="2"/></svg>
    <figcaption><span>${fmtDate(hist[0].day)}</span><span>${fmtDate(last.day)}</span></figcaption></figure>`;
}

export function storageCard(r) {
  if (!r) return '';
  const d = r.disk;
  const g = r.growth;
  const maxArea = Math.max(1, ...r.areas.map(a => a.bytes));
  return html`<section class="card" id="storage-card" style="max-width:900px;margin-bottom:16px">
    <div class="card-head"><h2>${icon('disk')}Espaço e uso</h2><span class="sub">visível só para administradores</span></div>
    <div class="card-body st-grid">
      <div class="st-box">
        <h3>Render · disco de dados</h3>
        ${d ? html`<div class="st-big"><b>${fmtBytes(d.used)}</b> de ${fmtBytes(d.total)} <span class="st-tag st-${d.level}">${LEVEL[d.level]} · ${pctTxt(d.pct)}</span></div>
          ${meter(d.pct, d.level, `Disco ${pctTxt(d.pct)} usado`)}
          <p class="st-line">Livre: <b>${fmtBytes(d.free)}</b>${r.is_render ? '' : html` <span class="muted">· neste computador (no Render é o disco de 1 GB)</span>`}</p>`
        : html`<p class="muted">Não foi possível ler o tamanho do disco neste servidor.</p>`}
        <p class="st-line">Banco de dados: <b>${fmtBytes(r.db_bytes)}</b> · Fotos e anexos: <b>${fmtBytes(r.files_bytes)}</b> (${r.files_count.toLocaleString('pt-BR')} arquivo(s))</p>
        <p class="st-line">${g.days > 0
          ? html`Crescimento: <b>${g.bytes >= 0 ? '+' : ''}${fmtBytes(g.bytes)}</b> em ${g.days} dia(s) (≈ ${fmtBytes(Math.round(g.per_day))}/dia)${g.days_to_full !== null ? html` · no ritmo atual, o disco enche em <b>${g.days_to_full > 3650 ? 'mais de 10 anos' : g.days_to_full > 60 ? `~${Math.round(g.days_to_full / 30)} meses` : `~${g.days_to_full} dia(s)`}</b>` : ''}`
          : html`<span class="muted">O acompanhamento diário começou hoje: o crescimento aparece a partir de amanhã.</span>`}</p>
        ${spark(r.history)}
        ${r.areas.length ? html`<details class="st-areas"><summary>Fotos e anexos por área</summary>
          <ul>${r.areas.map(a => html`<li><span class="st-an" title="${a.area}">${a.area}</span><span class="st-ab"><span style="width:${Math.max(2, (a.bytes / maxArea) * 100)}%"></span></span><span class="st-av">${fmtBytes(a.bytes)} <small class="muted">${a.count} arq.</small></span></li>`)}</ul>
          ${r.areas.some(a => a.area.startsWith('Sem vínculo')) ? html`<p class="hint">“Sem vínculo”: arquivos que ficaram no disco sem registro ligado a eles (ex.: itens excluídos). Não são apagados automaticamente.</p>` : ''}
        </details>` : ''}
        <p class="hint">Faixas: até 70% tranquilo · 70% a 85% atenção · acima de 85% crítico. Para aumentar, abra o serviço no painel do Render → <b>Disks</b> e aumente o tamanho (o disco só pode crescer, nunca diminuir).</p>
      </div>
      <div class="st-box" id="gh-box"><h3>GitHub · repositório do código</h3><p class="muted">Consultando o GitHub…</p></div>
    </div>
  </section>`;
}

function ghBox(g) {
  if (!g.ok) return html`<h3>GitHub · repositório do código</h3><p class="muted">${g.error}</p><p class="hint">Repositório: ${g.repo}</p>
    <button type="button" class="btn btn-ghost btn-sm" data-gh-refresh>${icon('history')}Tentar de novo</button>`;
  return html`<h3>GitHub · repositório do código</h3>
    <div class="st-big"><b>${fmtBytes(g.bytes)}</b> de 1 GB recomendado <span class="st-tag st-${g.level}">${LEVEL[g.level]} · ${pctTxt(g.pct_recommended)}</span></div>
    ${meter(g.pct_recommended, g.level, `Repositório ${pctTxt(g.pct_recommended)} do tamanho recomendado`)}
    <p class="st-line"><a href="${g.url}" target="_blank" rel="noopener">${g.repo}</a> · ${g.private ? 'privado' : 'público'} · último envio ${fmtDateTime(g.pushed_at)}</p>
    <p class="hint">Só o código fica no GitHub: banco, fotos e anexos ficam no disco do Render. O GitHub recomenda repositórios com menos de 1 GB (abaixo de 5 GB é o limite forte) e recusa arquivos acima de 100 MB.</p>
    <p class="hint">Consultado em ${fmtDateTime(g.checked_at)} (atualiza a cada hora). <button type="button" class="link-btn" data-gh-refresh>Atualizar agora</button></p>`;
}

export function bindStorage(root) {
  const box = root.querySelector('#gh-box');
  if (!box) return;
  const load = async fresh => {
    try { box.innerHTML = ghBox(await api('/settings/storage/github', { query: fresh ? { fresh: '1' } : {} })).toString(); }
    catch (e) { box.innerHTML = ghBox({ ok: false, error: e.message, repo: '' }).toString(); }
  };
  box.addEventListener('click', e => { if (e.target.closest('[data-gh-refresh]')) { box.querySelector('p').textContent = 'Consultando o GitHub…'; load(true); } });
  load(false);
}
