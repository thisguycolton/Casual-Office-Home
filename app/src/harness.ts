import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { loadConfig, type Config } from './config.ts';
import { buildServer } from './server.ts';
import { createUser } from './auth/users.ts';

export const HOST = 'app.test';
export const ORIGIN = `http://${HOST}`;
export const PASSWORD = 'correct horse battery';

export interface TestApp { app: FastifyInstance; config: Config; dir: string; close(): Promise<void> }

export async function startApp(env: Record<string, string> = {}): Promise<TestApp> {
  const dir = mkdtempSync(join(tmpdir(), 'casual-test-'));
  const root = resolve(import.meta.dirname, '..');
  const config = loadConfig({
    DATA_DIR: dir, APP_ROOT: root, EDITORS_DIR: join(dir, 'no-editors'), PUBLIC_DIR: join(dir, 'no-ui'),
    SECURE_COOKIES: 'false', RATE_LIMIT: 'false', LOG_LEVEL: 'silent', ...env,
  });
  const app = await buildServer(config);
  return { app, config, dir, close: async () => { await app.close(); rmSync(dir, { recursive: true, force: true }); } };
}

/** A tiny cookie-jar HTTP client over fastify.inject(), behaving like a browser session. */
export class Client {
  cookie = '';
  csrf = '';
  readonly t: TestApp;
  constructor(t: TestApp) { this.t = t; }

  async req(method: string, url: string, opts: { body?: unknown; raw?: Buffer | string; headers?: Record<string, string>; csrf?: boolean; origin?: boolean } = {}) {
    const headers: Record<string, string> = { host: HOST, ...(opts.headers ?? {}) };
    if (opts.origin !== false && method !== 'GET') headers.origin ??= ORIGIN;
    if (this.cookie) headers.cookie = this.cookie;
    if (this.csrf && opts.csrf !== false) headers['x-csrf-token'] ??= this.csrf;
    let payload: string | Buffer | undefined;
    if (opts.raw !== undefined) { payload = opts.raw; headers['content-type'] ??= 'application/octet-stream'; }
    else if (opts.body !== undefined) { payload = JSON.stringify(opts.body); headers['content-type'] = 'application/json'; }
    const res = await this.t.app.inject({ method: method as 'GET', url, headers, payload });
    const set = res.headers['set-cookie'];
    const c = Array.isArray(set) ? set[0] : set;
    if (c) { const kv = c.split(';')[0]!; this.cookie = kv.endsWith('=') ? '' : kv; }
    let json: any; try { json = res.json(); } catch { json = undefined; }
    return { status: res.statusCode, json, body: res.rawPayload, headers: res.headers };
  }
  get = (url: string) => this.req('GET', url);
  post = (url: string, body?: unknown) => this.req('POST', url, { body });
  patch = (url: string, body?: unknown) => this.req('PATCH', url, { body });
  del = (url: string) => this.req('DELETE', url);

  async login(email: string, password = PASSWORD) {
    const r = await this.req('POST', '/api/auth/login', { body: { email, password } });
    if (r.status === 200) this.csrf = r.json.csrfToken;
    return r;
  }
  upload(name: string, data: Buffer | string, parentId?: string) {
    const q = new URLSearchParams({ name }); if (parentId) q.set('parentId', parentId);
    return this.req('POST', `/api/files?${q}`, { raw: typeof data === 'string' ? Buffer.from(data) : data });
  }
}

/** Creates a user directly and returns a logged-in client. */
export async function userClient(t: TestApp, email: string, role: 'user' | 'admin' = 'user'): Promise<Client> {
  await createUser(t.app.ctx.db, { email, password: PASSWORD, role });
  const c = new Client(t);
  const r = await c.login(email);
  if (r.status !== 200) throw new Error(`login failed for ${email}: ${r.status}`);
  return c;
}
