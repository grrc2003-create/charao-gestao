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

// O PDF tem largura menor que a tela e ativaria o layout de celular (ex.: semana empilhada). Para sair igual à tela,
// copia o layout calculado de cada elemento (exibição, grade, flex, posição e largura) para o clone.
const FREEZE = ['display', 'position', 'top', 'left', 'right', 'bottom', 'width', 'min-width', 'max-width', 'grid-template-columns', 'grid-template-rows',
  'grid-column-start', 'grid-column-end', 'grid-row-start', 'grid-row-end', 'grid-auto-flow', 'flex-direction', 'flex-wrap', 'flex-grow', 'flex-shrink', 'flex-basis',
  'row-gap', 'column-gap', 'align-items', 'justify-content', 'order', 'font-size', 'white-space', 'overflow-x', 'overflow-y', 'padding-left', 'padding-right'];
function freezeLayout(src, dst) {
  const a = [src, ...src.querySelectorAll('*')], b = [dst, ...dst.querySelectorAll('*')];
  if (a.length !== b.length) return;
  a.forEach((el, i) => {
    if (el instanceof SVGElement && el.tagName.toLowerCase() !== 'svg') return;
    const cs = getComputedStyle(el), st = b[i].style;
    FREEZE.forEach(k => st.setProperty(k, cs.getPropertyValue(k)));
  });
  dst.style.width = `${src.getBoundingClientRect().width}px`;
}

async function printCard(card, ctx) {
  if (card.tagName === 'DETAILS' && !card.open) { card.open = true; card.dispatchEvent(new Event('toggle')); await sleep(150); }
  await waitLoaded(card);
  card.querySelectorAll('details').forEach(d => { d.open = true; });
  await sleep(60);
  const head = card.querySelector('.card-head');
  const title = head?.querySelector('h2')?.textContent.trim() || 'Quadro';
  const width = Math.max(card.getBoundingClientRect().width, ...[...card.querySelectorAll('.table-wrap, .gantt, .fy-wrap, table, svg')].map(el => el.scrollWidth || 0));
  const wide = card.matches('.gantt-sec') || width > 760;
  const pageW = wide ? 1040 : 700;
  const scale = width > pageW ? Math.max(0.45, pageW / width) : 1;
  const clone = card.cloneNode(true);
  freezeLayout(card, clone);
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
  // Mantém as classes dos contêineres da tela (variáveis de cor e estilos do painel, ex.: .ct-dash) sem o layout deles
  let inner = clone;
  for (let el = card.parentElement; el && el.id !== 'view' && el !== document.body; el = el.parentElement) {
    if (!el.className || typeof el.className !== 'string') continue;
    const anc = document.createElement('div');
    anc.className = `${el.className} po-anc`;
    anc.appendChild(inner);
    inner = anc;
  }
  wrap.appendChild(inner);
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

// Contexto padrão do PDF: título e "sobrancelha" da página (ex.: Contratos · Gestão da Empresa)
function pageCtx(root) {
  const h1 = root.querySelector('.page-head h1')?.textContent.trim();
  const eb = root.querySelector('.page-head .eyebrow')?.textContent.trim();
  return { title: h1 || document.title.replace(/ · Charão$/, ''), sub: eb || '' };
}

// Coloca o botão "PDF" em todos os quadros (card com cabeçalho) dentro de root
// (fora de janelas/formulários: o quadro precisa ser um visual, não um cadastro)
export function addPdfButtons(root, ctx) {
  root.querySelectorAll('.card').forEach(card => {
    const head = [...card.children].find(el => el.classList?.contains('card-head'));
    if (!head || head.querySelector('.sec-pdf')) return;
    if (card.tagName === 'FORM' || card.closest('.sheet, .modal, [role=dialog], form') || card.querySelector(':scope > form, :scope > .card-body > form')) return;
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'sec-pdf no-print';
    b.title = 'Gerar PDF só deste quadro';
    b.setAttribute('aria-label', `Gerar PDF: ${head.querySelector('h2')?.textContent.trim() || 'quadro'}`);
    b.innerHTML = `${icon('print')}<span>PDF</span>`;
    b.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); printCard(card, ctx || pageCtx(root)); });
    head.appendChild(b);
  });
}

// Todas as telas: acompanha o conteúdo da tela (inclusive quadros redesenhados por filtros) e coloca o botão
export function autoPdfButtons(root) {
  let queued = false;
  const run = () => { queued = false; if (!document.body.classList.contains('print-mode')) addPdfButtons(root); };
  new MutationObserver(() => { if (!queued) { queued = true; requestAnimationFrame(run); } }).observe(root, { childList: true, subtree: true });
  run();
}
