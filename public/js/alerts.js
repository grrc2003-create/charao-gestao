// Charão, o mascote dos avisos: fica no canto da tela, reage quando chega aviso novo e abre o painel de avisos.
// Estados: espera (padrão, em repetição) · parabens (sucesso) · atencao (alertas) · insatisfacao (reprovação/atraso).
// Cada reação toca uma vez e volta à espera. Com "reduzir movimento" no aparelho, usa as poses paradas.
import { api, html, icon, fmtDateTime } from './core.js';
import { toast } from './ui.js';

const BASE = '/assets/mascote/';
const STATES = { espera: 2400, parabens: 1600, atencao: 1600, insatisfacao: 1600 };
const reduced = matchMedia('(prefers-reduced-motion: reduce)');
const HIDE_KEY = 'charao-hidden-until';

let timer = null, playTimer = null, bubbleTimer = null;
let known = null;          // ids de avisos já vistos nesta sessão (para reagir só aos novos)
let list = [];
let playId = 0;
let alertBusyUntil = 0;     // reação a aviso novo tem prioridade sobre a reação à tela
const lastMood = new Map(); // última reação por tela (só reage quando o resultado muda)

const store = { get: k => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* sem armazenamento */ } } };

function play(state) {
  const img = document.querySelector('#charao .ch-img');
  if (!img || !STATES[state]) return;
  clearTimeout(playTimer);
  img.src = reduced.matches ? `${BASE}${state}.png` : `${BASE}${state}.webp?p=${++playId}`;
  if (state !== 'espera') playTimer = setTimeout(() => play('espera'), STATES[state] + 200);
}

function bubble(text) {
  const b = document.querySelector('#charao .ch-bubble');
  if (!b) return;
  b.textContent = text;
  b.hidden = false;
  clearTimeout(bubbleTimer);
  bubbleTimer = setTimeout(() => { b.hidden = true; }, 6000);
}

const item = a => html`<div class="al-item al-${a.tone}" data-alert="${a.id}">
  <span class="al-ic" aria-hidden="true">${icon(a.tone === 'parabens' ? 'check' : 'alert')}</span>
  <div class="al-main">
    <div class="al-head"><span class="al-kind">${a.kind_label}</span><small class="muted">${a.sender_name} · ${fmtDateTime(a.created_at)}</small></div>
    <div class="al-task" title="${a.code} · ${a.title}${a.project_name ? ` · ${a.project_name}` : ''}"><span class="mono">${a.code}</span> ${a.title}${a.project_name ? html`<span class="muted"> · ${a.project_name}</span>` : ''}</div>
    ${a.note ? html`<div class="al-note" title="${a.note}">${a.kind === 'ressalvas' ? html`<i>Ressalvas</i> ` : ''}${a.note}</div>` : ''}
  </div>
  <div class="al-acts">
    ${a.can_open ? html`<a class="btn btn-ghost btn-sm" href="#/tarefas/${a.task_id}" data-open-task>Abrir</a>` : ''}
    <button type="button" class="btn btn-primary btn-sm" data-seen="${a.id}">${icon('check')}Ciente</button>
  </div>
</div>`;

function drawPanel() {
  const root = document.getElementById('charao');
  if (!root) return;
  const n = list.length;
  root.classList.toggle('ch-idle', !n);
  const badge = root.querySelector('.ch-badge');
  badge.hidden = !n;
  badge.textContent = n > 9 ? '9+' : String(n);
  root.querySelector('.ch-btn').setAttribute('aria-label', n ? `Charão: ${n} aviso(s). Abrir avisos` : 'Charão: nenhum aviso. Abrir avisos');
  root.querySelector('.ch-list').innerHTML = (n ? html`${list.map(item)}`
    : html`<div class="ch-empty">Tudo em dia por aqui. Quando chegar um aviso de tarefa, eu te chamo.</div>`).toString();
  root.querySelector('[data-seen-all]').hidden = n < 2;
  root.querySelector('.ch-count').textContent = n ? `${n} aviso(s)` : 'sem avisos';
}

function setOpen(open) {
  const root = document.getElementById('charao');
  if (!root) return;
  root.querySelector('.ch-panel').hidden = !open;
  root.querySelector('.ch-btn').setAttribute('aria-expanded', open ? 'true' : 'false');
  if (open) root.querySelector('.ch-bubble').hidden = true;
}

