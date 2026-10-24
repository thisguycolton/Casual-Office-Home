// Editor integration journey: create → edit → save → verify stored bytes → reopen.
// Usage: BASE_URL=... ADMIN_EMAIL=... ADMIN_PASSWORD=... node tests/e2e/editors.cjs   (needs a FRESH instance + editor bundles)
const { chromium } = require('playwright');
const { execFileSync } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path');
const base = process.env.BASE_URL ?? 'http://127.0.0.1:3100';
const EMAIL = process.env.ADMIN_EMAIL ?? 'admin@example.com', PASSWORD = process.env.ADMIN_PASSWORD ?? 'correct horse battery';
const only = process.env.ONLY; // 'sheets' | 'docs'
const step = (m) => console.log('•', m);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'editors-e2e-'));
const shot = (n) => path.join(tmp, n + '.png');

function zipContains(buf, needle, parts) {
  const f = path.join(tmp, 'x.zip'); fs.writeFileSync(f, buf);
  const py = `import zipfile,sys\nz=zipfile.ZipFile(sys.argv[1]);blob=b''.join(z.read(n) for n in z.namelist() if n.endswith('.xml') and any(n.startswith(p) for p in sys.argv[3].split(',')))\nprint(sys.argv[2].encode() in blob)`;
  return execFileSync('python3', ['-I', '-c', py, f, needle, parts]).toString().trim() === 'True';
}

