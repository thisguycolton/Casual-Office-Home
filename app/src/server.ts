import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, type Config } from './config.ts';
import { openDb, type Db } from './db.ts';
import { registerAdminRoutes } from './admin/routes.ts';
import { registerAuthHook } from './auth/plugin.ts';
import { registerAuthRoutes } from './auth/routes.ts';
import { pruneSessions } from './auth/sessions.ts';
import { countUsers, createUser, findByEmail } from './auth/users.ts';
import { AppError } from './errors.ts';
import { BlobStore } from './files/blobs.ts';
import { registerFileRoutes } from './files/routes.ts';
import { CollabClient } from './collab/client.ts';
import { registerCollabRoutes } from './collab/routes.ts';

/** Editors served as static bundles under /editors/<name>/. */
export const EDITORS = ['docs', 'sheets', 'slides', 'pdf'] as const;

// Strict policy for the application itself. Editor bundles (under /editors/) have their own, looser needs.
const appCsp = (extraConnect: string) => "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; " +
  `font-src 'self' data:; connect-src 'self' ${extraConnect}; frame-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'self'`;

export async function buildServer(config: Config, existingDb?: Db): Promise<FastifyInstance> {
  const app = Fastify({ logger: process.env.LOG_LEVEL !== 'silent' && { level: process.env.LOG_LEVEL ?? 'info' }, trustProxy: config.trustProxy, bodyLimit: 256 * 1024 });
  const db = existingDb ?? openDb(config.dbPath, config.migrationsDir);
  const APP_CSP = appCsp(config.cspConnectExtra);
  const blobs = new BlobStore(config.blobDir, config.tmpDir);
  await blobs.init();
  app.decorate('ctx', { config, db, blobs, collab: new CollabClient(config) });

  if (config.bootstrapAdmin && !findByEmail(db, config.bootstrapAdmin.email.toLowerCase()) && countUsers(db) === 0) {
    await createUser(db, { ...config.bootstrapAdmin, displayName: 'Administrator', role: 'admin' });
    app.log.info(`bootstrap administrator created: ${config.bootstrapAdmin.email} (remove BOOTSTRAP_ADMIN_* from .env now)`);
  }

  await app.register(cookie);
  if (config.rateLimit) await app.register(rateLimit, { global: false });

  app.addHook('onSend', async (req, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    const p = req.url.split('?')[0]!;
    if (p.startsWith('/api/')) {
      if (!reply.hasHeader('Cache-Control')) reply.header('Cache-Control', 'no-store');
      if (!reply.hasHeader('Content-Security-Policy')) reply.header('Content-Security-Policy', APP_CSP);
    } else if (!p.startsWith('/editors/') && !reply.hasHeader('Content-Security-Policy')) {
      reply.header('Content-Security-Policy', APP_CSP);
    }
  });

  app.setErrorHandler((err: Error & { statusCode?: number; code?: string }, req, reply) => {
    if (err instanceof AppError) return reply.code(err.status).send({ error: err.code, message: err.message });
    const status = err.statusCode ?? 500;
    if (status >= 500) { req.log.error({ err }, 'unhandled error'); return reply.code(500).send({ error: 'internal', message: 'Internal server error' }); }
    return reply.code(status).send({ error: err.code ?? 'bad_request', message: err.message });
  });

  registerAuthHook(app);
  app.get('/api/health', async () => ({ ok: true }));
  registerAuthRoutes(app);
  const files = registerFileRoutes(app);
  registerCollabRoutes(app, files);
  registerAdminRoutes(app, files);

  // Editor bundles: each is a self-contained static site served from our own origin.
  for (const name of EDITORS) {
    const root = join(config.editorsDir, name);
    if (!existsSync(root)) { app.log.warn(`editor bundle missing: ${root}`); continue; }
    await app.register(fastifyStatic, { root, prefix: `/editors/${name}/`, decorateReply: false, index: ['index.html', 'embed.html'], maxAge: '1h' });
  }
  const fonts = join(config.editorsDir, 'fonts');
  if (existsSync(fonts)) await app.register(fastifyStatic, { root: fonts, prefix: '/editors/fonts/', decorateReply: false, maxAge: '30d', immutable: true });

  const hasUi = existsSync(join(config.publicDir, 'index.html'));
  if (hasUi) await app.register(fastifyStatic, { root: config.publicDir, prefix: '/', maxAge: '1h', decorateReply: true });
  app.setNotFoundHandler((req, reply) => {
    const p = req.url.split('?')[0]!;
    if (hasUi && req.method === 'GET' && !p.startsWith('/api/') && !p.startsWith('/editors/') && (req.headers.accept ?? '').includes('text/html')) {
      return reply.header('Cache-Control', 'no-cache').sendFile('index.html');
    }
    return reply.code(404).send({ error: 'not_found', message: 'Not found' });
  });

  const timer = setInterval(() => { try { pruneSessions(db); } catch { /* ignore */ } }, 60 * 60_000);
  timer.unref();
  app.addHook('onClose', async () => { clearInterval(timer); if (!existingDb) db.close(); });
  return app;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const config = loadConfig();
  const app = await buildServer(config);
  await app.listen({ port: config.port, host: config.host });
}
