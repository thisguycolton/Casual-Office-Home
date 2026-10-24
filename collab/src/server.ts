import { createServer, type Server as HttpServer } from 'node:http';
import { Hocuspocus } from '@hocuspocus/server';
import { WebSocketServer } from 'ws';
import { arbitrate, SEED_TIMEOUT_MS, type ArbiterState, type Candidate } from './arbiter.ts';
import { TokenError, verifyToken } from './token.ts';

export interface CollabConfig {
  port: number;
  host: string;
  secret: string;
  /** If non-empty, WebSocket upgrades must come from one of these origins. */
  allowedOrigins: string[];
  maxPayloadBytes: number;
  seedTimeoutMs: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): CollabConfig {
  const secret = env.COLLAB_JWT_SECRET ?? '';
  if (secret.length < 32) throw new Error('COLLAB_JWT_SECRET must be set to at least 32 characters');
  return {
    port: Number(env.PORT ?? 1234), host: env.HOST ?? '0.0.0.0', secret,
    allowedOrigins: (env.ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    maxPayloadBytes: Number(env.MAX_PAYLOAD_MB ?? 32) * 1024 * 1024,
    seedTimeoutMs: Number(env.SEED_TIMEOUT_MS ?? SEED_TIMEOUT_MS),
  };
}

const DOC_NAME = /^[0-9a-f-]{36}$/;
interface Ctx { userId: string; name: string; role: 'editor' | 'viewer' }

export interface Running { server: HttpServer; hocuspocus: Hocuspocus; close(): Promise<void>; port: number }

/**
 * Authenticated, ephemeral Hocuspocus service.
 *  - Every connection must present a signed token naming exactly this room; viewers are read-only server-side.
 *  - Nothing is persisted: a room exists only while someone is connected. The app's stored file is the source of truth.
 *  - The only HTTP routes are /health and the revocation hook; there is no REST, AI, proxy or admin surface.
 */
export async function start(cfg: CollabConfig): Promise<Running> {
  const arb = new Map<string, ArbiterState>();

  const hocuspocus = new Hocuspocus({
    quiet: true,
    // Sockets that never authenticate are dropped instead of lingering.
    timeout: 10_000,
    async onAuthenticate({ token, documentName, connection }): Promise<Ctx> {
      if (!DOC_NAME.test(documentName)) throw new Error('forbidden');
      let claims;
      try { claims = verifyToken(cfg.secret, token); } catch (e) { throw new Error(e instanceof TokenError ? 'forbidden' : 'error'); }
      if (claims.purpose === 'kick' || claims.file_id !== documentName) throw new Error('forbidden');
      connection.readOnly = claims.role !== 'editor';
      return { userId: claims.sub, name: claims.name, role: claims.role };
    },
    // NOTE: Hocuspocus attributes every awareness update to the room creator's socket/context, so neither can be used to
    // tell who sent it. The room's own connection table maps each connection to the awareness client ids it controls.
    async onAwarenessUpdate({ document, documentName, awareness }) {
      const state = arb.get(documentName) ?? { bad: new Set<number>(), timer: null }; arb.set(documentName, state);
      // Recomputed on every pass (including the stall timer's re-run) so it always reflects who is connected NOW.
      const run = () => {
        const w = new Set<number>();
        const conns = (document as unknown as { connections: Map<unknown, { clients: Set<number>; connection: { context?: Ctx } }> }).connections;
        for (const { clients, connection } of conns.values()) if (connection.context?.role === 'editor') for (const id of clients) w.add(id);
        const live = new Map<number, Candidate>();
        for (const [id, s] of awareness.getStates()) live.set(id, { clientId: id, writable: w.has(id), canSeed: !!(s as { canSeed?: boolean })?.canSeed });
        arbitrate(document.getMap('meta'), live, state, (fn) => document.transact(fn, 'arbiter'), run, cfg.seedTimeoutMs);
      };
      run();
    },
    async afterUnloadDocument({ documentName }) {
      const s = arb.get(documentName); if (s?.timer) clearTimeout(s.timer);
      arb.delete(documentName);
    },
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: cfg.maxPayloadBytes });
  const server = createServer((req, res) => {
    const json = (code: number, body: unknown) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    const path = (req.url ?? '').split('?')[0];
    if (req.method === 'GET' && path === '/health') return json(200, { ok: true, rooms: hocuspocus.getDocumentsCount(), connections: hocuspocus.getConnectionsCount() });
    if (req.method === 'POST' && path === '/internal/kick') {
      const chunks: Buffer[] = []; let size = 0;
      req.on('data', (c: Buffer) => { size += c.length; if (size < 4096) chunks.push(c); });
      req.on('end', () => {
        try {
          const auth = /^Bearer (.+)$/.exec(String(req.headers.authorization ?? ''))?.[1];
          const claims = verifyToken(cfg.secret, auth);
          if (claims.purpose !== 'kick') return json(403, { error: 'forbidden' });
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { file_id?: string; user_id?: string };
          if (!body.file_id && !body.user_id) return json(400, { error: 'file_id or user_id required' });
          if (body.file_id && !DOC_NAME.test(body.file_id)) return json(400, { error: 'invalid file_id' });
          const docs = body.file_id ? [hocuspocus.documents.get(body.file_id)] : [...hocuspocus.documents.values()];
          let kicked = 0;
          for (const conn of docs.flatMap((d) => d?.getConnections() ?? [])) {
            const c = (conn as unknown as { context?: Ctx }).context;
            if (!body.user_id || c?.userId === body.user_id) { conn.close({ code: 4403, reason: 'access revoked' }); kicked++; }
          }
          json(200, { kicked });
        } catch { json(401, { error: 'unauthorized' }); }
      });
      return;
    }
    json(404, { error: 'not_found' });
  });

  server.on('upgrade', (req, socket, head) => {
    const origin = req.headers.origin;
    if (cfg.allowedOrigins.length && (!origin || !cfg.allowedOrigins.includes(origin))) { socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (ws) => hocuspocus.handleConnection(ws, req));
  });

  await new Promise<void>((resolve) => server.listen(cfg.port, cfg.host, resolve));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : cfg.port;
  return {
    server, hocuspocus, port,
    async close() {
      for (const s of arb.values()) if (s.timer) clearTimeout(s.timer);
      wss.clients.forEach((c) => c.terminate()); hocuspocus.closeConnections();
      await new Promise((r) => server.close(r)); await hocuspocus.destroy?.();
    },
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const cfg = loadConfig();
  const r = await start(cfg);
  console.log(`collab listening on ${cfg.host}:${r.port}`);
  const stop = () => { void r.close().then(() => process.exit(0)); };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
}
