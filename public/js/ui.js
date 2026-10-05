// Componentes de interface: toast, modal/bottom-sheet, confirmação, leitura de imagens.
import { html, esc } from './core.js';

export function toast(msg, type = 'ok') {
  let host = document.getElementById('toasts');
  if (!host) {
    host = document.createElement('div');
    host.id = 'toasts';
    host.setAttribute('role', 'status');
    host.setAttribute('aria-live', 'polite');
    document.body.appendChild(host);
  }
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.textContent = msg;
  host.appendChild(el);
  setTimeout(() => el.classList.add('out'), 3200);
  setTimeout(() => el.remove(), 3700);
}

// Modal que vira bottom-sheet no celular. Retorna Promise com o valor do submit (ou null).
export function sheet({ title, body, submitLabel = 'Salvar', danger = false, onSubmit, wide = false }) {
  return new Promise(resolve => {
    const wrap = document.createElement('div');
    wrap.className = 'sheet-backdrop';
    wrap.innerHTML = html`<div class="sheet ${wide ? 'sheet-wide' : ''}" role="dialog" aria-modal="true" aria-labelledby="sheet-title">
      <div class="sheet-grip" aria-hidden="true"></div>
      <header class="sheet-head"><h2 id="sheet-title">${title}</h2>
        <button type="button" class="icon-btn" data-close aria-label="Fechar">✕</button></header>
      <form class="sheet-body" novalidate>${body}
        <div class="form-error" hidden></div>
        <div class="sheet-actions">
          <button type="button" class="btn btn-ghost" data-close>Cancelar</button>
          <button type="submit" class="btn ${danger ? 'btn-danger' : 'btn-primary'}">${submitLabel}</button>
        </div>
      </form></div>`.toString();
    document.body.appendChild(wrap);
    document.body.classList.add('no-scroll');
    const form = wrap.querySelector('form');
    const err = wrap.querySelector('.form-error');
    const close = val => {
      wrap.classList.add('closing');
      document.body.classList.remove('no-scroll');
      setTimeout(() => wrap.remove(), 180);
      resolve(val);
    };
    wrap.addEventListener('click', e => { if (e.target === wrap || e.target.closest('[data-close]')) close(null); });
    wrap.addEventListener('keydown', e => { if (e.key === 'Escape') close(null); });
    form.addEventListener('submit', async e => {
      e.preventDefault();
      const btn = form.querySelector('[type=submit]');
      const data = Object.fromEntries(new FormData(form));
      btn.disabled = true;
      err.hidden = true;
      try {
        const r = onSubmit ? await onSubmit(data, form) : data;
        close(r ?? data);
      } catch (ex) {
        err.textContent = ex.message;
        err.hidden = false;
        btn.disabled = false;
      }
    });
    setTimeout(() => (form.querySelector('textarea, input:not([type=hidden]), select') || form.querySelector('button')).focus(), 50);
  });
}

export const confirmSheet = (title, message, label = 'Confirmar', danger = false) =>
  sheet({ title, body: html`<p class="muted">${message}</p>`, submitLabel: label, danger }).then(r => r !== null);

// Redimensiona fotos no aparelho antes do envio (economiza dados em campo)
export function readImages(files, max = 1600, quality = 0.82) {
  return Promise.all([...files].slice(0, 10).map(file => new Promise((resolve, reject) => {
    if (!/^image\/(jpeg|png|webp|heic|heif)$/i.test(file.type) && !/\.(jpe?g|png|webp)$/i.test(file.name)) {
      return reject(new Error(`Arquivo não suportado: ${file.name}`));
    }
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const scale = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * scale);
      c.height = Math.round(img.height * scale);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      resolve({ data: c.toDataURL('image/jpeg', quality), name: file.name });
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error(`Não foi possível ler ${file.name}`)); };
    img.src = url;
  })));
}

export function pickImages({ capture = false, multiple = true } = {}) {
  return new Promise(resolve => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.multiple = multiple;
    if (capture) input.capture = 'environment';
    input.onchange = () => resolve(input.files?.length ? input.files : null);
    input.click();
  });
}

export function lightbox(src, caption) {
  const wrap = document.createElement('div');
  wrap.className = 'lightbox';
  wrap.innerHTML = `<figure><img src="${esc(src)}" alt="${esc(caption || 'Imagem')}"><figcaption>${esc(caption || '')}</figcaption></figure><button class="icon-btn" aria-label="Fechar">✕</button>`;
  wrap.addEventListener('click', () => wrap.remove());
  document.body.appendChild(wrap);
}
