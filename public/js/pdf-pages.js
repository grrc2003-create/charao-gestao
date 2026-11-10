// Comprovantes em PDF dentro dos recibos: cada página do PDF vira uma imagem na página de impressão.
// Usa o pdf.js (Mozilla, Apache-2.0) servido pelo próprio sistema em /js/vendor/pdfjs (nada externo).
// Marcação: <div data-pdf-pages="/api/...arquivo"></div> — as imagens entram nesse lugar.
// Opcional: data-pdf-max (páginas; padrão 10) e data-pdf-label (legenda em cada página, ex.: "Anexo 03 · proposta.pdf").
let loading = null;
function loadPdfJs() {
  if (globalThis.pdfjsLib) return Promise.resolve(globalThis.pdfjsLib);
  loading ||= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = '/js/vendor/pdfjs/pdf.min.js';
    s.onload = () => {
      const lib = globalThis.pdfjsLib;
      if (!lib) return reject(new Error('Leitor de PDF indisponível.'));
      lib.GlobalWorkerOptions.workerSrc = '/js/vendor/pdfjs/pdf.worker.min.js';
      resolve(lib);
    };
    s.onerror = () => { loading = null; reject(new Error('Não foi possível carregar o leitor de PDF.')); };
    document.head.appendChild(s);
  });
  return loading;
}

async function renderInto(box, lib) {
  const url = box.dataset.pdfPages;
  try {
    const data = await fetch(url, { credentials: 'same-origin' }).then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.arrayBuffer(); });
    const pdf = await lib.getDocument({ data, isEvalSupported: false }).promise;
    const max = Math.min(pdf.numPages, Number(box.dataset.pdfMax) || 10);
    const label = box.dataset.pdfLabel || '';
    box.innerHTML = '';
    for (let n = 1; n <= max; n++) {
      const page = await pdf.getPage(n);
      const vp = page.getViewport({ scale: 2 });
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(vp.width); canvas.height = Math.ceil(vp.height);
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
      // intent "print": desenha direto (sem esperar a animação da tela, que pode ficar parada) e com qualidade de impressão
      const task = page.render({ canvasContext: ctx, viewport: vp, intent: 'print' });
      await Promise.race([task.promise, new Promise((_, rej) => setTimeout(() => { task.cancel(); rej(new Error('tempo esgotado')); }, 20000))]);
      const img = document.createElement('img');
      img.src = canvas.toDataURL('image/png');
      img.alt = `${label || 'Comprovante (PDF)'} — página ${n}`;
      if (label) {
        const fig = document.createElement('figure');
        fig.className = 'pdf-pg';
        const cap = document.createElement('figcaption');
        cap.textContent = `${label} · página ${n} de ${pdf.numPages}`;
        fig.append(img, cap);
        box.appendChild(fig);
      } else box.appendChild(img);
    }
    if (pdf.numPages > max) box.insertAdjacentHTML('beforeend', `<p class="muted">Mostrando ${max} de ${pdf.numPages} páginas do PDF.</p>`);
    box.classList.add('is-ready');
  } catch (ex) {
    box.classList.add('is-error');
    box.textContent = `Não foi possível mostrar este PDF aqui (${ex.message}). Envie o arquivo junto.`;
  }
}

// Desenha todos os PDFs marcados dentro de root; devolve uma promessa (a impressão espera terminar)
export async function renderPdfPages(root) {
  const boxes = [...root.querySelectorAll('[data-pdf-pages]:not(.is-ready)')];
  if (!boxes.length) return;
  let lib;
  try { lib = await loadPdfJs(); } catch (ex) { boxes.forEach(b => { b.classList.add('is-error'); b.textContent = `${ex.message} Envie o arquivo junto.`; }); return; }
  for (const b of boxes) await renderInto(b, lib);
}
