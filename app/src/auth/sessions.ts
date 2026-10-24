import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Db } from '../db.ts';
import type { AuthInfo } from '../context.ts';
import { findById, toUser } from './users.ts';

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
export const newToken = () => randomBytes(32).toString('base64url');

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function createSession(db: Db, userId: string, ttlMs: number, meta: { ip?: string; ua?: string }) {
  const token = newToken();
  const csrf = newToken();
  const now = Date.now();
  db.prepare('INSERT INTO sessions (id_hash,user_id,csrf_token,created_at,expires_at,last_seen,user_agent,ip) VALUES (?,?,?,?,?,?,?,?)')
    .run(sha256(token), userId, csrf, now, now + ttlMs, now, meta.ua?.slice(0, 200) ?? null, meta.ip ?? null);
  return { token, csrf, expiresAt: now + ttlMs };
}

/** Resolves a cookie token to an authenticated user, or null. Expired sessions and disabled users never authenticate. */
export function resolveSession(db: Db, token: string | undefined, ttlMs: number): AuthInfo | null {
  if (!token || token.length > 100) return null;
  const hash = sha256(token);
  const s = db.prepare('SELECT * FROM sessions WHERE id_hash = ?').get(hash) as
    | { user_id: string; csrf_token: string; expires_at: number; last_seen: number } | undefined;
  if (!s) return null;
  const now = Date.now();
  if (s.expires_at <= now) { db.prepare('DELETE FROM sessions WHERE id_hash = ?').run(hash); return null; }
  const u = findById(db, s.user_id);
  if (!u || u.disabled) return null;
  // Sliding expiry, written at most every 5 minutes to avoid a write per request.
  if (now - s.last_seen > 5 * 60_000) {
    db.prepare('UPDATE sessions SET last_seen = ?, expires_at = ? WHERE id_hash = ?').run(now, now + ttlMs, hash);
  }
  return { user: toUser(u), csrfToken: s.csrf_token, sessionHash: hash };
}

export const destroySession = (db: Db, hash: string) => db.prepare('DELETE FROM sessions WHERE id_hash = ?').run(hash);
export const destroyUserSessions = (db: Db, userId: string, exceptHash?: string) =>
  db.prepare('DELETE FROM sessions WHERE user_id = ? AND id_hash IS NOT ?').run(userId, exceptHash ?? null);
export const pruneSessions = (db: Db) => db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(Date.now());
