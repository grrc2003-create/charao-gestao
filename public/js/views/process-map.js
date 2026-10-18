// Mapa mental dos Processos da Empresa: centro → áreas → processos, com as ligações entre processos relacionados.
// Tocar em um processo destaca as ligações dele e mostra o resumo ao lado (com atalho para a ficha).
import { html, raw, esc, api, icon } from '../core.js';
import { pageHead } from './shared.js';

const AREA_COLORS = ['#2A3D50', '#C9520F', '#1F6FB2', '#2E8B57', '#7A4FA3', '#A86F0E', '#0F7C83', '#B03A5B'];
const W = 1000, H = 720, CX = W / 2, CY = H / 2;

// Quebra o título em até 2 linhas de ~24 caracteres
function wrap(t, max = 24) {
  const words = String(t || '').split(/\s+/);
  const lines = [''];
  for (const w of words) {
    const cur = lines[lines.length - 1];
    if ((cur + ' ' + w).trim().length <= max) lines[lines.length - 1] = (cur + ' ' + w).trim();
    else if (lines.length < 2) lines.push(w);
    else { lines[1] = (lines[1] + ' ' + w).slice(0, max - 1) + '…'; break; }
  }
  return lines.map(l => (l.length > max ? l.slice(0, max - 1) + '…' : l));
}

function layout(items) {
  const areas = [...new Set(items.map(i => i.area || 'Sem área'))].sort((a, b) => a.localeCompare(b, 'pt-BR'));
  const ordered = areas.flatMap(a => items.filter(i => (i.area || 'Sem área') === a));
  const n = ordered.length;
  const pos = new Map();
  ordered.forEach((p, j) => {
    const ang = (2 * Math.PI * j) / n - Math.PI / 2 + Math.PI / n;
    pos.set(p.id, { x: CX + 385 * Math.cos(ang), y: CY + 285 * Math.sin(ang), ang });
  });
  const areaNodes = areas.map((a, k) => {
    const ps = ordered.filter(i => (i.area || 'Sem área') === a);
    const sx = ps.reduce((s, p) => s + Math.cos(pos.get(p.id).ang), 0), sy = ps.reduce((s, p) => s + Math.sin(pos.get(p.id).ang), 0);
    const ang = Math.atan2(sy, sx);
    return { name: a, color: AREA_COLORS[k % AREA_COLORS.length], x: CX + 190 * Math.cos(ang), y: CY + 140 * Math.sin(ang), ps };
  });
  // Ligações entre processos (sem repetir o par)
  const ids = new Set(items.map(i => i.id));
  const pairs = new Map();
  for (const i of items) for (const r of i.related || []) {
    if (!ids.has(r) || r === i.id) continue;
    const k = [Math.min(i.id, r), Math.max(i.id, r)].join('-');
    if (!pairs.has(k)) pairs.set(k, [Math.min(i.id, r), Math.max(i.id, r)]);
  }
  return { areaNodes, pos, links: [...pairs.values()] };
}

const curve = (a, b, pull = 0.45) => {
  const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
  const qx = mx + (CX - mx) * pull, qy = my + (CY - my) * pull;
  return `M${a.x.toFixed(1)},${a.y.toFixed(1)} Q${qx.toFixed(1)},${qy.toFixed(1)} ${b.x.toFixed(1)},${b.y.toFixed(1)}`;
};

