// Processos da Empresa: manual de procedimentos (como cada atividade deve ser executada).
// Leitura: todos os usuários, somente versões publicadas. Edição: seção "processos" (padrão: administrador, gestor e coordenador).
// Alterações ficam em rascunho; quem não é administrador envia para aprovação e só o administrador publica
// (ou devolve com o motivo). Cada publicação gera uma versão (histórico).
import { all, one, run, tx } from '../db.js';
import { badRequest, forbidden, notFound, str, intOrNull } from '../lib/http.js';
import { hasSection, isAdmin } from '../lib/permissions.js';
import { audit } from './audit.js';
import { saveImageFromDataUrl, cleanFileName, deleteStored } from './files.js';

export const FREQUENCIES = ['Diária', 'Semanal', 'Semanal/Mensal', 'Quinzenal', 'Mensal/Quinzenal', 'Mensal', 'Trimestral', 'Anual', 'Sob demanda'];
const LINK_KINDS = ['video', 'ajuda', 'link'];
const nowIso = () => new Date().toISOString().replace('T', ' ').slice(0, 19);

export const canEditProcesses = user => hasSection(user, 'processos');
export const canApproveProcesses = user => isAdmin(user) && canEditProcesses(user);
function requireEditor(ctx) {
  if (!canEditProcesses(ctx.user)) throw forbidden('A edição de processos não está liberada para o seu usuário.');
}
function requireApprover(ctx) {
  if (!canApproveProcesses(ctx.user)) throw forbidden('Somente o administrador aprova e publica processos.');
}

const parse = s => { try { return s ? JSON.parse(s) : null; } catch { return null; } };
const userName = id => (id ? one('SELECT name FROM users WHERE id = ?', id)?.name || null : null);

// Leitores veem apenas processos publicados; quem edita vê também rascunhos e arquivados
function loadProcess(ctx, id) {
  const p = one('SELECT * FROM processes WHERE id = ?', id);
  if (!p || (!canEditProcesses(ctx.user) && p.status !== 'publicado')) throw notFound('Processo não encontrado.');
  return p;
}

// ---------- Validação do conteúdo ----------
function normalize(body, selfId = null) {
  const b = body || {};
  const c = {
    title: str(b.title, { max: 120, required: true, label: 'Nome do processo' }),
    area: str(b.area, { max: 60, required: true, label: 'Área' }),
    frequency: str(b.frequency, { max: 40, label: 'Frequência' }),
    objective: str(b.objective, { max: 1000, required: true, label: 'Objetivo' }),
    erp_module: str(b.erp_module, { max: 200, label: 'Módulo / sistema' }),
    inputs: str(b.inputs, { max: 3000, label: 'Entradas' }),
    outputs: str(b.outputs, { max: 3000, label: 'Saídas' }),
    rules: str(b.rules, { max: 3000, label: 'Regras e cuidados' }),
  };
  const links = Array.isArray(b.links) ? b.links : [];
  if (links.length > 20) throw badRequest('Use no máximo 20 materiais de apoio.');
  c.links = links.map(l => ({
    kind: LINK_KINDS.includes(l?.kind) ? l.kind : 'link',
    label: str(l?.label, { max: 160, label: 'Descrição do material' }),
    url: str(l?.url, { max: 600, required: true, label: 'Endereço (link) do material' }),
  })).filter(l => l.url);
  for (const l of c.links) {
    if (!/^https?:\/\/[^\s]+$/i.test(l.url)) throw badRequest(`Link inválido: ${l.url.slice(0, 60)}. Use um endereço que comece com https://`);
    if (!l.label) l.label = l.url.replace(/^https?:\/\//i, '').slice(0, 80);
  }
  const ind = Array.isArray(b.indicators) ? b.indicators : String(b.indicators || '').split('\n');
  c.indicators = ind.map(x => String(x || '').replace(/^\s*[-–•]\s*/, '').trim()).filter(Boolean);
  if (c.indicators.length > 20) throw badRequest('Use no máximo 20 indicadores.');
  for (const x of c.indicators) if (x.length > 200) throw badRequest('Cada indicador pode ter até 200 caracteres.');
  const steps = Array.isArray(b.steps) ? b.steps : [];
  if (!steps.length) throw badRequest('Inclua ao menos uma etapa.');
  if (steps.length > 40) throw badRequest('Use no máximo 40 etapas.');
  c.steps = steps.map((s, i) => {
    const n = i + 1;
    const control = s?.control === true || s?.control === 1 || s?.control === '1';
    const back = s?.back_to === '' || s?.back_to == null ? null : Number(s.back_to);
    if (back !== null && (!Number.isInteger(back) || back < 1 || back > steps.length || back === n)) throw badRequest(`Etapa ${n}: escolha uma etapa de retorno válida.`);
    return {
      responsible: str(s?.responsible, { max: 80, required: true, label: `Responsável da etapa ${n}` }),
      activity: str(s?.activity, { max: 300, required: true, label: `Atividade da etapa ${n}` }),
      details: str(s?.details, { max: 5000, label: `Como fazer (etapa ${n})` }),
      control,
      fail: control ? str(s?.fail, { max: 200, label: `Não conforme (etapa ${n})` }) : null,
      back_to: control ? back : null,
    };
  });
  const rel = Array.isArray(b.related) ? b.related.map(intOrNull).filter(Boolean) : [];
  c.related = [...new Set(rel)].filter(id => id !== selfId && one('SELECT id FROM processes WHERE id = ?', id)).slice(0, 20);
  return c;
}

function normalizeCode(v, selfId = null) {
  const code = String(v || '').trim().toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9.-]{1,14}$/.test(code)) throw badRequest('Código inválido: use de 2 a 15 letras, números, ponto ou hífen (ex.: PRC-09).');
  const dup = one('SELECT id FROM processes WHERE code = ? AND id <> ?', code, selfId || 0);
  if (dup) throw badRequest(`Já existe um processo com o código ${code}.`);
  return code;
}

