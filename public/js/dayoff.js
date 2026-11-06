// Aviso de prazo em dia em que a pessoa não trabalha (jornada do Cadastro da Equipe, férias ou feriado).
// Só avisa: a data pode ser mantida.
import { api } from './core.js';

const br = d => d.split('-').reverse().join('/');
export async function dayOffWarn(box, { projectId, date, userId, name }) {
  if (!box) return;
  if (!projectId || !date) { box.hidden = true; box.textContent = ''; return; }
  try {
    const r = await api(`/projects/${projectId}/plan-dates`, { query: { start: date, due: date, user: userId || '' } });
    const off = r.due_off;
    box.hidden = !off;
    box.textContent = !off ? ''
      : off.code === 'fim_de_semana' || off.code === 'feriado' ? `Atenção: ${br(date)} ${off.text}.`
        : `Atenção: ${name || 'o responsável'} ${off.text} em ${br(date)}, e não estará presente nesse dia.`;
  } catch { box.hidden = true; }
}
