import { createHmac, timingSafeEqual } from 'node:crypto';

export type CollabRole = 'editor' | 'viewer';
export interface Claims { sub: string; name: string; file_id: string; role: CollabRole; exp: number; iat: number; purpose?: 'room' | 'kick' }

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
const sign = (secret: string, data: string) => createHmac('sha256', secret).update(data).digest('base64url');

/** HS256 JWT. Hand-rolled (≈20 lines) so the algorithm is fixed and "alg: none"/key-confusion are impossible by construction. */
export function signToken(secret: string, claims: Omit<Claims, 'iat'>): string {
  const head = b64({ alg: 'HS256', typ: 'JWT' });
  const body = b64({ ...claims, iat: Math.floor(Date.now() / 1000) });
  return `${head}.${body}.${sign(secret, `${head}.${body}`)}`;
}

export class TokenError extends Error {}

export function verifyToken(secret: string, token: unknown, now = Date.now()): Claims {
  if (typeof token !== 'string' || token.length > 2048) throw new TokenError('malformed');
  const parts = token.split('.');
  if (parts.length !== 3) throw new TokenError('malformed');
  const [h, p, s] = parts as [string, string, string];
  let header: { alg?: string };
  try { header = JSON.parse(Buffer.from(h, 'base64url').toString('utf8')); } catch { throw new TokenError('malformed'); }
  if (header.alg !== 'HS256') throw new TokenError('bad algorithm');
  const expected = Buffer.from(sign(secret, `${h}.${p}`)), got = Buffer.from(s);
  if (expected.length !== got.length || !timingSafeEqual(expected, got)) throw new TokenError('bad signature');
  let c: Partial<Claims>;
  try { c = JSON.parse(Buffer.from(p, 'base64url').toString('utf8')); } catch { throw new TokenError('malformed'); }
  if (typeof c.exp !== 'number' || c.exp * 1000 <= now) throw new TokenError('expired');
  if (typeof c.sub !== 'string' || typeof c.file_id !== 'string' || (c.role !== 'editor' && c.role !== 'viewer')) throw new TokenError('bad claims');
  return { sub: c.sub, name: typeof c.name === 'string' ? c.name.slice(0, 80) : '', file_id: c.file_id, role: c.role, exp: c.exp, iat: c.iat ?? 0, purpose: c.purpose };
}
