import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { mkdir, open, readdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import { AppError } from '../errors.ts';

export interface Received { tempPath: string; size: number; sha256: string; head: Buffer }

/** Content-addressed-by-UUID blob store on a local volume. Filenames never touch the filesystem. */
export class BlobStore {
  private readonly blobDir: string;
  private readonly tmpDir: string;
  constructor(blobDir: string, tmpDir: string) { this.blobDir = blobDir; this.tmpDir = tmpDir; }

  async init(): Promise<void> {
    await mkdir(this.blobDir, { recursive: true });
    await mkdir(this.tmpDir, { recursive: true });
    await this.sweepTmp(60 * 60 * 1000);
  }

  newKey(): string {
    const id = randomUUID();
    return `${id.slice(0, 2)}/${id}`;
  }

  private pathFor(key: string): string {
    if (!/^[0-9a-f]{2}\/[0-9a-f-]{36}$/.test(key)) throw new Error('invalid storage key');
    return join(this.blobDir, key);
  }

  /** Streams a body into a temp file, enforcing a size limit and hashing as it goes. Cleans up on any failure. */
  async receive(body: Readable, maxBytes: number): Promise<Received> {
    const tempPath = join(this.tmpDir, randomUUID());
    const hash = createHash('sha256');
    let size = 0;
    const chunks: Buffer[] = [];
    let headLen = 0;
    const meter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        size += chunk.length;
        if (size > maxBytes) return cb(new AppError(413, 'too_large', 'File exceeds the upload limit'));
        hash.update(chunk);
        if (headLen < 16) { chunks.push(chunk.subarray(0, 16 - headLen)); headLen += Math.min(chunk.length, 16 - headLen); }
        cb(null, chunk);
      },
    });
    try {
      await pipeline(body, meter, createWriteStream(tempPath, { flags: 'wx', mode: 0o600 }));
      // Durability: flush file contents before it becomes visible under its final name.
      const fh = await open(tempPath, 'r');
      try { await fh.sync(); } finally { await fh.close(); }
    } catch (err) {
      await rm(tempPath, { force: true });
      if (err instanceof AppError) throw err;
      if ((err as { code?: string }).code === 'ERR_STREAM_PREMATURE_CLOSE' || (err as Error).name === 'AbortError') {
        throw new AppError(400, 'upload_interrupted', 'Upload was interrupted');
      }
      throw err;
    }
    return { tempPath, size, sha256: hash.digest('hex'), head: Buffer.concat(chunks) };
  }

  /** Atomically moves a received temp file into place. */
  async commit(tempPath: string, key: string): Promise<void> {
    const dest = this.pathFor(key);
    await mkdir(dirname(dest), { recursive: true });
    await rename(tempPath, dest);
  }

  async discard(tempPath: string): Promise<void> { await rm(tempPath, { force: true }); }
  async remove(key: string): Promise<void> { await rm(this.pathFor(key), { force: true }); }
  exists(key: string): boolean { return existsSync(this.pathFor(key)); }
  async size(key: string): Promise<number> { return (await stat(this.pathFor(key))).size; }
  read(key: string): Readable { return createReadStream(this.pathFor(key)); }

  /** Duplicates a stored blob into a fresh temp file (hashed), ready for commit(). */
  duplicate(key: string): Promise<Received> {
    return this.receive(this.read(key), Number.MAX_SAFE_INTEGER);
  }

  /** Removes abandoned partial uploads left by a crash. */
  async sweepTmp(olderThanMs: number): Promise<number> {
    let n = 0;
    for (const f of await readdir(this.tmpDir).catch(() => [])) {
      const p = join(this.tmpDir, f);
      const st = await stat(p).catch(() => null);
      if (st && Date.now() - st.mtimeMs > olderThanMs) { await rm(p, { force: true }); n++; }
    }
    return n;
  }
}
