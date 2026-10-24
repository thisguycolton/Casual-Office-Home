import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Ctx } from '../context.ts';
import { tx } from '../db.ts';
import { AppError, badRequest, notFound } from '../errors.ts';
import { audit } from '../audit.ts';
import type { Received } from './blobs.ts';
import { EDITOR_FOR, classify, magicMatches, type Kind } from './kinds.ts';
import { likeEscape, numberedName, validateName } from './names.ts';

export interface FileRow {
  id: string; owner_id: string; parent_id: string | null; name: string; kind: Kind; mime: string;
  storage_key: string | null; size: number; sha256: string | null; version: number; starred: number;
  trashed_at: number | null; trashed_root: number; created_at: number; updated_at: number; last_opened_at: number | null;
}

export const toApi = (r: FileRow) => ({
  id: r.id, name: r.name, kind: r.kind, mime: r.mime, parentId: r.parent_id, size: r.size, version: r.version,
  starred: !!r.starred, trashedAt: r.trashed_at, createdAt: r.created_at, updatedAt: r.updated_at,
  lastOpenedAt: r.last_opened_at, editor: EDITOR_FOR[r.kind] ?? null,
});

export type SortKey = 'name' | 'kind' | 'size' | 'updated';
const SORT_SQL: Record<SortKey, string> = {
  name: 'name COLLATE NOCASE', kind: 'kind', size: 'size', updated: 'updated_at',
};

const NEW_TEMPLATES = {
  document: { file: 'blank.docx', name: 'Untitled document.docx' },
  spreadsheet: { file: 'blank.xlsx', name: 'Untitled spreadsheet.xlsx' },
  presentation: { file: 'blank.pptx', name: 'Untitled presentation.pptx' },
} as const;
export type NewKind = keyof typeof NEW_TEMPLATES;
export const isNewKind = (k: unknown): k is NewKind => typeof k === 'string' && k in NEW_TEMPLATES;

export class FileService {
  private readonly ctx: Ctx;
  constructor(ctx: Ctx) { this.ctx = ctx; }
  private get db() { return this.ctx.db; }

  // ───────── lookup (the ONLY way handlers obtain a row — always owner-scoped) ─────────
  get(userId: string, id: string, opts: { trashed?: boolean } = {}): FileRow {
    if (typeof id !== 'string' || id.length > 64) throw notFound();
    const r = this.db.prepare('SELECT * FROM files WHERE id = ? AND owner_id = ?').get(id, userId) as FileRow | undefined;
    if (!r) throw notFound();
    if (opts.trashed ? r.trashed_at === null : r.trashed_at !== null) throw notFound();
    return r;
  }

  private folder(userId: string, id: string | null): FileRow | null {
    if (id === null) return null;
    const f = this.get(userId, id);
    if (f.kind !== 'folder') throw badRequest('not_a_folder', 'Target is not a folder');
    return f;
  }

  private parentParam(raw: unknown): string | null {
    if (raw === undefined || raw === null || raw === '' || raw === 'root') return null;
    if (typeof raw !== 'string') throw badRequest('invalid_parent');
    return raw;
  }

  /** Ancestors from the top down, excluding the item itself. */
  path(userId: string, id: string | null): { id: string; name: string }[] {
    const out: { id: string; name: string }[] = [];
    let cur = id;
    for (let i = 0; cur && i < 100; i++) {
      const r = this.db.prepare('SELECT id, name, parent_id FROM files WHERE id = ? AND owner_id = ?').get(cur, userId) as
        | { id: string; name: string; parent_id: string | null } | undefined;
      if (!r) break;
      out.unshift({ id: r.id, name: r.name });
      cur = r.parent_id;
    }
    return out;
  }

  private liveNameTaken(userId: string, parentId: string | null, name: string, exceptId?: string): boolean {
    return !!this.db.prepare(
      `SELECT 1 FROM files WHERE owner_id = ? AND COALESCE(parent_id,'') = ? AND name = ? COLLATE NOCASE
         AND trashed_at IS NULL AND id IS NOT ?`,
    ).get(userId, parentId ?? '', name, exceptId ?? null);
  }

