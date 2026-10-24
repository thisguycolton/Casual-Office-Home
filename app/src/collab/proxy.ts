import type { IncomingMessage } from 'node:http';
import { connect, type Socket } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { cookieName } from '../auth/plugin.ts';
import { resolveSession } from '../auth/sessions.ts';

function cookieValue(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return undefined;
}

function reject(socket: Socket, status: string): void {
  socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

/**
 * Tunnels WebSocket upgrades at /collab to the internal collab service.
 *
 * The collab service is never reachable from outside. Before a single byte is forwarded we require a valid session and a
 * same-origin request (so another website cannot open a socket using the visitor's cookies). The session cookie is NOT
 * forwarded: collab authenticates with its own per-file token inside the protocol. Pure TCP piping — no WebSocket frames
 * are parsed or modified here.
 */
export function registerCollabProxy(app: FastifyInstance): void {
  const { config, db, collab } = app.ctx;
  if (!collab.enabled) return;
  const target = new URL(config.collabInternalUrl);

  app.server.on('upgrade', (req: IncomingMessage, socket: Socket, head: Buffer) => {
    const path = (req.url ?? '').split('?')[0];
    if (path !== '/collab') return; // other upgrades (none today) are not ours to handle
    socket.on('error', () => socket.destroy());

    const origin = req.headers.origin, host = req.headers.host;
    let sameOrigin = false;
    try { sameOrigin = !!origin && !!host && new URL(origin).host === host; } catch { /* malformed */ }
    if (!sameOrigin) return reject(socket, '403 Forbidden');
    const auth = resolveSession(db, cookieValue(req.headers.cookie, cookieName(config.secureCookies)), config.sessionTtlMs);
    if (!auth) return reject(socket, '401 Unauthorized');

    const upstream = connect(Number(target.port || 80), target.hostname);
    upstream.on('error', () => reject(socket, '502 Bad Gateway'));
    upstream.on('connect', () => {
      const headers: string[] = [];
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        const k = req.rawHeaders[i]!, v = req.rawHeaders[i + 1]!;
        if (/^(cookie|authorization|x-forwarded-.*|forwarded)$/i.test(k)) continue;
        headers.push(`${k}: ${v}`);
      }
      upstream.write(`GET / HTTP/1.1\r\n${headers.join('\r\n')}\r\n\r\n`);
      if (head.length) upstream.write(head);
      socket.pipe(upstream); upstream.pipe(socket);
    });
    socket.on('close', () => upstream.destroy());
    upstream.on('close', () => socket.destroy());
  });
}
