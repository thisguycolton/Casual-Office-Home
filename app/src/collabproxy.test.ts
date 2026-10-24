import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider';
import WebSocket from 'ws';
import * as Y from 'yjs';
import { start as startCollab, type Running } from '../../collab/src/server.ts';
import { Client, startApp, userClient, type TestApp } from './harness.ts';

const SECRET = 'shared-secret-shared-secret-shared-0123456789';
const PDF_DOCX = Buffer.from('PK\x03\x04 placeholder'); // kind is decided by extension; bytes are not parsed by the collab path

describe('/collab websocket tunnel', () => {
  let t: TestApp, collab: Running, port = 0; let alice: Client, bob: Client; let file: any;

  before(async () => {
    collab = await startCollab({ port: 0, host: '127.0.0.1', secret: SECRET, allowedOrigins: [], maxPayloadBytes: 1 << 20, seedTimeoutMs: 400 });
    t = await startApp({ COLLAB_JWT_SECRET: SECRET, COLLAB_INTERNAL_URL: `http://127.0.0.1:${collab.port}` });
    await t.app.listen({ port: 0, host: '127.0.0.1' });
    port = (t.app.server.address() as { port: number }).port;
    alice = await userClient(t, 'alice@example.com'); bob = await userClient(t, 'bob@example.com');
    const up = await alice.upload('plan.docx', PDF_DOCX);
    assert.equal(up.status, 201, JSON.stringify(up.json));
    file = up.json;
  });
  after(async () => { await t.close(); await collab.close(); });

  const open = (headers: Record<string, string>) => new Promise<{ status?: number; open: boolean }>((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/collab`, { headers });
    ws.on('open', () => { ws.close(); resolve({ open: true }); });
    ws.on('unexpected-response', (_q, res) => { res.resume(); resolve({ status: res.statusCode, open: false }); });
    ws.on('error', () => { /* handled via unexpected-response */ });
  });
  const origin = () => `http://127.0.0.1:${port}`;

  it('refuses without a session or with a foreign origin, before reaching collab', async () => {
    assert.deepEqual(await open({ origin: origin() }), { status: 401, open: false });
    assert.deepEqual(await open({ origin: 'http://evil.example', cookie: alice.cookie }), { status: 403, open: false });
    assert.deepEqual(await open({ cookie: alice.cookie }), { status: 403, open: false });
    assert.equal((await open({ origin: origin(), cookie: alice.cookie })).open, true);
  });

  it('carries a real Hocuspocus session end-to-end, and the per-file token still gates the room', async () => {
    const tokA = (await alice.post(`/api/files/${file.id}/collab`)).json;
    assert.equal(tokA.path, '/collab');
    const mk = (token: string) => {
      const doc = new Y.Doc(); const st = { synced: false, authFailed: false };
      const Ws = class extends WebSocket { constructor(u: string) { super(u, { headers: { origin: origin(), cookie: alice.cookie } }); } };
      const socket = new HocuspocusProviderWebsocket({ url: `ws://127.0.0.1:${port}/collab`, WebSocketPolyfill: Ws as never, maxAttempts: 1 });
      const p = new HocuspocusProvider({ websocketProvider: socket, name: tokA.room, document: doc, token,
        onSynced: () => { st.synced = true; }, onAuthenticationFailed: () => { st.authFailed = true; } });
      return { doc, p, st };
    };
    const good = mk(tokA.token), bad = mk('not-a-token');
    const until = async (f: () => boolean) => { const s = Date.now(); while (!f()) { if (Date.now() - s > 5000) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 20)); } };
    await until(() => good.st.synced); await until(() => bad.st.authFailed);
    assert.equal(bad.st.synced, false);
    good.doc.getMap('x').set('k', 'v');
    good.p.destroy(); bad.p.destroy(); good.p.configuration.websocketProvider.destroy(); bad.p.configuration.websocketProvider.destroy();
  });

  it('a user without access to the file gets no token to present', async () => {
    assert.equal((await bob.post(`/api/files/${file.id}/collab`)).status, 404);
  });
});
