import { ApiError } from '../api.ts';
import { hashString } from './hash.ts';

export type EditorApp = 'docs' | 'sheet';
export type SaveState = 'loading' | 'ready' | 'saving' | 'saved' | 'error' | 'conflict' | 'failed-to-load';
export interface SessionOptions {
  app: EditorApp;
  fileId: string;
  fileName: string;
  parentId: string | null;
  frame: HTMLIFrameElement;
  onState(state: SaveState, detail?: string): void;
  /** Injected for tests. */
  fetchImpl?: typeof fetch;
  csrf(): string;
  /** Sheets: converts an editor snapshot into .xlsx bytes. */
  toXlsx?: (snapshot: unknown) => Promise<ArrayBuffer>;
  pollMs?: number;
}

interface Envelope { type: string; app: EditorApp; id?: string; v: 1; data: any }
const isEnvelope = (x: any): x is Envelope => !!x && typeof x.type === 'string' && x.type.startsWith('casual.') && x.v === 1 && 'data' in x;

/**
 * Bridges one embedded editor iframe to the central app. The editor never touches storage: it asks the host
 * for bytes and hands bytes (or a snapshot we convert) back, and this class performs every read and write
 * over the authenticated, version-checked API.
 */
export class EditorSession {
  private readonly o: SessionOptions;
  private version = 0;
  private loaded = false;
  private helloSent = false;
  private disposed = false;
  private chain: Promise<unknown> = Promise.resolve();
  private lastSavedHash: string | null = null;
  private baselineTimer: ReturnType<typeof setTimeout> | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private forceNext = false;
  private docsSaveRequests = 0;
  private waiters: (() => void)[] = [];
  /** Most recent bytes we know the editor produced; preserved so a conflict never loses the user's work. */
  lastBytes: ArrayBuffer | null = null;
  state: SaveState = 'loading';

  constructor(o: SessionOptions) {
    this.o = o;
    this.onMessage = this.onMessage.bind(this);
    window.addEventListener('message', this.onMessage);
  }

  private set(state: SaveState, detail?: string) { this.state = state; this.o.onState(state, detail); }
  private f: typeof fetch = (...a) => (this.o.fetchImpl ?? fetch)(...a);

  dispose() {
    this.disposed = true;
    window.removeEventListener('message', this.onMessage);
    if (this.baselineTimer) clearTimeout(this.baselineTimer);
    if (this.pollTimer) clearInterval(this.pollTimer);
  }

  private post(type: string, data: unknown, id?: string, transfer: Transferable[] = []) {
    this.o.frame.contentWindow?.postMessage({ type, app: this.o.app, v: 1, ...(id ? { id } : {}), data }, location.origin, transfer);
  }

  // ───────── storage I/O ─────────
  private async fetchContent(): Promise<{ bytes: ArrayBuffer; version: number }> {
    const r = await this.f(`/api/files/${this.o.fileId}/content`, { credentials: 'same-origin' });
    if (!r.ok) throw new ApiError(r.status, 'load_failed', r.status === 404 ? 'File not found' : `Could not load file (${r.status})`);
    return { bytes: await r.arrayBuffer(), version: Number(r.headers.get('x-file-version') ?? 0) };
  }

  /** Serialized so two saves can never race each other's If-Match. */
  private put(bytes: ArrayBuffer): Promise<number> {
    const run = async () => {
      if (this.state === 'conflict') throw new ApiError(409, 'version_conflict', 'File changed elsewhere');
      this.lastBytes = bytes;
      this.set('saving');
      const r = await this.f(`/api/files/${this.o.fileId}/content`, {
        method: 'PUT', credentials: 'same-origin',
        headers: { 'content-type': 'application/octet-stream', 'if-match': String(this.version), 'x-csrf-token': this.o.csrf() },
        body: bytes,
      });
      if (r.status === 409) { this.set('conflict'); throw new ApiError(409, 'version_conflict', 'File changed elsewhere'); }
      if (!r.ok) { this.set('error', `Save failed (${r.status})`); throw new ApiError(r.status, 'save_failed', `Save failed (${r.status})`); }
      this.version = (await r.json()).version;
      this.set('saved');
      return this.version;
    };
    const next = this.chain.then(run, run);
    this.chain = next.catch(() => {});
    return next;
  }

  // ───────── message handling ─────────
  private async onMessage(ev: MessageEvent) {
    if (this.disposed || ev.origin !== location.origin || ev.source !== this.o.frame.contentWindow) return;
    const m = ev.data;
    if (!isEnvelope(m) || m.app !== this.o.app) return;
    try {
      switch (m.type) {
        case 'casual.hello': case 'casual.ready':
          if (!this.helloSent) { this.helloSent = true; this.post('casual.hello', { capabilities: ['saveDocument'] }); }
          return;
        case 'casual.load.request': return await this.handleLoad(m);
        case 'casual.save.request': return await this.handleDocsSave(m);
        case 'casual.save.notify': return await this.handleSheetSnapshot(m.data.snapshot, m.data.reason);
        case 'casual.selection.format-state': return this.handleSheetReady();
        case 'casual.error':
          // The Docs editor emits a non-fatal "parse_failed" after its first save; only treat errors as fatal before load.
          if (!this.loaded) this.set('failed-to-load', m.data?.message);
          else console.warn('[editor] non-fatal error', m.data);
          return;
      }
    } catch (e) { console.warn('[editor-host]', e); }
  }

