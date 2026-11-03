// Avisos de preenchimento obrigatório e de ações bloqueadas, válidos para todas as telas:
// 1) ao enviar um formulário com campo obrigatório vazio: destaca o campo, avisa quais faltam e não envia;
// 2) botão de ação bloqueado (aria-disabled) explica o motivo ao ser tocado;
// 3) erro devolvido pelo servidor num formulário também aparece como aviso e a tela rola até ele;
// 4) passar o mouse (ou chegar pelo teclado) num botão bloqueado abre uma janela com o motivo.
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
  tip.className = 'why-tip';
  tip.id = 'why-tip';
  tip.setAttribute('role', 'tooltip');
  tip.textContent = el.dataset.why || 'Ação indisponível no momento.';
  document.body.appendChild(tip);
  tipFor = el;
  el.setAttribute('aria-describedby', tip.id);
  // Acima do botão, ou abaixo se não couber; sempre dentro da tela
  const b = el.getBoundingClientRect(), t = tip.getBoundingClientRect(), edge = 12, gap = 8;
  tip.style.left = `${Math.max(edge, Math.min(b.left + b.width / 2 - t.width / 2, innerWidth - t.width - edge))}px`;
  tip.style.top = `${b.top - t.height - gap >= edge ? b.top - t.height - gap : b.bottom + gap}px`;
  // A tela pode redesenhar com o mouse parado sobre o botão
  tipWatch = setInterval(() => { if (!el.isConnected || !el.matches(BLOCKED)) hideTip(); }, 250);
}
document.addEventListener('pointerover', e => {
  if (e.pointerType !== 'mouse') return; // no toque, o motivo aparece ao tocar (aviso acima)
  const b = e.target.closest?.(BLOCKED);
  if (b) showTip(b); else hideTip();
});
document.addEventListener('focusin', e => { const b = e.target.closest?.(BLOCKED); if (b && b.matches(':focus-visible')) showTip(b); });
document.addEventListener('focusout', hideTip);
document.addEventListener('keydown', e => { if (e.key === 'Escape') hideTip(); });
addEventListener('scroll', hideTip, true);
addEventListener('resize', hideTip);
addEventListener('hashchange', hideTip);

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
