import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client, startApp, userClient, type TestApp } from './harness.ts';

const PDF = Buffer.from('%PDF-1.4\n% test\n');
const PNG = Buffer.concat([Buffer.from([0x89]), Buffer.from('PNG\r\n\x1a\n'), Buffer.alloc(8)]);
const walk = (dir: string): string[] => existsSync(dir)
  ? readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]) : [];

describe('files and folders', () => {
  let t: TestApp; let a: Client;
  before(async () => { t = await startApp(); a = await userClient(t, 'a@example.com'); });
  after(() => t.close());

  it('creates nested folders and reports breadcrumbs', async () => {
    const top = (await a.post('/api/folders', { name: 'Projects' })).json;
    const sub = (await a.post('/api/folders', { name: '2026', parentId: top.id })).json;
    const r = (await a.get(`/api/files?parentId=${sub.id}`)).json;
    assert.deepEqual(r.path.map((p: any) => p.name), ['Projects', '2026']);
    assert.equal(r.folder.id, sub.id);
  });

  it('uploads, classifies by type, lists, and downloads identical bytes', async () => {
    const up = await a.upload('report.pdf', PDF);
    assert.equal(up.status, 201);
    assert.equal(up.json.kind, 'pdf'); assert.equal(up.json.editor, 'pdf'); assert.equal(up.json.size, PDF.length);
    const dl = await a.get(`/api/files/${up.json.id}/content`);
    assert.equal(dl.status, 200);
    assert.deepEqual(dl.body, PDF);
    assert.match(String(dl.headers['content-disposition']), /^attachment/);
    assert.match(String(dl.headers['content-security-policy']), /sandbox/);
    assert.equal(dl.headers['x-content-type-options'], 'nosniff');
  });

  it('maps file types to the right editor and kind', async () => {
    const cases: [string, string, string | null][] = [['a.docx', 'document', 'docs'], ['b.xlsx', 'spreadsheet', 'sheets'], ['c.pptx', 'presentation', 'slides'], ['d.txt', 'text', null], ['e.bin', 'other', null], ['f.DOCX', 'document', 'docs']];
    for (const [name, kind, editor] of cases) {
      const data = /docx|xlsx|pptx/i.test(name) ? Buffer.from('PK\x03\x04zip') : Buffer.from('hello');
      const r = await a.upload(name, data);
      assert.equal(r.status, 201, name); assert.equal(r.json.kind, kind, name); assert.equal(r.json.editor, editor, name);
    }
  });

  it('rejects uploads whose content contradicts their extension', async () => {
    assert.equal((await a.upload('fake.pdf', 'not a pdf')).status, 415);
    assert.equal((await a.upload('fake.docx', 'plain text')).status, 415);
    assert.equal((await a.upload('fake.png', PDF)).status, 415);
    assert.equal((await a.upload('real.png', PNG)).status, 201);
  });

  it('never lets names reach the filesystem and rejects hostile names', async () => {
    for (const bad of ['../etc/passwd', 'a/b', 'a\\b', '..', '.', '', '   ', 'x\u0000y', 'x'.repeat(300)]) {
      assert.equal((await a.upload(bad, 'x')).status, 400, JSON.stringify(bad));
      assert.equal((await a.post('/api/folders', { name: bad })).status, 400, `folder ${JSON.stringify(bad)}`);
    }
    await a.upload('secret-name.txt', 'x');
    const onDisk = walk(t.config.blobDir);
    assert.ok(onDisk.length > 0);
    assert.ok(onDisk.every((p) => !p.includes('secret-name')), 'stored paths use UUIDs only');
  });

  it('auto-numbers duplicate uploads but rejects duplicate renames', async () => {
    const one = (await a.upload('dup.txt', '1')).json; const two = (await a.upload('dup.txt', '2')).json;
    assert.equal(one.name, 'dup.txt'); assert.equal(two.name, 'dup (1).txt');
    const r = await a.patch(`/api/files/${two.id}`, { name: 'DUP.txt' });
    assert.equal(r.status, 409, 'names are case-insensitively unique');
    assert.equal((await a.patch(`/api/files/${two.id}`, { name: 'renamed.txt' })).json.name, 'renamed.txt');
  });

  it('moves files, and refuses to move a folder into itself or its descendants', async () => {
    const f1 = (await a.post('/api/folders', { name: 'M1' })).json;
    const f2 = (await a.post('/api/folders', { name: 'M2', parentId: f1.id })).json;
    const file = (await a.upload('moveme.txt', 'x')).json;
    assert.equal((await a.patch(`/api/files/${file.id}`, { parentId: f2.id })).json.parentId, f2.id);
    assert.equal((await a.patch(`/api/files/${f1.id}`, { parentId: f1.id })).status, 400);
    assert.equal((await a.patch(`/api/files/${f1.id}`, { parentId: f2.id })).status, 400);
    assert.equal((await a.patch(`/api/files/${file.id}`, { parentId: 'root' })).json.parentId, null);
    assert.equal((await a.patch(`/api/files/${file.id}`, { parentId: file.id })).status, 400, 'a file is not a folder');
  });

  it('stars and unstars, and lists starred items', async () => {
    const f = (await a.upload('star.txt', 'x')).json;
    assert.equal((await a.patch(`/api/files/${f.id}`, { starred: true })).json.starred, true);
    assert.ok((await a.get('/api/files?view=starred')).json.items.some((i: any) => i.id === f.id));
    await a.patch(`/api/files/${f.id}`, { starred: false });
    assert.ok(!(await a.get('/api/files?view=starred')).json.items.some((i: any) => i.id === f.id));
    assert.equal((await a.patch(`/api/files/${f.id}`, { starred: 'yes' })).status, 400);
  });

  it('searches by filename, treating wildcards literally', async () => {
    await a.upload('100%_done.txt', 'x'); await a.upload('1000 done.txt', 'x');
    const hits = (await a.get('/api/files?search=' + encodeURIComponent('100%_'))).json.items.map((i: any) => i.name);
    assert.deepEqual(hits, ['100%_done.txt']);
    assert.ok((await a.get('/api/files?search=REPORT')).json.items.some((i: any) => i.name === 'report.pdf'), 'case-insensitive');
  });

  it('sorts by name, size and kind in both directions, folders first', async () => {
    const t2 = await startApp(); const c = await userClient(t2, 's@example.com');
    try {
      await c.upload('b.txt', 'bbbbbb'); await c.upload('a.txt', 'a'); await c.upload('c.txt', 'cccc'); await c.post('/api/folders', { name: 'Zed' });
      const names = async (q: string) => (await c.get(`/api/files?${q}`)).json.items.map((i: any) => i.name);
      assert.deepEqual(await names('sort=name&order=asc'), ['Zed', 'a.txt', 'b.txt', 'c.txt']);
      assert.deepEqual(await names('sort=name&order=desc'), ['Zed', 'c.txt', 'b.txt', 'a.txt']);
      assert.deepEqual(await names('sort=size&order=desc'), ['Zed', 'b.txt', 'c.txt', 'a.txt']);
      assert.equal((await c.get('/api/files?sort=password')).status, 200, 'unknown sort keys fall back safely, never reach SQL');
    } finally { await t2.close(); }
  });

  it('tracks recently opened files', async () => {
    const f = (await a.upload('recent.txt', 'x')).json;
    assert.ok(!(await a.get('/api/files?view=recent')).json.items.some((i: any) => i.id === f.id));
    await a.post(`/api/files/${f.id}/open`);
    assert.equal((await a.get('/api/files?view=recent')).json.items[0].id, f.id);
  });

  it('trashes a folder with its contents, hides them, and restores the whole tree', async () => {
    const dir = (await a.post('/api/folders', { name: 'Doomed' })).json;
    const child = (await a.upload('child.txt', 'x', dir.id)).json;
    assert.equal((await a.del(`/api/files/${dir.id}`)).status, 200);
    assert.equal((await a.get(`/api/files/${child.id}`)).status, 404, 'descendants are not reachable while trashed');
    assert.equal((await a.get(`/api/files/${child.id}/content`)).status, 404);
    const trash = (await a.get('/api/files?view=trash')).json.items;
    assert.deepEqual(trash.filter((i: any) => i.id === dir.id || i.id === child.id).map((i: any) => i.id), [dir.id], 'only the deleted root is listed');
    assert.equal((await a.post(`/api/files/${child.id}/restore`)).status, 404, 'cannot restore a descendant on its own');
    assert.equal((await a.post(`/api/files/${dir.id}/restore`)).status, 200);
    assert.equal((await a.get(`/api/files/${child.id}`)).status, 200);
    assert.equal((await a.get(`/api/files?parentId=${dir.id}`)).json.items.length, 1);
  });

  it('restores to the top level when the original folder is gone, and renames on conflict', async () => {
    const dir = (await a.post('/api/folders', { name: 'Orphanage' })).json;
    const f = (await a.upload('orphan.txt', 'x', dir.id)).json;
    await a.del(`/api/files/${f.id}`); await a.del(`/api/files/${dir.id}`);
    assert.equal((await a.post(`/api/files/${f.id}/restore`)).json.parentId, null);
    await a.upload('orphan.txt', 'y'); // occupy... name already taken by restored file -> second goes (1)
    await a.del(`/api/files/${f.id}`);
    const again = (await a.upload('orphan.txt', 'z')).json; assert.equal(again.name, 'orphan.txt');
    const back = await a.post(`/api/files/${f.id}/restore`);
    assert.equal(back.status, 200); assert.equal(back.json.name, 'orphan (2).txt', 'conflicting name is auto-numbered');
  });

  it('permanently deletes trashed items and removes their stored content', async () => {
    const f = (await a.upload('gone.txt', 'bye')).json;
    const before = walk(t.config.blobDir).length;
    assert.equal((await a.del(`/api/files/${f.id}/permanent`)).status, 404, 'must be in the trash first');
    await a.del(`/api/files/${f.id}`);
    assert.equal((await a.del(`/api/files/${f.id}/permanent`)).status, 200);
    assert.equal(walk(t.config.blobDir).length, before - 1);
    assert.equal((await a.get(`/api/files/${f.id}`)).status, 404);
  });

  it('empties the trash', async () => {
    const x = (await a.upload('e1.txt', 'x')).json; await a.del(`/api/files/${x.id}`);
    const r = await a.post('/api/trash/empty');
    assert.ok(r.json.deleted >= 1);
    assert.equal((await a.get('/api/files?view=trash')).json.items.length, 0);
  });

  it('copies files (not folders) with independent content', async () => {
    const f = (await a.upload('orig.txt', 'original')).json;
    const c = await a.post(`/api/files/${f.id}/copy`, {});
    assert.equal(c.status, 201); assert.notEqual(c.json.id, f.id); assert.equal(c.json.name, 'orig (copy).txt');
    assert.equal(c.json.size, f.size);
    const dir = (await a.post('/api/folders', { name: 'CopyDir' })).json;
    assert.equal((await a.post(`/api/files/${dir.id}/copy`, {})).status, 400);
  });

  it('creates blank document, spreadsheet and presentation files that are valid OOXML', async () => {
    for (const [kind, editor, ext] of [['document', 'docs', 'docx'], ['spreadsheet', 'sheets', 'xlsx'], ['presentation', 'slides', 'pptx']]) {
      const r = await a.post('/api/files/new', { kind });
      assert.equal(r.status, 201, kind); assert.equal(r.json.editor, editor); assert.ok(r.json.name.endsWith(`.${ext}`));
      const bytes = (await a.get(`/api/files/${r.json.id}/content`)).body;
      assert.equal(bytes.subarray(0, 4).toString('hex'), '504b0304', `${kind} is a zip`);
    }
    assert.equal((await a.post('/api/files/new', { kind: 'pdf' })).status, 400);
    assert.equal((await a.post('/api/files/new', { kind: 'document', name: 'Plan' })).json.name, 'Plan.docx');
  });

  it('does not render uploaded SVG or HTML inline', async () => {
    const svg = (await a.upload('x.svg', '<svg onload="alert(1)"/>')).json;
    const html = (await a.upload('x.html', '<script>alert(1)</script>')).json;
    for (const f of [svg, html]) {
      const r = await a.get(`/api/files/${f.id}/content?inline=1`);
      assert.match(String(r.headers['content-disposition']), /^attachment/);
      assert.equal(r.headers['content-type'], 'application/octet-stream');
    }
  });
});

