// Reações do Charão à tela aberta e aos filtros: cada tela pode devolver { tone, text, points?, more? } (mood);
// sem isso, a reação é lida do que está na tela (etiquetas de status).
// tone: parabens · atencao · insatisfacao · espera (só o balão, sem reação)
// points: o que o Charão apontou (até 30), para listar ao clicar nele: { label, sub?, href? (abre outra tela) | sel? (rola até o item nesta tela) }
// more: { label, href } — link para ver a lista completa
const n = (k, one, many) => `${k} ${k === 1 ? one : many}`;
const pctTxt = p => `${String(p).replace('.', ',')}%`;
const MAX_POINTS = 30;

// Tarefa como ponto do Charão (abre a tarefa)
export function taskPoint(t) {
  const late = t.eff_status === 'atrasada' && t.days_late ? `${n(t.days_late, 'dia', 'dias')} de atraso` : '';
  return { label: `${t.code} · ${t.title}`, sub: [late, t.assignee_name, t.project_code].filter(Boolean).join(' · '), href: `#/tarefas/${t.id}` };
}
export const taskPoints = list => [...list].sort((a, b) => (b.days_late || 0) - (a.days_late || 0)).slice(0, MAX_POINTS).map(taskPoint);

// Lista de tarefas (filtrada)
export function moodTasks(list, where = '') {
  if (!list.length) return { tone: 'espera', text: `Nenhuma tarefa${where}.` };
  const of = s => list.filter(t => t.eff_status === s);
  const late = of('atrasada'), review = of('aguardando_conferencia'), done = of('concluida').length;
  if (late.length) return { tone: 'insatisfacao', text: `${n(late.length, 'tarefa atrasada', 'tarefas atrasadas')}${where}.`, points: taskPoints(late), total: late.length };
  if (review.length) return { tone: 'atencao', text: `${n(review.length, 'tarefa aguardando', 'tarefas aguardando')} conferência${where}.`, points: taskPoints(review), total: review.length };
  if (done === list.length) return { tone: 'parabens', text: `${n(done, 'tarefa concluída', 'tarefas concluídas')}${where}!` };
  return { tone: 'parabens', text: `Nada atrasado${where}: ${n(list.length, 'tarefa', 'tarefas')} em dia.` };
}

// Resumo de indicadores (painel, empresa, projeto): atrasadas, pontualidade e conferências
// late/review: listas de tarefas (quando a tela tem) para o Charão apontar; more/moreReview: link da lista completa
export function moodSummary(s, where = '', { awaiting = 0, awaitingText = '', late = null, review = null, more = null, moreReview = null } = {}) {
  if (!s || !s.total) return { tone: 'espera', text: `Ainda não há tarefas${where}.` };
  if (s.late) return { tone: 'insatisfacao', text: `${n(s.late, 'tarefa atrasada', 'tarefas atrasadas')}${where}.`, points: late ? taskPoints(late) : [], total: s.late, more };
  if (awaiting) return { tone: 'atencao', text: awaitingText || `${n(awaiting, 'entrega esperando', 'entregas esperando')} conferência.`, points: review ? taskPoints(review) : [], total: awaiting, more: moreReview };
  if (s.on_time_pct !== null && s.on_time_pct !== undefined && s.delivered >= 3 && s.on_time_pct < 70) {
    return { tone: 'atencao', text: `Nada atrasado agora, mas só ${pctTxt(s.on_time_pct)} das entregas foram no prazo${where}.` };
  }
  return { tone: 'parabens', text: `Tudo em dia${where}${s.on_time_pct !== null && s.on_time_pct !== undefined && s.delivered ? ` · ${pctTxt(s.on_time_pct)} no prazo` : ''}!` };
}

// Qualquer outra tela: lê as etiquetas de status visíveis (tarefas, check-lists, itens) e marca os itens para o Charão apontar
export function moodFromDom(root) {
  const vis = sel => [...root.querySelectorAll(sel)].filter(el => el.offsetParent !== null);
  const late = vis('.badge.st-atrasada'), review = vis('.badge.st-aguardando_conferencia');
  const any = vis('.badge[class*="st-"]').length;
  const pts = badges => badges.slice(0, MAX_POINTS).map((b, i) => {
    const row = b.closest('a[href], tr, li, .card') || b.parentElement;
    const link = row.matches('a[href^="#/"]') ? row : row.querySelector('a[href^="#/"]');
    const label = (row.innerText || row.textContent || '').replace(b.innerText || '', '').split('\n').map(s => s.trim()).filter(Boolean).slice(0, 2).join(' · ').slice(0, 120) || 'Item';
    if (link) return { label, href: link.getAttribute('href') };
    row.setAttribute('data-ch-pt', String(i));
    return { label, sel: `[data-ch-pt="${i}"]` };
  });
  if (late.length) return { tone: 'insatisfacao', text: `${n(late.length, 'item atrasado', 'itens atrasados')} nesta tela.`, points: pts(late), total: late.length };
  if (review.length) return { tone: 'atencao', text: `${n(review.length, 'item aguardando', 'itens aguardando')} conferência nesta tela.`, points: pts(review), total: review.length };
  if (any >= 3) return { tone: 'parabens', text: 'Nada atrasado nesta tela.' };
  return null; // tela sem situação para comentar: o Charão fica em espera
}
