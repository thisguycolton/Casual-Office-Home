import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { HocuspocusProvider } from '@hocuspocus/provider';
import * as Y from 'yjs';
import { RoomController, type RoomStatus } from './controller.ts';
import { signToken } from '../../../../collab/src/token.ts';
import { start, type Running } from '../../../../collab/src/server.ts';

const SECRET = 'test-secret-test-secret-test-secret-0123';
const ROOM = '11111111-2222-3333-4444-555555555555';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (f: () => boolean, ms = 6000) => { const t = Date.now(); while (!f()) { if (Date.now() - t > ms) throw new Error('timeout'); await sleep(20); } };

/** In-memory stand-in for the app's file API, with the same If-Match semantics. */
function fakeStore() {
  const s = { text: 'hello', version: 1, writes: [] as { text: string; ifMatch: number }[], reads: 0 };
  return Object.assign(s, {
    storage: {
      async read() { s.reads++; return { bytes: new TextEncoder().encode(s.text).buffer as ArrayBuffer, version: s.version }; },
      async write(bytes: ArrayBuffer, ifMatch: number) {
        s.writes.push({ text: new TextDecoder().decode(bytes), ifMatch });
        if (ifMatch !== s.version) return 'conflict' as const;
        s.text = new TextDecoder().decode(bytes); s.version += 1; return { version: s.version };
      },
    },
  });
}

describe('room controller against the real collab service', () => {
  let srv: Running;
  before(async () => { srv = await start({ port: 0, host: '127.0.0.1', secret: SECRET, allowedOrigins: [], maxPayloadBytes: 1 << 20, seedTimeoutMs: 600 }); });
  after(async () => { await srv.close(); });

  function client(store: ReturnType<typeof fakeStore>, role: 'editor' | 'viewer', name: string) {
    const doc = new Y.Doc();
    const token = signToken(SECRET, { sub: name, name, file_id: ROOM, role, exp: Math.floor(Date.now() / 1000) + 600 });
    const p = new HocuspocusProvider({ url: `ws://127.0.0.1:${srv.port}`, name: ROOM, document: doc, token, maxAttempts: 1 });
    const text = doc.getText('t');
    const statuses: RoomStatus[] = [];
    let seeds = 0;
    const ctl = new RoomController({
      doc, awareness: p.awareness as never, writable: role === 'editor', storage: store.storage, debounceMs: 100, minIntervalMs: 150,
      io: {
        async prepareSeed(b) { const t = new TextDecoder().decode(b); seeds++; return () => text.insert(0, t); },
        async exportBytes() { return new TextEncoder().encode(text.toString()).buffer as ArrayBuffer; },
      },
      onStatus: (s) => statuses.push(s),
    });
    const sync = () => ctl.setConnection(p.isConnected, p.synced);
    p.on('synced', sync); p.on('status', sync); p.on('awarenessUpdate', () => {});
    return { doc, p, ctl, text, statuses, seeds: () => seeds, stop() { ctl.dispose(); p.destroy(); p.configuration.websocketProvider.destroy(); } };
  }

  it('two editors opening at once seed exactly once; one leader saves; edits flow both ways', async () => {
    const store = fakeStore();
    const a = client(store, 'editor', 'a'), b = client(store, 'editor', 'b');
    await until(() => a.ctl.status === 'live' && b.ctl.status === 'live');
    assert.equal(a.seeds() + b.seeds(), 1);
    assert.equal(a.text.toString(), 'hello'); assert.equal(b.text.toString(), 'hello');
    assert.equal(store.reads, 1);

    a.text.insert(5, ' world'); b.text.insert(0, '>> ');
    await until(() => a.text.toString() === b.text.toString() && a.text.toString().includes('world'));
    await until(() => store.version === 2);
    await sleep(600);
    assert.equal(store.writes.length, 1, 'only the leader writes: ' + JSON.stringify(store.writes));
    assert.equal(store.text, a.text.toString());
    assert.equal(a.ctl.savedVersion, 2); assert.equal(b.ctl.savedVersion, 2);
    a.stop(); b.stop();
  });

  it('a viewer sees the live room, never seeds and never writes', async () => {
    const store = fakeStore();
    const w = client(store, 'editor', 'w');
    await until(() => w.ctl.status === 'live');
    const v = client(store, 'viewer', 'v');
    await until(() => v.ctl.status === 'live');
    assert.equal(v.seeds(), 0); assert.equal(v.text.toString(), 'hello');
    w.text.insert(5, '!'); await until(() => v.text.toString() === 'hello!');
    v.text.insert(0, 'EVIL'); await sleep(300);
    assert.equal(w.text.toString(), 'hello!', 'viewer edits never reach the room');
    assert.equal(v.ctl.isLeader, false);
    w.stop(); v.stop();
  });

  it('leadership moves to the next editor when the leader leaves, without losing unsaved edits', async () => {
    const store = fakeStore();
    const a = client(store, 'editor', 'a'); await until(() => a.ctl.status === 'live');
    const b = client(store, 'editor', 'b'); await until(() => b.ctl.status === 'live');
    const leader = a.ctl.isLeader ? a : b, other = leader === a ? b : a;
    leader.ctl.dispose(); // leader stops saving (as if its tab froze), then goes away before saving
    other.text.insert(0, 'X'); await sleep(50);
    leader.p.destroy(); leader.p.configuration.websocketProvider.destroy();
    await until(() => other.ctl.isLeader, 8000);
    await until(() => store.text.startsWith('X'), 8000);
    other.stop();
  });

  it('reports a conflict (and stops saving) when the file changed outside the room', async () => {
    const store = fakeStore();
    const a = client(store, 'editor', 'a'); await until(() => a.ctl.status === 'live');
    store.version = 99; // someone uploaded a new version through the file manager
    a.text.insert(0, 'Z');
    await until(() => a.ctl.status === 'conflict', 8000);
    const n = store.writes.length; await sleep(700);
    assert.equal(store.writes.length, n, 'no further attempts');
    a.stop();
  });
});
