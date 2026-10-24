import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { HocuspocusProvider } from '@hocuspocus/provider';
import WebSocket from 'ws';
import * as Y from 'yjs';
import { signToken, verifyToken, TokenError, type CollabRole } from './token.ts';
import { start, type Running } from './server.ts';

const SECRET = 'test-secret-test-secret-test-secret-0123';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (fn: () => boolean, ms = 4000) => { const t = Date.now(); while (!fn()) { if (Date.now() - t > ms) throw new Error('timeout waiting for condition'); await sleep(20); } };
const tok = (file: string, role: CollabRole = 'editor', user = 'u1', ttl = 600, extra: object = {}) =>
  signToken(SECRET, { sub: user, name: user, file_id: file, role, exp: Math.floor(Date.now() / 1000) + ttl, ...extra });

describe('tokens', () => {
  it('round-trips and rejects tampering, wrong secret, wrong alg, expiry and junk', () => {
    const t = tok('f1');
    assert.equal(verifyToken(SECRET, t).file_id, 'f1');
    assert.throws(() => verifyToken('another-secret-another-secret-123456', t), TokenError);
    assert.throws(() => verifyToken(SECRET, t.slice(0, -2) + 'xx'), TokenError);
    assert.throws(() => verifyToken(SECRET, tok('f1', 'editor', 'u', -10)), /expired/);
    const none = `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from(JSON.stringify({ sub: 'x', file_id: 'f', role: 'editor', exp: 9999999999 })).toString('base64url')}.`;
    assert.throws(() => verifyToken(SECRET, none), TokenError);
    for (const junk of [undefined, null, '', 'a.b', 'a.b.c.d', 123, 'x'.repeat(5000)]) assert.throws(() => verifyToken(SECRET, junk), TokenError);
    assert.throws(() => verifyToken(SECRET, tok('f', 'admin' as CollabRole)), /bad claims/);
  });
});

