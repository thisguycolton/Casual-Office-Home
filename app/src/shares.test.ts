import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { Client, startApp, userClient, type TestApp } from './harness.ts';
import { verifyToken } from '../../collab/src/token.ts'; // the collab service's own verifier: a contract test between the two services

const SECRET = 'shared-secret-shared-secret-shared-0123456789';
const PDF = Buffer.from('%PDF-1.4\n% test\n');
const kicks: { auth: string; body: any }[] = [];
let fake: Server; let fakePort = 0;

describe('sharing', () => {
  let t: TestApp; let owner: Client, editor: Client, viewer: Client, stranger: Client, admin: Client;
  let file: any, folder: any; let editorId = '', viewerId = '';

  before(async () => {
    fake = createServer((req, res) => { const c: Buffer[] = []; req.on('data', (d) => c.push(d)); req.on('end', () => { kicks.push({ auth: String(req.headers.authorization), body: JSON.parse(Buffer.concat(c).toString() || '{}') }); res.end('{}'); }); });
    await new Promise<void>((r) => fake.listen(0, '127.0.0.1', r)); fakePort = (fake.address() as { port: number }).port;
    t = await startApp({ COLLAB_JWT_SECRET: SECRET, COLLAB_INTERNAL_URL: `http://127.0.0.1:${fakePort}`, USER_QUOTA_MB: '5' });
    owner = await userClient(t, 'owner@example.com'); editor = await userClient(t, 'editor@example.com'); viewer = await userClient(t, 'viewer@example.com');
    stranger = await userClient(t, 'stranger@example.com'); admin = await userClient(t, 'root@example.com', 'admin');
    folder = (await owner.post('/api/folders', { name: 'Secret Projects' })).json;
    file = (await owner.upload('plan.pdf', PDF, folder.id)).json;
    editorId = (await editor.get('/api/auth/me')).json.user.id; viewerId = (await viewer.get('/api/auth/me')).json.user.id;
    assert.equal((await owner.req('PUT', `/api/files/${file.id}/shares`, { body: { email: 'editor@example.com', role: 'editor' } })).status, 200);
    assert.equal((await owner.req('PUT', `/api/files/${file.id}/shares`, { body: { email: 'VIEWER@example.com', role: 'viewer' } })).status, 200);
  });
  after(async () => { await t.close(); fake.close(); });
  const put = (c: Client, id: string, body: Buffer, ifMatch: string) => c.req('PUT', `/api/files/${id}/content`, { raw: body, headers: { 'if-match': ifMatch } });

  it('lists shares for the owner only', async () => {
    const r = await owner.get(`/api/files/${file.id}/shares`);
    assert.deepEqual(r.json.shares.map((s: any) => [s.email, s.role]), [['editor@example.com', 'editor'], ['viewer@example.com', 'viewer']]);
    for (const c of [editor, viewer, stranger, admin]) assert.equal((await c.get(`/api/files/${file.id}/shares`)).status, 404);
  });

  it('read access: owner, editor and viewer can read; a stranger sees nothing', async () => {
    for (const c of [owner, editor, viewer]) {
      assert.equal((await c.get(`/api/files/${file.id}`)).status, 200);
      assert.deepEqual((await c.get(`/api/files/${file.id}/content`)).body, PDF);
    }
    for (const c of [stranger, admin]) {
      assert.equal((await c.get(`/api/files/${file.id}`)).status, 404);
      assert.equal((await c.get(`/api/files/${file.id}/content`)).status, 404);
    }
  });

  it('sharees never learn the owner\'s folder structure', async () => {
    for (const c of [editor, viewer]) {
      const d = (await c.get(`/api/files/${file.id}`)).json;
      assert.deepEqual(d.path, []); assert.equal(d.parentId, null); assert.deepEqual(d.versions, []); assert.equal(d.sharedBy, 'owner');
      assert.equal(JSON.stringify(d).includes('Secret Projects'), false);
      assert.equal((await c.get(`/api/files?parentId=${folder.id}`)).status, 404, 'cannot browse into the owner\'s folder');
    }
  });

  it('write access: owner and editor can save; viewer is refused (403); stranger gets 404', async () => {
    assert.equal((await put(editor, file.id, Buffer.concat([PDF, Buffer.from('edited by editor')]), '1')).status, 200);
    assert.equal((await put(owner, file.id, Buffer.concat([PDF, Buffer.from('edited by owner')]), '2')).status, 200);
    const v = await put(viewer, file.id, Buffer.concat([PDF, Buffer.from('forged')]), '3');
    assert.equal(v.status, 403); assert.equal(v.json.error, 'read_only');
    assert.equal((await put(stranger, file.id, PDF, '3')).status, 404);
    assert.equal((await owner.get(`/api/files/${file.id}/content`)).body.toString().endsWith('edited by owner'), true);
  });

  it('charges storage to the owner, not the editor who saved', async () => {
    assert.ok((await owner.get('/api/storage')).json.used > 0);
    assert.equal((await editor.get('/api/storage')).json.used, 0);
  });

  it('everything else is owner-only: sharees get 404 for rename, move, star, trash, versions and share management', async () => {
    for (const [who, c] of [['editor', editor], ['viewer', viewer]] as const) {
      assert.equal((await c.patch(`/api/files/${file.id}`, { name: 'hijack.pdf' })).status, 404, `${who} rename`);
      assert.equal((await c.patch(`/api/files/${file.id}`, { starred: true })).status, 404, `${who} star`);
      assert.equal((await c.patch(`/api/files/${file.id}`, { parentId: 'root' })).status, 404, `${who} move`);
      assert.equal((await c.del(`/api/files/${file.id}`)).status, 404, `${who} trash`);
      assert.equal((await c.del(`/api/files/${file.id}/permanent`)).status, 404, `${who} permanent`);
      assert.equal((await c.post(`/api/files/${file.id}/versions/1/restore`)).status, 404, `${who} version restore`);
      assert.equal((await c.req('PUT', `/api/files/${file.id}/shares`, { body: { email: 'stranger@example.com', role: 'editor' } })).status, 404, `${who} re-share`);
      assert.equal((await c.del(`/api/files/${file.id}/shares/${viewerId}`)).status, 404, `${who} unshare`);
    }
    assert.equal((await owner.get(`/api/files/${file.id}`)).json.name, 'plan.pdf');
  });

  it('shows shared files (with owner and role) in the Shared view, and not to others', async () => {
    const s = (await editor.get('/api/files?view=shared')).json.items;
    assert.equal(s.length, 1); assert.equal(s[0].id, file.id); assert.equal(s[0].role, 'editor'); assert.equal(s[0].sharedBy, 'owner'); assert.equal(s[0].parentId, null);
    assert.equal((await viewer.get('/api/files?view=shared')).json.items[0].role, 'viewer');
    assert.equal((await stranger.get('/api/files?view=shared')).json.items.length, 0);
    assert.equal((await owner.get('/api/files?view=shared')).json.items.length, 0, 'files you own are not "shared with you"');
    for (const c of [editor, viewer, stranger]) assert.equal((await c.get('/api/files')).json.items.some((i: any) => i.id === file.id), false, 'not in My Files');
  });

  it('lets a viewer make their own private copy', async () => {
    const c = await viewer.post(`/api/files/${file.id}/copy`, {});
    assert.equal(c.status, 201); assert.equal(c.json.parentId, null);
    assert.equal((await owner.get(`/api/files/${c.json.id}`)).status, 404, 'the copy belongs to the viewer alone');
    assert.equal((await viewer.get(`/api/files/${c.json.id}`)).status, 200);
  });

  it('opening a shared file does not touch the owner\'s Recent list', async () => {
    assert.equal((await viewer.post(`/api/files/${file.id}/open`)).status, 200);
    assert.equal((await owner.get('/api/files?view=recent')).json.items.some((i: any) => i.id === file.id), false);
  });

  it('validates share requests', async () => {
    const share = (body: any, id = file.id) => owner.req('PUT', `/api/files/${id}/shares`, { body });
    assert.equal((await share({ email: 'nobody@example.com', role: 'viewer' })).json.error, 'user_not_found');
    assert.equal((await share({ email: 'owner@example.com', role: 'viewer' })).json.error, 'self_share');
    assert.equal((await share({ email: 'stranger@example.com', role: 'admin' })).json.error, 'invalid_role');
    assert.equal((await share({ email: 'not-an-email', role: 'viewer' })).status, 400);
    assert.equal((await share({ email: 'stranger@example.com', role: 'viewer' }, folder.id)).json.error, 'not_shareable');
    const aid = (await admin.get('/api/auth/me')).json.user.id;
    await admin.patch(`/api/admin/users/${(await admin.get('/api/admin/users')).json.users.find((u: any) => u.email === 'stranger@example.com').id}`, { disabled: true });
    assert.equal((await share({ email: 'stranger@example.com', role: 'viewer' })).json.error, 'user_not_found', 'disabled users cannot be shared with');
    await admin.patch(`/api/admin/users/${(await admin.get('/api/admin/users')).json.users.find((u: any) => u.email === 'stranger@example.com').id}`, { disabled: false });
    void aid;
    assert.equal((await stranger.get('/api/auth/me')).status, 401, 'disabling revoked their session');
    assert.equal((await stranger.login('stranger@example.com')).status, 200);
  });

  it('a trashed file is inaccessible to sharees and the share returns on restore', async () => {
    const f = (await owner.upload('temp.pdf', PDF)).json;
    await owner.req('PUT', `/api/files/${f.id}/shares`, { body: { email: 'viewer@example.com', role: 'viewer' } });
    assert.equal((await viewer.get(`/api/files/${f.id}`)).status, 200);
    await owner.del(`/api/files/${f.id}`);
    assert.equal((await viewer.get(`/api/files/${f.id}`)).status, 404);
    assert.equal((await viewer.get('/api/files?view=shared')).json.items.some((i: any) => i.id === f.id), false);
    await owner.post(`/api/files/${f.id}/restore`);
    assert.equal((await viewer.get(`/api/files/${f.id}`)).status, 200);
  });

  describe('live co-editing tokens', () => {
    it('are granted by role and bound to the exact file, verified by the collab service\'s own code', async () => {
      const doc = (await owner.post('/api/files/new', { kind: 'document' })).json;
      for (const [em, role] of [['editor@example.com', 'editor'], ['viewer@example.com', 'viewer']]) await owner.req('PUT', `/api/files/${doc.id}/shares`, { body: { email: em, role } });
      const claim = async (c: Client, id = doc.id) => { const r = await c.post(`/api/files/${id}/collab`); return { r, c: r.status === 200 ? verifyToken(SECRET, r.json.token) : null }; };
      const o = await claim(owner), e = await claim(editor), v = await claim(viewer);
      assert.deepEqual([o.c?.role, e.c?.role, v.c?.role], ['editor', 'editor', 'viewer']);
      for (const x of [o, e, v]) { assert.equal(x.c!.file_id, doc.id); assert.equal(x.c!.purpose, 'room'); assert.equal(x.r.json.room, doc.id); assert.equal(x.r.json.path, '/collab'); }
      assert.equal(e.c!.sub, editorId); assert.equal(v.c!.name, 'viewer');
      assert.ok(e.c!.exp * 1000 - Date.now() <= 8 * 3600_000 + 5000, 'bounded lifetime');
      assert.equal((await claim(stranger)).r.status, 404, 'strangers get no token');
      assert.equal((await claim(admin)).r.status, 404, 'admins get no token for files they cannot read');
      assert.equal((await claim(owner, folder.id)).r.status, 400, 'folders have no room');
      assert.throws(() => verifyToken(SECRET, o.r.json.token.slice(0, -3) + 'abc'), 'a tampered token is rejected by the collab verifier');
    });

    it('are refused for file types without live editing, and when the feature is not configured', async () => {
      const img = (await owner.upload('p.png', Buffer.concat([Buffer.from([0x89]), Buffer.from('PNG\r\n\x1a\n'), Buffer.alloc(8)]))).json;
      assert.equal((await owner.post(`/api/files/${img.id}/collab`)).json.error, 'not_collaborative');
      assert.equal((await owner.post(`/api/files/${file.id}/collab`)).json.error, 'not_collaborative', 'PDF has no collaborative editor here');
      const t2 = await startApp(); const c = await userClient(t2, 'o@example.com');
      try { const d = (await c.post('/api/files/new', { kind: 'document' })).json; const r = await c.post(`/api/files/${d.id}/collab`); assert.equal(r.status, 404); assert.equal(r.json.error, 'collab_disabled'); assert.equal((await c.get('/api/collab/status')).json.enabled, false); }
      finally { await t2.close(); }
    });
  });

  describe('revocation ends live sessions', () => {
    const last = () => kicks[kicks.length - 1]!;
    it('removing a share kicks that user from the room', async () => {
      const f = (await owner.post('/api/files/new', { kind: 'document' })).json;
      await owner.req('PUT', `/api/files/${f.id}/shares`, { body: { email: 'editor@example.com', role: 'editor' } });
      kicks.length = 0;
      assert.equal((await owner.del(`/api/files/${f.id}/shares/${editorId}`)).status, 200);
      assert.deepEqual(last().body, { file_id: f.id, user_id: editorId });
      assert.equal(verifyToken(SECRET, last().auth.replace('Bearer ', '')).purpose, 'kick');
      assert.equal((await editor.get(`/api/files/${f.id}`)).status, 404);
      assert.equal((await owner.del(`/api/files/${f.id}/shares/${editorId}`)).status, 404, 'already removed');
    });
    it('downgrading editor → viewer kicks (so they reconnect read-only); upgrading does not', async () => {
      const f = (await owner.post('/api/files/new', { kind: 'document' })).json; const sh = (r: string) => owner.req('PUT', `/api/files/${f.id}/shares`, { body: { email: 'editor@example.com', role: r } });
      await sh('viewer'); kicks.length = 0; await sh('editor'); assert.equal(kicks.length, 0);
      await sh('viewer'); assert.deepEqual(last().body, { file_id: f.id, user_id: editorId });
    });
    it('trashing and permanently deleting a file kick everyone from its room', async () => {
      const f = (await owner.post('/api/files/new', { kind: 'document' })).json; kicks.length = 0;
      await owner.del(`/api/files/${f.id}`); await new Promise((r) => setTimeout(r, 100)); assert.deepEqual(last().body, { file_id: f.id });
      kicks.length = 0; await owner.del(`/api/files/${f.id}/permanent`); await new Promise((r) => setTimeout(r, 100)); assert.deepEqual(last().body, { file_id: f.id });
    });
    it('disabling a user kicks them from every room', async () => {
      const id = (await admin.get('/api/admin/users')).json.users.find((u: any) => u.email === 'viewer@example.com').id; kicks.length = 0;
      await admin.patch(`/api/admin/users/${id}`, { disabled: true }); await new Promise((r) => setTimeout(r, 100));
      assert.deepEqual(last().body, { user_id: id });
      await admin.patch(`/api/admin/users/${id}`, { disabled: false });
    });
  });
});