function nextCode() {
  let max = 0;
  for (const r of all("SELECT code FROM processes WHERE code LIKE 'PRC-%'")) {
    const n = Number(r.code.slice(4));
    if (Number.isInteger(n) && n > max) max = n;
  }
  return `PRC-${String(max + 1).padStart(2, '0')}`;
}

function ownerOrNull(v) {
  const id = intOrNull(v);
  if (!id) return null;
  if (!one('SELECT id FROM users WHERE id = ? AND active = 1', id)) throw badRequest('Responsável pelo processo inválido.');
  return id;
}

// ---------- Leitura ----------
const stats = c => ({
  steps: c?.steps?.length || 0,
  controls: (c?.steps || []).filter(s => s.control).length,
  people: [...new Set((c?.steps || []).map(s => s.responsible))],
});

function card(p, editor) {
  const c = parse(p.published) || (editor ? parse(p.draft) : null) || {};
  const st = stats(c);
  return {
    id: p.id, code: p.code, title: c.title, area: c.area, frequency: c.frequency, objective: c.objective,
    steps: st.steps, controls: st.controls, people: st.people, related: c.related || [],
    status: p.status, version: p.version, published_at: p.published_at,
    has_draft: editor ? !!p.draft : false,
    draft_title: editor && p.draft ? parse(p.draft)?.title : null,
    review_status: editor && p.draft ? p.review_status : null,
  };
}

export function listProcesses(ctx, { archived = false } = {}) {
  const editor = canEditProcesses(ctx.user);
  const rows = all('SELECT * FROM processes ORDER BY code')
    .filter(p => p.status === 'publicado' || (editor && (p.status === 'rascunho' || archived)));
  const items = rows.map(p => card(p, editor));
  const pub = items.filter(i => i.status === 'publicado');
  return {
    items,
    can_edit: editor,
    can_approve: canApproveProcesses(ctx.user),
    summary: {
      total: pub.length,
      areas: [...new Set(pub.map(i => i.area))].length,
      controls: pub.reduce((s, i) => s + i.controls, 0),
      people: [...new Set(pub.flatMap(i => i.people))].length,
      drafts: editor ? items.filter(i => (i.status === 'rascunho' || i.has_draft) && i.review_status !== 'enviado').length : 0,
      pending: editor ? items.filter(i => i.review_status === 'enviado').length : 0,
      returned: editor ? items.filter(i => i.review_status === 'devolvido').length : 0,
      archived: editor ? one("SELECT COUNT(*) AS n FROM processes WHERE status = 'arquivado'").n : 0,
    },
    areas: [...new Set(all('SELECT published, draft FROM processes').flatMap(p => [parse(p.published)?.area, parse(p.draft)?.area]).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'pt-BR')),
    frequencies: FREQUENCIES,
  };
}

function relatedOf(ctx, c) {
  const editor = canEditProcesses(ctx.user);
  return (c?.related || []).map(id => one('SELECT id, code, status, published, draft FROM processes WHERE id = ?', id))
    .filter(r => r && (r.status === 'publicado' || editor))
    .map(r => ({ id: r.id, code: r.code, title: (parse(r.published) || parse(r.draft) || {}).title, status: r.status }));
}

