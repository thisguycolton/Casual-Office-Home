import * as Y from 'yjs';

/**
 * Client-side protocol for a live room, independent of any editor.
 *
 * The collab service never stores documents, so someone has to put the stored file's content into an empty room
 * ("seed") and someone has to write the room's content back to the stored file ("save"). Two rules keep that safe:
 *
 *  - Seeding: the server names exactly one writable client in `meta.seedOwner`; only that client seeds, and it sets
 *    `meta.seeded` in the SAME transaction as the content, so a seeder that dies half-way leaves nothing behind.
 *  - Saving: only the "leader" (lowest awareness client id among writers) writes, so N open tabs make one PUT, not N.
 *    `meta.dirty` / `meta.savedVersion` are shared so leadership can change hands without losing edits or the ETag.
 */
export type RoomStatus = 'connecting' | 'waiting' | 'seeding' | 'live' | 'offline' | 'conflict' | 'error';

export interface RoomIO {
  /** Slow, asynchronous part of seeding (parse the file, load it into the local editor). Returns the synchronous part. */
  prepareSeed(bytes: ArrayBuffer): Promise<() => void>;
  exportBytes(): Promise<ArrayBuffer>;
}
export interface RoomStorage {
  read(): Promise<{ bytes: ArrayBuffer; version: number }>;
  /** Resolves 'conflict' when the stored file's version no longer matches `ifMatch`. */
  write(bytes: ArrayBuffer, ifMatch: number): Promise<{ version: number } | 'conflict'>;
}
export interface AwarenessLike {
  clientID: number;
  getStates(): Map<number, Record<string, unknown>>;
  setLocalStateField(field: string, value: unknown): void;
  on(event: 'change', cb: () => void): void;
  off(event: 'change', cb: () => void): void;
}
export interface RoomOptions {
  doc: Y.Doc;
  awareness: AwarenessLike;
  writable: boolean;
  io: RoomIO;
  storage: RoomStorage;
  onStatus?: (s: RoomStatus, detail?: string) => void;
  /** Wait this long after the first unsaved edit before saving. */
  debounceMs?: number;
  /** Never save more often than this. */
  minIntervalMs?: number;
  /**
   * Editors rewrite a freshly loaded document on their own (normalising ids, attributes…). Treating that as an edit
   * would re-save every file merely for being opened, so when set, nothing counts as an edit until this client has
   * actually received input (keyboard, paste, pointer). Peers' edits arrive through their own `dirty` flag.
   */
  armOnInput?: Document;
}

const CTRL = Symbol('room-controller');

export class RoomController {
  status: RoomStatus = 'connecting';
  private synced = false;
  private connected = false;
  private seeding = false;
  private conflicted = false;
  private disposed = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastSave = 0;
  private inflight: Promise<void> | null = null;
  private retries = 0;
  private readonly meta: Y.Map<unknown>;
  private readonly debounceMs: number;
  private readonly minIntervalMs: number;
  private readonly onMeta = () => { this.refresh(); this.schedule(); };
  private readonly onAware = () => { this.schedule(); this.refresh(); };
  private armed = true;
  private readonly arm = () => { this.armed = true; };
  private static readonly INPUT = ['keydown', 'beforeinput', 'paste', 'cut', 'drop', 'pointerdown'] as const;
  private readonly onTx = (tr: Y.Transaction) => {
    if (!this.o.writable || !tr.local || tr.origin === CTRL || this.status !== 'live' || !this.armed || tr.changed.size === 0) return;
    // After the transaction: mark the room dirty once (not once per keystroke).
    queueMicrotask(() => { if (!this.disposed && !this.meta.get('dirty')) this.o.doc.transact(() => this.meta.set('dirty', true), CTRL); });
  };

  private readonly o: RoomOptions;
  constructor(o: RoomOptions) {
    this.o = o;
    this.meta = o.doc.getMap('meta');
    this.debounceMs = o.debounceMs ?? 4000;
    this.minIntervalMs = o.minIntervalMs ?? 10_000;
    if (o.armOnInput) { this.armed = false; for (const t of RoomController.INPUT) o.armOnInput.addEventListener(t, this.arm, true); }
    this.meta.observe(this.onMeta);
    o.awareness.on('change', this.onAware);
    o.doc.on('afterTransaction', this.onTx);
  }