function svgMap(items) {
  const { areaNodes, pos, links } = layout(items);
  const colorOf = new Map(areaNodes.flatMap(a => a.ps.map(p => [p.id, a.color])));
  let s = `<svg viewBox="0 0 ${W} ${H}" class="pm-svg" role="img" aria-label="Mapa mental dos processos">`;
  // Ramos: centro → área → processo
  for (const a of areaNodes) {
    s += `<path class="pm-branch" d="${curve({ x: CX, y: CY }, a, 0)}" stroke="${a.color}" stroke-width="5"/>`;
    for (const p of a.ps) s += `<path class="pm-branch" data-branch="${p.id}" d="${curve(a, pos.get(p.id), -0.15)}" stroke="${a.color}" stroke-width="2.5"/>`;
  }
  // Ligações entre processos relacionados
  for (const [x, y] of links) s += `<path class="pm-link" data-a="${x}" data-b="${y}" d="${curve(pos.get(x), pos.get(y), 0.55)}"/>`;
  // Centro
  s += `<g class="pm-center"><circle cx="${CX}" cy="${CY}" r="70"/><text x="${CX}" y="${CY - 6}" text-anchor="middle">Processos</text><text x="${CX}" y="${CY + 16}" text-anchor="middle">da Empresa</text></g>`;
  // Áreas
  for (const a of areaNodes) {
    const w = Math.max(96, a.name.length * 9 + 30);
    s += `<g class="pm-area"><rect x="${(a.x - w / 2).toFixed(1)}" y="${(a.y - 17).toFixed(1)}" width="${w}" height="34" rx="17" fill="${a.color}"/>
      <text x="${a.x.toFixed(1)}" y="${(a.y + 5).toFixed(1)}" text-anchor="middle">${esc(a.name)}</text></g>`;
  }
  // Processos
  for (const p of items) {
    const { x, y } = pos.get(p.id);
    const lines = wrap(p.title);
    const h = 30 + lines.length * 17;
    const c = colorOf.get(p.id);
    s += `<g class="pm-node ${p.status !== 'publicado' ? 'is-off' : ''}" data-id="${p.id}" tabindex="0" role="button" aria-label="${esc(`${p.code} ${p.title}`)}">
      <rect x="${(x - 100).toFixed(1)}" y="${(y - h / 2).toFixed(1)}" width="200" height="${h}" rx="10" style="--c:${c}"/>
      <rect class="pm-bar" x="${(x - 100).toFixed(1)}" y="${(y - h / 2).toFixed(1)}" width="6" height="${h}" rx="3" fill="${c}"/>
      <text class="pm-code" x="${(x - 86).toFixed(1)}" y="${(y - h / 2 + 18).toFixed(1)}" fill="${c}">${esc(p.code)}${p.controls ? `  ◆ ${p.controls}` : ''}</text>
      ${lines.map((l, i) => `<text class="pm-title" x="${(x - 86).toFixed(1)}" y="${(y - h / 2 + 36 + i * 17).toFixed(1)}">${esc(l)}</text>`).join('')}
    </g>`;
  }
  return raw(s + '</svg>');
}