describe('content writes (editor saves) and versions', () => {
  let t: TestApp; let a: Client;
  before(async () => { t = await startApp({ KEEP_VERSIONS: '2', VERSION_INTERVAL_MIN: '0' }); a = await userClient(t, 'a@example.com'); });
  after(() => t.close());
  const put = (id: string, body: Buffer | string, ifMatch?: string) =>
    a.req('PUT', `/api/files/${id}/content`, { raw: Buffer.from(body), headers: ifMatch ? { 'if-match': ifMatch } : {} });

  it('requires If-Match and detects concurrent modification', async () => {
    const f = (await a.upload('doc.pdf', PDF)).json;
    assert.equal((await put(f.id, PDF)).status, 428);
    const ok = await put(f.id, Buffer.concat([PDF, Buffer.from('v2')]), '1');
    assert.equal(ok.status, 200); assert.equal(ok.json.version, 2);
    const stale = await put(f.id, Buffer.concat([PDF, Buffer.from('stale')]), '1');
    assert.equal(stale.status, 409); assert.equal(stale.json.error, 'version_conflict');
    assert.equal((await a.get(`/api/files/${f.id}/content`)).body.toString().endsWith('v2'), true, 'stale write did not clobber');
  });

  it('refuses content that contradicts the type, and empty content', async () => {
    const f = (await a.upload('d2.pdf', PDF)).json;
    assert.equal((await put(f.id, 'garbage', '1')).status, 415);
    assert.equal((await put(f.id, '', '1')).status, 400);
    assert.equal((await a.get(`/api/files/${f.id}`)).json.version, 1, 'failed writes leave the file untouched');
  });

  it('keeps only the configured number of previous versions and can restore one', async () => {
    const f = (await a.upload('v.pdf', Buffer.concat([PDF, Buffer.from('one')]))).json;
    for (let v = 1; v <= 4; v++) assert.equal((await put(f.id, Buffer.concat([PDF, Buffer.from('rev' + (v + 1))]), String(v))).status, 200);
    const d = (await a.get(`/api/files/${f.id}`)).json;
    assert.equal(d.version, 5); assert.deepEqual(d.versions.map((x: any) => x.version), [4, 3]);
    const r = await a.post(`/api/files/${f.id}/versions/3/restore`);
    assert.equal(r.status, 200); assert.equal(r.json.version, 6);
    assert.equal((await a.get(`/api/files/${f.id}/content`)).body.toString().endsWith('rev3'), true);
    assert.equal((await a.post(`/api/files/${f.id}/versions/1/restore`)).status, 404, 'pruned version is gone');
  });

  it('coalesces rapid autosaves into one retained checkpoint per interval', async () => {
    const t2 = await startApp({ KEEP_VERSIONS: '5', VERSION_INTERVAL_MIN: '10' }); const c = await userClient(t2, 'auto@example.com');
    try {
      const f = (await c.upload('auto.pdf', PDF)).json;
      for (let v = 1; v <= 6; v++) {
        const r = await c.req('PUT', `/api/files/${f.id}/content`, { raw: Buffer.concat([PDF, Buffer.from('s' + v)]), headers: { 'if-match': String(v) } });
        assert.equal(r.status, 200);
      }
      const d = (await c.get(`/api/files/${f.id}`)).json;
      assert.equal(d.version, 7, 'every save still bumps the version');
      assert.equal(d.versions.length, 1, 'but only one checkpoint is retained inside the interval');
      assert.equal(walk(t2.config.blobDir).length, 2, 'superseded blobs are deleted, not leaked');
      // Once the interval has elapsed, the next save retains another checkpoint.
      t2.app.ctx.db.prepare('UPDATE file_versions SET created_at = created_at - 11 * 60 * 1000').run();
      await c.req('PUT', `/api/files/${f.id}/content`, { raw: Buffer.concat([PDF, Buffer.from('later')]), headers: { 'if-match': '7' } });
      assert.equal((await c.get(`/api/files/${f.id}`)).json.versions.length, 2);
    } finally { await t2.close(); }
  });

  it('leaves no temp files behind after failed or rejected uploads', async () => {
    await a.upload('bad.pdf', 'nope');
    await put((await a.upload('ok.pdf', PDF)).json.id, 'nope', '1');
    assert.equal(walk(t.config.tmpDir).length, 0);
  });
});