  /** Auto-numbering for creates/uploads/copies: "a.txt" -> "a (1).txt". */
  private freeName(userId: string, parentId: string | null, name: string): string {
    if (!this.liveNameTaken(userId, parentId, name)) return name;
    for (let n = 1; n < 10_000; n++) {
      const cand = numberedName(name, n);
      if (!this.liveNameTaken(userId, parentId, cand)) return cand;
    }
    throw new AppError(409, 'name_conflict', 'Could not find a free name');
  }

  // ───────── listing ─────────
  list(userId: string, q: {
    view?: string; parentId?: unknown; search?: unknown; sort?: unknown; order?: unknown; limit?: unknown;
  }) {
    const sort = (q.sort as SortKey) in SORT_SQL ? (q.sort as SortKey) : 'name';
    const dir = q.order === 'desc' ? 'DESC' : 'ASC';
    const orderBy = `${SORT_SQL[sort]} ${dir}, name COLLATE NOCASE ASC`;
    const limit = Math.min(Math.max(Number(q.limit) || 500, 1), 1000);
    const view = q.view ?? 'folder';
    const search = typeof q.search === 'string' ? q.search.trim() : '';
    let rows: FileRow[];
    let extra: Record<string, unknown> = {};

    if (search) {
      rows = this.db.prepare(
        `SELECT * FROM files WHERE owner_id = ? AND trashed_at IS NULL AND name LIKE ? ESCAPE '\\'
         ORDER BY kind = 'folder' DESC, ${orderBy} LIMIT ?`,
      ).all(userId, `%${likeEscape(search.slice(0, 100))}%`, limit) as unknown as FileRow[];
    } else if (view === 'recent') {
      rows = this.db.prepare(
        `SELECT * FROM files WHERE owner_id = ? AND trashed_at IS NULL AND last_opened_at IS NOT NULL AND kind != 'folder'
         ORDER BY last_opened_at DESC LIMIT ?`,
      ).all(userId, Math.min(limit, 50)) as unknown as FileRow[];
    } else if (view === 'starred') {
      rows = this.db.prepare(
        `SELECT * FROM files WHERE owner_id = ? AND trashed_at IS NULL AND starred = 1
         ORDER BY kind = 'folder' DESC, ${orderBy} LIMIT ?`,
      ).all(userId, limit) as unknown as FileRow[];
    } else if (view === 'trash') {
      rows = this.db.prepare(
        `SELECT * FROM files WHERE owner_id = ? AND trashed_root = 1 AND trashed_at IS NOT NULL
         ORDER BY trashed_at DESC LIMIT ?`,
      ).all(userId, limit) as unknown as FileRow[];
    } else if (view === 'shared') {
      rows = []; // Sharing is not implemented: files are private to their owner.
      extra = { sharingImplemented: false };
    } else if (view === 'folder') {
      const parent = this.parentParam(q.parentId);
      const cur = this.folder(userId, parent);
      rows = this.db.prepare(
        `SELECT * FROM files WHERE owner_id = ? AND COALESCE(parent_id,'') = ? AND trashed_at IS NULL
         ORDER BY kind = 'folder' DESC, ${orderBy} LIMIT ?`,
      ).all(userId, parent ?? '', limit) as unknown as FileRow[];
      extra = { folder: cur ? toApi(cur) : null, path: this.path(userId, parent) };
    } else {
      throw badRequest('invalid_view');
    }
    return { items: rows.map(toApi), ...extra };
  }

  details(userId: string, id: string) {
    const r = this.get(userId, id);
    const versions = this.db.prepare(
      'SELECT version, size, created_at AS createdAt FROM file_versions WHERE file_id = ? ORDER BY version DESC',
    ).all(id);
    return { ...toApi(r), sha256: r.sha256, path: this.path(userId, r.parent_id), versions };
  }