  /** Feed connection facts from whichever provider the editor uses. */
  setConnection(connected: boolean, synced: boolean): void {
    this.connected = connected; this.synced = synced;
    if (this.synced && this.o.writable) this.o.awareness.setLocalStateField('canSeed', true);
    this.refresh();
  }

  get savedVersion(): number { return Number(this.meta.get('savedVersion') ?? 0); }
  get seeded(): boolean { return !!this.meta.get('seeded'); }
  get isLeader(): boolean {
    if (!this.o.writable) return false;
    let min = Infinity;
    for (const [id, s] of this.o.awareness.getStates()) if (s.canSeed) min = Math.min(min, id);
    return min === this.o.awareness.clientID;
  }

  private set(status: RoomStatus, detail?: string): void {
    if (this.status === status && !detail) return;
    this.status = status; this.o.onStatus?.(status, detail);
  }

  private refresh(): void {
    if (this.disposed) return;
    if (this.conflicted) return this.set('conflict');
    if (!this.connected) return this.set(this.synced ? 'offline' : 'connecting');
    if (!this.synced) return this.set('connecting');
    if (this.seeded) { this.seeding = false; this.set('live'); this.schedule(); return; }
    if (this.seeding) return this.set('seeding');
    if (this.o.writable && this.meta.get('seedOwner') === this.o.awareness.clientID) { void this.seed(); return; }
    this.set('waiting');
  }

  private async seed(): Promise<void> {
    this.seeding = true; this.set('seeding');
    try {
      const { bytes, version } = await this.o.storage.read();
      const apply = await this.o.io.prepareSeed(bytes);
      // Content, flag and version land as one update: a peer either sees a fully seeded room or an empty one.
      this.o.doc.transact(() => { apply(); this.meta.set('savedVersion', version); this.meta.set('dirty', false); this.meta.set('seeded', true); }, CTRL);
    } catch (e) {
      this.seeding = false;
      this.set('error', e instanceof Error ? e.message : 'Could not open this file');
    }
  }

  private schedule(): void {
    if (this.disposed || this.timer || this.status !== 'live' || !this.meta.get('dirty') || !this.isLeader || this.conflicted) return;
    const wait = Math.max(this.debounceMs, this.lastSave + this.minIntervalMs - Date.now());
    this.timer = setTimeout(() => { this.timer = null; void this.save(); }, wait);
  }

  /** Persist now if this client is the leader and there is something unsaved. Safe to call at any time. */
  async flush(): Promise<void> {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (this.inflight) await this.inflight.catch(() => undefined);
    if (this.status === 'live' && this.isLeader && this.meta.get('dirty') && !this.conflicted) await this.save();
  }

  private save(): Promise<void> {
    if (this.inflight) return this.inflight;
    this.inflight = this.doSave().finally(() => { this.inflight = null; this.schedule(); });
    return this.inflight;
  }

  private async doSave(): Promise<void> {
    const doc = this.o.doc;
    // Clear first: an edit that lands while we export sets it again and is picked up by the next round.
    doc.transact(() => this.meta.set('dirty', false), CTRL);
    const base = this.savedVersion;
    try {
      const bytes = await this.o.io.exportBytes();
      const r = await this.o.storage.write(bytes, base);
      if (r === 'conflict') {
        // Two clients can briefly both believe they lead. If the other one's save already moved the shared version, retry.
        await new Promise((res) => setTimeout(res, 1500));
        if (this.savedVersion !== base) { doc.transact(() => this.meta.set('dirty', true), CTRL); return; }
        this.conflicted = true; this.set('conflict'); return;
      }
      this.lastSave = Date.now(); this.retries = 0;
      doc.transact(() => this.meta.set('savedVersion', r.version), CTRL);
    } catch {
      doc.transact(() => this.meta.set('dirty', true), CTRL);
      this.retries += 1;
      this.lastSave = Date.now() + Math.min(60_000, 2 ** this.retries * 1000) - this.minIntervalMs;
    }
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.meta.unobserve(this.onMeta);
    this.o.awareness.off('change', this.onAware);
    this.o.doc.off('afterTransaction', this.onTx);
    if (this.o.armOnInput) for (const t of RoomController.INPUT) this.o.armOnInput.removeEventListener(t, this.arm, true);
  }
}