// view: '' (publicado; rascunho se nunca publicado) | 'rascunho' | número da versão
export function getProcess(ctx, id, { view = '' } = {}) {
  const p = loadProcess(ctx, id);
  const editor = canEditProcesses(ctx.user);
  const versions = all(`SELECT v.version, v.note, v.published_at, u.name AS published_by_name FROM process_versions v
    LEFT JOIN users u ON u.id = v.published_by WHERE v.process_id = ? ORDER BY v.version DESC`, p.id);
  let content = parse(p.published);
  let showing = 'publicado';
  if (!content || (view === 'rascunho' && editor && p.draft)) { content = parse(p.draft); showing = 'rascunho'; }
  if (/^\d+$/.test(String(view)) && Number(view) !== p.version) {
    const v = one('SELECT content FROM process_versions WHERE process_id = ? AND version = ?', p.id, Number(view));
    if (!v) throw notFound('Versão não encontrada.');
    content = parse(v.content);
    showing = Number(view);
  }
  if (!content) throw notFound('Processo sem conteúdo.');
  const draft = editor ? parse(p.draft) : null;
  const approver = canApproveProcesses(ctx.user);
  const pending = p.review_status === 'enviado';
  delete content._meta;
  return {
    id: p.id, code: p.code, status: p.status, version: p.version,
    owner_id: p.owner_id, owner_name: userName(p.owner_id),
    published_at: p.published_at, published_by_name: userName(p.published_by),
    has_draft: editor && !!p.draft, draft_at: editor ? p.draft_at : null, draft_by_name: editor ? userName(p.draft_by) : null,
    showing,
    content: { ...content, related_items: relatedOf(ctx, content) },
    // Formulário de edição: parte do rascunho (se houver) ou da versão publicada
    editable: editor ? draft || parse(p.published) : null,
    // Código/responsável alterados no rascunho de um processo publicado (valem na publicação)
    pending_code: draft?._meta?.code || null,
    pending_owner_id: draft?._meta ? draft._meta.owner_id : undefined,
    review: editor && p.draft ? {
      status: p.review_status, submit_note: p.submit_note, submitted_by_name: userName(p.submitted_by), submitted_at: p.submitted_at,
      note: p.review_note, reviewed_by_name: userName(p.reviewed_by), reviewed_at: p.reviewed_at,
    } : null,
    versions,
    files: all(`SELECT f.id, f.mime, f.size, f.caption, f.original_name, f.created_at, u.name AS uploaded_by_name
      FROM process_files f LEFT JOIN users u ON u.id = f.uploaded_by WHERE f.process_id = ? ORDER BY f.id`, p.id),
    can: {
      edit: editor,
      approver,
      publish: approver && !!p.draft,
      submit: editor && !approver && !!p.draft && !pending,
      return: approver && !!p.draft && pending,
      discard: editor && !!p.draft && !!p.published,
      archive: approver && p.status === 'publicado',
      restore: approver && p.status === 'arquivado',
      remove: editor && p.status === 'rascunho' && !p.published,
      files: editor && (approver || !p.published),
    },
  };
}

// Manual completo (impressão): todos os processos publicados, com o conteúdo
export function processManual(ctx) {
  const rows = all("SELECT * FROM processes WHERE status = 'publicado' ORDER BY code");
  return {
    processes: rows.map(p => {
      const c = parse(p.published) || {};
      return { id: p.id, code: p.code, version: p.version, published_at: p.published_at, owner_name: userName(p.owner_id), content: { ...c, related_items: relatedOf(ctx, c) } };
    }),
  };
}

// ---------- Edição ----------
export function createProcess(ctx, body, ip) {
  requireEditor(ctx);
  const c = normalize(body);
  const code = body?.code ? normalizeCode(body.code) : nextCode();
  const owner = ownerOrNull(body?.owner_id);
  const r = run(`INSERT INTO processes (code, owner_id, status, draft, draft_at, draft_by, created_by) VALUES (?,?,'rascunho',?,?,?,?)`,
    code, owner, JSON.stringify(c), nowIso(), ctx.user.id, ctx.user.id);
  const id = Number(r.lastInsertRowid);
  audit(ctx.user.id, 'process', id, 'create', { code, title: c.title }, ip);
  if (body?.publish) return publishProcess(ctx, id, { note: body.note || 'Primeira versão' }, ip);
  if (body?.submit) return submitProcess(ctx, id, { note: body.note || 'Primeira versão' }, ip);
  return getProcess(ctx, id, { view: 'rascunho' });
}