  usage(userId: string) {
    const f = this.db.prepare("SELECT COALESCE(SUM(size),0) s FROM files WHERE owner_id = ? AND kind != 'folder'").get(userId) as { s: number };
    const v = this.db.prepare(
      'SELECT COALESCE(SUM(v.size),0) s FROM file_versions v JOIN files f ON f.id = v.file_id WHERE f.owner_id = ?',
    ).get(userId) as { s: number };
    return { used: f.s + v.s, quota: this.ctx.config.userQuotaBytes };
  }

  private assertQuota(userId: string, adding: number): void {
    const { quota, used } = this.usage(userId);
    if (quota > 0 && used + adding > quota) throw new AppError(413, 'quota_exceeded', 'Storage quota exceeded');
  }

  // ───────── create ─────────
  createFolder(userId: string, ip: string | undefined, input: { name?: unknown; parentId?: unknown }) {
    const name = validateName(input.name);
    const parent = this.parentParam(input.parentId);
    this.folder(userId, parent);
    const row = tx(this.db, () => {
      if (this.liveNameTaken(userId, parent, name)) throw new AppError(409, 'name_conflict', 'An item with that name already exists');
      const id = randomUUID(); const now = Date.now();
      this.db.prepare(
        `INSERT INTO files (id,owner_id,parent_id,name,kind,mime,storage_key,size,created_at,updated_at)
         VALUES (?,?,?,?, 'folder','inode/directory',NULL,0,?,?)`,
      ).run(id, userId, parent, name, now, now);
      return this.get(userId, id);
    });
    audit(this.db, userId, 'folder_create', row.id, ip);
    return toApi(row);
  }

