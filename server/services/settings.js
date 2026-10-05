// Configurações gerais do sistema (Gestor e Administrador). Hoje: justificativas de reagendamento (válidas para todos os projetos).
import { all, one, run, tx } from '../db.js';
import { badRequest, intOrNull } from '../lib/http.js';
import { requireSettingsManager } from '../lib/permissions.js';
import { audit } from './audit.js';

export function listReasons({ includeInactive = false } = {}) {
  return all(`SELECT r.id, r.name, r.active, r.sort_order,
      (SELECT COUNT(*) FROM task_reschedules x WHERE x.reason_id = r.id) AS use_count
    FROM reschedule_reasons r ${includeInactive ? '' : 'WHERE r.active = 1'} ORDER BY r.sort_order, r.id`);
}

export function activeReason(id) {
  const r = one('SELECT * FROM reschedule_reasons WHERE id = ? AND active = 1', intOrNull(id));
  if (!r) throw badRequest('Selecione uma justificativa válida para o reagendamento.');
  return r;
}

// Sincroniza a lista editada em Configurações: cria, renomeia, ordena, ativa/inativa e remove (somente nunca usadas).
export function saveReasons(ctx, input, ip) {
  requireSettingsManager(ctx.user);
  if (!Array.isArray(input)) throw badRequest('Lista de justificativas inválida.');
  const current = listReasons({ includeInactive: true });
  const byId = new Map(current.map(r => [r.id, r]));
  const items = input.slice(0, 200).map((x, i) => ({
    id: intOrNull(x?.id),
    name: String(x?.name ?? '').replace(/\s+/g, ' ').trim(),
    active: x?.active === false || x?.active === 0 ? 0 : 1,
    order: i + 1,
  }));
  const seen = new Set();
  for (const x of items) {
    if (!x.name) throw badRequest('Informe o texto de todas as justificativas.');
    if (x.name.length > 120) throw badRequest(`Justificativa "${x.name.slice(0, 30)}…" excede 120 caracteres.`);
    const k = x.name.toLowerCase();
    if (seen.has(k)) throw badRequest(`Justificativa repetida: ${x.name}.`);
    seen.add(k);
    if (x.id && !byId.has(x.id)) throw badRequest('Justificativa inválida.');
  }
  if (!items.some(x => x.active)) throw badRequest('Mantenha pelo menos uma justificativa ativa.');
  const keep = new Set(items.filter(x => x.id).map(x => x.id));
  const removed = current.filter(r => !keep.has(r.id));
  for (const r of removed) {
    if (r.use_count) throw badRequest(`"${r.name}" já foi usada em ${r.use_count} reagendamento(s). Inative-a em vez de excluir.`);
  }
  const log = { criadas: [], renomeadas: [], inativadas: [], reativadas: [], excluidas: removed.map(r => r.name) };
  tx(() => {
    for (const r of removed) run('DELETE FROM reschedule_reasons WHERE id = ?', r.id);
    // Nomes temporários evitam conflito do índice único ao trocar textos entre itens
    for (const x of items.filter(x => x.id)) run('UPDATE reschedule_reasons SET name = ? WHERE id = ?', `~tmp~${x.id}`, x.id);
    for (const x of items) {
      if (x.id) {
        const old = byId.get(x.id);
        if (old.name !== x.name) log.renomeadas.push(`${old.name} → ${x.name}`);
        if (old.active && !x.active) log.inativadas.push(x.name);
        if (!old.active && x.active) log.reativadas.push(x.name);
        run(`UPDATE reschedule_reasons SET name = ?, active = ?, sort_order = ?, updated_at = datetime('now') WHERE id = ?`, x.name, x.active, x.order, x.id);
      } else {
        run('INSERT INTO reschedule_reasons (name, active, sort_order) VALUES (?, ?, ?)', x.name, x.active, x.order);
        log.criadas.push(x.name);
      }
    }
    audit(ctx.user.id, 'settings', null, 'Justificativas de reagendamento atualizadas', log, ip);
  });
  return listReasons({ includeInactive: true });
}
