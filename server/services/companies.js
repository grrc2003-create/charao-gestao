// Empresas (Configurações → Empresas): a empresa de cada pessoa e de cada projeto.
// 'grupo' = Charão e LuS · 'parceira' = outra empresa cuja equipe é gerenciada aqui · 'terceirizada'.
// A empresa não muda o acesso; só quem é de empresa de fora do grupo vê apenas as pessoas da própria empresa
// (regra em lib/permissions.js → canSeeUser). Administradores veem todos.
import { all, one, run, tx } from '../db.js';
import { badRequest, forbidden, notFound, str, oneOf, intOrNull } from '../lib/http.js';
import { isAdmin } from '../lib/permissions.js';
import { audit } from './audit.js';
import { saveImageFromDataUrl, deleteStored, isPdf } from './files.js';

export const COMPANY_KINDS = ['grupo', 'parceira', 'terceirizada'];
export const KIND_LABEL = { grupo: 'Do grupo', parceira: 'Outra empresa (equipe gerenciada)', terceirizada: 'Terceirizada' };

export const defaultCompanyId = () => one(`SELECT id FROM companies WHERE group_key = 'charao'`)?.id ?? null;
export const companyById = id => (id ? one('SELECT * FROM companies WHERE id = ?', id) : null);

export function listCompanies({ includeInactive = false } = {}) {
  const use = new Map(all(`SELECT company_id AS id, COUNT(*) AS n FROM users WHERE company_id IS NOT NULL GROUP BY company_id`).map(r => [r.id, r.n]));
  const proj = new Map(all(`SELECT company_id AS id, COUNT(*) AS n FROM projects WHERE company_id IS NOT NULL GROUP BY company_id`).map(r => [r.id, r.n]));
  return all(`SELECT * FROM companies ${includeInactive ? '' : 'WHERE active = 1'} ORDER BY kind <> 'grupo', sort_order, name COLLATE NOCASE`)
    .map(c => ({ ...c, people: use.get(c.id) || 0, projects: proj.get(c.id) || 0, is_default: c.group_key === 'charao', logo_url: logoUrl(c) }));
}

// Empresa escolhida num cadastro: precisa existir e estar ativa (a que a pessoa/projeto já tem continua valendo)
export function resolveCompany(input, current = null) {
  const id = intOrNull(input);
  if (!id) return null;
  const c = companyById(id);
  if (!c || (!c.active && id !== current)) throw badRequest('Empresa inválida ou inativa.');
  return id;
}

// Nome gravado em users.company (rótulo exibido nas listas): só quando não é a empresa principal
export const companyLabel = id => { const c = companyById(id); return c && c.group_key !== 'charao' ? c.name : null; };

// Grava a empresa da pessoa (company_id + rótulo). Aceita o nome digitado (terceirizado, formulário antigo): procura ou cadastra.
export function applyUserCompany(userId, body, { fallback = null, only = null } = {}) {
  const u = one('SELECT id, company_id, is_external FROM users WHERE id = ?', userId);
  if (!u) return;
  let id;
  if (body.company_id !== undefined) id = body.company_id === '' || body.company_id === null ? null : resolveCompany(body.company_id, u.company_id);
  else if (typeof body.company === 'string') id = findOrCreateByName(body.company, u.is_external ? 'terceirizada' : 'parceira');
  else id = u.company_id ?? fallback;
  if (!id && !u.is_external) id = defaultCompanyId();
  // Quem é de empresa de fora do grupo só cadastra pessoas na própria empresa
  if (only && id !== only) { if (body.company_id !== undefined || typeof body.company === 'string') throw badRequest('Você só pode cadastrar pessoas da sua empresa.'); id = only; }
  run('UPDATE users SET company_id = ?, company = ? WHERE id = ?', id, companyLabel(id), userId);
}
function findOrCreateByName(name, kind) {
  const n = String(name || '').trim().slice(0, 160);
  if (!n) return null;
  const ex = one('SELECT id FROM companies WHERE name = ? COLLATE NOCASE', n);
  if (ex) return ex.id;
  return Number(run('INSERT INTO companies (name, kind, sort_order) VALUES (?,?,10)', n, kind).lastInsertRowid);
}

