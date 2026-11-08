// Mapa de vínculos do projeto: as atividades em cartões, da esquerda (o que vem antes) para a direita (o que vem depois).
// Ligar: arrastar o ponto laranja até a próxima atividade, ou tocar no ponto e depois na atividade (no celular é mais fácil).
// Depois de ligar, a atividade de destino vira a origem da próxima ligação, para seguir encadeando.
// Filtros por responsável e função: a cadeia mostra até onde vão as atividades ligadas às escolhidas.
// As regras são as mesmas da tela da tarefa (POST/DELETE /dependencies): ciclo, permissão e ajuste de datas ficam no servidor.
import { html, api, icon, fmtDate } from '../core.js';
import { toast, confirmSheet } from '../ui.js';
import { pageHead } from './shared.js';

const CARD_W = 216, CARD_H = 96, COL_GAP = 74, ROW_GAP = 16, PAD_X = 16, PAD_Y = 32;
const TYPE = { tarefa: 'Tarefa', subtarefa: 'Subtarefa', checklist: 'Check-list', item: 'Item' };
const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// Atividades ligadas a partir de start, seguindo as ligações num sentido (next: sucessoras; prev: predecessoras)
function walk(start, links) {
  const seen = new Set(start);
  const stack = [...start];
  while (stack.length) for (const k of links.get(stack.pop()) || []) if (!seen.has(k)) { seen.add(k); stack.push(k); }
  return seen;
}

// Colunas pelo maior caminho desde o início; as linhas seguem a média das predecessoras (mantém as cadeias alinhadas).
// Atividades sem ligação ficam à esquerda, à mão para começar a ligar — em várias colunas quando são muitas
// (mais ou menos da altura da sequência), para o mapa inteiro caber na tela ao ajustar a escala.
function layout(nodes, edges) {
  const preds = new Map(nodes.map(n => [n.key, []]));
  const succs = new Map(nodes.map(n => [n.key, []]));
  for (const e of edges) { preds.get(e.succ).push(e.pred); succs.get(e.pred).push(e.succ); }
  const free = nodes.filter(n => !preds.get(n.key).length && !succs.get(n.key).length);
  const linked = nodes.filter(n => preds.get(n.key).length || succs.get(n.key).length);
  const depth = new Map();
  const depthOf = k => {
    if (depth.has(k)) return depth.get(k);
    depth.set(k, 0);
    const d = preds.get(k).reduce((m, p) => Math.max(m, depthOf(p) + 1), 0);
    depth.set(k, d);
    return d;
  };
  linked.forEach(n => depthOf(n.key));
  const pos = new Map();
  const step = CARD_H + ROW_GAP;
  const colNext = new Map();
  const order = [...linked].sort((a, b) => depth.get(a.key) - depth.get(b.key));
  for (const n of order) {
    const col = depth.get(n.key);
    const ps = preds.get(n.key).map(p => pos.get(p)?.y).filter(y => y !== undefined);
    const wanted = ps.length ? ps.reduce((a, b) => a + b, 0) / ps.length : 0;
    const y = Math.max(wanted, colNext.get(col) ?? PAD_Y);
    colNext.set(col, y + step);
    pos.set(n.key, { x: col * (CARD_W + COL_GAP), y });
  }
  // Sem vínculo: colunas com a altura da sequência (no mínimo 5 linhas)
  const FREE_GAP = 20;
  const linkedRows = linked.length ? Math.round((Math.max(...linked.map(n => pos.get(n.key).y)) - PAD_Y) / step) + 1 : 0;
  // Linhas das soltas: a escolha que deixa o mapa inteiro maior numa tela de proporção ~1,6 (largura/altura)
  const linkedW = linked.length ? Math.max(...linked.map(n => pos.get(n.key).x)) + CARD_W + COL_GAP : 0;
  const linkedH = linkedRows * step;
  let rows = 1, best = -1;
  for (let r = Math.min(Math.max(5, linkedRows), Math.max(1, free.length)); r <= Math.max(5, free.length); r++) {
    const W = Math.ceil(free.length / r) * (CARD_W + FREE_GAP) + linkedW + 2 * PAD_X, H = Math.max(r * step, linkedH) + 2 * PAD_Y;
    const z = Math.min(1.6 / W, 1 / H);
    if (z > best) { best = z; rows = r; }
  }
  const freeCols = free.length ? Math.ceil(free.length / rows) : 0;
  free.forEach((n, i) => pos.set(n.key, { x: PAD_X + Math.floor(i / rows) * (CARD_W + FREE_GAP), y: PAD_Y + (i % rows) * step }));
  const linkedX = free.length ? PAD_X + freeCols * (CARD_W + FREE_GAP) - FREE_GAP + COL_GAP : PAD_X;
  for (const n of linked) pos.get(n.key).x += linkedX;
  const all = [...pos.values()];
  return { pos, freeCount: free.length, linkedCount: linked.length, linkedX,
    width: Math.max(0, ...all.map(p => p.x)) + CARD_W + PAD_X + 40, height: Math.max(0, ...all.map(p => p.y)) + CARD_H + PAD_Y };
}

