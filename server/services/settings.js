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

// ---------- Configurações gerais (chave/valor) ----------
const GENERAL = {
  chronic_reschedule_threshold: { def: 3, min: 2, max: 10, label: 'Limite de tarefa crônica' },
};

export function getSetting(key) {
  const r = one('SELECT value FROM app_settings WHERE key = ?', key);
  const n = Number(r?.value);
  return Number.isFinite(n) ? n : GENERAL[key].def;
}

export function getGeneral() {
  return Object.fromEntries(Object.keys(GENERAL).map(k => [k, getSetting(k)]));
}

export function saveGeneral(ctx, body, ip) {
  requireSettingsManager(ctx.user);
  const changes = {};
  for (const [k, spec] of Object.entries(GENERAL)) {
    if (!(k in (body || {}))) continue;
    const v = Number(body[k]);
    if (!Number.isInteger(v) || v < spec.min || v > spec.max) throw badRequest(`${spec.label}: informe um número entre ${spec.min} e ${spec.max}.`);
    const old = getSetting(k);
    if (old !== v) {
      run(`INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`, k, String(v));
      changes[spec.label] = `${old} → ${v}`;
    }
  }
  if (Object.keys(changes).length) audit(ctx.user.id, 'settings', null, 'Configurações gerais alteradas', changes, ip);
  return getGeneral();
}

// ---------- Modelos de listas (especialidades do check-list e classificações Grupo/Local/Etapa) ----------
const parseList = s => { try { const a = JSON.parse(s); return Array.isArray(a) ? a.filter(x => typeof x === 'string') : []; } catch { return []; } };

// table: tabela do modelo · usage: SQL que conta as obras que usam o modelo (ou null) · what: textos das mensagens
const TEMPLATE_KINDS = {
  specialty: { table: 'specialty_templates', usage: 'SELECT COUNT(*) FROM projects p WHERE p.specialty_template_id = t.id',
    item: 'especialidade', items: 'especialidades', maxLen: 60, audit: 'Modelos de especialidades atualizados' },
  stage: { table: 'stage_templates', usage: null,
    item: 'classificação', items: 'classificações', maxLen: 60, audit: 'Modelos de classificação (Grupo/Local/Etapa) atualizados' },
};

function listTemplates(kind) {
  const k = TEMPLATE_KINDS[kind];
  return all(`SELECT t.id, t.name, t.items, ${k.usage ? `(${k.usage})` : '0'} AS project_count
    FROM ${k.table} t ORDER BY t.sort_order, t.id`).map(t => ({ ...t, items: parseList(t.items) }));
}

// Sincroniza os modelos editados em Configurações (cria, renomeia, altera a lista, ordena e exclui os que nenhuma obra usa)
function saveTemplates(ctx, kind, input, ip) {
  requireSettingsManager(ctx.user);
  const k = TEMPLATE_KINDS[kind];
  if (!Array.isArray(input)) throw badRequest('Lista de modelos inválida.');
  if (input.length > 50) throw badRequest('No máximo 50 modelos.');
  const current = listTemplates(kind);
  const byId = new Map(current.map(t => [t.id, t]));
  const seen = new Set();
  const items = input.map((x, i) => {
    const name = String(x?.name ?? '').replace(/\s+/g, ' ').trim();
    if (!name) throw badRequest('Informe o nome de todos os modelos.');
    if (name.length > 80) throw badRequest(`Nome do modelo "${name.slice(0, 30)}…" excede 80 caracteres.`);
    if (seen.has(name.toLowerCase())) throw badRequest(`Modelo repetido: ${name}.`);
    seen.add(name.toLowerCase());
    const id = intOrNull(x?.id);
    if (id && !byId.has(id)) throw badRequest('Modelo inválido.');
    const names = [];
    for (const raw of Array.isArray(x?.items) ? x.items : []) {
      const n = String(raw ?? '').replace(/\s+/g, ' ').trim();
      if (!n) continue;
      if (n.length > k.maxLen) throw badRequest(`"${n.slice(0, 30)}…" excede ${k.maxLen} caracteres.`);
      if (!names.some(o => o.toLowerCase() === n.toLowerCase())) names.push(n);
    }
    if (!names.length) throw badRequest(`O modelo "${name}" precisa de ao menos uma ${k.item}.`);
    if (names.length > 60) throw badRequest(`O modelo "${name}" aceita no máximo 60 ${k.items}.`);
    return { id, name, items: names, order: i + 1 };
  });
  const keep = new Set(items.filter(x => x.id).map(x => x.id));
  const removed = current.filter(t => !keep.has(t.id));
  for (const t of removed) {
    if (t.project_count) throw badRequest(`O modelo "${t.name}" está em uso em ${t.project_count} obra(s). Troque o modelo nessas obras antes de excluir.`);
  }
  const log = { criados: [], alterados: [], excluidos: removed.map(t => t.name) };
  tx(() => {
    for (const t of removed) run(`DELETE FROM ${k.table} WHERE id = ?`, t.id);
    for (const x of items.filter(x => x.id)) run(`UPDATE ${k.table} SET name = ? WHERE id = ?`, `~tmp~${x.id}`, x.id);
    for (const x of items) {
      if (x.id) {
        const old = byId.get(x.id);
        if (old.name !== x.name || JSON.stringify(old.items) !== JSON.stringify(x.items)) log.alterados.push(x.name);
        run(`UPDATE ${k.table} SET name = ?, items = ?, sort_order = ?, updated_at = datetime('now') WHERE id = ?`, x.name, JSON.stringify(x.items), x.order, x.id);
      } else {
        run(`INSERT INTO ${k.table} (name, items, sort_order) VALUES (?, ?, ?)`, x.name, JSON.stringify(x.items), x.order);
        log.criados.push(x.name);
      }
    }
    audit(ctx.user.id, 'settings', null, k.audit, log, ip);
  });
  return listTemplates(kind);
}

// Especialidades do check-list: modelo escolhido em cada obra
export const listSpecialtyTemplates = () => listTemplates('specialty');
export const saveSpecialtyTemplates = (ctx, input, ip) => saveTemplates(ctx, 'specialty', input, ip);

// Classificações (Grupo/Local/Etapa): modelo aplicado (copiado) no cadastro do projeto
export const listStageTemplates = () => listTemplates('stage');
export const saveStageTemplates = (ctx, input, ip) => saveTemplates(ctx, 'stage', input, ip);

// Especialidades da obra (do modelo escolhido no projeto)
export function specialtiesOf(templateId) {
  if (!templateId) return [];
  const r = one('SELECT items FROM specialty_templates WHERE id = ?', templateId);
  return r ? parseList(r.items) : [];
}

export function validTemplateId(v) {
  const id = intOrNull(v);
  if (id && !one('SELECT id FROM specialty_templates WHERE id = ?', id)) throw badRequest('Modelo de especialidades inválido.');
  return id;
}