// Salva as alterações como rascunho (a versão publicada continua valendo até publicar)
export function saveDraft(ctx, id, body, ip) {
  requireEditor(ctx);
  const p = loadProcess(ctx, id);
  const c = normalize(body, p.id);
  const prevMeta = parse(p.draft)?._meta || {};
  const code = body?.code ? normalizeCode(body.code, p.id) : prevMeta.code || p.code;
  const owner = body && 'owner_id' in body ? ownerOrNull(body.owner_id) : 'owner_id' in prevMeta ? prevMeta.owner_id : p.owner_id;
  // Processo publicado: código e responsável também só mudam na publicação
  if (p.published) c._meta = { code, owner_id: owner };
  // Alterado por quem não aprova: volta a ser rascunho (precisa ser enviado de novo)
  const review = canApproveProcesses(ctx.user) ? p.review_status : null;
  run(`UPDATE processes SET code = ?, owner_id = ?, draft = ?, draft_at = ?, draft_by = ?, review_status = ?, updated_at = datetime('now') WHERE id = ?`,
    p.published ? p.code : code, p.published ? p.owner_id : owner, JSON.stringify(c), nowIso(), ctx.user.id, review, p.id);
  audit(ctx.user.id, 'process', p.id, 'draft', { code, title: c.title }, ip);
  if (body?.publish) return publishProcess(ctx, p.id, { note: body.note }, ip);
  if (body?.submit) return submitProcess(ctx, p.id, { note: body.note }, ip);
  return getProcess(ctx, p.id, { view: 'rascunho' });
}

// Publicação (aprovação): somente o administrador
export function publishProcess(ctx, id, body, ip) {
  requireApprover(ctx);
  const p = loadProcess(ctx, id);
  if (!p.draft) throw badRequest('Não há alterações em rascunho para publicar.');
  const note = str(body?.note, { max: 500, label: 'O que mudou' }) || p.submit_note;
  const { _meta: meta, ...content } = parse(p.draft) || {};
  const code = meta?.code ? normalizeCode(meta.code, p.id) : p.code;
  const owner = meta && 'owner_id' in meta ? meta.owner_id : p.owner_id;
  const json = JSON.stringify(content);
  const v = p.version + 1;
  const at = nowIso();
  tx(() => {
    run(`UPDATE processes SET code = ?, owner_id = ?, published = ?, draft = NULL, draft_at = NULL, draft_by = NULL, version = ?, status = 'publicado',
      published_at = ?, published_by = ?, review_status = NULL, submit_note = NULL, submitted_by = NULL, submitted_at = NULL,
      review_note = NULL, reviewed_by = NULL, reviewed_at = NULL, updated_at = datetime('now') WHERE id = ?`, code, owner, json, v, at, ctx.user.id, p.id);
    run('INSERT INTO process_versions (process_id, version, content, note, published_by, published_at) VALUES (?,?,?,?,?,?)', p.id, v, json, note, ctx.user.id, at);
  });
  audit(ctx.user.id, 'process', p.id, 'publish', { code, version: v, note, submitted_by: p.submitted_by }, ip);
  return getProcess(ctx, p.id);
}

// Envio para aprovação do administrador (gestor/coordenador)
export function submitProcess(ctx, id, body, ip) {
  requireEditor(ctx);
  const p = loadProcess(ctx, id);
  if (!p.draft) throw badRequest('Não há alterações em rascunho para enviar.');
  if (p.review_status === 'enviado') throw badRequest('Este processo já está aguardando aprovação.');
  const note = str(body?.note, { max: 500, label: 'O que mudou' });
  run(`UPDATE processes SET review_status = 'enviado', submit_note = ?, submitted_by = ?, submitted_at = ?, review_note = NULL, reviewed_by = NULL, reviewed_at = NULL,
    updated_at = datetime('now') WHERE id = ?`, note, ctx.user.id, nowIso(), p.id);
  audit(ctx.user.id, 'process', p.id, 'submit', { code: p.code, note }, ip);
  return getProcess(ctx, p.id, { view: 'rascunho' });
}

