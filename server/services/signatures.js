// Assinatura eletrônica dos documentos (recibos das folhas, boletim de medição, check-list, relatórios e História do projeto).
// Assinatura eletrônica simples: imagem desenhada no tablet/celular (ou a assinatura salva da pessoa, com a senha dela),
// com registro de quem assinou, quem coletou, quando e de qual aparelho. Não é certificado digital ICP-Brasil.
// Quem pode ver/assinar um documento é quem pode abrir o próprio documento.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { all, one, run, UPLOAD_DIR } from '../db.js';
import { badRequest, forbidden, notFound, str, intOrNull, HttpError } from '../lib/http.js';
import { isAdmin, hasSection, canAccessProject, sameCompanyOk } from '../lib/permissions.js';
import { verifyPassword } from '../lib/auth.js';
import { saveImageFromDataUrl, deleteStored, readStored } from './files.js';
import { audit } from './audit.js';
import { getMeasurement } from './contracts.js';
import { loadVisible } from './tasks.js';
import { getSheet } from './field.js';
import { canPayroll } from './payroll.js';

export const DOC_TYPES = ['campo', 'folha', 'medicao', 'checklist', 'relatorio', 'historia'];
const MAX_IMAGE = 800 * 1024; // assinatura desenhada: imagem pequena

// ---------- Acesso ao documento (mesmas regras de abrir o documento) ----------
function docAccess(ctx, type, key) {
  const k = String(key || '');
  try {
    if (type === 'medicao') { getMeasurement(ctx, intOrNull(k)); return true; }
    if (type === 'checklist') { loadVisible(ctx, intOrNull(k)); return true; }
    if (type === 'historia') return canAccessProject(ctx.user, intOrNull(k), ctx.projects);
    if (type === 'relatorio') return hasSection(ctx.user, 'relatorios');
    if (type === 'campo') {
      const [sid] = k.split(':');
      return !!getSheet(ctx, intOrNull(sid))?.can?.money;
    }
    if (type === 'folha') {
      const [mid, eid] = k.split(':').map(intOrNull);
      const e = one('SELECT e.id, p.user_id FROM payroll_entries e JOIN payroll_people p ON p.id = e.person_id WHERE e.id = ? AND e.month_id = ?', eid, mid);
      return !!e && (canPayroll(ctx.user) || e.user_id === ctx.user.id);
    }
  } catch { return false; }
  return false;
}
function requireDoc(ctx, type, key) {
  if (!DOC_TYPES.includes(type)) throw badRequest('Tipo de documento inválido.');
  if (!key || String(key).length > 400) throw badRequest('Documento inválido.');
  if (!docAccess(ctx, type, key)) throw notFound('Documento não encontrado.');
}
const hashOf = fp => (fp === undefined || fp === null || fp === '' ? null : crypto.createHash('sha256').update(String(fp)).digest('hex'));

const view = (s, curHash) => ({
  id: s.id, slot: s.slot, slot_label: s.slot_label, signer_name: s.signer_name, signer_doc: s.signer_doc, signer_user_id: s.signer_user_id,
  method: s.method, signed_at: s.signed_at, collected_by_name: s.collected_by_name, image_url: `/api/signatures/${s.id}/image`,
  // Documento alterado depois da assinatura (a impressão do conteúdo mudou)
  changed: !!(s.content_hash && curHash && s.content_hash !== curHash),
});

