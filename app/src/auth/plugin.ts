import type { FastifyInstance, FastifyRequest } from 'fastify';
import { AppError } from '../errors.ts';
import { resolveSession, safeEqual } from './sessions.ts';

export const cookieName = (secure: boolean) => (secure ? '__Host-sid' : 'sid');

/** Routes reachable without a session. Everything else under /api requires one. */
const PUBLIC = new Set(['/api/health', '/api/auth/login', '/api/auth/register', '/api/auth/reset', '/api/auth/config']);
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function sameOrigin(req: FastifyRequest): boolean {
  const origin = req.headers.origin;
  const host = req.headers.host;
  if (!origin || !host) return false;
  try { return new URL(origin).host === host; } catch { return false; }
}

/**
 * Authentication + CSRF for the whole /api surface.
 *  - Session cookie is looked up on every request (so a disabled user or revoked session is cut off immediately).
 *  - State-changing requests must carry a same-origin Origin header AND the per-session CSRF token.
 * This is enforced here on the server; hiding UI controls is never relied upon.
 */
export function registerAuthHook(app: FastifyInstance): void {
  app.decorateRequest('auth', null);
  app.addHook('onRequest', async (req) => {
    const path = req.url.split('?')[0]!;
    if (!path.startsWith('/api/')) return;
    const name = cookieName(app.ctx.config.secureCookies);
    req.auth = resolveSession(app.ctx.db, req.cookies?.[name], app.ctx.config.sessionTtlMs);

    if (!SAFE_METHODS.has(req.method)) {
      if (!sameOrigin(req)) throw new AppError(403, 'bad_origin', 'Cross-origin request rejected');
      if (!PUBLIC.has(path)) {
        const sent = req.headers['x-csrf-token'];
        if (!req.auth || typeof sent !== 'string' || !safeEqual(sent, req.auth.csrfToken)) {
          if (!req.auth) throw new AppError(401, 'unauthenticated', 'Sign in required');
          throw new AppError(403, 'bad_csrf', 'Missing or invalid CSRF token');
        }
      }
    }
    if (!PUBLIC.has(path) && !req.auth) throw new AppError(401, 'unauthenticated', 'Sign in required');
  });
}

export function requireAdmin(req: FastifyRequest): void {
  if (req.auth?.user.role !== 'admin') throw new AppError(403, 'forbidden', 'Administrator access required');
}
