// Espaço e uso (Configurações → só administradores): disco de dados do Render (banco + fotos/anexos) e tamanho do repositório no GitHub.
import fs from 'node:fs';
import path from 'node:path';
import { all, run, DATA_DIR, UPLOAD_DIR } from '../db.js';
import { today, daysBetween, addDays } from './metrics.js';

// Repositório do código (público). Pode ser trocado pela variável GITHUB_REPO no Render; GITHUB_TOKEN é opcional.
const GITHUB_REPO = process.env.GITHUB_REPO || 'grrc2003-create/charao-gestao';
const GB = 1024 ** 3;

// Colunas que guardam nomes de arquivos enviados (fotos, PDFs, logos, assinaturas)
const FILE_COLS = new Set(['stored_name', 'avatar_file', 'image_file', 'logo_file', 'signature_file']);
const AREA = [
  [/^(task_files|checklist_|recurrence_files)/, 'Tarefas e check-lists'],
  [/^field_/, 'Folha de Campo'],
  [/^payroll_/, 'Folha (Administrativa)'],
  [/^(finance_|reimbursement)/, 'Financeiro e reembolsos'],
  [/^process/, 'Processos da Empresa'],
  [/^quote_|^suppliers/, 'Cotações'],
  [/^(record_|project_records)/, 'Registros do projeto'],
  [/^(contract|measurement)/, 'Contratos e medições'],
  [/^sales_/, 'Vendas'],
  [/^users$/, 'Pessoas (fotos e assinaturas)'],
  [/^document_signatures/, 'Assinaturas de documentos'],
  [/^(companies|settings)/, 'Empresas (logos)'],
];
const areaOf = table => AREA.find(([re]) => re.test(table))?.[1] || 'Outros';

function fileOwners() {
  const owners = new Map();
  const tables = all(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`).map(r => r.name);
  for (const t of tables) {
    const cols = all(`PRAGMA table_info("${t}")`).map(c => c.name).filter(c => FILE_COLS.has(c));
    for (const c of cols) for (const r of all(`SELECT "${c}" AS f FROM "${t}" WHERE "${c}" IS NOT NULL AND "${c}" <> ''`)) owners.set(r.f, t);
  }
  return owners;
}

const sizeOf = f => { try { return fs.statSync(f).size; } catch { return 0; } };

function measure() {
  let disk = null;
  try {
    const s = fs.statfsSync(DATA_DIR);
    const total = s.blocks * s.bsize;
    disk = { total, free: s.bavail * s.bsize, used: total - s.bfree * s.bsize };
  } catch { /* sistema sem statfs: mostra só o que o sistema ocupa */ }
  const dbBytes = ['charao.db', 'charao.db-wal', 'charao.db-shm'].reduce((n, f) => n + sizeOf(path.join(DATA_DIR, f)), 0);
  const owners = fileOwners();
  const areas = new Map();
  let filesBytes = 0, filesCount = 0;
  const walk = dir => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      const size = sizeOf(p);
      filesBytes += size; filesCount++;
      const area = owners.has(e.name) ? areaOf(owners.get(e.name)) : 'Sem vínculo (arquivos soltos)';
      const a = areas.get(area) || { area, bytes: 0, count: 0 };
      a.bytes += size; a.count++;
      areas.set(area, a);
    }
  };
  try { walk(UPLOAD_DIR); } catch { /* pasta ainda não criada */ }
  return { disk, dbBytes, filesBytes, filesCount, areas: [...areas.values()].sort((a, b) => b.bytes - a.bytes) };
}

// Uma foto por dia (a mais recente do dia vale)
function snapshot(m) {
  run(`INSERT INTO storage_snapshots (day, disk_total, disk_used, db_bytes, files_bytes, files_count, created_at) VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(day) DO UPDATE SET disk_total = excluded.disk_total, disk_used = excluded.disk_used, db_bytes = excluded.db_bytes,
      files_bytes = excluded.files_bytes, files_count = excluded.files_count, created_at = excluded.created_at`,
    today(), m.disk?.total ?? null, m.disk?.used ?? null, m.dbBytes, m.filesBytes, m.filesCount, new Date().toISOString());
}
export function dailySnapshot() {
  try { snapshot(measure()); } catch (e) { console.error('[espaço]', e.message); }
}

const level = pct => (pct >= 85 ? 'critico' : pct >= 70 ? 'atencao' : 'ok');

export function diskReport() {
  const m = measure();
  snapshot(m);
  const sys = m.dbBytes + m.filesBytes;
  // Crescimento: do registro mais antigo dos últimos 30 dias até hoje (pelo que o sistema ocupa)
  const hist = all('SELECT day, disk_used, db_bytes, files_bytes FROM storage_snapshots WHERE day >= ? ORDER BY day', addDays(today(), -30));
  const first = hist[0];
  const days = first ? daysBetween(first.day, today()) : 0;
  const grown = first ? sys - (first.db_bytes + first.files_bytes) : 0;
  const perDay = days > 0 ? grown / days : null;
  const disk = m.disk ? { ...m.disk, pct: Math.round((m.disk.used / m.disk.total) * 1000) / 10 } : null;
  return {
    data_dir: DATA_DIR,
    is_render: !!process.env.RENDER,
    disk: disk ? { ...disk, level: level(disk.pct) } : null,
    system_bytes: sys,
    db_bytes: m.dbBytes,
    files_bytes: m.filesBytes,
    files_count: m.filesCount,
    areas: m.areas,
    growth: { days, bytes: grown, per_day: perDay, days_to_full: disk && perDay > 0 ? Math.floor(disk.free / perDay) : null },
    history: hist.map(h => ({ day: h.day, bytes: h.db_bytes + h.files_bytes, disk_used: h.disk_used })),
  };
}

// GitHub: tamanho do repositório (API pública; guardado por 1 hora para não gastar o limite de consultas)
let ghCache = null;
export async function githubReport({ fresh = false } = {}) {
  if (!fresh && ghCache && Date.now() - ghCache.at < 3600e3) return ghCache.data;
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'charao-gestao' };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  let data;
  try {
    const r = await fetch(`https://api.github.com/repos/${GITHUB_REPO}`, { headers, signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error(r.status === 404 ? 'Repositório não encontrado (privado ou nome diferente).' : r.status === 403 ? 'Limite de consultas do GitHub atingido; tente mais tarde.' : `GitHub respondeu ${r.status}.`);
    const j = await r.json();
    const bytes = (j.size || 0) * 1024;
    const pct = Math.round((bytes / GB) * 1000) / 10; // em relação a 1 GB (tamanho recomendado pelo GitHub)
    data = { ok: true, repo: j.full_name, url: j.html_url, private: !!j.private, bytes, pct_recommended: pct, level: level(pct),
      pushed_at: j.pushed_at, default_branch: j.default_branch, checked_at: new Date().toISOString() };
  } catch (e) {
    data = { ok: false, repo: GITHUB_REPO, error: e.name === 'TimeoutError' ? 'O GitHub não respondeu a tempo.' : e.message, checked_at: new Date().toISOString() };
  }
  ghCache = { at: Date.now(), data };
  return data;
}