export async function view({ query, setQuery }) {
  const data = await api('/processes');
  const items = data.items;
  const byId = new Map(items.map(i => [i.id, i]));
  const linksOf = id => {
    const out = new Set(byId.get(id)?.related?.filter(r => byId.has(r)) || []);
    for (const i of items) if (i.related?.includes(id)) out.add(i.id);
    out.delete(id);
    return [...out].map(x => byId.get(x));
  };
  const total = new Set(items.flatMap(i => (i.related || []).filter(r => byId.has(r) && r !== i.id).map(r => [Math.min(i.id, r), Math.max(i.id, r)].join('-')))).size;
  const isolated = items.filter(i => !linksOf(i.id).length);
  return {
    title: 'Mapa mental dos processos',
    html: html`
      ${pageHead({
        back: { href: '#/processos', label: 'Processos da Empresa' },
        eyebrow: 'Processos da Empresa',
        title: 'Mapa mental dos processos',
        sub: `${items.length} processo(s) por área · ${total} ligação(ões) entre processos relacionados. Toque em um processo para destacar as ligações dele.`,
      })}
      ${items.length ? html`<div class="pm-layout">
        <section class="card pm-card">
          <div class="pm-tools">
            <span class="pm-legend"><i class="pm-l-branch"></i>Área → processo</span>
            <span class="pm-legend"><i class="pm-l-link"></i>Processos relacionados</span>
            <span class="pm-legend"><b>◆</b> pontos de controle</span>
            <span class="pm-zoom"><button type="button" class="icon-btn" data-zoom="-1" aria-label="Diminuir">−</button><button type="button" class="icon-btn" data-zoom="1" aria-label="Aumentar">+</button></span>
          </div>
          <div class="pm-scroll" id="pm-scroll">${svgMap(items)}</div>
        </section>
        <aside class="card pm-info" id="pm-info" aria-live="polite"></aside>
      </div>` : html`<div class="empty-state"><h2>Nenhum processo publicado</h2><p>O mapa aparece quando houver processos cadastrados.</p></div>`}`,
    mount(root) {
      if (!items.length) return;
      const svg = root.querySelector('.pm-svg');
      const info = root.querySelector('#pm-info');
      const scroll = root.querySelector('#pm-scroll');
      const idle = html`<div class="card-body"><div class="sub-label">Como usar</div>
        <p class="muted" style="margin:4px 0 12px">Toque em um processo para ver com quais outros ele se liga. As ligações são definidas em “Processos relacionados” na edição de cada processo.</p>
        ${isolated.length ? html`<div class="sub-label">Sem ligação com outros processos</div><ul class="pm-list">${isolated.map(i => html`<li><button type="button" data-pick="${i.id}"><span class="mono">${i.code}</span> ${i.title}</button></li>`)}</ul>` : ''}</div>`;
      const select = id => {
        const p = byId.get(id);
        svg.classList.toggle('has-sel', !!p);
        const linked = p ? new Set(linksOf(id).map(x => x.id)) : new Set();
        svg.querySelectorAll('.pm-node').forEach(n => {
          const nid = Number(n.dataset.id);
          n.classList.toggle('is-sel', nid === id);
          n.classList.toggle('is-linked', linked.has(nid));
        });
        svg.querySelectorAll('.pm-link').forEach(l => l.classList.toggle('is-on', !!p && (Number(l.dataset.a) === id || Number(l.dataset.b) === id)));
        svg.querySelectorAll('[data-branch]').forEach(b => b.classList.toggle('is-on', Number(b.dataset.branch) === id));
        setQuery({ p: p ? String(id) : '' });
        if (!p) { info.innerHTML = idle.toString(); bindPicks(); return; }
        const ls = linksOf(id);
        info.innerHTML = html`<div class="card-body">
          <div class="pr-card-top"><span class="pr-code">${p.code}</span>${p.frequency ? html`<span class="pr-freq">${icon('clock')}${p.frequency}</span>` : ''}</div>
          <h2 class="pm-h">${p.title}</h2>
          <div class="muted" style="font-size:13px">${p.area} · ${p.steps} etapa(s) · ${p.controls} ponto(s) de controle</div>
          <p style="font-size:13.5px;margin:10px 0">${p.objective || ''}</p>
          <div class="sub-label">Ligado a ${ls.length} processo(s)</div>
          ${ls.length ? html`<ul class="pm-list">${ls.map(x => html`<li><button type="button" data-pick="${x.id}"><span class="mono">${x.code}</span> ${x.title}</button></li>`)}</ul>` : html`<p class="muted" style="font-size:13px">Nenhum processo relacionado.</p>`}
          <div class="pm-acts"><a class="btn btn-primary btn-sm" href="#/processos/${p.id}">${icon('file')}Abrir ficha</a><button type="button" class="btn btn-ghost btn-sm" data-clear>Limpar seleção</button></div>
        </div>`.toString();
        bindPicks();
        info.querySelector('[data-clear]')?.addEventListener('click', () => select(null));
      };
      const bindPicks = () => info.querySelectorAll('[data-pick]').forEach(b => b.addEventListener('click', () => {
        const id = Number(b.dataset.pick);
        select(id);
        focusNode(id, true);
      }));
      // Rola o desenho (ampliado) até o processo
      const focusNode = (id, smooth) => {
        const n = svg.querySelector(`.pm-node[data-id="${id}"]`);
        if (!n || scroll.scrollWidth <= scroll.clientWidth) return;
        const r = n.getBoundingClientRect(), sr = scroll.getBoundingClientRect();
        scroll.scrollBy({ left: r.left - sr.left - sr.width / 2 + r.width / 2, top: r.top - sr.top - sr.height / 2 + r.height / 2, behavior: smooth ? 'smooth' : 'auto' });
      };
      svg.querySelectorAll('.pm-node').forEach(n => {
        const pick = () => { const id = Number(n.dataset.id); select(svg.querySelector('.pm-node.is-sel')?.dataset.id === n.dataset.id ? null : id); };
        n.addEventListener('click', pick);
        n.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } });
      });
      // Zoom: muda a largura do desenho (no celular começa ampliado, com rolagem)
      const ZOOMS = [100, 140, 180, 230];
      let z = innerWidth < 700 ? 2 : 0;
      const applyZoom = () => {
        svg.style.width = `${ZOOMS[z]}%`;
        scroll.classList.toggle('is-zoomed', z > 0);
      };
      root.querySelectorAll('[data-zoom]').forEach(b => b.addEventListener('click', () => {
        const prev = { x: scroll.scrollLeft / Math.max(1, scroll.scrollWidth), y: scroll.scrollTop / Math.max(1, scroll.scrollHeight) };
        z = Math.max(0, Math.min(ZOOMS.length - 1, z + Number(b.dataset.zoom)));
        applyZoom();
        scroll.scrollLeft = prev.x * scroll.scrollWidth;
        scroll.scrollTop = prev.y * scroll.scrollHeight;
      }));
      applyZoom();
      const q = Number(query.get('p'));
      select(byId.has(q) ? q : null);
      // Celular: começa centralizado (ou no processo escolhido)
      if (z > 0) setTimeout(() => {
        scroll.scrollLeft = (scroll.scrollWidth - scroll.clientWidth) / 2;
        scroll.scrollTop = (scroll.scrollHeight - scroll.clientHeight) / 2;
        if (byId.has(q)) focusNode(q, false);
      }, 60);
    },
  };
}
