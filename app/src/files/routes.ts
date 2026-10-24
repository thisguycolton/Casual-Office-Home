import type { FastifyInstance, FastifyReply } from 'fastify';
import { AppError, badRequest } from '../errors.ts';
import { canInline } from './kinds.ts';
import { FileService } from './service.ts';
import { ShareService } from './shares.ts';

function contentDisposition(kind: 'inline' | 'attachment', name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())}`;
}

function contentLength(h: Record<string, unknown>): number | undefined {
  const v = h['content-length'];
  const n = typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : undefined;
}

export function registerFileRoutes(app: FastifyInstance): FileService {
  const svc = new FileService(app.ctx);
  const shares = new ShareService(app.ctx, svc);
  const uid = (req: { auth: { user: { id: string } } | null }) => req.auth!.user.id;
  type P = { id: string };

  // Raw bodies (uploads and editor saves) arrive as streams and are metered/limited in BlobStore.receive().
  app.addContentTypeParser('*', (_req, payload, done) => done(null, payload));

  app.get('/api/files', async (req) => svc.list(uid(req), req.query as Record<string, unknown>));
  app.get('/api/storage', async (req) => svc.usage(uid(req)));
  app.get<{ Params: P }>('/api/files/:id', async (req) => svc.details(uid(req), req.params.id));

  app.post('/api/folders', async (req, reply) => {
    reply.code(201);
    return svc.createFolder(uid(req), req.ip, (req.body ?? {}) as Record<string, unknown>);
  });

  app.post('/api/files/new', async (req, reply) => {
    reply.code(201);
    return svc.createNew(uid(req), req.ip, (req.body ?? {}) as Record<string, unknown>);
  });

  // Upload: raw body, name/parent in the query string (one request per file → per-file progress in the UI).
  app.post('/api/files', async (req, reply) => {
    const q = req.query as { name?: unknown; parentId?: unknown };
    if (!req.body || typeof (req.body as { pipe?: unknown }).pipe !== 'function') throw badRequest('missing_body', 'Upload body is required');
    reply.code(201);
    return svc.upload(uid(req), req.ip, { name: q.name, parentId: q.parentId, body: req.body as NodeJS.ReadableStream, contentLength: contentLength(req.headers) });
  });

  app.patch<{ Params: P }>('/api/files/:id', async (req) =>
    svc.update(uid(req), req.ip, req.params.id, (req.body ?? {}) as Record<string, unknown>));

  app.post<{ Params: P }>('/api/files/:id/copy', async (req, reply) => {
    reply.code(201);
    return svc.copy(uid(req), req.ip, req.params.id, (req.body ?? {}) as Record<string, unknown>);
  });

  app.post<{ Params: P }>('/api/files/:id/open', async (req) => { svc.touchOpened(uid(req), req.params.id); return { ok: true }; });

  app.get<{ Params: P; Querystring: { inline?: string } }>('/api/files/:id/content', async (req, reply: FastifyReply) => {
    const f = svc.contentForRead(uid(req), req.params.id).row;
    const inline = req.query.inline === '1' && canInline(f.kind, f.mime);
    reply
      .header('Content-Type', inline ? f.mime : 'application/octet-stream')
      .header('Content-Disposition', contentDisposition(inline ? 'inline' : 'attachment', f.name))
      .header('Content-Length', f.size)
      .header('ETag', `"${f.version}"`)
      .header('X-File-Version', String(f.version))
      // Uploaded content is untrusted: never let it run script in our origin.
      .header('Content-Security-Policy', "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:")
      .header('X-Content-Type-Options', 'nosniff')
      .header('Cache-Control', 'private, no-store');
    return reply.send(app.ctx.blobs.read(f.storage_key!));
  });

  app.put<{ Params: P }>('/api/files/:id/content', async (req) => {
    const m = /^"?(\d{1,12})"?$/.exec(String(req.headers['if-match'] ?? ''));
    if (!m) throw new AppError(428, 'if_match_required', 'If-Match: <version> is required');
    if (!req.body || typeof (req.body as { pipe?: unknown }).pipe !== 'function') throw badRequest('missing_body', 'Body is required');
    return svc.writeContent(uid(req), req.ip, req.params.id, Number(m[1]), req.body as NodeJS.ReadableStream, contentLength(req.headers));
  });

  app.post<{ Params: P & { v: string } }>('/api/files/:id/versions/:v/restore', async (req) => {
    const v = Number(req.params.v);
    if (!Number.isInteger(v) || v < 1) throw badRequest('invalid_version');
    return svc.restoreVersion(uid(req), req.ip, req.params.id, v);
  });

  app.get<{ Params: P }>('/api/files/:id/shares', async (req) => ({ shares: shares.list(uid(req), req.params.id) }));
  app.put<{ Params: P }>('/api/files/:id/shares', async (req) => {
    const b = (req.body ?? {}) as { email?: unknown; role?: unknown };
    return { shares: await shares.set(uid(req), req.ip, req.params.id, b.email, b.role) };
  });
  app.delete<{ Params: P & { userId: string } }>('/api/files/:id/shares/:userId', async (req) => ({ shares: await shares.remove(uid(req), req.ip, req.params.id, req.params.userId) }));

  app.delete<{ Params: P }>('/api/files/:id', async (req) => { svc.trash(uid(req), req.ip, req.params.id); return { ok: true }; });
  app.post<{ Params: P }>('/api/files/:id/restore', async (req) => svc.restore(uid(req), req.ip, req.params.id));
  app.delete<{ Params: P }>('/api/files/:id/permanent', async (req) => { await svc.deletePermanently(uid(req), req.ip, req.params.id); return { ok: true }; });
  app.post('/api/trash/empty', async (req) => svc.emptyTrash(uid(req), req.ip));
  return svc;
}