// Assinaturas válidas (a mais recente de cada linha) de vários documentos de uma vez
export function querySignatures(ctx, items) {
  if (!Array.isArray(items) || items.length > 300) throw badRequest('Lista de documentos inválida.');
  const out = {};
  for (const it of items) {
    const type = String(it?.type || ''), key = String(it?.key || '');
    if (!DOC_TYPES.includes(type) || !key || !docAccess(ctx, type, key)) continue;
    const cur = hashOf(it.fp);
    const rows = all(`SELECT s.*, c.name AS collected_by_name FROM document_signatures s LEFT JOIN users c ON c.id = s.collected_by
      WHERE s.doc_type = ? AND s.doc_key = ? AND s.removed_at IS NULL ORDER BY s.id DESC`, type, key);
    const slots = {};
    for (const r of rows) if (!slots[r.slot]) slots[r.slot] = view(r, cur);
    out[`${type}:${key}`] = { slots, history: rows.length };
  }
  return { docs: out, can_remove: isAdmin(ctx.user), me: { id: ctx.user.id, has_saved: !!one('SELECT signature_file FROM users WHERE id = ?', ctx.user.id)?.signature_file } };
}

// Tentativas de senha ao usar a assinatura salva: 5 erros bloqueiam a pessoa por 15 minutos
const fails = new Map();
function checkPassword(user, password) {
  const f = fails.get(user.id);
  if (f && f.until > Date.now()) throw new HttpError(429, 'Muitas tentativas com a senha. Aguarde 15 minutos ou assine desenhando.');
  if (!password || !verifyPassword(String(password), user.password_hash)) {
    const n = (f && f.until > Date.now() - 15 * 60e3 ? f.n : 0) + 1;
    fails.set(user.id, { n, until: n >= 5 ? Date.now() + 15 * 60e3 : 0 });
    throw badRequest('Senha incorreta para usar a assinatura salva.');
  }
  fails.delete(user.id);
}
function copyStored(stored) {
  const buf = readStored(stored);
  if (!buf) throw badRequest('A assinatura salva não foi encontrada. Desenhe a assinatura.');
  const name = `${crypto.randomUUID()}.${stored.split('.').pop()}`;
  fs.writeFileSync(path.join(UPLOAD_DIR, name), buf);
  return name;
}
function readDrawing(data) {
  if (typeof data !== 'string' || !data.startsWith('data:image/')) throw badRequest('Desenhe a assinatura.');
  if (data.length > MAX_IMAGE * 1.4) throw badRequest('Imagem da assinatura grande demais.');
  const saved = saveImageFromDataUrl(data);
  if (!/^image\//.test(saved.mime)) { deleteStored(saved.stored_name); throw badRequest('Assinatura inválida.'); }
  return saved.stored_name;
}

// Assinar uma linha do documento: desenhando, ou com a assinatura salva de uma pessoa cadastrada (senha dela)
export function signDocument(ctx, body, req) {
  const type = String(body.type || ''), key = String(body.key || '');
  requireDoc(ctx, type, key);
  const slot = str(body.slot, { max: 120, required: true, label: 'Linha de assinatura' });
  const slotLabel = str(body.slot_label, { max: 160, label: 'Descrição da linha' });
  let signerUserId = null, signerName, image, method;
  if (body.method === 'salva') {
    const uid = intOrNull(body.signer_user_id) || ctx.user.id;
    const u = one('SELECT * FROM users WHERE id = ? AND active = 1', uid);
    if (!u || !u.signature_file || !u.login_enabled) throw badRequest('Esta pessoa não tem assinatura salva.');
    if (!sameCompanyOk(ctx, uid)) throw notFound('Pessoa não encontrada.');
    checkPassword(u, body.password);
    signerUserId = u.id; signerName = u.name; method = 'salva';
    image = copyStored(u.signature_file);
  } else {
    signerName = str(body.signer_name, { max: 160, required: true, label: 'Nome de quem assina' });
    image = readDrawing(body.data);
    method = 'desenho';
  }
  const signerDoc = str(body.signer_doc, { max: 30, label: 'CPF/CNPJ' }) || null;
  const now = new Date().toISOString();
  const id = Number(run(`INSERT INTO document_signatures (doc_type, doc_key, slot, slot_label, signer_user_id, signer_name, signer_doc, method, image_file, content_hash, collected_by, ip, user_agent, signed_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, type, key, slot, slotLabel, signerUserId, signerName, signerDoc, method, image, hashOf(body.fp), ctx.user.id,
    req?.ip || null, String(req?.ua || '').slice(0, 300) || null, now).lastInsertRowid);
  audit(ctx.user.id, 'signature', id, 'Documento assinado eletronicamente', { documento: `${type}:${key}`, linha: slotLabel || slot, assinou: signerName, forma: method === 'salva' ? 'assinatura salva (senha confirmada)' : 'desenhada no aparelho' }, req?.ip);
  return { id };
}

// Remover uma assinatura (administrador, com motivo): fica no histórico como removida
export function removeSignature(ctx, id, body, ip) {
  if (!isAdmin(ctx.user)) throw forbidden('Somente administradores removem assinaturas.');
  const s = one('SELECT * FROM document_signatures WHERE id = ? AND removed_at IS NULL', id);
  if (!s) throw notFound('Assinatura não encontrada.');
  const reason = str(body.reason, { max: 500, required: true, label: 'Motivo' });
  run('UPDATE document_signatures SET removed_at = ?, removed_by = ?, remove_reason = ? WHERE id = ?', new Date().toISOString(), ctx.user.id, reason, id);
  audit(ctx.user.id, 'signature', id, 'Assinatura removida', { documento: `${s.doc_type}:${s.doc_key}`, linha: s.slot_label || s.slot, assinou: s.signer_name, motivo: reason }, ip);
  return { ok: true };
}

export function signatureImage(ctx, id) {
  const s = one('SELECT * FROM document_signatures WHERE id = ?', id);
  if (!s || !docAccess(ctx, s.doc_type, s.doc_key)) throw notFound();
  return { stored_name: s.image_file, mime: s.image_file.endsWith('.png') ? 'image/png' : s.image_file.endsWith('.webp') ? 'image/webp' : 'image/jpeg' };
}

// Pessoas com assinatura salva (para escolher na hora de assinar; a senha da pessoa é pedida)
export function signers(ctx) {
  return all(`SELECT id, name, job_title FROM users WHERE active = 1 AND login_enabled = 1 AND signature_file IS NOT NULL ORDER BY name`)
    .filter(u => sameCompanyOk(ctx, u.id));
}

// ---------- Minha assinatura salva ----------
export function mySignature(ctx) {
  const u = one('SELECT signature_file, signature_updated_at FROM users WHERE id = ?', ctx.user.id);
  return { has: !!u?.signature_file, updated_at: u?.signature_updated_at || null, image_url: u?.signature_file ? `/api/me/signature/image?v=${u.signature_file.slice(0, 8)}` : null };
}
export function saveMySignature(ctx, body, ip) {
  const stored = readDrawing(body.data);
  const old = one('SELECT signature_file FROM users WHERE id = ?', ctx.user.id)?.signature_file;
  run(`UPDATE users SET signature_file = ?, signature_updated_at = ? WHERE id = ?`, stored, new Date().toISOString(), ctx.user.id);
  if (old) deleteStored(old); // as assinaturas já feitas têm cópia própria
  audit(ctx.user.id, 'user', ctx.user.id, 'Assinatura salva atualizada', {}, ip);
  return mySignature(ctx);
}
export function removeMySignature(ctx, ip) {
  const old = one('SELECT signature_file FROM users WHERE id = ?', ctx.user.id)?.signature_file;
  if (old) {
    run('UPDATE users SET signature_file = NULL, signature_updated_at = NULL WHERE id = ?', ctx.user.id);
    deleteStored(old);
    audit(ctx.user.id, 'user', ctx.user.id, 'Assinatura salva removida', {}, ip);
  }
  return mySignature(ctx);
}
export function mySignatureImage(ctx) {
  const f = one('SELECT signature_file FROM users WHERE id = ?', ctx.user.id)?.signature_file;
  if (!f) throw notFound();
  return { stored_name: f, mime: f.endsWith('.png') ? 'image/png' : f.endsWith('.webp') ? 'image/webp' : 'image/jpeg' };
}
