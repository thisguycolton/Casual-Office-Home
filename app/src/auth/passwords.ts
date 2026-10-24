import { hash, verify, Algorithm } from '@node-rs/argon2';
import { badRequest } from '../errors.ts';

export const MIN_PASSWORD = 12;
const MAX_PASSWORD_BYTES = 256; // bound the work an unauthenticated caller can force

// OWASP-recommended argon2id baseline (19 MiB, t=2, p=1).
const OPTS = { algorithm: Algorithm.Argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;

export function checkPasswordPolicy(pw: unknown): string {
  if (typeof pw !== 'string') throw badRequest('invalid_password', 'Password must be a string');
  if (pw.length < MIN_PASSWORD) throw badRequest('weak_password', `Password must be at least ${MIN_PASSWORD} characters`);
  if (Buffer.byteLength(pw, 'utf8') > MAX_PASSWORD_BYTES) throw badRequest('invalid_password', 'Password is too long');
  return pw;
}

export const hashPassword = (pw: string) => hash(pw, OPTS);

export async function verifyPassword(stored: string, pw: string): Promise<boolean> {
  try { return await verify(stored, pw); } catch { return false; }
}

// Verified against when the account does not exist, so response time does not reveal which emails are registered.
let dummy: Promise<string> | null = null;
export async function dummyVerify(pw: string): Promise<void> {
  dummy ??= hashPassword('not-a-real-password-for-timing');
  await verifyPassword(await dummy, pw);
}
