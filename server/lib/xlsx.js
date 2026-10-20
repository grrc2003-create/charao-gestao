// Leitura mínima de planilhas .xlsx (sem dependências): abre o zip, lê a primeira aba e devolve as linhas.
// Células de texto, número, booleano e datas (número serial do Excel nas colunas de data).
import { inflateRawSync } from 'node:zlib';

function unzip(buf) {
  // Fim do diretório central (assinatura 0x06054b50), procurado de trás para frente
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('arquivo não é um .xlsx válido');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = new Map();
  for (let k = 0; k < count; k++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('arquivo .xlsx corrompido');
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28), elen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32), local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nlen);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(start, start + csize);
    files.set(name, () => (method === 8 ? inflateRawSync(data) : data).toString('utf8'));
    p += 46 + nlen + elen + clen;
  }
  return files;
}

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const decode = s => s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => (e[0] === '#' ? String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ENT[e] ?? m));
const texts = xml => [...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>|<t\s*\/>/g)].map(m => decode(m[1] || '')).join('');
const colIndex = ref => { let n = 0; for (const ch of ref.replace(/\d+/g, '')) n = n * 26 + (ch.charCodeAt(0) - 64); return n - 1; };

// Linhas da primeira aba: matriz de valores (string | number | boolean | null)
export function readXlsx(buf) {
  const files = unzip(buf);
  const get = n => files.get(n)?.();
  const strings = [];
  const ss = get('xl/sharedStrings.xml');
  if (ss) for (const m of ss.matchAll(/<si>([\s\S]*?)<\/si>/g)) strings.push(texts(m[1]));
  // Primeira aba pela ordem do workbook
  let sheetPath = 'xl/worksheets/sheet1.xml';
  const wb = get('xl/workbook.xml'), rels = get('xl/_rels/workbook.xml.rels');
  const rid = wb && /<sheet\b[^>]*\br:id="([^"]+)"/.exec(wb)?.[1];
  if (rid && rels) {
    const t = new RegExp(`<Relationship\\b[^>]*Id="${rid}"[^>]*Target="([^"]+)"`).exec(rels)?.[1] || new RegExp(`<Relationship\\b[^>]*Target="([^"]+)"[^>]*Id="${rid}"`).exec(rels)?.[1];
    if (t) sheetPath = t.startsWith('/') ? t.slice(1) : `xl/${t.replace(/^\.\//, '')}`;
  }
  const sheet = get(sheetPath);
  if (!sheet) throw new Error('planilha sem abas');
  const rows = [];
  for (const rm of sheet.matchAll(/<row\b[^>]*?(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const row = [];
    for (const cm of (rm[1] || '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cm[1], inner = cm[2] || '';
      const ref = /\br="([A-Z]+\d+)"/.exec(attrs)?.[1];
      const t = /\bt="(\w+)"/.exec(attrs)?.[1];
      const v = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1];
      let val = null;
      if (t === 's') val = v !== undefined ? strings[Number(v)] ?? null : null;
      else if (t === 'inlineStr') val = texts(inner);
      else if (t === 'str' || t === 'e') val = v !== undefined ? decode(v) : null;
      else if (t === 'b') val = v === '1';
      else if (v !== undefined) val = Number(v);
      row[ref ? colIndex(ref) : row.length] = val;
    }
    rows.push(Array.from(row, x => (x === undefined ? null : x)));
  }
  return rows;
}

// Número serial do Excel (sistema 1900) → AAAA-MM-DD
export const serialToDate = n => new Date(Date.UTC(1899, 11, 30) + Math.round(n) * 86400e3).toISOString().slice(0, 10);
