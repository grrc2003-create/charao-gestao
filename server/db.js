// Camada de dados: abre o SQLite e aplica migrações versionadas.
// Novas funcionalidades = novo arquivo em server/migrations (NNN_descricao.sql).
// Migrações já aplicadas nunca são reexecutadas, então os dados existentes são preservados.
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..');
export const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
export const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

export const db = new DatabaseSync(path.join(DATA_DIR, 'charao.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

export function migrate() {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')))`);
  const applied = new Set(db.prepare('SELECT version FROM schema_migrations').all().map(r => r.version));
  const dir = path.join(__dirname, 'migrations');
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort();
  for (const f of files) {
    if (applied.has(f)) continue;
    const sql = fs.readFileSync(path.join(dir, f), 'utf8');
    // Migrações que reconstroem tabelas desligam as FKs (fora da transação, exigência do SQLite)
    // para que DROP TABLE não apague em cascata arquivos e históricos; a integridade é conferida ao final.
    const fkOff = sql.startsWith('-- @foreign_keys_off');
    if (fkOff) db.exec('PRAGMA foreign_keys = OFF');
    try {
      tx(() => {
        db.exec(sql);
        if (fkOff) {
          const bad = db.prepare('PRAGMA foreign_key_check').all();
          if (bad.length) throw new Error(`Migração ${f} violou integridade referencial (${bad.length} registros).`);
        }
        db.prepare('INSERT INTO schema_migrations (version) VALUES (?)').run(f);
      });
    } finally {
      if (fkOff) db.exec('PRAGMA foreign_keys = ON');
    }
    console.log(`[db] migração aplicada: ${f}`);
  }
}

export function tx(fn) {
  db.exec('BEGIN');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

export const one = (sql, ...p) => db.prepare(sql).get(...p);
export const all = (sql, ...p) => db.prepare(sql).all(...p);
export const run = (sql, ...p) => db.prepare(sql).run(...p);