  private async handleLoad(m: Envelope) {
    try {
      const { bytes, version } = await this.fetchContent();
      this.version = version;
      this.loaded = true;
      this.set('ready');
      this.post('casual.load.response', { ok: true, bytes, etag: String(version), fileName: this.o.fileName }, m.id, [bytes]);
    } catch (e) {
      this.set('failed-to-load', (e as Error).message);
      this.post('casual.load.response', { ok: false, code: (e as ApiError).status === 404 ? 'not_found' : 'load_failed', message: (e as Error).message }, m.id);
    }
  }

  // Docs: the editor autosaves and sends .docx bytes itself.
  private async handleDocsSave(m: Envelope) {
    const bytes = m.data.bytes as ArrayBuffer;
    this.docsSaveRequests++;
    try {
      const v = await this.put(bytes.slice(0));
      this.post('casual.save.response', { ok: true, etag: String(v) }, m.id);
    } catch (e) {
      this.post('casual.save.response', { ok: false, code: (e as ApiError).code, message: (e as Error).message }, m.id);
    }
  }

  // ───────── Sheets: poll for snapshots, convert, save only when changed ─────────
  private handleSheetReady() {
    if (this.o.app !== 'sheet' || this.baselineTimer || this.lastSavedHash !== null || !this.loaded) return;
    // The editor is up. Take a baseline snapshot shortly afterwards so unchanged workbooks are never re-saved.
    this.baselineTimer = setTimeout(() => this.post('casual.command.save', {}), 1500);
  }

  private startPolling() {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => { if (this.state !== 'conflict') this.post('casual.command.save', {}); }, this.o.pollMs ?? 5000);
  }

  private async handleSheetSnapshot(snapshot: unknown, reason: string) {
    if (this.o.app !== 'sheet' || !this.o.toXlsx) return;
    const hash = hashString(JSON.stringify(snapshot));
    const waiters = this.waiters.splice(0);
    try {
      const force = this.forceNext || reason === 'shortcut';
      this.forceNext = false;
      if (this.lastSavedHash === null && !force) {
        // First snapshot after load = the baseline for "has anything changed?". Nothing to save yet.
        this.lastSavedHash = hash; this.startPolling(); return;
      }
      if (!force && hash === this.lastSavedHash) return;
      const bytes = await this.o.toXlsx(snapshot);
      await this.put(bytes);
      this.lastSavedHash = hash;
      this.startPolling();
    } catch (e) {
      console.warn('[sheets-host] save failed; will retry on next change', e);
    } finally { waiters.forEach((w) => w()); }
  }

  /** Persist any pending edits now (used before leaving the page). Resolves when done or after a timeout. */
  async flush(timeoutMs = 8000): Promise<void> {
    if (this.o.app === 'sheet' && this.loaded && this.state !== 'conflict') {
      // Before a baseline exists we cannot tell "unchanged" from "edited", so save unconditionally.
      if (this.lastSavedHash === null) this.forceNext = true;
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, timeoutMs);
        this.waiters.push(() => { clearTimeout(t); resolve(); });
        this.post('casual.command.save', {});
      });
    }
    if (this.o.app === 'docs' && this.loaded && this.state !== 'conflict') await this.flushDocs();
    await this.chain;
  }

  /**
   * The Docs editor autosaves every 30 s and has no host-side "save now". It does, however, flush any unsaved edits
   * when its window receives `pagehide` — an upstream behaviour (useFileSourceAutoSave) we deliberately trigger when
   * the user leaves in-app, since removing the iframe would otherwise drop up to 30 s of work.
   */
  private async flushDocs(): Promise<void> {
    const before = this.docsSaveRequests;
    try { this.o.frame.contentWindow?.dispatchEvent(new Event('pagehide')); } catch { return; }
    // Serialising the document takes a moment; if nothing was dirty, no request ever arrives.
    const deadline = Date.now() + 2500;
    while (this.docsSaveRequests === before && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  }

  /** Conflict recovery: keep the user's work by saving it as a separate file. */
  async saveAsCopy(): Promise<string> {
    if (!this.lastBytes) throw new Error('Nothing to save');
    const dot = this.o.fileName.lastIndexOf('.');
    const name = `${dot > 0 ? this.o.fileName.slice(0, dot) : this.o.fileName} (conflicted copy)${dot > 0 ? this.o.fileName.slice(dot) : ''}`;
    const q = new URLSearchParams({ name }); if (this.o.parentId) q.set('parentId', this.o.parentId);
    const r = await this.f(`/api/files?${q}`, {
      method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/octet-stream', 'x-csrf-token': this.o.csrf() }, body: this.lastBytes,
    });
    if (!r.ok) throw new ApiError(r.status, 'copy_failed', 'Could not save a copy');
    return (await r.json()).name as string;
  }
}
