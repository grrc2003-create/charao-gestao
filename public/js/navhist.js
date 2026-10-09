// Caminho percorrido entre as telas, para o "Voltar" levar à tela anterior de verdade (com os filtros que estavam em uso).
// Formulários (novo/editar) não ficam no caminho: depois de salvar, voltar leva à tela de antes do formulário.
const KEY = 'charao-nav';
const MAX = 40;
const pathOf = h => h.replace(/^#/, '').split('?')[0] || '/';
const isForm = h => /\/(editar|nova|novo)$/.test(pathOf(h));

let stack = [];
try { stack = JSON.parse(sessionStorage.getItem(KEY) || '[]'); } catch { stack = []; }
const save = () => { try { sessionStorage.setItem(KEY, JSON.stringify(stack)); } catch { /* sem armazenamento */ } };

// Anterior/Próxima entre tarefas: substitui a tela atual (o "Voltar" continua levando à lista de origem)
let replaceNext = false;
export const replaceNextRoute = () => { replaceNext = true; };

// Chamado a cada troca de tela (antes de montar a tela, para o "Voltar" já saber a anterior)
export function trackRoute(hash) {
  const h = hash || '#/';
  const top = stack.at(-1);
  if (replaceNext && top) {
    replaceNext = false;
    stack[stack.length - 1] = { hash: h, title: '' };
    save();
    return;
  }
  const idx = stack.findIndex(e => e.hash === h);
  if (idx >= 0) stack = stack.slice(0, idx + 1); // voltou para uma tela do caminho
  else if (top && pathOf(top.hash) === pathOf(h)) top.hash = h; // mesma tela, outros filtros
  else if (top && isForm(top.hash)) stack[stack.length - 1] = { hash: h, title: '' }; // saiu do formulário
  else stack.push({ hash: h, title: '' });
  if (stack.length > MAX) stack = stack.slice(-MAX);
  save();
}

// Filtros alterados sem trocar de tela
export function updateCurrent(hash) {
  const top = stack.at(-1);
  if (top && pathOf(top.hash) === pathOf(hash)) { top.hash = hash; save(); }
}

export function setCurrentTitle(title) {
  const top = stack.at(-1);
  if (top && title) { top.title = title; save(); }
}

// Tela anterior do caminho (ignorando formulários)
export function previousScreen() {
  for (let i = stack.length - 2; i >= 0; i--) if (!isForm(stack[i].hash)) return stack[i];
  return null;
}

export function clearNav() { stack = []; save(); }
