import { randomUUID } from 'node:crypto';
import type { Db } from '../db.ts';
import type { User } from '../context.ts';
import { AppError, badRequest } from '../errors.ts';
import { checkPasswordPolicy, hashPassword } from './passwords.ts';

export interface UserRow { id: string; email: string; display_name: string; password_hash: string; role: 'user' | 'admin'; disabled: number }
export const toUser = (r: UserRow): User => ({ id: r.id, email: r.email, displayName: r.display_name, role: r.role, disabled: !!r.disabled });

const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;
export function validateEmail(raw: unknown): string {
  if (typeof raw !== 'string') throw badRequest('invalid_email', 'Email must be a string');
  const e = raw.trim().toLowerCase();
  if (e.length > 320 || !EMAIL.test(e)) throw badRequest('invalid_email', 'Email address is not valid');
  return e;
}
export function validateDisplayName(raw: unknown, fallback: string): string {
  if (raw === undefined || raw === null || raw === '') return fallback;
  if (typeof raw !== 'string') throw badRequest('invalid_name', 'Display name must be a string');
  const n = raw.trim();
  // eslint-disable-next-line no-control-regex
  if (!n || n.length > 80 || /[\u0000-\u001f\u007f]/.test(n)) throw badRequest('invalid_name', 'Display name is not valid');
  return n;
}

export const findByEmail = (db: Db, email: string) =>
  db.prepare('SELECT * FROM users WHERE email = ?').get(email) as UserRow | undefined;
export const findById = (db: Db, id: string) =>
  db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
export const countUsers = (db: Db) => (db.prepare('SELECT COUNT(*) c FROM users').get() as { c: number }).c;

export async function createUser(
  db: Db, input: { email: unknown; password: unknown; displayName?: unknown; role?: 'user' | 'admin' },
): Promise<User> {
  const email = validateEmail(input.email);
  const pw = checkPasswordPolicy(input.password);
  const displayName = validateDisplayName(input.displayName, email.split('@')[0]!);
  const passwordHash = await hashPassword(pw);
  const id = randomUUID();
  const now = Date.now();
  try {
    db.prepare('INSERT INTO users (id,email,display_name,password_hash,role,created_at,updated_at) VALUES (?,?,?,?,?,?,?)')
      .run(id, email, displayName, passwordHash, input.role ?? 'user', now, now);
  } catch (err) {
    if (/UNIQUE/.test((err as Error).message)) throw new AppError(409, 'email_taken', 'An account with that email already exists');
    throw err;
  }
  return toUser(findById(db, id)!);
}