(async () => {
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 1400, height: 900 } });
  const p = await ctx.newPage();
  const errs = []; p.on('pageerror', (e) => errs.push('PAGEERR ' + e.message));
  const ext = new Set(); p.on('request', (r) => { const u = r.url(); if (!u.startsWith(base) && !/^(data|blob):/.test(u)) ext.add(new URL(u).host); });
  await p.goto(base + '/'); await p.getByLabel('Email').fill(EMAIL); await p.getByLabel('Password').fill(PASSWORD);
  await p.getByRole('button', { name: 'Sign in' }).click(); await p.getByText(/^Welcome/).waitFor();

  // A folder, so we can prove "Back" returns to the same place.
  await p.getByRole('button', { name: 'New', exact: true }).first().click(); await p.getByRole('menuitem', { name: 'New folder' }).click();
  await p.locator('#name-input').fill('Work'); await p.getByRole('button', { name: 'Create' }).click();
  await p.getByRole('link', { name: 'Work' }).first().click(); await p.waitForURL(/\/files\/[0-9a-f-]{36}$/);
  const folderUrl = p.url();

  const api = async (url) => ctx.request.get(base + url);
  const listFile = async (name) => (await (await api('/api/files?parentId=' + folderUrl.split('/').pop())).json()).items.find((i) => i.name === name);
  const bytesOf = async (id) => Buffer.from(await (await api(`/api/files/${id}/content`)).body());

  if (!only || only === 'sheets') {
    await p.getByRole('button', { name: 'New', exact: true }).first().click(); await p.getByRole('menuitem', { name: 'New spreadsheet' }).click();
    await p.waitForURL(/\/open\//); const fileUrl = p.url();
    const frame = p.frameLocator('iframe.editor-frame');
    await frame.getByText('Sheet1').first().waitFor({ timeout: 30000 });
    await p.waitForTimeout(3000); step('Sheets editor loaded inside the host page');
    await p.screenshot({ path: shot('sheets-open') });
    // Click a cell in the grid and type.
    await p.mouse.click(90, 184); await p.keyboard.type('HELLO-FROM-SHEETS'); await p.keyboard.press('Enter');
    await p.getByText('All changes saved').waitFor({ timeout: 40000 }); step('host reported the sheet as saved');
    const f = await listFile('Untitled spreadsheet.xlsx');
    const bytes = await bytesOf(f.id);
    step(`stored xlsx: version ${f.version}, ${bytes.length} bytes, contains edit: ` + zipContains(bytes, 'HELLO-FROM-SHEETS', 'xl/'));
    if (!zipContains(bytes, 'HELLO-FROM-SHEETS', 'xl/')) throw new Error('edit not found in stored xlsx');
    await p.screenshot({ path: shot('sheets-saved') });

    // Reopen from scratch: the edit must come back.
    await p.goto(fileUrl); await p.waitForTimeout(9000);
    const snap = await p.frames().find((x) => x.url().includes('/editors/sheets/')).evaluate(() => JSON.stringify(window.__casualEmbedApi.getSnapshot()));
    if (!snap.includes('HELLO-FROM-SHEETS')) throw new Error('edit missing after reopen'); step('reopened: edit is present in the editor');

    // Back returns to the same folder, and the file manager reflects the save.
    await p.getByRole('link', { name: '← Back' }).click(); await p.waitForURL(folderUrl);
    await p.getByRole('link', { name: 'Untitled spreadsheet.xlsx' }).waitFor(); step('Back returned to the same folder; file listed');
    const after = await listFile('Untitled spreadsheet.xlsx'); step(`file manager metadata updated: version ${after.version}, size ${after.size}`);

    // Conflict: someone else changes the file; the editor must not overwrite it, and must keep the user's work.
    await p.goto(fileUrl); await p.waitForTimeout(8000);
    const csrf = (await (await api('/api/auth/me')).json()).csrfToken;
    const cur = await listFile('Untitled spreadsheet.xlsx');
    const put = await ctx.request.put(`${base}/api/files/${cur.id}/content`, { headers: { 'if-match': String(cur.version), 'x-csrf-token': csrf, origin: base, 'content-type': 'application/octet-stream' }, data: await bytesOf(cur.id) });
    if (put.status() !== 200) throw new Error('external write failed ' + put.status());
    await p.mouse.click(178, 224); await p.keyboard.type('CONFLICT-EDIT'); await p.keyboard.press('Enter');
    await p.getByRole('alert').filter({ hasText: 'changed somewhere else' }).waitFor({ timeout: 40000 }); step('conflict detected; editor refused to overwrite');
    await p.screenshot({ path: shot('sheets-conflict') });
    await p.getByRole('button', { name: 'Save my version as a copy' }).click(); await p.waitForURL(folderUrl);
    const copy = await listFile('Untitled spreadsheet (conflicted copy).xlsx');
    if (!copy || !zipContains(await bytesOf(copy.id), 'CONFLICT-EDIT', 'xl/')) throw new Error('conflict copy missing or lost the edit');
    step('user\'s work preserved as a conflicted copy');
  }

  if (!only || only === 'docs') {
    await p.goto(folderUrl);
    await p.getByRole('button', { name: 'New', exact: true }).first().click(); await p.getByRole('menuitem', { name: 'New document' }).click();
    await p.waitForURL(/\/open\//); const fileUrl = p.url();
    const frame = p.frameLocator('iframe.editor-frame');
    await frame.getByText('Page 1 of 1').waitFor({ timeout: 30000 }); await p.waitForTimeout(1500); step('Docs editor loaded inside the host page');
    await p.mouse.click(700, 420); await p.keyboard.type('HELLO-FROM-DOCS');
    // The Docs editor autosaves every 30 s while dirty; there is no host-side flush.
    await p.getByText('All changes saved').waitFor({ timeout: 60000 }); step('host reported the document as saved (after the editor\'s 30 s autosave)');
    const f = await listFile('Untitled document.docx'); const bytes = await bytesOf(f.id);
    step(`stored docx: version ${f.version}, ${bytes.length} bytes, contains edit: ` + zipContains(bytes, 'HELLO-FROM-DOCS', 'word/'));
    if (!zipContains(bytes, 'HELLO-FROM-DOCS', 'word/')) throw new Error('edit not found in stored docx');
    await p.screenshot({ path: shot('docs-saved') });

    await p.goto(fileUrl); await p.getByText('Page 1 of 1').or(p.frameLocator('iframe.editor-frame').getByText('Page 1 of 1')).first().waitFor({ timeout: 30000 }).catch(() => {});
    await p.frameLocator('iframe.editor-frame').getByText('HELLO-FROM-DOCS').first().waitFor({ timeout: 30000 }); step('reopened: edit is present in the editor');
    await p.getByRole('link', { name: '← Back' }).click(); await p.waitForURL(folderUrl);
    await p.getByRole('link', { name: 'Untitled document.docx' }).waitFor(); step('Back returned to the same folder; file listed');

    // Leaving quickly must not lose edits made since the last 30 s autosave.
    await p.goto(fileUrl); await p.frameLocator('iframe.editor-frame').getByText('HELLO-FROM-DOCS').first().waitFor({ timeout: 30000 });
    const before2 = await listFile('Untitled document.docx');
    await p.mouse.click(700, 420); await p.keyboard.type(' QUICK-LEAVE'); await p.waitForTimeout(500);
    await p.getByRole('link', { name: '← Back' }).click(); await p.waitForURL(folderUrl);
    const after2 = await listFile('Untitled document.docx');
    if (!zipContains(await bytesOf(after2.id), 'QUICK-LEAVE', 'word/')) throw new Error('edit made just before leaving was lost');
    step(`leaving right after typing flushed the edit (version ${before2.version} → ${after2.version})`);

    // Conflict: external write between open and the editor's next autosave.
    await p.goto(fileUrl); await p.frameLocator('iframe.editor-frame').getByText('HELLO-FROM-DOCS').first().waitFor({ timeout: 30000 });
    const csrf = (await (await api('/api/auth/me')).json()).csrfToken; const cur = await listFile('Untitled document.docx');
    const put = await ctx.request.put(`${base}/api/files/${cur.id}/content`, { headers: { 'if-match': String(cur.version), 'x-csrf-token': csrf, origin: base, 'content-type': 'application/octet-stream' }, data: await bytesOf(cur.id) });
    if (put.status() !== 200) throw new Error('external write failed ' + put.status());
    await p.mouse.click(700, 420); await p.keyboard.type(' CONFLICT-EDIT');
    await p.getByRole('alert').filter({ hasText: 'changed somewhere else' }).waitFor({ timeout: 60000 }); step('conflict detected; editor refused to overwrite');
    await p.getByRole('button', { name: 'Save my version as a copy' }).click(); await p.waitForURL(folderUrl);
    const copy = await listFile('Untitled document (conflicted copy).docx');
    if (!copy || !zipContains(await bytesOf(copy.id), 'CONFLICT-EDIT', 'word/')) throw new Error('conflict copy missing or lost the edit');
    step('user\'s work preserved as a conflicted copy');
  }

  console.log('EXTERNAL HOSTS:', JSON.stringify([...ext]));
  console.log('PAGE ERRORS:', JSON.stringify(errs));
  console.log('screenshots in', tmp);
  await b.close();
})().catch((e) => { console.error('FAIL', e.message.split('\n').slice(0, 6).join('\n')); process.exit(1); });
