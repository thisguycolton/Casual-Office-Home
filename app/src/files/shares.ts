import type { Ctx } from '../context.ts';
import { audit } from '../audit.ts';
import { AppError, badRequest, notFound } from '../errors.ts';
import { validateEmail } from '../auth/users.ts';
import type { FileService } from './service.ts';

export interface ShareView { userId: string; email: string; displayName: string; role: 'viewer' | 'editor' }

/** Sharing is per-file and owner-managed. Sharees can read (viewer) or read+write content (editor); nothing else. */
export class ShareService {
  private readonly ctx: Ctx;
  private readonly files: FileService;
  constructor(ctx: Ctx, files: FileService) { this.ctx = ctx; this.files = files; }

  private ownedFile(ownerId: string, fileId: string) {
    const f = this.files.get(ownerId, fileId); // owner-scoped: anyone else gets 404
    if (f.kind === 'folder') throw badRequest('not_shareable', 'Folders cannot be shared; share individual files');
    return f;
  }

  list(ownerId: string, fileId: string): ShareView[] {
    this.ownedFile(ownerId, fileId);
    return this.ctx.db.prepare(
      `SELECT u.id AS userId, u.email, u.display_name AS displayName, s.role FROM file_shares s JOIN users u ON u.id = s.user_id
       WHERE s.file_id = ? ORDER BY u.email`,
    ).all(fileId) as unknown as ShareView[];
  }

  async set(ownerId: string, ip: string | undefined, fileId: string, emailRaw: unknown, role: unknown): Promise<ShareView[]> {
    this.ownedFile(ownerId, fileId);
    if (role !== 'viewer' && role !== 'editor') throw badRequest('invalid_role', 'role must be viewer or editor');
    const email = validateEmail(emailRaw);
    const target = this.ctx.db.prepare('SELECT id, disabled FROM users WHERE email = ?').get(email) as { id: string; disabled: number } | undefined;
    // Deliberately explicit: this is a private, admin-managed deployment, and the caller must already be signed in.
    if (!target || target.disabled) throw new AppError(404, 'user_not_found', 'No active user with that email address');
    if (target.id === ownerId) throw badRequest('self_share', 'You already own this file');
    const prev = this.ctx.db.prepare('SELECT role FROM file_shares WHERE file_id = ? AND user_id = ?').get(fileId, target.id) as { role: string } | undefined;
    this.ctx.db.prepare(
      `INSERT INTO file_shares (file_id,user_id,role,created_by,created_at) VALUES (?,?,?,?,?)
       ON CONFLICT(file_id,user_id) DO UPDATE SET role = excluded.role`,
    ).run(fileId, target.id, role, ownerId, Date.now());
    audit(this.ctx.db, ownerId, 'share_set', `${fileId}:${target.id}:${role}`, ip);
    // A downgrade must take effect now, not at the user's next reconnect.
    if (prev?.role === 'editor' && role === 'viewer') await this.ctx.collab.kick(fileId, target.id);
    return this.list(ownerId, fileId);
  }

  async remove(ownerId: string, ip: string | undefined, fileId: string, userId: string): Promise<ShareView[]> {
    this.ownedFile(ownerId, fileId);
    const r = this.ctx.db.prepare('DELETE FROM file_shares WHERE file_id = ? AND user_id = ?').run(fileId, userId);
    if (!r.changes) throw notFound();
    audit(this.ctx.db, ownerId, 'share_remove', `${fileId}:${userId}`, ip);
    await this.ctx.collab.kick(fileId, userId);
    return this.list(ownerId, fileId);
  }
}
