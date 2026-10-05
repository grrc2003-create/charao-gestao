// Dados de DEMONSTRAÇÃO. Uso: `npm run seed` (recria o banco do zero!).
// Senha de todos os usuários de demonstração: charao2026
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DATA_DIR = process.env.DATA_DIR || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// Recria o banco limpo
for (const f of ['charao.db', 'charao.db-wal', 'charao.db-shm']) fs.rmSync(path.join(DATA_DIR, f), { force: true });
for (const f of fs.readdirSync(UPLOAD_DIR)) fs.rmSync(path.join(UPLOAD_DIR, f), { force: true });

const { migrate } = await import('./db.js');
const { seedDemo, DEMO_PASSWORD } = await import('./demo-data.js');
migrate();
const n = seedDemo();
console.log(`Seed concluído: ${n.users} usuários, ${n.projects} projetos, ${n.tasks} tarefas. Senha demo: ${DEMO_PASSWORD}`);
