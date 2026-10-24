import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { audit } from '../audit.ts';
import { AppError, badRequest } from '../errors.ts';
import { tx } from '../db.ts';
import { cookieName } from './plugin.ts';
import { checkPasswordPolicy, dummyVerify, hashPassword, verifyPassword } from './passwords.ts';
import { createSession, destroySession, destroyUserSessions, sha256 } from './sessions.ts';
import { createUser, findByEmail, findById, toUser, validateDisplayName, validateEmail } from './users.ts';

/** Per-account failed-login throttle (in addition to the per-IP route limit). */
const failures = new Map<string, { count: number; resetAt: number }>();
const MAX_FAILURES = 10, WINDOW_MS = 15 * 60_000;
function throttled(email: string): boolean {
  const f = failures.get(email);
  if (f && f.resetAt < Date.now()) { failures.delete(email); return false; }
  return !!f && f.count >= MAX_FAILURES;
}
function noteFailure(email: string): void {
  const f = failures.get(email);
  if (!f || f.resetAt < Date.now()) failures.set(email, { count: 1, resetAt: Date.now() + WINDOW_MS });
  else f.count++;
}
export const _resetThrottle = () => failures.clear();

export function registerAuthRoutes(app: FastifyInstance): void {
  const { db, config } = app.ctx;
  const limit = (max: number) => ({ rateLimit: config.rateLimit ? { max, timeWindow: '1 minute' } : (false as const) });

  function startSession(req: FastifyRequest, reply: FastifyReply, userId: string) {
    const s = createSession(db, userId, config.sessionTtlMs, { ip: req.ip, ua: req.headers['user-agent'] });
    reply.setCookie(cookieName(config.secureCookies), s.token, {
      path: '/', httpOnly: true, sameSite: 'lax', secure: config.secureCookies, expires: new Date(s.expiresAt),
    });
    return s;
  }

  const publicUser = (u: ReturnType<typeof toUser>) => ({ id: u.id, email: u.email, displayName: u.displayName, role: u.role });

  app.get('/api/auth/config', async () => ({ allowRegistration: config.allowRegistration }));

  app.post('/api/auth/login', { config: limit(20) }, async (req, reply) => {
    const body = (req.body ?? {}) as { email?: unknown; password?: unknown };
    if (typeof body.email !== 'string' || typeof body.password !== 'string' || body.password.length > 256) {
      throw badRequest('invalid_credentials', 'Email and password are required');
    }
    const email = body.email.trim().toLowerCase();
    if (throttled(email)) throw new AppError(429, 'too_many_attempts', 'Too many failed attempts. Try again later.');
    const row = findByEmail(db, email);
    const ok = row ? await verifyPassword(row.password_hash, body.password) : (await dummyVerify(body.password), false);
    if (!row || !ok || row.disabled) {
      noteFailure(email);
      audit(db, row?.id ?? null, 'login_failed', email, req.ip);
      throw new AppError(401, 'invalid_credentials', 'Invalid email or password');
    }
    failures.delete(email);
    const s = startSession(req, reply, row.id);
    audit(db, row.id, 'login', undefined, req.ip);
    return { user: publicUser(toUser(row)), csrfToken: s.csrf };
  });

  app.post('/api/auth/register', { config: limit(10) }, async (req, reply) => {
    if (!config.allowRegistration) throw new AppError(403, 'registration_disabled', 'Registration is disabled');
    const b = (req.body ?? {}) as Record<string, unknown>;
    const user = await createUser(db, { email: b.email, password: b.password, displayName: b.displayName });
    const s = startSession(req, reply, user.id);
    audit(db, user.id, 'register', undefined, req.ip);
    return { user: publicUser(user), csrfToken: s.csrf };
  });

  app.get('/api/auth/me', async (req) => ({ user: publicUser(req.auth!.user), csrfToken: req.auth!.csrfToken }));

  app.post('/api/auth/logout', async (req, reply) => {
    destroySession(db, req.auth!.sessionHash);
    audit(db, req.auth!.user.id, 'logout', undefined, req.ip);
    reply.clearCookie(cookieName(config.secureCookies), { path: '/' });
    return { ok: true };
  });

  app.patch('/api/auth/profile', async (req) => {
    const b = (req.body ?? {}) as { displayName?: unknown };
    const name = validateDisplayName(b.displayName, '');
    if (!name) throw badRequest('invalid_name', 'Display name is required');
    db.prepare('UPDATE users SET display_name = ?, updated_at = ? WHERE id = ?').run(name, Date.now(), req.auth!.user.id);
    return { user: publicUser(toUser(findById(db, req.auth!.user.id)!)) };
  });

  app.post('/api/auth/change-password', { config: limit(10) }, async (req) => {
    const b = (req.body ?? {}) as { currentPassword?: unknown; newPassword?: unknown };
    const row = findById(db, req.auth!.user.id)!;
    if (typeof b.currentPassword !== 'string' || !(await verifyPassword(row.password_hash, b.currentPassword))) {
      throw new AppError(403, 'wrong_password', 'Current password is incorrect');
    }
    const next = checkPasswordPolicy(b.newPassword);
    const h = await hashPassword(next);
    tx(db, () => {
      db.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?').run(h, Date.now(), row.id);
      destroyUserSessions(db, row.id, req.auth!.sessionHash); // sign out everywhere else
    });
    audit(db, row.id, 'password_changed', undefined, req.ip);
    return { ok: true };
  });

  // Redeem a one-time reset token minted by an administrator.
  app.post('/api/auth/reset', { config: limit(10) }, async (req) => {
    const b = (req.body ?? {}) as { token?: unknown; password?: unknown };
    if (typeof b.token !== 'string' || b.token.length > 100) throw badRequest('invalid_token', 'Invalid or expired token');
    const pw = checkPasswordPolicy(b.password);
    const h = await hashPassword(pw);
    const th = sha256(b.token);
    const done = tx(db, () => {
      const r = db.prepare('SELECT user_id, expires_at, used_at FROM password_resets WHERE token_hash = ?').get(th) as
        | { user_id: string; expires_at: number; used_at: number | null } | undefined;
      if (!r || r.used_at || r.expires_at < Date.now()) return null;
      db.prepare('UPDATE password_resets SET used_at = ? WHERE token_hash = ?').run(Date.now(), th);
      db.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?').run(h, Date.now(), r.user_id);
      destroyUserSessions(db, r.user_id);
      return r.user_id;
    });
    if (!done) throw badRequest('invalid_token', 'Invalid or expired token');
    audit(db, done, 'password_reset', undefined, req.ip);
    return { ok: true };
  });
}