describe('collab service', () => {
  let s: Running;
  before(async () => { s = await start({ port: 0, host: '127.0.0.1', secret: SECRET, allowedOrigins: [], maxPayloadBytes: 1 << 20, seedTimeoutMs: 400 }); });

  const clients: HocuspocusProvider[] = [];
  function join(room: string, token: string | undefined, opts: { canSeed?: boolean } = {}) {
    const doc = new Y.Doc();
    const state = { authFailed: false, synced: false, closed: false };
    const p = new HocuspocusProvider({ url: `ws://127.0.0.1:${s.port}`, name: room, document: doc, token: token ?? '', WebSocketPolyfill: WebSocket as never, maxAttempts: 1,
      onAuthenticationFailed: () => { state.authFailed = true; }, onSynced: () => { state.synced = true; }, onClose: () => { state.closed = true; } });
    clients.push(p);
    if (opts.canSeed) p.awareness?.setLocalStateField('canSeed', true);
    return { doc, p, state, id: doc.clientID, meta: doc.getMap('meta'), text: doc.getText('t') };
  }
  after(async () => { clients.forEach((c) => { try { c.destroy(); (c.configuration as { websocketProvider?: { destroy(): void } }).websocketProvider?.destroy(); } catch { /* ignore */ } }); await s.close(); });

  it('serves /health and nothing else', async () => {
    const h = await (await fetch(`http://127.0.0.1:${s.port}/health`)).json();
    assert.equal(h.ok, true);
    for (const p of ['/', '/api/rooms', '/api/admin/config', '/api/mcp-proxy', '/wopi/files/x', '/auth/login', '/yjs']) {
      assert.equal((await fetch(`http://127.0.0.1:${s.port}${p}`)).status, 404, p);
    }
    assert.equal((await fetch(`http://127.0.0.1:${s.port}/internal/kick`, { method: 'POST', body: '{}' })).status, 401);
  });

  it('refuses connections without a valid token for exactly this room', async () => {
    const room = randomUUID();
    for (const [label, t] of [['none', undefined], ['junk', 'junk'], ['wrong room', tok(randomUUID())], ['expired', tok(room, 'editor', 'u', -5)], ['kick token', tok(room, 'editor', 'u', 60, { purpose: 'kick' })]] as const) {
      const c = join(room, t);
      if (t === undefined) { await sleep(800); assert.equal(c.state.synced, false, label); continue; } // sends no credentials at all: never authenticates
      await until(() => c.state.authFailed, 3000); assert.equal(c.state.synced, false, label);
    }
    assert.equal(s.hocuspocus.getConnectionsCount(), 0, 'no rejected client holds a live connection');
  });

  it('refuses non-UUID room names (no arbitrary room creation)', async () => {
    const c = join('../../etc/passwd', tok('../../etc/passwd')); await until(() => c.state.authFailed, 3000);
  });

  it('propagates edits between editors in both directions', async () => {
    const room = randomUUID(); const a = join(room, tok(room, 'editor', 'a')); const b = join(room, tok(room, 'editor', 'b'));
    await until(() => a.state.synced && b.state.synced);
    a.text.insert(0, 'hello'); await until(() => b.text.toString() === 'hello');
    b.text.insert(5, ' world'); await until(() => a.text.toString() === 'hello world');
  });

  it('enforces viewers as read-only ON THE SERVER, even if the client tries to write', async () => {
    const room = randomUUID(); const e = join(room, tok(room, 'editor', 'e')); const v = join(room, tok(room, 'viewer', 'v'));
    await until(() => e.state.synced && v.state.synced);
    e.text.insert(0, 'from-editor'); await until(() => v.text.toString() === 'from-editor', 4000);
    v.text.insert(0, 'FORGED-'); await sleep(500);
    assert.equal(e.text.toString(), 'from-editor', 'a viewer\'s write must never reach other clients');
    const late = join(room, tok(room, 'editor', 'late')); await until(() => late.state.synced);
    assert.equal(late.text.toString(), 'from-editor', 'nor be stored in the room');
  });

  it('keeps rooms ephemeral: nothing survives the last client leaving', async () => {
    const room = randomUUID(); const a = join(room, tok(room)); await until(() => a.state.synced);
    a.text.insert(0, 'secret'); await sleep(300); a.p.destroy(); await sleep(500);
    const b = join(room, tok(room)); await until(() => b.state.synced);
    assert.equal(b.text.toString(), '', 'a fresh room starts empty so it is re-seeded from the stored file');
  });

  it('arbitrates seeding: with many simultaneous candidates exactly one is chosen, and everyone agrees', async () => {
    const room = randomUUID(); const cs = Array.from({ length: 8 }, (_, i) => join(room, tok(room, 'editor', 'u' + i), { canSeed: true }));
    await until(() => cs.every((c) => c.state.synced));
    await until(() => cs.every((c) => typeof c.meta.get('seedOwner') === 'number'));
    const owners = new Set(cs.map((c) => c.meta.get('seedOwner')));
    assert.equal(owners.size, 1, 'all clients must see the same single owner');
    assert.ok(cs.some((c) => c.id === [...owners][0]), 'the owner is one of the connected candidates');
  });

  it('never makes a viewer the seed owner', async () => {
    const room = randomUUID(); const v = join(room, tok(room, 'viewer', 'v'), { canSeed: true }); await until(() => v.state.synced); await sleep(400);
    assert.equal(v.meta.get('seedOwner'), undefined);
    const e = join(room, tok(room, 'editor', 'e'), { canSeed: true }); await until(() => e.meta.get('seedOwner') === e.id);
  });

  it('reassigns when the owner disappears or stalls, and stops once seeded', async () => {
    const room = randomUUID(); const a = join(room, tok(room, 'editor', 'a'), { canSeed: true }); await until(() => a.state.synced);
    await until(() => a.meta.get('seedOwner') === a.id);
    const b = join(room, tok(room, 'editor', 'b'), { canSeed: true }); await until(() => b.state.synced);
    // a never seeds; after the stall timeout the owner moves to b
    await until(() => b.meta.get('seedOwner') === b.id, 4000);
    b.meta.set('seeded', true); await sleep(900);
    assert.equal(b.meta.get('seedOwner'), b.id, 'owner is not reassigned after seeding');
  });

  it('revocation closes the targeted user\'s connections and spares others', async () => {
    const room = randomUUID(); const a = join(room, tok(room, 'editor', 'alice')); const b = join(room, tok(room, 'editor', 'bob'));
    await until(() => a.state.synced && b.state.synced);
    const kick = tok(room, 'editor', 'app', 60, { purpose: 'kick' });
    const r = await fetch(`http://127.0.0.1:${s.port}/internal/kick`, { method: 'POST', headers: { authorization: `Bearer ${kick}`, 'content-type': 'application/json' }, body: JSON.stringify({ file_id: room, user_id: 'alice' }) });
    assert.equal((await r.json()).kicked, 1);
    await until(() => a.state.closed);
    a.text.insert(0, 'after-kick'); await sleep(300);
    assert.equal(b.text.toString(), '', 'kicked client can no longer write');
    assert.equal((await fetch(`http://127.0.0.1:${s.port}/internal/kick`, { method: 'POST', headers: { authorization: `Bearer ${tok(room)}` }, body: '{}' })).status, 403, 'a normal room token cannot kick');
  });
});

describe('origin allowlist', () => {
  it('rejects upgrades from other origins', async () => {
    const s = await start({ port: 0, host: '127.0.0.1', secret: SECRET, allowedOrigins: ['https://office.example.com'], maxPayloadBytes: 1 << 20, seedTimeoutMs: 1000 });
    try {
      const open = (origin: string) => new Promise<string>((res) => { const w = new WebSocket(`ws://127.0.0.1:${s.port}`, { headers: { origin } }); w.on('open', () => { w.close(); res('open'); }); w.on('error', () => res('rejected')); w.on('unexpected-response', () => res('rejected')); });
      assert.equal(await open('https://evil.example.net'), 'rejected');
      assert.equal(await open('https://office.example.com'), 'open');
    } finally { await s.close(); }
  });
});
