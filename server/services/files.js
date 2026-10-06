// Armazenamento de anexos (imagens e PDF; referência e comprovação). Validação por assinatura binária,
// nunca pela extensão/mime informados pelo cliente.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { UPLOAD_DIR } from '../db.js';
import { badRequest } from '../lib/http.js';

const MAX_BYTES = 8 * 1024 * 1024;
const EXT_RE = /^[0-9a-f-]{36}\.(jpg|png|webp|svg|pdf)$/;

function sniff(buf) {
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { mime: 'image/jpeg', ext: 'jpg' };
  if (buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { mime: 'image/png', ext: 'png' };
  if (buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP') return { mime: 'image/webp', ext: 'webp' };
  if (buf.slice(0, 5).toString() === '%PDF-') return { mime: 'application/pdf', ext: 'pdf' };
  return null;
}

export const isPdf = mime => mime === 'application/pdf';

// Nome original exibido para PDFs (sem caminho nem caracteres de controle)
export function cleanFileName(name) {
  const n = String(name || '').split(/[\\/]/).pop().replace(/[\u0000-\u001f\u007f"<>]/g, '').trim().slice(0, 160);
  return n || null;
}

// Aceita imagens (JPG/PNG/WEBP) e PDF. O tipo é confirmado pela assinatura do conteúdo.
export function saveImageFromDataUrl(dataUrl) {
  if (typeof dataUrl !== 'string') throw badRequest('Arquivo inválido.');
  const m = /^data:(?:image\/[a-z+.-]+|application\/pdf);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!m) throw badRequest('Formato de arquivo inválido.');
  const buf = Buffer.from(m[1], 'base64');
  if (buf.length > MAX_BYTES) throw badRequest('Arquivo maior que 8 MB.');
  const kind = sniff(buf);
  if (!kind) throw badRequest('Apenas imagens JPG, PNG, WEBP ou arquivos PDF são aceitos.');
  const stored = `${crypto.randomUUID()}.${kind.ext}`;
  fs.writeFileSync(path.join(UPLOAD_DIR, stored), buf);
  return { stored_name: stored, mime: kind.mime, size: buf.length };
}

// Usado apenas pelo seed de demonstração (imagens SVG geradas internamente)
export function saveDemoSvg(svg) {
  const stored = `${crypto.randomUUID()}.svg`;
  fs.writeFileSync(path.join(UPLOAD_DIR, stored), svg);
  return { stored_name: stored, mime: 'image/svg+xml', size: Buffer.byteLength(svg) };
}

export function readStored(storedName) {
  if (!EXT_RE.test(storedName)) return null;
  const p = path.join(UPLOAD_DIR, storedName);
  return fs.existsSync(p) ? fs.readFileSync(p) : null;
}

export function deleteStored(storedName) {
  if (!EXT_RE.test(storedName)) return;
  fs.rmSync(path.join(UPLOAD_DIR, storedName), { force: true });
}

// Copia um arquivo armazenado para um novo nome (ex.: imagens do molde de recorrência para cada ocorrência)
export function copyStored(storedName) {
  const buf = readStored(storedName);
  if (!buf) return null;
  const ext = storedName.split('.').pop();
  const stored = `${crypto.randomUUID()}.${ext}`;
  fs.writeFileSync(path.join(UPLOAD_DIR, stored), buf);
  return { stored_name: stored, size: buf.length };
}
