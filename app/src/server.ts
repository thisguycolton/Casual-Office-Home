import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, type Config } from './config.ts';

/** Editors served as static bundles under /editors/<name>/. */
export const EDITORS = ['docs', 'sheets', 'slides', 'pdf'] as const;

export async function buildServer(config: Config): Promise<FastifyInstance> {
  const app = Fastify({ logger: true, trustProxy: true });

  app.get('/api/health', async () => ({ ok: true }));

  // Editor bundles: each is a self-contained static site served from our own origin.
  for (const name of EDITORS) {
    const root = join(config.editorsDir, name);
    if (!existsSync(root)) {
      app.log.warn(`editor bundle missing: ${root}`);
      continue;
    }
    await app.register(fastifyStatic, {
      root,
      prefix: `/editors/${name}/`,
      decorateReply: false,
      index: ['index.html', 'embed.html'],
      // Never let the browser reuse a stale editor shell; hashed assets are immutable.
      cacheControl: true,
      maxAge: '1h',
    });
  }
  // Docs fonts are requested at ../fonts relative to the embed page.
  const fonts = join(config.editorsDir, 'fonts');
  if (existsSync(fonts)) {
    await app.register(fastifyStatic, {
      root: fonts,
      prefix: '/editors/fonts/',
      decorateReply: false,
      maxAge: '30d',
      immutable: true,
    });
  }

  if (existsSync(config.publicDir)) {
    await app.register(fastifyStatic, { root: config.publicDir, prefix: '/' });
  }
  return app;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const config = loadConfig();
  const app = await buildServer(config);
  await app.listen({ port: config.port, host: config.host });
}
