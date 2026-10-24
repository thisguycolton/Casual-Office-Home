import type { FastifyInstance } from 'fastify';
import { audit } from '../audit.ts';
import { requireAdmin } from '../auth/plugin.ts';
import { sha256, newToken, destroyUserSessions } from '../auth/sessions.ts';
import { createUser, findById, toUser, validateDisplayName, type UserRow } from '../auth/users.ts';
import { AppError, badRequest, notFound } from '../errors.ts';
import type { FileService } from '../files/service.ts';

export function registerAdminRoutes(app: FastifyInstance, files: FileService): void {
  const { db } = app.ctx;
  const admins = () => (db.prepare("SELECT COUNT(*) c FROM users WHERE role='admin' AND disabled=0").get() as { c: number }).c;
  const view = (r: UserRow) => {
    const u = toUser(r);
    const s = db.prepare("SELECT COALESCE(SUM(size),0) s, COUNT(*) n FROM files WHERE owner_id = ? AND kind != 'folder'").get(r.id) as { s: number; n: number };
    return { id: u.id, email: u.email, displayName: u.displayName, role: u.role, disabled: u.disabled, storageUsed: s.s, fileCount: s.n };
  };
  const target = (id: string) => { const r = findById(db, id); if (!r) throw notFound(); return r; };
  app.addHook('preHandler', async (req) => { if (req.url.startsWith('/api/admin/')) requireAdmin(req); });

  app.get('/api/admin/users', async () => ({
    users: (db.prepare('SELECT * FROM users ORDER BY created_at').all() as unknown as UserRow[]).map(view),
  }));

  app.post('/api/admin/users', async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    if (b.role !== undefined && b.role !== 'user' && b.role !== 'admin') throw badRequest('invalid_role');
    const u = await createUser(db, { email: b.email, password: b.password, displayName: b.displayName, role: (b.role as 'user' | 'admin') ?? 'user' });
    audit(db, req.auth!.user.id, 'admin_user_create', u.id, req.ip);
    reply.code(201);
    return view(findById(db, u.id)!);
  });

  app.patch<{ Params: { id: string } }>('/api/admin/users/:id', async (req) => {
    const r = target(req.params.id);
    const b = (req.body ?? {}) as { role?: unknown; disabled?: unknown; displayName?: unknown };
    const role = b.role === undefined ? r.role : b.role;
    if (role !== 'user' && role !== 'admin') throw badRequest('invalid_role');
    if (b.disabled !== undefined && typeof b.disabled !== 'boolean') throw badRequest('invalid_disabled');
    const disabled = b.disabled === undefined ? !!r.disabled : b.disabled;
    const name = b.displayName === undefined ? r.display_name : validateDisplayName(b.displayName, r.display_name);
    const losesAdmin = r.role === 'admin' && !r.disabled && (role !== 'admin' || disabled);
    if (losesAdmin && admins() <= 1) throw new AppError(409, 'last_admin', 'Cannot remove or disable the last administrator');
    db.prepare('UPDATE users SET role=?, disabled=?, display_name=?, updated_at=? WHERE id=?').run(role, disabled ? 1 : 0, name, Date.now(), r.id);
    if (disabled) destroyUserSessions(db, r.id);
    audit(db, req.auth!.user.id, 'admin_user_update', r.id, req.ip);
    return view(findById(db, r.id)!);
  });

  app.delete<{ Params: { id: string } }>('/api/admin/users/:id', async (req) => {
    const r = target(req.params.id);
    if (r.id === req.auth!.user.id) throw new AppError(409, 'self_delete', 'You cannot delete your own account here');
    if (r.role === 'admin' && !r.disabled && admins() <= 1) throw new AppError(409, 'last_admin', 'Cannot delete the last administrator');
    await files.purgeUserFiles(r.id);
    db.prepare('DELETE FROM users WHERE id = ?').run(r.id); // files, sessions, resets cascade
    audit(db, req.auth!.user.id, 'admin_user_delete', r.id, req.ip);
    return { ok: true };
  });

  // No email service is assumed: an admin mints a one-time link and hands it to the user.
  app.post<{ Params: { id: string } }>('/api/admin/users/:id/reset-token', async (req) => {
    const r = target(req.params.id);
    const token = newToken();
    const expiresAt = Date.now() + 60 * 60_000;
    db.prepare('INSERT INTO password_resets (token_hash,user_id,created_by,expires_at) VALUES (?,?,?,?)').run(sha256(token), r.id, req.auth!.user.id, expiresAt);
    audit(db, req.auth!.user.id, 'admin_reset_token', r.id, req.ip);
    return { token, expiresAt };
  });
}