export function processAction(ctx, id, action, body, ip) {
  requireEditor(ctx);
  const p = loadProcess(ctx, id);
  if (action === 'publicar') return publishProcess(ctx, id, body, ip);
  if (action === 'enviar') return submitProcess(ctx, id, body, ip);
  if (action === 'devolver') {
    requireApprover(ctx);
    if (!p.draft || p.review_status !== 'enviado') throw badRequest('Este processo não está aguardando aprovação.');
    const note = str(body?.note, { max: 1000, required: true, label: 'Motivo da devolução' });
    run(`UPDATE processes SET review_status = 'devolvido', review_note = ?, reviewed_by = ?, reviewed_at = ?, updated_at = datetime('now') WHERE id = ?`,
      note, ctx.user.id, nowIso(), p.id);
    audit(ctx.user.id, 'process', p.id, 'return', { code: p.code, note }, ip);
    return getProcess(ctx, p.id, { view: 'rascunho' });
  }
  if (action === 'descartar') {
    if (!p.draft) throw badRequest('Não há rascunho para descartar.');
    if (!p.published) throw badRequest('Este processo ainda não foi publicado: para desistir dele, use Excluir.');
    run(`UPDATE processes SET draft = NULL, draft_at = NULL, draft_by = NULL, review_status = NULL, submit_note = NULL, submitted_by = NULL, submitted_at = NULL,
      review_note = NULL, reviewed_by = NULL, reviewed_at = NULL, updated_at = datetime('now') WHERE id = ?`, p.id);
    audit(ctx.user.id, 'process', p.id, 'discard_draft', { code: p.code }, ip);
    return getProcess(ctx, p.id);
  }
  if (action === 'arquivar') {
    requireApprover(ctx);
    if (p.status !== 'publicado') throw badRequest('Somente processos publicados podem ser arquivados.');
    run(`UPDATE processes SET status = 'arquivado', updated_at = datetime('now') WHERE id = ?`, p.id);
    audit(ctx.user.id, 'process', p.id, 'archive', { code: p.code }, ip);
    return getProcess(ctx, p.id);
  }
  if (action === 'restaurar') {
    requireApprover(ctx);
    if (p.status !== 'arquivado') throw badRequest('O processo não está arquivado.');
    run(`UPDATE processes SET status = 'publicado', updated_at = datetime('now') WHERE id = ?`, p.id);
    audit(ctx.user.id, 'process', p.id, 'restore', { code: p.code }, ip);
    return getProcess(ctx, p.id);
  }
  throw badRequest('Ação inválida.');
}

// Exclusão: somente processos que nunca foram publicados (os publicados são arquivados, nunca apagados)
export function removeProcess(ctx, id, ip) {
  requireEditor(ctx);
  const p = loadProcess(ctx, id);
  if (p.published || p.status !== 'rascunho') throw badRequest('Processos já publicados não são excluídos: use Arquivar.');
  const files = all('SELECT stored_name FROM process_files WHERE process_id = ?', p.id);
  run('DELETE FROM processes WHERE id = ?', p.id);
  for (const f of files) deleteStored(f.stored_name);
  audit(ctx.user.id, 'process', p.id, 'delete', { code: p.code }, ip);
  return { ok: true };
}

// ---------- Documentos e modelos ----------
// Em processo já publicado os documentos aparecem na hora para todos: só o administrador inclui/remove
function requireFilesEditor(ctx, p) {
  requireEditor(ctx);
  if (p.published && !canApproveProcesses(ctx.user)) throw forbidden('Em processos publicados, somente o administrador inclui ou remove documentos.');
}
export function addProcessFiles(ctx, id, body) {
  const p = loadProcess(ctx, id);
  requireFilesEditor(ctx, p);
  const list = Array.isArray(body?.files) ? body.files.slice(0, 15) : [];
  if (!list.length) throw badRequest('Nenhum arquivo enviado.');
  tx(() => {
    for (const f of list) {
      const saved = saveImageFromDataUrl(f.data);
      run('INSERT INTO process_files (process_id, stored_name, mime, size, caption, original_name, uploaded_by) VALUES (?,?,?,?,?,?,?)',
        p.id, saved.stored_name, saved.mime, saved.size, str(f.caption, { max: 200, label: 'Legenda' }), cleanFileName(f.name), ctx.user.id);
    }
  });
  audit(ctx.user.id, 'process', p.id, 'files_add', { count: list.length });
  return getProcess(ctx, p.id);
}

export function removeProcessFile(ctx, id, fileId) {
  const p = loadProcess(ctx, id);
  requireFilesEditor(ctx, p);
  const f = one('SELECT * FROM process_files WHERE id = ? AND process_id = ?', fileId, p.id);
  if (!f) throw notFound('Arquivo não encontrado.');
  run('DELETE FROM process_files WHERE id = ?', f.id);
  deleteStored(f.stored_name);
  audit(ctx.user.id, 'process', p.id, 'files_remove', { file: f.original_name || f.id });
  return getProcess(ctx, p.id);
}

export function processFileForUser(ctx, fileId) {
  const f = one('SELECT * FROM process_files WHERE id = ?', fileId);
  if (!f) throw notFound('Arquivo não encontrado.');
  loadProcess(ctx, f.process_id);
  return f;
}