export async function refreshAlerts() {
  const root = document.getElementById('charao');
  if (!root) return;
  let data;
  try { data = await api('/alerts'); } catch { return; }
  const fresh = data.filter(a => !known?.has(a.id) || known === null);
  const first = known === null;
  known = new Set(data.map(a => a.id));
  list = data;
  drawPanel();
  // Escondido pela pessoa: volta a aparecer quando chega aviso mais novo que o último escondido
  const hiddenUntil = Number(store.get(HIDE_KEY) || 0);
  const newest = data.reduce((m, a) => Math.max(m, a.id), 0);
  root.hidden = !!hiddenUntil && newest <= hiddenUntil;
  // Reage ao aviso novo mais recente (ou, ao entrar no sistema, ao mais recente pendente)
  const react = first ? data[0] : fresh[0];
  if (react && !root.hidden) {
    alertBusyUntil = Date.now() + 6500;
    play(react.tone);
    bubble(fresh.length > 1 || (first && data.length > 1) ? `${first ? data.length : fresh.length} avisos novos` : `${react.kind_label} · ${react.code}`);
  }
}

// Reação à tela aberta e aos filtros (pode ser desligada em Minha conta). Mesmo resultado na mesma tela não repete.
export function screenMood(m, key, enabled = true) {
  if (!enabled || !m) return;
  const sig = `${m.tone}|${m.text}`;
  if (lastMood.get(key) === sig) return;
  lastMood.set(key, sig);
  const root = document.getElementById('charao');
  if (!root || root.hidden || !root.querySelector('.ch-panel')?.hidden) return;
  if (Date.now() < alertBusyUntil) return;
  if (m.tone !== 'espera') play(m.tone);
  bubble(m.text);
}

// Chamado ao montar o layout: liga o mascote e atualiza a cada minuto (e ao voltar para a aba)
export function startAlerts() {
  const root = document.getElementById('charao');
  if (!root) return;
  known = null;
  root.innerHTML = html`
    <div class="ch-panel" hidden role="dialog" aria-label="Avisos do Charão">
      <header class="ch-head"><img src="${BASE}espera.png" alt="" width="34" height="34"><div><b>Charão</b><small class="ch-count muted"></small></div>
        <button type="button" class="btn btn-ghost btn-sm" data-seen-all hidden>${icon('check')}Ciente em todos</button>
        <button type="button" class="icon-btn" data-ch-close aria-label="Fechar avisos">✕</button></header>
      <div class="ch-list"></div>
      <button type="button" class="ch-hide" data-ch-hide>Esconder o Charão até o próximo aviso</button>
    </div>
    <div class="ch-bubble" hidden aria-live="polite"></div>
    <button type="button" class="ch-btn" aria-haspopup="dialog" aria-expanded="false"><img class="ch-img" src="${BASE}${reduced.matches ? 'espera.png' : 'espera.webp'}" alt="" width="192" height="192"><span class="ch-badge" hidden></span></button>`.toString();
  root.addEventListener('click', async e => {
    if (e.target.closest('.ch-btn') || e.target.closest('.ch-bubble')) return setOpen(root.querySelector('.ch-panel').hidden);
    if (e.target.closest('[data-ch-close]') || e.target.closest('[data-open-task]')) return setOpen(false);
    if (e.target.closest('[data-ch-hide]')) {
      store.set(HIDE_KEY, String(list.reduce((m, a) => Math.max(m, a.id), 0) || 1));
      setOpen(false);
      root.hidden = true;
      return toast('Charão escondido. Ele volta quando chegar um aviso novo.');
    }
    const all = e.target.closest('[data-seen-all]');
    const b = e.target.closest('[data-seen]');
    if (!all && !b) return;
    (all || b).disabled = true;
    try {
      if (all) await api('/alerts/seen-all', { method: 'POST' });
      else await api(`/alerts/${b.dataset.seen}/seen`, { method: 'POST' });
      const had = list.length;
      list = all ? [] : list.filter(a => String(a.id) !== b.dataset.seen);
      drawPanel();
      if (had && !list.length) { play('parabens'); bubble('Tudo em dia!'); setOpen(false); }
    } catch (ex) { (all || b).disabled = false; toast(ex.message, 'err'); }
  });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') setOpen(false); });
  document.addEventListener('click', e => { if (!e.target.closest('#charao')) setOpen(false); });
  reduced.addEventListener?.('change', () => play('espera'));
  refreshAlerts();
  clearInterval(timer);
  timer = setInterval(() => { if (!document.hidden) refreshAlerts(); }, 60000);
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshAlerts(); });
