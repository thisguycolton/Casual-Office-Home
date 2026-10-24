/** Central, validated configuration. All runtime settings come from environment variables. */
import { join } from 'node:path';

export interface Config {
  port: number;
  host: string;
  dataDir: string;
  dbPath: string;
  blobDir: string;
  tmpDir: string;
  migrationsDir: string;
  templatesDir: string;
  /** Directory holding the built editor bundles (docs, sheets, slides, pdf, fonts). */
  editorsDir: string;
  /** Directory holding the built central web UI. */
  publicDir: string;
  maxUploadBytes: number;
  /** 0 = unlimited. */
  userQuotaBytes: number;
  keepVersions: number;
  sessionTtlMs: number;
  secureCookies: boolean;
  allowRegistration: boolean;
  bootstrapAdmin: { email: string; password: string } | null;
  trustProxy: boolean;
  /** Disable only in tests. */
  rateLimit: boolean;
}

function int(env: NodeJS.ProcessEnv, key: string, def: number, min = 0): number {
  const raw = env[key];
  if (raw === undefined || raw === '') return def;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < min) throw new Error(`${key} must be an integer >= ${min}, got "${raw}"`);
  return n;
}
function bool(env: NodeJS.ProcessEnv, key: string, def: boolean): boolean {
  const raw = env[key]?.toLowerCase();
  if (raw === undefined || raw === '') return def;
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  throw new Error(`${key} must be a boolean, got "${env[key]}"`);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const port = int(env, 'PORT', 3000, 1);
  if (port > 65535) throw new Error(`PORT out of range: ${port}`);
  const dataDir = env.DATA_DIR ?? '/data';
  const appRoot = env.APP_ROOT ?? '/app';
  const email = env.BOOTSTRAP_ADMIN_EMAIL?.trim();
  const password = env.BOOTSTRAP_ADMIN_PASSWORD;
  if ((email && !password) || (!email && password)) {
    throw new Error('BOOTSTRAP_ADMIN_EMAIL and BOOTSTRAP_ADMIN_PASSWORD must be set together');
  }
  return {
    port,
    host: env.HOST ?? '0.0.0.0',
    dataDir,
    dbPath: join(dataDir, 'app.db'),
    blobDir: join(dataDir, 'blobs'),
    tmpDir: join(dataDir, 'tmp'),
    migrationsDir: env.MIGRATIONS_DIR ?? join(appRoot, 'migrations'),
    templatesDir: env.TEMPLATES_DIR ?? join(appRoot, 'templates'),
    editorsDir: env.EDITORS_DIR ?? join(appRoot, 'editors'),
    publicDir: env.PUBLIC_DIR ?? join(appRoot, 'public'),
    maxUploadBytes: int(env, 'MAX_UPLOAD_MB', 500, 1) * 1024 * 1024,
    userQuotaBytes: int(env, 'USER_QUOTA_MB', 0, 0) * 1024 * 1024,
    keepVersions: int(env, 'KEEP_VERSIONS', 5, 0),
    sessionTtlMs: int(env, 'SESSION_TTL_HOURS', 24 * 14, 1) * 3600_000,
    secureCookies: bool(env, 'SECURE_COOKIES', true),
    allowRegistration: bool(env, 'ALLOW_REGISTRATION', false),
    bootstrapAdmin: email && password ? { email, password } : null,
    trustProxy: bool(env, 'TRUST_PROXY', true),
    rateLimit: bool(env, 'RATE_LIMIT', true),
  };
}
