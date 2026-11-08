// Alertas por indicador, definidos em cada projeto: limite de atenção e limite crítico.
// Indicadores "máximo" alertam quando o valor chega ao limite ou passa dele (ex.: tarefas atrasadas);
// indicadores "mínimo" alertam quando o valor cai até o limite ou abaixo (ex.: % de entregas no prazo).
import { all, one, run, tx } from '../db.js';
import { badRequest, forbidden, notFound } from '../lib/http.js';
import { canAccessProject, canManageProject } from '../lib/permissions.js';
import { audit } from './audit.js';

export const INDICATORS = {
  atrasadas: 'max', atraso_medio: 'max', vencem_7d: 'max', em_conferencia: 'max', no_prazo: 'min', conclusao: 'min',
  exec_media: 'max', atraso_preenchimento: 'max', cot_tres_pct: 'min', cot_sem: 'max', cot_vencidas: 'max',
};

function load(ctx, projectId) {
  const p = one('SELECT id, code FROM projects WHERE id = ?', projectId);
  if (!p || !canAccessProject(ctx.user, p.id, ctx.projects)) throw notFound('Projeto não encontrado.');
  return p;
}
export function getAlerts(ctx, projectId) {
  const p = load(ctx, projectId);
  let rows = [];
  try { rows = all('SELECT indicator, warn, crit FROM project_alerts WHERE project_id = ?', p.id); } catch { /* antes da migração */ }
  return { alerts: rows.filter(r => INDICATORS[r.indicator]), can_edit: canManageProject(ctx, p.id) };
}
const val = (v, label) => {
  if (v === '' || v === null || v === undefined) return null;
  const n = Number(String(v).replace(',', '.'));
  if (!Number.isFinite(n) || n < 0) throw badRequest(`${label}: valor inválido.`);
  return Math.round(n * 100) / 100;
};
export function saveAlerts(ctx, projectId, body, ip) {
  const p = load(ctx, projectId);
  if (!canManageProject(ctx, p.id)) throw forbidden('Só quem gerencia o projeto define os alertas.');
  const list = Array.isArray(body?.alerts) ? body.alerts : [];
  const clean = [];
  for (const a of list) {
    const dir = INDICATORS[a?.indicator];
    if (!dir) continue;
    const warn = val(a.warn, 'Limite de atenção'), crit = val(a.crit, 'Limite crítico');
    if (warn === null && crit === null) continue;
    if (warn !== null && crit !== null && (dir === 'max' ? crit < warn : crit > warn)) {
      throw badRequest(dir === 'max' ? 'O limite crítico não pode ser menor que o de atenção (indicadores em que mais é pior).' : 'O limite crítico não pode ser maior que o de atenção (indicadores em que menos é pior).');
    }
    clean.push({ indicator: a.indicator, warn, crit });
  }
  tx(() => {
    run('DELETE FROM project_alerts WHERE project_id = ?', p.id);
    for (const a of clean) run('INSERT INTO project_alerts (project_id, indicator, warn, crit, updated_by) VALUES (?,?,?,?,?)', p.id, a.indicator, a.warn, a.crit, ctx.user.id);
  });
  audit(ctx.user.id, 'project', p.id, 'Alertas dos indicadores definidos', { projeto: p.code, alertas: clean.length }, ip);
  return getAlerts(ctx, p.id);
}
