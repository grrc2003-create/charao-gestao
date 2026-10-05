// Barra de ferramentas e utilidades comuns aos documentos de impressão.
import { html, icon } from '../core.js';
import { toast } from '../ui.js';

export const printToolbar = ({ back, title, extra }) => html`<div class="print-toolbar no-print">
  <a class="btn btn-ghost btn-sm" href="${back}">${icon('back')}Voltar</a>
  <div class="pt-title">${title}</div>
  <div class="pt-actions">${extra || ''}<button type="button" class="btn btn-primary btn-sm" id="do-print">${icon('print')}Imprimir / Salvar PDF</button></div>
</div>`;

async function imagesReady(root) {
  const imgs = [...root.querySelectorAll('img')];
  await Promise.all(imgs.map(img => (img.complete ? null : new Promise(r => { img.onload = img.onerror = r; }))));
}

export function bindPrintToolbar(root) {
  root.querySelector('#do-print').addEventListener('click', async () => {
    toast('Preparando documento…', 'warn');
    await imagesReady(root);
    window.print();
  });
}

// Rodapé em todas as páginas (margem da página A4) com texto dinâmico
export function setPageFooter(text) {
  let st = document.getElementById('page-footer-style');
  if (!st) {
    st = document.createElement('style');
    st.id = 'page-footer-style';
    document.head.appendChild(st);
  }
  const safe = text.replace(/["\\\n\r]/g, ' ');
  st.textContent = `@page { @bottom-left { content: "${safe}"; } }`;
}
