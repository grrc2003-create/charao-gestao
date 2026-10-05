// Autenticação: hash de senha (scrypt), sessões com token opaco em cookie HttpOnly,
// expiração deslizante e limitação de tentativas de login.
import crypto from 'node:crypto';
import { one, run } from '../db.js';
import { HttpError, parseCookies } from './http.js';

export const COOKIE = 'charao_sid';
const SESSION_HOURS = Number(process.env.SESSION_HOURS || 12);

export function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(pw, stored) {
  const [alg, saltB64, hashB64] = String(stored).split('$');
  if (alg !== 'scrypt') return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = crypto.scryptSync(pw, Buffer.from(saltB64, 'base64'), expected.length, { N: 16384, r: 8, p: 1 });
  return crypto.timingSafeEqual(actual, expected);
}

export function validatePasswordStrength(pw) {
  if (typeof pw !== 'string' || pw.length < 8) throw new HttpError(400, 'A senha deve ter pelo menos 8 caracteres.');
  if (!/[A-Za-z]/.test(pw) || !/\d/.test(pw)) throw new HttpError(400, 'A senha deve conter letras e números.');
  if (pw.length > 200) throw new HttpError(400, 'Senha muito longa.');
}

const sha = t => crypto.createHash('sha256').update(t).digest('hex');
const isoPlusHours = h => new Date(Date.now() + h * 3600e3).toISOString();

export function createSession(userId, req) {
  const token = crypto.randomBytes(32).toString('base64url');
  run('INSERT INTO sessions (token_hash, user_id, expires_at, ip, user_agent) VALUES (?,?,?,?,?)',
    sha(token), userId, isoPlusHours(SESSION_HOURS), clientIp(req), String(req.headers['user-agent'] || '').slice(0, 300));
  return token;
}

export function destroySession(req) {
  const t = parseCookies(req)[COOKIE];
  if (t) run('DELETE FROM sessions WHERE token_hash = ?', sha(t));
}

export function destroyUserSessions(userId) {
  run('DELETE FROM sessions WHERE user_id = ?', userId);
}

export function sessionCookie(token, req, maxAgeSec = SESSION_HOURS * 3600) {
  const secure = req.headers['x-forwarded-proto'] === 'https' || req.socket.encrypted ? '; Secure' : '';
  return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSec}${secure}`;
}

// Retorna o usuário autenticado (ou null) e renova a sessão.
export function authenticate(req) {
  const t = parseCookies(req)[COOKIE];
  if (!t) return null;
  const h = sha(t);
  const s = one('SELECT * FROM sessions WHERE token_hash = ?', h);
  if (!s) return null;
  if (s.expires_at < new Date().toISOString()) {
    run('DELETE FROM sessions WHERE token_hash = ?', h);
    return null;
  }
  const user = one('SELECT * FROM users WHERE id = ? AND active = 1', s.user_id);
  if (!user) return null;
  run('UPDATE sessions SET last_seen = datetime(\'now\'), expires_at = ? WHERE token_hash = ?', isoPlusHours(SESSION_HOURS), h);
  return user;
}

export function clientIp(req) {
  return String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
}

// Limita tentativas de login por IP+e-mail (em memória).
const attempts = new Map();
export function checkLoginRate(key) {
  const now = Date.now();
  const a = attempts.get(key);
  if (a && a.lockedUntil > now) {
    const min = Math.ceil((a.lockedUntil - now) / 60000);
    throw new HttpError(429, `Muitas tentativas. Tente novamente em ${min} min.`);
  }
}
export function registerLoginFailure(key) {
  const now = Date.now();
  const a = attempts.get(key) || { count: 0, lockedUntil: 0 };
  a.count++;
  if (a.count >= 5) { a.lockedUntil = now + 10 * 60e3; a.count = 0; }
  attempts.set(key, a);
}
export function clearLoginFailures(key) { attempts.delete(key); }
