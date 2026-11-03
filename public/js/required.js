// Avisos de preenchimento obrigatório e de ações bloqueadas, válidos para todas as telas:
// 1) ao enviar um formulário com campo obrigatório vazio: destaca o campo, avisa quais faltam e não envia;
// 2) botão de ação bloqueado (aria-disabled) explica o motivo ao ser tocado;
// 3) erro devolvido pelo servidor num formulário também aparece como aviso e a tela rola até ele;
// 4) passar o mouse (ou chegar pelo teclado) num botão bloqueado abre uma janela com o motivo;
// 5) o mesmo vale para um número com a conta dele (data-calc); no toque, tocar no número abre a janela;
// 6) e para a pizza de quanto cada usuário contribui em um número (data-pie).
import { toast } from './ui.js';

const labelOf = el => {
  const lb = el.id ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`) : el.closest('label');
  return (lb?.textContent || el.getAttribute('aria-label') || el.placeholder || el.name || 'campo').replace(/\*/g, '').replace(/\s+/g, ' ').trim();
};
const isEmpty = el => (el.type === 'checkbox' || el.type === 'radio'
  ? !(el.name && el.form ? el.form.querySelector(`[name="${CSS.escape(el.name)}"]:checked`) : el.checked)
  : !String(el.value ?? '').trim());

document.addEventListener('submit', e => {
  const f = e.target;
  const missing = [...f.querySelectorAll('[required]')].filter(el => !el.disabled && !el.closest('[hidden]') && isEmpty(el));
  if (!missing.length) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  missing.forEach(el => el.classList.add('is-invalid'));
  const names = [...new Set(missing.map(labelOf))];
  toast(`Preencha ${names.length > 1 ? 'os campos obrigatórios' : 'o campo obrigatório'}: ${names.join(', ')}.`, 'warn');
  missing[0].scrollIntoView({ block: 'center', behavior: 'smooth' });
  setTimeout(() => missing[0].focus({ preventScroll: true }), 250);
}, true);

const clear = e => e.target.classList?.remove('is-invalid');
document.addEventListener('input', clear, true);
document.addEventListener('change', clear, true);

document.addEventListener('click', e => {
  const b = e.target.closest?.('[aria-disabled="true"]');
  if (!b) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  const why = b.dataset.why || b.title;
  toast(why || 'Ação indisponível no momento.', 'warn');
}, true);

const BLOCKED = '[aria-disabled="true"]';
const WITH_TIP = `${BLOCKED}, [data-calc], [data-pie]`;
const ON_TAP = '[data-calc], [data-pie]';
// Cores validadas para o fundo escuro da janela; "Outros" fica neutro
const PIE_COLORS = ['#3987e5', '#d95926', '#199e70'], PIE_OTHER = '#6E7A86';
const SVG_NS = 'http://www.w3.org/2000/svg';
function fillPie(box, { title, by }) {
  const total = by.reduce((n, u) => n + u.n, 0);
  const color = (u, i) => (u.other ? PIE_OTHER : PIE_COLORS[i]);
  const head = document.createElement('div');
  head.className = 'pie-title';
  head.textContent = title;
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '-50 -50 100 100');
  svg.setAttribute('aria-hidden', 'true');
  let at = -Math.PI / 2;
  by.forEach((u, i) => {
    const end = at + (u.n / total) * 2 * Math.PI;
    const p = document.createElementNS(SVG_NS, 'path');
    const pt = a => `${(48 * Math.cos(a)).toFixed(2)} ${(48 * Math.sin(a)).toFixed(2)}`;
    p.setAttribute('d', `M0 0L${pt(at)}A48 48 0 ${end - at > Math.PI ? 1 : 0} 1 ${pt(end)}Z`);
    p.setAttribute('fill', color(u, i));
    svg.appendChild(p);
    at = end;
  });
  const list = document.createElement('ul');
  by.forEach((u, i) => {
    const li = document.createElement('li');
    const sw = document.createElement('i');
    sw.style.background = color(u, i);
    const name = document.createElement('span');
    name.textContent = u.name;
    const val = document.createElement('b');
    val.textContent = `${u.n} · ${Math.round((u.n / total) * 100)}%`;
    li.append(sw, name, val);
    list.appendChild(li);
  });
  const body = document.createElement('div');
  body.className = 'pie-body';
  body.append(svg, list);
  box.append(head, body);
}
let tip = null, tipFor = null, tipWatch = null;
function hideTip() {
  clearInterval(tipWatch);
  tipFor?.removeAttribute('aria-describedby');
  tip?.remove();
  tip = tipFor = null;
}
function showTip(el) {
  if (el === tipFor) return;
  hideTip();
  // O motivo em title viraria uma segunda janela, a do navegador
  if (el.title) { el.dataset.why ||= el.title; el.removeAttribute('title'); }
  tip = document.createElement('div');
  tip.className = el.dataset.pie ? 'why-tip is-pie' : el.dataset.calc ? 'why-tip is-calc' : 'why-tip';
  tip.id = 'why-tip';
  tip.setAttribute('role', 'tooltip');
  if (el.dataset.pie) fillPie(tip, JSON.parse(el.dataset.pie));
  else tip.textContent = el.dataset.calc || el.dataset.why || 'Ação indisponível no momento.';
  document.body.appendChild(tip);
  tipFor = el;
  el.setAttribute('aria-describedby', tip.id);
  // Acima do botão, ou abaixo se não couber; sempre dentro da tela
  const b = el.getBoundingClientRect(), t = tip.getBoundingClientRect(), edge = 12, gap = 8;
  tip.style.left = `${Math.max(edge, Math.min(b.left + b.width / 2 - t.width / 2, innerWidth - t.width - edge))}px`;
  tip.style.top = `${b.top - t.height - gap >= edge ? b.top - t.height - gap : b.bottom + gap}px`;
  // A tela pode redesenhar com o mouse parado sobre o botão
  tipWatch = setInterval(() => { if (!el.isConnected || !el.matches(WITH_TIP)) hideTip(); }, 250);
}
document.addEventListener('pointerover', e => {
  if (e.pointerType !== 'mouse') return; // no toque, a janela e o aviso abrem ao tocar
  const b = e.target.closest?.(WITH_TIP);
  if (b) showTip(b); else hideTip();
});
// No toque, o número fica dentro de um link: tocar nele abre a conta em vez de sair da tela
let lastPointer = 'mouse';
document.addEventListener('pointerdown', e => {
  lastPointer = e.pointerType;
  if (lastPointer !== 'mouse' && !e.target.closest?.(ON_TAP)) hideTip();
}, true);
document.addEventListener('click', e => {
  const c = lastPointer !== 'mouse' && e.target.closest?.(ON_TAP);
  if (!c) return;
  // Pizza em um link: o primeiro toque mostra, o segundo abre a lista
  if (c === tipFor && c.dataset.pie && c.matches('a')) { hideTip(); return; }
  e.preventDefault();
  e.stopImmediatePropagation();
  if (c === tipFor) hideTip(); else showTip(c);
}, true);
document.addEventListener('focusin', e => { const b = e.target.closest?.(BLOCKED); if (b && b.matches(':focus-visible')) showTip(b); });
document.addEventListener('focusout', hideTip);
document.addEventListener('keydown', e => { if (e.key === 'Escape') hideTip(); });
addEventListener('scroll', hideTip, true);
addEventListener('resize', hideTip);
// Ao mudar de tela, nenhuma janela fica para trás (a dica dos gráficos também: a barra pode ser um link)
addEventListener('hashchange', () => { hideTip(); document.querySelectorAll('.chart-tip').forEach(x => x.remove()); });

new MutationObserver(records => {
  const seen = new Set();
  for (const r of records) {
    const el = r.target;
    if (seen.has(el) || !el.classList?.contains('form-error') || el.hidden) continue;
    seen.add(el);
    const msg = el.textContent.trim();
    if (!msg) continue;
    toast(msg, 'err');
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
}).observe(document.documentElement, { subtree: true, attributes: true, attributeFilter: ['hidden'] });