  /** Commits a received temp file as a brand-new file. Cleans up the temp file/blob on any failure. */
  private async insertReceived(userId: string, parent: string | null, name: string, rec: Received, kind: Kind, mime: string) {
    const key = this.ctx.blobs.newKey();
    try {
      await this.ctx.blobs.commit(rec.tempPath, key);
      const row = tx(this.db, () => {
        const finalName = this.freeName(userId, parent, name);
        const id = randomUUID(); const now = Date.now();
        this.db.prepare(
          `INSERT INTO files (id,owner_id,parent_id,name,kind,mime,storage_key,size,sha256,created_at,updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        ).run(id, userId, parent, finalName, kind, mime, key, rec.size, rec.sha256, now, now);
        return this.get(userId, id);
      });
      return row;
    } catch (err) {
      await this.ctx.blobs.discard(rec.tempPath);
      await this.ctx.blobs.remove(key);
      throw err;
    }
  }

  async upload(userId: string, ip: string | undefined, input: { name: unknown; parentId: unknown; body: NodeJS.ReadableStream; contentLength?: number }) {
    const name = validateName(input.name);
    const parent = this.parentParam(input.parentId);
    this.folder(userId, parent);
    const max = this.ctx.config.maxUploadBytes;
    if (input.contentLength !== undefined && input.contentLength > max) throw new AppError(413, 'too_large', 'File exceeds the upload limit');
    const rec = await this.ctx.blobs.receive(input.body as never, max);
    try {
      const c = classify(name);
      if (!magicMatches(c.magic, rec.head)) throw new AppError(415, 'type_mismatch', `File content does not look like a .${c.ext} file`);
      this.assertQuota(userId, rec.size);
    } catch (err) { await this.ctx.blobs.discard(rec.tempPath); throw err; }
    const c = classify(name);
    const row = await this.insertReceived(userId, parent, name, rec, c.kind, c.mime);
    audit(this.db, userId, 'upload', row.id, ip);
    return toApi(row);
  }

  async createNew(userId: string, ip: string | undefined, input: { kind?: unknown; name?: unknown; parentId?: unknown }) {
    if (!isNewKind(input.kind)) throw badRequest('invalid_kind', 'kind must be document, spreadsheet or presentation');
    const t = NEW_TEMPLATES[input.kind];
    const name = input.name === undefined ? t.name : validateName(input.name);
    const wantExt = t.name.slice(t.name.lastIndexOf('.'));
    const finalName = name.toLowerCase().endsWith(wantExt) ? name : name + wantExt;
    const parent = this.parentParam(input.parentId);
    this.folder(userId, parent);
    const bytes = await readFile(join(this.ctx.config.templatesDir, t.file));
    this.assertQuota(userId, bytes.length);
    const { Readable } = await import('node:stream');
    const rec = await this.ctx.blobs.receive(Readable.from([bytes]), this.ctx.config.maxUploadBytes);
    const c = classify(finalName);
    const row = await this.insertReceived(userId, parent, finalName, rec, c.kind, c.mime);
    audit(this.db, userId, 'file_new', row.id, ip);
    return toApi(row);
  }

  // ───────── content ─────────
  contentFor(userId: string, id: string) {
    const r = this.get(userId, id);
    if (r.kind === 'folder' || !r.storage_key) throw badRequest('is_folder', 'Folders have no content');
    return r;
  }

  touchOpened(userId: string, id: string) {
    const r = this.contentFor(userId, id);
    this.db.prepare('UPDATE files SET last_opened_at = ? WHERE id = ?').run(Date.now(), r.id);
  }

  /** Replace content (editor saves). Optimistic concurrency via the file version. Previous content is retained. */
  async writeContent(userId: string, ip: string | undefined, id: string, ifMatch: number, body: NodeJS.ReadableStream, contentLength?: number) {
    const r = this.contentFor(userId, id);
    const max = this.ctx.config.maxUploadBytes;
    if (contentLength !== undefined && contentLength > max) throw new AppError(413, 'too_large', 'File exceeds the upload limit');
    if (r.version !== ifMatch) throw new AppError(409, 'version_conflict', `File changed (current version ${r.version})`);
    const rec = await this.ctx.blobs.receive(body as never, max);
    const key = this.ctx.blobs.newKey();
    const dropKeys: string[] = [];
    try {
      if (rec.size === 0) throw badRequest('empty_body', 'Refusing to replace a file with empty content');
      const c = classify(r.name);
      if (!magicMatches(c.magic, rec.head)) throw new AppError(415, 'type_mismatch', `Content does not look like a .${c.ext} file`);
      this.assertQuota(userId, rec.size);
      await this.ctx.blobs.commit(rec.tempPath, key);
      const updated = tx(this.db, () => {
        const cur = this.get(userId, id);
        if (cur.version !== ifMatch) throw new AppError(409, 'version_conflict', `File changed (current version ${cur.version})`);
        const now = Date.now();
        if (this.ctx.config.keepVersions > 0) {
          this.db.prepare('INSERT INTO file_versions (file_id,version,storage_key,size,sha256,created_at) VALUES (?,?,?,?,?,?)')
            .run(id, cur.version, cur.storage_key, cur.size, cur.sha256, now);
          const old = this.db.prepare('SELECT version, storage_key FROM file_versions WHERE file_id = ? ORDER BY version DESC LIMIT -1 OFFSET ?')
            .all(id, this.ctx.config.keepVersions) as { version: number; storage_key: string }[];
          for (const o of old) {
            this.db.prepare('DELETE FROM file_versions WHERE file_id = ? AND version = ?').run(id, o.version);
            dropKeys.push(o.storage_key);
          }
        } else dropKeys.push(cur.storage_key!);
        this.db.prepare('UPDATE files SET storage_key=?, size=?, sha256=?, version=version+1, updated_at=? WHERE id=?')
          .run(key, rec.size, rec.sha256, now, id);
        return this.get(userId, id);
      });
      for (const k of dropKeys) await this.ctx.blobs.remove(k).catch(() => {});
      audit(this.db, userId, 'file_save', id, ip);
      return { version: updated.version, size: updated.size, updatedAt: updated.updated_at };
    } catch (err) {
      await this.ctx.blobs.discard(rec.tempPath);
      await this.ctx.blobs.remove(key);
      throw err;
    }
  }

  async restoreVersion(userId: string, ip: string | undefined, id: string, version: number) {
    this.contentFor(userId, id);
    const v = this.db.prepare('SELECT * FROM file_versions WHERE file_id = ? AND version = ?').get(id, version) as
      | { storage_key: string; size: number; sha256: string | null } | undefined;
    if (!v) throw notFound();
    const rec = await this.ctx.blobs.duplicate(v.storage_key);
    const key = this.ctx.blobs.newKey();
    await this.ctx.blobs.commit(rec.tempPath, key);
    try {
      tx(this.db, () => {
        const cur = this.get(userId, id);
        const now = Date.now();
        this.db.prepare('INSERT INTO file_versions (file_id,version,storage_key,size,sha256,created_at) VALUES (?,?,?,?,?,?)')
          .run(id, cur.version, cur.storage_key, cur.size, cur.sha256, now);
        this.db.prepare('UPDATE files SET storage_key=?, size=?, sha256=?, version=version+1, updated_at=? WHERE id=?')
          .run(key, v.size, v.sha256, now, id);
      });
    } catch (err) { await this.ctx.blobs.remove(key); throw err; }
    audit(this.db, userId, 'version_restore', id, ip);
    return toApi(this.get(userId, id));
  }

  // ───────── modify ─────────
  update(userId: string, ip: string | undefined, id: string, patch: { name?: unknown; parentId?: unknown; starred?: unknown }) {
    const row = tx(this.db, () => {
      const r = this.get(userId, id);
      let name = r.name, parent = r.parent_id;
      if (patch.name !== undefined) name = validateName(patch.name);
      if (patch.parentId !== undefined) {
        parent = this.parentParam(patch.parentId);
        this.folder(userId, parent);
        // A folder may not be moved into itself or any of its own descendants.
        if (r.kind === 'folder') {
          for (const a of this.path(userId, parent)) if (a.id === r.id) throw badRequest('invalid_move', 'Cannot move a folder into itself');
        }
      }
      if ((name !== r.name || parent !== r.parent_id) && this.liveNameTaken(userId, parent, name, r.id)) {
        throw new AppError(409, 'name_conflict', 'An item with that name already exists in the destination');
      }
      let starred = r.starred;
      if (patch.starred !== undefined) {
        if (typeof patch.starred !== 'boolean') throw badRequest('invalid_starred');
        starred = patch.starred ? 1 : 0;
      }
      this.db.prepare('UPDATE files SET name=?, parent_id=?, starred=?, updated_at=? WHERE id=?')
        .run(name, parent, starred, name !== r.name || parent !== r.parent_id ? Date.now() : r.updated_at, id);
      return this.get(userId, id);
    });
    audit(this.db, userId, 'file_update', id, ip);
    return toApi(row);
  }

  async copy(userId: string, ip: string | undefined, id: string, input: { name?: unknown; parentId?: unknown }) {
    const src = this.contentFor(userId, id);
    const parent = input.parentId === undefined ? src.parent_id : this.parentParam(input.parentId);
    this.folder(userId, parent);
    this.assertQuota(userId, src.size);
    const name = input.name === undefined ? numberedName(src.name, 1).replace(/ \(1\)/, ' (copy)') : validateName(input.name);
    const rec = await this.ctx.blobs.duplicate(src.storage_key!);
    const row = await this.insertReceived(userId, parent, name, rec, src.kind, src.mime);
    audit(this.db, userId, 'file_copy', row.id, ip);
    return toApi(row);
  }

  // ───────── trash ─────────
  private descendantIds(id: string): string[] {
    return (this.db.prepare(
      `WITH RECURSIVE d(id) AS (SELECT id FROM files WHERE parent_id = ? UNION ALL SELECT f.id FROM files f JOIN d ON f.parent_id = d.id)
       SELECT id FROM d`,
    ).all(id) as { id: string }[]).map((r) => r.id);
  }

  trash(userId: string, ip: string | undefined, id: string) {
    tx(this.db, () => {
      const r = this.get(userId, id);
      const now = Date.now();
      const ids = [r.id, ...this.descendantIds(r.id)];
      const mark = this.db.prepare('UPDATE files SET trashed_at = ?, trashed_root = ? WHERE id = ? AND trashed_at IS NULL');
      for (const x of ids) mark.run(now, x === r.id ? 1 : 0, x);
    });
    audit(this.db, userId, 'trash', id, ip);
  }

  restore(userId: string, ip: string | undefined, id: string) {
    const row = tx(this.db, () => {
      const r = this.get(userId, id, { trashed: true });
      if (!r.trashed_root) throw notFound();
      let parent = r.parent_id;
      if (parent) {
        const p = this.db.prepare('SELECT trashed_at FROM files WHERE id = ? AND owner_id = ?').get(parent, userId) as { trashed_at: number | null } | undefined;
        if (!p || p.trashed_at !== null) parent = null; // original folder is gone/in trash: restore to top level
      }
      const name = this.freeName(userId, parent, r.name);
      const stamp = r.trashed_at!;
      const ids = [r.id, ...this.descendantIds(r.id)];
      // Rename/re-parent while still trashed: the live-name unique index must never see a conflicting name.
      this.db.prepare('UPDATE files SET name = ?, parent_id = ? WHERE id = ?').run(name, parent, r.id);
      const un = this.db.prepare('UPDATE files SET trashed_at = NULL, trashed_root = 0 WHERE id = ? AND trashed_at = ?');
      for (const x of ids) un.run(x, stamp);
      return this.get(userId, id);
    });
    audit(this.db, userId, 'restore', id, ip);
    return toApi(row);
  }

  /** Irreversibly deletes a trashed item (and its subtree + stored content). */
  async deletePermanently(userId: string, ip: string | undefined, id: string) {
    const keys = tx(this.db, () => {
      const r = this.get(userId, id, { trashed: true });
      if (!r.trashed_root) throw notFound();
      const ids = [r.id, ...this.descendantIds(r.id)];
      const keys: string[] = [];
      for (const x of ids) {
        const f = this.db.prepare('SELECT storage_key FROM files WHERE id = ?').get(x) as { storage_key: string | null };
        if (f.storage_key) keys.push(f.storage_key);
        for (const v of this.db.prepare('SELECT storage_key FROM file_versions WHERE file_id = ?').all(x) as { storage_key: string }[]) keys.push(v.storage_key);
      }
      this.db.prepare('DELETE FROM files WHERE id = ?').run(r.id); // children + versions cascade
      return keys;
    });
    for (const k of keys) await this.ctx.blobs.remove(k).catch(() => {});
    audit(this.db, userId, 'delete_permanent', id, ip);
  }

  async emptyTrash(userId: string, ip: string | undefined) {
    const roots = this.db.prepare('SELECT id FROM files WHERE owner_id = ? AND trashed_root = 1').all(userId) as { id: string }[];
    for (const r of roots) await this.deletePermanently(userId, ip, r.id);
    return { deleted: roots.length };
  }

  /** Used when an administrator deletes an account. */
  async purgeUserFiles(userId: string): Promise<void> {
    const keys = [
      ...(this.db.prepare('SELECT storage_key k FROM files WHERE owner_id = ? AND storage_key IS NOT NULL').all(userId) as { k: string }[]),
      ...(this.db.prepare('SELECT v.storage_key k FROM file_versions v JOIN files f ON f.id = v.file_id WHERE f.owner_id = ?').all(userId) as { k: string }[]),
    ];
    for (const { k } of keys) await this.ctx.blobs.remove(k).catch(() => {});
  }
}