describe('limits', () => {
  it('rejects oversize uploads (by header and by actual size) and cleans up', async () => {
    const t = await startApp({ MAX_UPLOAD_MB: '1' }); const c = await userClient(t, 'l@example.com');
    try {
      const big = Buffer.alloc(1024 * 1024 + 10, 1);
      const r = await c.upload('big.bin', big);
      assert.equal(r.status, 413);
      assert.equal(walk(t.config.tmpDir).length, 0);
      assert.equal(walk(t.config.blobDir).length, 0);
      assert.equal((await c.get('/api/files')).json.items.length, 0);
    } finally { await t.close(); }
  });

  it('enforces per-user storage quota', async () => {
    const t = await startApp({ USER_QUOTA_MB: '1' }); const c = await userClient(t, 'q@example.com');
    try {
      assert.equal((await c.upload('a.bin', Buffer.alloc(700 * 1024))).status, 201);
      const r = await c.upload('b.bin', Buffer.alloc(700 * 1024));
      assert.equal(r.status, 413); assert.equal(r.json.error, 'quota_exceeded');
      assert.equal(walk(t.config.tmpDir).length, 0);
      assert.equal(walk(t.config.blobDir).length, 1);
    } finally { await t.close(); }
  });
});

describe('authorization: users can never reach each other\'s files', () => {
  let t: TestApp; let alice: Client; let bob: Client; let admin: Client;
  let file: any, folder: any, trashed: any;
  before(async () => {
    t = await startApp();
    alice = await userClient(t, 'alice@example.com'); bob = await userClient(t, 'bob@example.com'); admin = await userClient(t, 'root@example.com', 'admin');
    folder = (await alice.post('/api/folders', { name: 'Private' })).json;
    file = (await alice.upload('secret.pdf', PDF, folder.id)).json;
    trashed = (await alice.upload('old.txt', 'x')).json; await alice.del(`/api/files/${trashed.id}`);
  });
  after(() => t.close());

  it('returns 404 (not 403) for every operation on another user\'s file, hiding existence', async () => {
    for (const c of [bob, admin]) {
      const who = c === bob ? 'user' : 'admin';
      assert.equal((await c.get(`/api/files/${file.id}`)).status, 404, `${who} details`);
      assert.equal((await c.get(`/api/files/${file.id}/content`)).status, 404, `${who} download`);
      assert.equal((await c.req('PUT', `/api/files/${file.id}/content`, { raw: PDF, headers: { 'if-match': '1' } })).status, 404, `${who} overwrite`);
      assert.equal((await c.patch(`/api/files/${file.id}`, { name: 'pwned.pdf' })).status, 404, `${who} rename`);
      assert.equal((await c.patch(`/api/files/${file.id}`, { starred: true })).status, 404, `${who} star`);
      assert.equal((await c.post(`/api/files/${file.id}/copy`, {})).status, 404, `${who} copy`);
      assert.equal((await c.post(`/api/files/${file.id}/open`)).status, 404, `${who} open`);
      assert.equal((await c.del(`/api/files/${file.id}`)).status, 404, `${who} trash`);
      assert.equal((await c.post(`/api/files/${file.id}/versions/1/restore`)).status, 404, `${who} version restore`);
      assert.equal((await c.get(`/api/files?parentId=${folder.id}`)).status, 404, `${who} list folder`);
      assert.equal((await c.post(`/api/files/${trashed.id}/restore`)).status, 404, `${who} restore`);
      assert.equal((await c.del(`/api/files/${trashed.id}/permanent`)).status, 404, `${who} permanent delete`);
    }
    // ...and Alice's data is unchanged.
    const d = (await alice.get(`/api/files/${file.id}`)).json;
    assert.equal(d.name, 'secret.pdf'); assert.equal(d.starred, false); assert.equal(d.trashedAt, null);
  });

  it('never lists, searches or counts another user\'s files', async () => {
    for (const c of [bob, admin]) {
      assert.equal((await c.get('/api/files')).json.items.length, 0);
      assert.equal((await c.get('/api/files?search=secret')).json.items.length, 0);
      assert.equal((await c.get('/api/files?view=trash')).json.items.length, 0);
      assert.equal((await c.get('/api/files?view=recent')).json.items.length, 0);
      assert.equal((await c.get('/api/storage')).json.used, 0);
    }
  });

  it('prevents creating or moving things into another user\'s folder', async () => {
    assert.equal((await bob.upload('x.txt', 'x', folder.id)).status, 404);
    assert.equal((await bob.post('/api/folders', { name: 'x', parentId: folder.id })).status, 404);
    const mine = (await bob.upload('mine.txt', 'x')).json;
    assert.equal((await bob.patch(`/api/files/${mine.id}`, { parentId: folder.id })).status, 404);
    assert.equal((await bob.post('/api/files/new', { kind: 'document', parentId: folder.id })).status, 404);
    assert.equal((await bob.post(`/api/files/${mine.id}/copy`, { parentId: folder.id })).status, 404);
    assert.equal((await alice.get(`/api/files?parentId=${folder.id}`)).json.items.length, 1, 'Alice\'s folder is untouched');
  });

  it('removes a deleted user\'s files from disk', async () => {
    const victim = await userClient(t, 'victim@example.com');
    await victim.upload('v.txt', 'x');
    const before = walk(t.config.blobDir).length;
    const id = (await admin.get('/api/admin/users')).json.users.find((u: any) => u.email === 'victim@example.com').id;
    assert.equal((await admin.del(`/api/admin/users/${id}`)).status, 200);
    assert.equal(walk(t.config.blobDir).length, before - 1);
  });
});