const curve = (x1, y1, x2, y2) => { const d = Math.max(30, Math.abs(x2 - x1) / 2); return `M${x1},${y1} C${x1 + d},${y1} ${x2 - d},${y2} ${x2},${y2}`; };

export async function view({ params, query }) {
  const projectId = Number(params.id);
  let map = await api(`/projects/${projectId}/dep-map`);
  const f = { resp: query.get('resp') || '', func: query.get('func') || '', type: '', q: '', chain: true, done: false };
  let selected = null, source = null;
  const options = () => ({
    resps: [...new Map(map.nodes.filter(n => n.responsible_id).map(n => [String(n.responsible_id), n.responsible_name])).entries()].sort((a, b) => a[1].localeCompare(b[1], 'pt-BR')),
    funcs: [...new Set(map.nodes.flatMap(n => n.functions))].sort((a, b) => a.localeCompare(b, 'pt-BR')),
  });
  const { resps, funcs } = options();
  return {
    title: `Mapa de vínculos · ${map.project.code}`,
    html: html`${pageHead({ back: { href: `#/projetos/${projectId}`, label: map.project.code }, eyebrow: `${map.project.code} · ${map.project.name}`, title: 'Mapa de vínculos',
        sub: map.can_edit ? 'Arraste o ponto laranja de uma atividade até a próxima para ligar. No celular, toque no ponto e depois na atividade.' : 'As ligações entre as atividades do projeto, da esquerda para a direita.' })}
      <div class="dm-filters section">
        <label class="dm-grow">Responsável<select data-f="resp"><option value="">Todos</option>${resps.map(([id, name]) => html`<option value="${id}" ${f.resp === id ? 'selected' : ''}>${name}</option>`)}</select></label>
        <label class="dm-grow">Função<select data-f="func"><option value="">Todas</option>${funcs.map(x => html`<option value="${x}" ${f.func === x ? 'selected' : ''}>${x}</option>`)}</select></label>
        <label>Tipo<select data-f="type"><option value="">Todos</option><option value="tarefa">Tarefas</option><option value="item">Itens de check-list</option></select></label>
        <label class="dm-grow">Buscar<input type="search" data-f="q" placeholder="Código ou título" autocomplete="off"></label>
        ${map.can_edit ? html`<label class="dm-lag">Folga (dias)<input type="text" inputmode="numeric" id="dm-lag" value="0" aria-label="Folga em dias da próxima ligação"></label>` : ''}
        <label class="dm-check"><input type="checkbox" data-f="chain" checked>Mostrar a cadeia ligada</label>
        <label class="dm-check"><input type="checkbox" data-f="done">Mostrar concluídas</label>
        <div class="dm-zoom" role="group" aria-label="Escala do mapa"><button type="button" class="btn btn-ghost btn-sm" data-dz="-1" aria-label="Diminuir">−</button><span id="dm-zl">100%</span>
          <button type="button" class="btn btn-ghost btn-sm" data-dz="1" aria-label="Aumentar">+</button><button type="button" class="btn btn-ghost btn-sm" data-dz="0" title="Ajustar a escala para ver o mapa inteiro">Ajustar</button></div>
      </div>
      <div class="dm-banner" id="dm-banner" hidden></div>
      <div class="notice dm-info" id="dm-info" hidden></div>
      <div class="dm-canvas" id="dm-canvas"><div class="dm-stage" id="dm-stage"></div></div>`,
    mount(root) {
      const canvas = root.querySelector('#dm-canvas');
      const stage = root.querySelector('#dm-stage');
      const banner = root.querySelector('#dm-banner');
      const info = root.querySelector('#dm-info');
      // Escala do mapa (como no organograma): − / + e "Ajustar" para ver tudo
      const ZK = `dm-zoom-${projectId}`;
      let zoom = 1;
      try { zoom = Number(sessionStorage.getItem(ZK)) || 1; } catch { /* sem armazenamento */ }
      const setZoom = z => {
        zoom = Math.max(0.15, Math.min(1.5, Math.round(z * 100) / 100));
        stage.style.zoom = zoom;
        root.querySelector('#dm-zl').textContent = `${Math.round(zoom * 100)}%`;
        try { sessionStorage.setItem(ZK, String(zoom)); } catch { /* sem armazenamento */ }
      };
      const fit = () => {
        const w = parseFloat(stage.style.width) || 1, h = parseFloat(stage.style.height) || 1;
        setZoom(Math.min(1, (canvas.clientWidth - 16) / w, (canvas.clientHeight - 16) / h));
        canvas.scrollLeft = 0; canvas.scrollTop = 0;
      };
      root.querySelectorAll('[data-dz]').forEach(b => b.addEventListener('click', () => { const dz = Number(b.dataset.dz); if (dz) setZoom(zoom + dz * 0.1); else fit(); }));
      const nodeOf = k => map.nodes.find(n => n.key === k);
      const nameOf = n => `${n.code} · ${n.title}`;

      const links = () => {
        const next = new Map(), prev = new Map();
        for (const e of map.edges) {
          (next.get(e.pred) || next.set(e.pred, []).get(e.pred)).push(e.succ);
          (prev.get(e.succ) || prev.set(e.succ, []).get(e.succ)).push(e.pred);
        }
        return { next, prev };
      };
      const matches = n => {
        if (f.resp && String(n.responsible_id) !== f.resp) return false;
        if (f.func && !n.functions.includes(f.func)) return false;
        if (f.type === 'item' && n.type !== 'item') return false;
        if (f.type === 'tarefa' && n.type === 'item') return false;
        if (f.q && !norm(`${n.code} ${n.title}`).includes(norm(f.q))) return false;
        return f.done || !n.done;
      };

      const draw = () => {
        const { next, prev } = links();
        const hit = new Set(map.nodes.filter(matches).map(n => n.key));
        const filtering = !!(f.resp || f.func || f.q || f.type);
        // Cadeia: o que vem antes e depois das atividades escolhidas (aparece em segundo plano)
        const around = f.chain && filtering ? new Set([...walk(hit, next), ...walk(hit, prev)]) : new Set();
        const shownKeys = new Set([...hit, ...around]);
        if (source) shownKeys.add(source);
        const nodes = map.nodes.filter(n => shownKeys.has(n.key));
        const edges = map.edges.filter(e => shownKeys.has(e.pred) && shownKeys.has(e.succ));
        if (selected && !shownKeys.has(selected)) selected = null;
        const lit = selected ? new Set([...walk([selected], next), ...walk([selected], prev)]) : null;
        const L = layout(nodes, edges);
        stage.style.width = `${L.width}px`;
        stage.style.height = `${Math.max(L.height, 300)}px`;
        const anchor = (k, side) => { const p = L.pos.get(k); return [p.x + (side === 'out' ? CARD_W : 0), p.y + CARD_H / 2]; };
        stage.innerHTML = (nodes.length ? html`
          ${L.freeCount ? html`<div class="dm-coltitle" style="left:${PAD_X}px">Sem vínculo (${L.freeCount})</div>` : ''}
          ${L.linkedCount ? html`<div class="dm-coltitle" style="left:${L.linkedX}px">Sequência →</div>` : ''}
          <svg class="dm-lines" width="${L.width}" height="${Math.max(L.height, 300)}" aria-hidden="true">
            <defs><marker id="dm-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerUnits="userSpaceOnUse" markerWidth="11" markerHeight="11" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#7A8794"/></marker></defs>
            ${edges.map(e => {
              const [x1, y1] = anchor(e.pred, 'out');
              const [x2, y2] = anchor(e.succ, 'in');
              const d = curve(x1, y1, x2, y2);
              const on = lit && lit.has(e.pred) && lit.has(e.succ);
              return html`<path class="dm-edge-hit" d="${d}" data-edge="${e.id}"></path><path class="dm-edge ${on ? 'is-chain' : lit ? 'is-dim' : ''}" d="${d}" marker-end="url(#dm-arrow)"></path>
                ${e.lag_days ? html`<text class="dm-lag-tag" x="${(x1 + x2) / 2}" y="${(y1 + y2) / 2 - 6}" text-anchor="middle">+${e.lag_days}d</text>` : ''}`;
            })}
            <path class="dm-rubber" id="dm-rubber" d="" hidden></path>
          </svg>
          ${nodes.map(n => {
            const p = L.pos.get(n.key);
            const cls = [n.done ? 'is-done' : n.late ? 'is-late' : '', !hit.has(n.key) ? 'is-context' : '', lit && !lit.has(n.key) ? 'is-dim' : '',
              selected === n.key ? 'is-selected' : '', source === n.key ? 'is-source' : ''].filter(Boolean).join(' ');
            const when = n.due_date ? fmtDate(n.due_date).slice(0, 5) : 'sem prazo';
            return html`<div class="dm-node ${cls}" data-node="${n.key}" role="button" tabindex="0" style="left:${p.x}px;top:${p.y}px" title="${TYPE[n.type]} · ${nameOf(n)}">
              <span class="dm-code">${n.code}</span><span class="dm-title">${n.title}</span>
              <span class="dm-meta">${n.responsible_name || 'Sem responsável'} · ${when}</span>
              ${map.can_edit ? html`<button type="button" class="dm-handle" data-handle="${n.key}" aria-label="Ligar ${n.code} à próxima atividade"><i></i></button>` : ''}
            </div>`;
          })}` : html`<div class="dm-empty">Nenhuma atividade com esses filtros.</div>`).toString();
        // Banner da ligação em andamento
        banner.hidden = !source;
        if (source) {
          banner.innerHTML = html`<span>Ligando a partir de <b>${nameOf(nodeOf(source))}</b>. Toque na atividade que vem depois.</span>
            <button type="button" class="btn btn-ghost btn-sm" id="dm-stop">Concluir</button>`.toString();
          banner.querySelector('#dm-stop').addEventListener('click', () => { source = null; draw(); });
        }
        // Até onde vai: a cadeia da atividade selecionada ou das atividades filtradas
        const summary = (keys, head) => {
          const list = [...keys].map(nodeOf);
          const ends = list.map(n => n.due_date).filter(Boolean).sort();
          const people = new Set(list.map(n => n.responsible_name).filter(Boolean));
          return html`${icon('info')}<span>${head}: <b>${plural(list.length, 'atividade', 'atividades')}</b> · <b>${plural(people.size, 'responsável', 'responsáveis')}</b>${ends.length ? html` · vai até <b>${fmtDate(ends.at(-1))}</b>` : ''}${list.some(n => n.late) ? html` · <b>${list.filter(n => n.late).length} atrasada(s)</b>` : ''}</span>`;
        };
        const sel = selected && nodeOf(selected);
        info.hidden = !sel && !(filtering && hit.size);
        if (sel) {
          info.innerHTML = html`${summary(lit, `Cadeia de ${sel.code}`)} <a class="btn btn-ghost btn-sm" href="${sel.link}">Abrir atividade</a>`.toString();
        } else if (filtering && hit.size) {
          const forward = walk(hit, next);
          info.innerHTML = summary(forward, `${plural(hit.size, 'atividade escolhida', 'atividades escolhidas')} e o que vem depois`).toString();
        }
      };

      const link = async (pred, succ) => {
        const lag = root.querySelector('#dm-lag')?.value.trim() || 0;
        try {
          const before = new Map(map.nodes.map(n => [n.key, n.due_date]));
          await api('/dependencies', { method: 'POST', body: { pred, succ, lag_days: lag } });
          map = await api(`/projects/${projectId}/dep-map`);
          // A sucessora não pode começar antes da predecessora terminar: o servidor ajusta as datas; avisa o que mudou
          const moved = map.nodes.filter(n => before.get(n.key) !== n.due_date && n.due_date);
          toast(moved.length ? `Vínculo criado. Prazo ajustado: ${moved.slice(0, 2).map(n => `${n.code} → ${fmtDate(n.due_date)}`).join(', ')}${moved.length > 2 ? ` e mais ${moved.length - 2}` : ''}.` : 'Vínculo criado.', moved.length ? 'warn' : undefined);
          return true;
        } catch (e) { toast(e.message, 'err'); return false; }
      };

      // Tocar num cartão: conclui a ligação em andamento ou mostra a cadeia dele
      stage.addEventListener('click', async e => {
        const edge = e.target.closest?.('[data-edge]');
        if (edge) {
          const d = map.edges.find(x => x.id === Number(edge.dataset.edge));
          const a = nodeOf(d.pred), b = nodeOf(d.succ);
          if (!map.can_edit) return;
          if (await confirmSheet('Remover vínculo', `${a.code} · ${a.title} → ${b.code} · ${b.title}${d.lag_days ? ` (folga de ${d.lag_days} dia(s))` : ''}. As datas não mudam; a remoção fica no histórico.`, 'Remover', true)) {
            try { await api(`/dependencies/${d.id}`, { method: 'DELETE' }); map = await api(`/projects/${projectId}/dep-map`); toast('Vínculo removido.'); draw(); } catch (er) { toast(er.message, 'err'); }
          }
          return;
        }
        if (e.target.closest('[data-handle]')) return;
        const card = e.target.closest('[data-node]');
        if (!card) { if (!source && selected) { selected = null; draw(); } return; }
        const key = card.dataset.node;
        if (source) {
          if (key === source) { source = null; draw(); return; }
          if (await link(source, key)) source = key; // segue encadeando a partir da atividade de destino
          draw();
          return;
        }
        selected = selected === key ? null : key;
        draw();
      });
      stage.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.matches?.('[data-node]')) e.target.click(); });

      // Ponto laranja: arrastar liga direto; tocar sem arrastar inicia a ligação por toque
      stage.addEventListener('pointerdown', e => {
        const h = e.target.closest('[data-handle]');
        if (!h) return;
        e.preventDefault();
        const from = h.dataset.handle;
        const rubber = stage.querySelector('#dm-rubber');
        const box = h.closest('[data-node]');
        const x1 = box.offsetLeft + CARD_W, y1 = box.offsetTop + CARD_H / 2;
        const sx = e.clientX, sy = e.clientY;
        let moved = false, over = null, raf = 0, last = e;
        const stagePoint = ev => { const r = stage.getBoundingClientRect(); return [(ev.clientX - r.left) / zoom, (ev.clientY - r.top) / zoom]; };
        const setOver = el => { if (over === el) return; over?.classList.remove('is-target'); over = el; over?.classList.add('is-target'); };
        const autoScroll = () => {
          const r = canvas.getBoundingClientRect();
          const edge = 40, speed = 12;
          if (last.clientX > r.right - edge) canvas.scrollLeft += speed; else if (last.clientX < r.left + edge) canvas.scrollLeft -= speed;
          if (last.clientY > r.bottom - edge) canvas.scrollTop += speed; else if (last.clientY < r.top + edge) canvas.scrollTop -= speed;
          if (moved) { const [x, y] = stagePoint(last); rubber.setAttribute('d', curve(x1, y1, x, y)); }
          raf = requestAnimationFrame(autoScroll);
        };
        const move = ev => {
          last = ev;
          if (!moved && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 8) return;
          if (!moved) { moved = true; rubber.removeAttribute('hidden'); raf = requestAnimationFrame(autoScroll); }
          const el = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('[data-node]');
          setOver(el && el.dataset.node !== from ? el : null);
        };
        const end = async ev => {
          document.removeEventListener('pointermove', move);
          document.removeEventListener('pointerup', end);
          document.removeEventListener('pointercancel', end);
          cancelAnimationFrame(raf);
          rubber.setAttribute('hidden', '');
          const target = over?.dataset.node;
          setOver(null);
          if (!moved) { source = source === from ? null : from; selected = null; draw(); return; }
          if (ev.type === 'pointerup' && target && await link(from, target)) { source = null; selected = target; }
          draw();
        };
        document.addEventListener('pointermove', move);
        document.addEventListener('pointerup', end);
        document.addEventListener('pointercancel', end);
      });

      root.querySelectorAll('[data-f]').forEach(el => el.addEventListener(el.type === 'search' ? 'input' : 'change', () => {
        f[el.dataset.f] = el.type === 'checkbox' ? el.checked : el.value;
        selected = null;
        draw();
      }));
      const onKey = e => { if (e.key === 'Escape' && (source || selected)) { source = null; selected = null; draw(); } };
      document.addEventListener('keydown', onKey);
      window.addEventListener('hashchange', function off() { document.removeEventListener('keydown', onKey); window.removeEventListener('hashchange', off); });
      draw();
      setZoom(zoom);
    },
  };
}
