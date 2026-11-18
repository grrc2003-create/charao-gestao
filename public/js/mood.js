// Reações do Charão à tela aberta e aos filtros: cada tela pode devolver { tone, text } (mood);
// sem isso, a reação é lida do que está na tela (etiquetas de status).
// tone: parabens · atencao · insatisfacao · espera (só o balão, sem reação)
const n = (k, one, many) => `${k} ${k === 1 ? one : many}`;
const pctTxt = p => `${String(p).replace('.', ',')}%`;

// Lista de tarefas (filtrada)
export function moodTasks(list, where = '') {
  if (!list.length) return { tone: 'espera', text: `Nenhuma tarefa${where}.` };
  const by = s => list.filter(t => t.eff_status === s).length;
  const late = by('atrasada'), review = by('aguardando_conferencia'), done = by('concluida');
  if (late) return { tone: 'insatisfacao', text: `${n(late, 'tarefa atrasada', 'tarefas atrasadas')}${where}.` };
  if (review) return { tone: 'atencao', text: `${n(review, 'tarefa aguardando', 'tarefas aguardando')} conferência${where}.` };
  if (done === list.length) return { tone: 'parabens', text: `${n(done, 'tarefa concluída', 'tarefas concluídas')}${where}!` };
  return { tone: 'parabens', text: `Nada atrasado${where}: ${n(list.length, 'tarefa', 'tarefas')} em dia.` };
}

// Resumo de indicadores (painel, empresa, projeto): atrasadas, pontualidade e conferências
export function moodSummary(s, where = '', { awaiting = 0, awaitingText = '' } = {}) {
  if (!s || !s.total) return { tone: 'espera', text: `Ainda não há tarefas${where}.` };
  if (s.late) return { tone: 'insatisfacao', text: `${n(s.late, 'tarefa atrasada', 'tarefas atrasadas')}${where}.` };
  if (awaiting) return { tone: 'atencao', text: awaitingText || `${n(awaiting, 'entrega esperando', 'entregas esperando')} conferência.` };
  if (s.on_time_pct !== null && s.on_time_pct !== undefined && s.delivered >= 3 && s.on_time_pct < 70) {
    return { tone: 'atencao', text: `Nada atrasado agora, mas só ${pctTxt(s.on_time_pct)} das entregas foram no prazo${where}.` };
  }
  return { tone: 'parabens', text: `Tudo em dia${where}${s.on_time_pct !== null && s.on_time_pct !== undefined && s.delivered ? ` · ${pctTxt(s.on_time_pct)} no prazo` : ''}!` };
}

// Qualquer outra tela: lê as etiquetas de status visíveis (tarefas, check-lists, itens)
export function moodFromDom(root) {
  const vis = sel => [...root.querySelectorAll(sel)].filter(el => el.offsetParent !== null).length;
  const late = vis('.badge.st-atrasada'), review = vis('.badge.st-aguardando_conferencia');
  const any = vis('.badge[class*="st-"]');
  if (late) return { tone: 'insatisfacao', text: `${n(late, 'item atrasado', 'itens atrasados')} nesta tela.` };
  if (review) return { tone: 'atencao', text: `${n(review, 'item aguardando', 'itens aguardando')} conferência nesta tela.` };
  if (any >= 3) return { tone: 'parabens', text: 'Nada atrasado nesta tela.' };
  return null; // tela sem situação para comentar: o Charão fica em espera
}
