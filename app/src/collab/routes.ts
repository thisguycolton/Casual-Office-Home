import type { FastifyInstance } from 'fastify';
import { AppError, badRequest } from '../errors.ts';
import type { FileService } from '../files/service.ts';

/** Kinds that have a live-collaboration-capable editor. */
const COLLAB_KINDS = new Set(['document', 'spreadsheet']);

export function registerCollabRoutes(app: FastifyInstance, files: FileService): void {
  app.get('/api/collab/status', async () => ({ enabled: app.ctx.collab.enabled }));

  /**
   * Grants a short-lived, file-bound room token. The collab service independently verifies it and enforces the role:
   * owner/editor → read-write, viewer → read-only. Whether the caller may join is decided HERE, from the same access
   * rules as every other file operation.
   */
  app.post<{ Params: { id: string } }>('/api/files/:id/collab', async (req) => {
    if (!app.ctx.collab.enabled) throw new AppError(404, 'collab_disabled', 'Live co-editing is not enabled on this server');
    const { row, role } = files.access(req.auth!.user.id, req.params.id);
    if (!COLLAB_KINDS.has(row.kind)) throw badRequest('not_collaborative', 'This file type has no live co-editing');
    const collabRole = role === 'viewer' ? 'viewer' : 'editor';
    const { token, expiresAt } = app.ctx.collab.mint(req.auth!.user, row.id, collabRole);
    return { token, expiresAt, room: row.id, path: '/collab', role: collabRole, version: row.version };
  });
}
