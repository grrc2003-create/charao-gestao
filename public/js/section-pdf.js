// PDF de um visual só: botão "PDF" no cabeçalho de cada quadro (card). Imprime apenas aquele quadro, com cabeçalho
// (logo, contexto — ex.: projeto —, nome do quadro, data/hora). Quadros recolhidos (Gantt, Calendário) são abertos e
// carregados antes; quadros largos saem em paisagem e reduzidos para caber na página.
import { html, icon } from './core.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const now = () => new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date());

async function waitLoaded(card) {
  for (let i = 0; i < 50; i++) {
    const body = card.querySelector('.card-body, [data-cal-body]');
    const loading = body && /Carregando/i.test(body.textContent || '') && body.textContent.trim().length < 40;
    if (!loading) return;
    await sleep(120);
  }
}

async function printCard(card, ctx) {
  if (card.tagName === 'DETAILS' && !card.open) { card.open = true; card.dispatchEvent(new Event('toggle')); await sleep(150); }
  await waitLoaded(card);
  card.querySelectorAll('details').forEach(d => { d.open = true; });
  await sleep(60);
  const head = card.querySelector('.card-head');
  const title = head?.querySelector('h2')?.textContent.trim() || 'Quadro';
  const wide = card.matches('.gantt-sec') || card.scrollWidth > 1100 || [...card.querySelectorAll('.table-wrap, .gantt, .fy-wrap')].some(el => el.scrollWidth > 1000);
  const width = Math.max(card.scrollWidth, ...[...card.querySelectorAll('.table-wrap, .gantt, .fy-wrap, table, svg')].map(el => el.scrollWidth || 0));
  const pageW = wide ? 1040 : 700;
  const scale = width > pageW ? Math.max(0.45, pageW / width) : 1;
  const clone = card.cloneNode(true);
  clone.querySelectorAll('.sec-pdf, .no-print').forEach(el => el.remove());
  if (clone.tagName === 'DETAILS') clone.open = true;
  clone.querySelectorAll('details').forEach(d => { d.open = true; });
  document.getElementById('print-one')?.remove();
  const box = document.createElement('div');
  box.id = 'print-one';
  if (wide) box.classList.add('is-land');
  box.innerHTML = html`<header class="po-head"><img src="/assets/logo.webp" alt="Charão Engenharia & Construção" class="po-logo">
    <div class="po-t"><b>${title}</b><span>${ctx.title || ''}${ctx.sub ? ` · ${ctx.sub}` : ''}</span></div><small class="po-d">Gerado em ${now()}</small></header>`.toString();
  const wrap = document.createElement('div');
  wrap.className = 'po-body';
  if (scale < 1) { wrap.style.zoom = String(scale); }
  wrap.appendChild(clone);
  box.appendChild(wrap);
  document.body.appendChild(box);
  document.body.classList.add('print-one');
  const prevTitle = document.title;
  document.title = `${title}${ctx.title ? ` - ${ctx.title}` : ''}`;
  const done = () => { document.body.classList.remove('print-one'); box.remove(); document.title = prevTitle; window.removeEventListener('afterprint', done); window.removeEventListener('hashchange', done); };
  // Limpa depois de imprimir (ou ao sair da tela — no iPhone a impressão não bloqueia a página)
  window.addEventListener('afterprint', done);
  window.addEventListener('hashchange', done);
  await Promise.race([Promise.all([...box.querySelectorAll('img')].map(i => (i.complete ? 1 : new Promise(r => { i.onload = i.onerror = r; })))), sleep(1500)]);
  window.print();
}

// Coloca o botão "PDF" em todos os quadros (card com cabeçalho) dentro de root
export function addPdfButtons(root, ctx = {}) {
  root.querySelectorAll('.card').forEach(card => {
    const head = [...card.children].find(el => el.classList?.contains('card-head'));
    if (!head || head.querySelector('.sec-pdf')) return;
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'sec-pdf no-print';
    b.title = 'Gerar PDF só deste quadro';
    b.setAttribute('aria-label', `Gerar PDF: ${head.querySelector('h2')?.textContent.trim() || 'quadro'}`);
    b.innerHTML = `${icon('print')}<span>PDF</span>`;
    b.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); printCard(card, ctx); });
    head.appendChild(b);
  });
}
