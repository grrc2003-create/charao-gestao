// Avisos de preenchimento obrigatório e de ações bloqueadas, válidos para todas as telas:
// 1) ao enviar um formulário com campo obrigatório vazio: destaca o campo, avisa quais faltam e não envia;
// 2) botão de ação bloqueado (aria-disabled) explica o motivo ao ser tocado;
// 3) erro devolvido pelo servidor num formulário também aparece como aviso e a tela rola até ele.
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