// Lista editável (administrador): nome, tipo, CNPJ, ativa. As empresas do grupo não mudam de tipo nem são excluídas.
export function saveCompanies(ctx, list, ip) {
  if (!isAdmin(ctx.user)) throw forbidden('Somente administradores alteram o cadastro de empresas.');
  if (!Array.isArray(list)) throw badRequest('Lista de empresas inválida.');
  const before = listCompanies({ includeInactive: true });
  const byId = new Map(before.map(c => [c.id, c]));
  const seen = new Set();
  const rows = list.map((x, i) => {
    const name = str(x.name, { max: 160, required: true, label: 'Nome da empresa' });
    const key = name.toLowerCase();
    if (seen.has(key)) throw badRequest(`Empresa repetida: ${name}.`);
    seen.add(key);
    const id = intOrNull(x.id);
    if (id && !byId.has(id)) throw notFound('Empresa não encontrada.');
    const cur = id ? byId.get(id) : null;
    const kind = cur?.group_key ? 'grupo' : oneOf(x.kind, COMPANY_KINDS.filter(k => k !== 'grupo'), 'Tipo da empresa', 'parceira');
    const active = cur?.is_default ? 1 : x.active === false || x.active === 0 || x.active === '0' ? 0 : 1;
    return { id, name, kind, cnpj: str(x.cnpj, { max: 20, label: 'CNPJ' }) || null, active, sort_order: i + 1 };
  });
  const keep = new Set(rows.filter(r => r.id).map(r => r.id));
  const removed = before.filter(c => !keep.has(c.id));
  for (const c of removed) {
    if (c.group_key) throw badRequest(`${c.name} é empresa do grupo e não pode ser excluída.`);
    if (c.people || c.projects) throw badRequest(`${c.name} está em uso (${c.people} pessoa(s), ${c.projects} projeto(s)). Inative-a em vez de excluir.`);
  }
  tx(() => {
    for (const c of removed) run('DELETE FROM companies WHERE id = ?', c.id);
    for (const r of rows) {
      if (r.id) run(`UPDATE companies SET name = ?, kind = ?, cnpj = ?, active = ?, sort_order = ?, updated_at = datetime('now') WHERE id = ?`, r.name, r.kind, r.cnpj, r.active, r.sort_order, r.id);
      else r.id = Number(run('INSERT INTO companies (name, kind, cnpj, active, sort_order) VALUES (?,?,?,?,?)', r.name, r.kind, r.cnpj, r.active, r.sort_order).lastInsertRowid);
    }
    // Rótulo das pessoas acompanha o nome
    for (const r of rows) run('UPDATE users SET company = ? WHERE company_id = ?', companyLabel(r.id), r.id);
    audit(ctx.user.id, 'company', null, 'Cadastro de empresas atualizado', {
      empresas: rows.map(r => `${r.name} (${KIND_LABEL[r.kind]}${r.active ? '' : ', inativa'})`), excluidas: removed.map(c => c.name) }, ip);
  });
  return listCompanies({ includeInactive: true });
}

// ---------- Logo da empresa ----------
// Enviado: /api/companies/:id/logo · LuS sem envio: o logo que já existe no sistema · Charão: logo padrão do sistema
const BUILTIN_LOGO = { charao: '/assets/logo.webp', lus: '/assets/logo-lus-h.png' };
export const logoUrl = c => (c?.logo_file ? `/api/companies/${c.id}/logo?v=${c.logo_file.slice(0, 8)}` : BUILTIN_LOGO[c?.group_key] || null);

// Marca exibida para quem está usando o sistema: a da empresa dele (se tiver logo); senão, a padrão (null)
export function brandFor(user) {
  const c = user?.company_id ? companyById(user.company_id) : null;
  if (!c || c.group_key === 'charao' || !c.active) return null;
  const logo = logoUrl(c);
  return logo ? { id: c.id, name: c.name, logo } : null;
}

export function setCompanyLogo(ctx, id, body, ip) {
  if (!isAdmin(ctx.user)) throw forbidden('Somente administradores alteram o logo das empresas.');
  const c = companyById(id);
  if (!c) throw notFound('Empresa não encontrada.');
  if (c.group_key === 'charao') throw badRequest('O logo da empresa principal é o logo do sistema.');
  const saved = saveImageFromDataUrl(body.data);
  if (isPdf(saved.mime)) { deleteStored(saved.stored_name); throw badRequest('Envie uma imagem (PNG, JPG ou WEBP).'); }
  run(`UPDATE companies SET logo_file = ?, updated_at = datetime('now') WHERE id = ?`, saved.stored_name, id);
  if (c.logo_file) deleteStored(c.logo_file);
  audit(ctx.user.id, 'company', id, 'Logo da empresa alterado', { empresa: c.name }, ip);
  return { logo_url: logoUrl({ ...c, logo_file: saved.stored_name }) };
}
export function removeCompanyLogo(ctx, id, ip) {
  if (!isAdmin(ctx.user)) throw forbidden('Somente administradores alteram o logo das empresas.');
  const c = companyById(id);
  if (!c) throw notFound('Empresa não encontrada.');
  if (c.logo_file) {
    run(`UPDATE companies SET logo_file = NULL, updated_at = datetime('now') WHERE id = ?`, id);
    deleteStored(c.logo_file);
    audit(ctx.user.id, 'company', id, 'Logo da empresa removido', { empresa: c.name }, ip);
  }
  return { logo_url: logoUrl({ ...c, logo_file: null }) };
}
export function companyLogoFile(id) {
  const c = companyById(id);
  if (!c?.logo_file) throw notFound('Sem logo.');
  const ext = c.logo_file.split('.').pop();
  return { stored_name: c.logo_file, mime: { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' }[ext] || 'image/png' };
}
