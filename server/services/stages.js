// Classificações de tarefas por projeto (Grupo/Local/Etapa). "Geral" é a padrão e não pode ser removida.
import { all, one, run } from '../db.js';
import { badRequest, intOrNull } from '../lib/http.js';

export const DEFAULT_STAGE = 'Geral';

export function listStages(projectId) {
  return all(`SELECT s.id, s.name, s.sort_order, s.is_default,
      (SELECT COUNT(*) FROM tasks t WHERE t.stage_id = s.id) AS task_count
    FROM project_stages s WHERE s.project_id = ? ORDER BY s.is_default DESC, s.sort_order, s.id`, projectId);
}

// Garante e retorna a classificação padrão do projeto
export function defaultStageId(projectId) {
  const s = one('SELECT id FROM project_stages WHERE project_id = ? AND is_default = 1', projectId);
  if (s) return s.id;
  return Number(run(`INSERT INTO project_stages (project_id, name, sort_order, is_default) VALUES (?, ?, 0, 1)`, projectId, DEFAULT_STAGE).lastInsertRowid);
}

// Valida a classificação escolhida para uma tarefa; vazio => Geral
export function resolveStage(projectId, stageId) {
  const id = intOrNull(stageId);
  if (!id) return defaultStageId(projectId);
  const s = one('SELECT id FROM project_stages WHERE id = ? AND project_id = ?', id, projectId);
  if (!s) throw badRequest('Classificação inválida para este projeto.');
  return s.id;
}

// Sincroniza a lista enviada pelo formulário do projeto: cria, renomeia, reordena e remove (somente sem tarefas).
// Retorna um resumo para auditoria.
export function syncStages(projectId, input) {
  if (!Array.isArray(input)) return null;
  const defId = defaultStageId(projectId);
  const current = listStages(projectId);
  const byId = new Map(current.map(s => [s.id, s]));
  const items = input.slice(0, 100).map((x, i) => ({
    id: intOrNull(x?.id),
    name: String(x?.name ?? '').replace(/\s+/g, ' ').trim(),
    order: i + 1,
  })).filter(x => x.id !== defId);

  const seen = new Set();
  for (const x of items) {
    if (!x.name) throw badRequest('Informe o nome de todas as classificações.');
    if (x.name.toLowerCase() === DEFAULT_STAGE.toLowerCase()) throw badRequest(`"${DEFAULT_STAGE}" já é a classificação padrão do projeto.`);
    if (x.name.length > 60) throw badRequest(`Classificação "${x.name.slice(0, 20)}…" excede 60 caracteres.`);
    const key = x.name.toLowerCase();
    if (seen.has(key)) throw badRequest(`Classificação repetida: ${x.name}.`);
    seen.add(key);
    if (x.id && !byId.has(x.id)) throw badRequest('Classificação inválida.');
  }
  const keep = new Set(items.filter(x => x.id).map(x => x.id));
  const removed = current.filter(s => !s.is_default && !keep.has(s.id));
  for (const s of removed) {
    if (s.task_count) throw badRequest(`A classificação "${s.name}" possui ${s.task_count} tarefa(s). Reclassifique-as antes de removê-la.`);
    const rec = one('SELECT COUNT(*) AS n FROM recurrences WHERE stage_id = ?', s.id).n;
    if (rec) throw badRequest(`A classificação "${s.name}" é usada em ${rec} tarefa(s) recorrente(s). Altere-as antes de removê-la.`);
  }
  const log = { criadas: [], renomeadas: [], removidas: removed.map(s => s.name) };
  for (const s of removed) run('DELETE FROM project_stages WHERE id = ?', s.id);
  // Nomes temporários evitam conflito do índice único ao trocar nomes entre classificações
  for (const x of items.filter(x => x.id)) run('UPDATE project_stages SET name = ? WHERE id = ?', `~tmp~${x.id}`, x.id);
  for (const x of items) {
    if (x.id) {
      const old = byId.get(x.id);
      if (old.name !== x.name) log.renomeadas.push(`${old.name} → ${x.name}`);
      run('UPDATE project_stages SET name = ?, sort_order = ? WHERE id = ?', x.name, x.order, x.id);
    } else {
      run('INSERT INTO project_stages (project_id, name, sort_order) VALUES (?, ?, ?)', projectId, x.name, x.order);
      log.criadas.push(x.name);
    }
  }
  return log.criadas.length || log.renomeadas.length || log.removidas.length ? log : null;
}
