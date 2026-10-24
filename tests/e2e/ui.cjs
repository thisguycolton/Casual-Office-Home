const { chromium } = require('playwright');
// Usage: BASE_URL=http://localhost ADMIN_EMAIL=... ADMIN_PASSWORD=... node tests/e2e/ui.cjs   (needs a FRESH instance with that admin)
const base = process.env.BASE_URL ?? 'http://127.0.0.1:3100';
const EMAIL = process.env.ADMIN_EMAIL ?? 'admin@example.com', PASSWORD = process.env.ADMIN_PASSWORD ?? 'correct horse battery';
const zip = Buffer.concat([Buffer.from([0x50, 0x4b, 3, 4]), Buffer.from('e2e fixture')]);
const fixtures = [
  { name: 'sample.docx', mimeType: 'application/octet-stream', buffer: zip },
  { name: 'e2e.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n% e2e\n') },
  { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hello text file') },
];
const step = (m) => console.log('•', m);
(async () => {
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 1360, height: 860 } });
  const p = await ctx.newPage();
  const errs = []; p.on('pageerror', e => errs.push('PAGEERR ' + e.message)); p.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
  const ext = new Set(); p.on('request', r => { const u = r.url(); if (!u.startsWith(base) && !/^(data|blob):/.test(u)) ext.add(u); });

  await p.goto(base + '/');
  await p.getByLabel('Email').fill(EMAIL); await p.getByLabel('Password').fill('wrong password here');
  await p.getByRole('button', { name: 'Sign in' }).click();
  await p.getByRole('alert').waitFor(); step('bad login shows error: ' + await p.getByRole('alert').innerText());
  await p.getByLabel('Password').fill(PASSWORD); await p.getByRole('button', { name: 'Sign in' }).click();
  await p.getByText('Welcome, Administrator').waitFor(); step('logged in, home dashboard visible');
  await p.screenshot({ path: require('os').tmpdir() + '/e2e-home.png' });

  // create folder through New menu
  await p.getByRole('button', { name: 'New', exact: true }).first().click();
  await p.getByRole('menuitem', { name: 'New folder' }).click();
  await p.locator('#name-input').fill('Projects'); await p.getByRole('button', { name: 'Create' }).click();
  await p.getByRole('link', { name: 'Projects' }).first().waitFor(); step('folder created');
  await p.getByRole('link', { name: 'Projects' }).first().click();
  await p.waitForURL(/\/files\//); step('navigated into folder: ' + p.url().replace(base, ''));

  // upload via file chooser
  const [chooser] = await Promise.all([p.waitForEvent('filechooser'), (async () => { await p.getByRole('button', { name: 'New', exact: true }).first().click(); await p.getByRole('menuitem', { name: 'Upload files' }).click(); })()]);
  await chooser.setFiles(fixtures);
  await p.getByRole('link', { name: 'sample.docx' }).waitFor(); await p.getByText('Uploads complete').waitFor(); step('3 files uploaded with progress panel completing');

  // create blank spreadsheet in this folder -> lands on open page
  await p.getByRole('button', { name: 'New', exact: true }).first().click(); await p.getByRole('menuitem', { name: 'New spreadsheet' }).click();
  await p.waitForURL(/\/open\//); step('new spreadsheet created and opened: ' + await p.locator('h1').innerText());
  await p.screenshot({ path: require('os').tmpdir() + '/e2e-open.png' });
  await p.getByRole('link', { name: '← Back' }).click(); await p.waitForURL(/\/files\/[0-9a-f-]{36}$/); step('returned to the same folder: ' + p.url().replace(base, ''));

  // rename via context menu
  await p.getByRole('button', { name: 'Actions for notes.txt' }).click(); await p.getByRole('menuitem', { name: 'Rename' }).click();
  await p.locator('#name-input').fill('renamed-notes.txt'); await p.getByRole('button', { name: 'Rename' }).click();
  await p.getByRole('link', { name: 'renamed-notes.txt' }).waitFor(); step('renamed');
  // star
  await p.getByRole('button', { name: 'Actions for e2e.pdf' }).click(); await p.getByRole('menuitem', { name: 'Add star' }).click();
  await p.getByTitle('Starred').first().waitFor(); step('starred');
  await p.screenshot({ path: require('os').tmpdir() + '/e2e-folder.png' });
  // grid view
  await p.getByRole('button', { name: 'Grid view' }).click(); await p.locator('.cards').waitFor(); step('grid view'); await p.screenshot({ path: require('os').tmpdir() + '/e2e-grid.png' });
  await p.getByRole('button', { name: 'List view' }).click();
  // details
  await p.getByRole('button', { name: 'Actions for sample.docx' }).click(); await p.getByRole('menuitem', { name: 'Details' }).click(); await p.getByText('SHA-256').waitFor(); step('details panel'); await p.screenshot({ path: require('os').tmpdir() + '/e2e-details.png' });
  // text preview
  await p.getByRole('link', { name: 'renamed-notes.txt' }).click(); await p.getByText('hello text file').waitFor(); step('text file preview');
  await p.goBack();
  // search
  await p.getByLabel('Search files by name').first().fill('sample'); await p.keyboard.press('Enter'); await p.waitForURL(/search/);
  await p.getByRole('link', { name: 'sample.docx' }).waitFor(); step('search found sample.docx');
  // trash + restore
  await p.getByRole('button', { name: 'Actions for sample.docx' }).click(); await p.getByRole('menuitem', { name: 'Move to trash' }).click();
  await p.getByText(/No matching files/).waitFor(); step('trashed (gone from search)');
  await p.getByRole('link', { name: 'Trash' }).click(); await p.locator('.row .name', { hasText: 'sample.docx' }).waitFor();
  await p.getByRole('button', { name: 'Actions for sample.docx' }).click(); await p.getByRole('menuitem', { name: 'Restore' }).click();
  await p.getByText('Trash is empty').waitFor(); step('restored from trash');
  await p.getByRole('link', { name: 'Shared Files' }).click(); await p.getByText('Sharing isn’t available yet').waitFor(); step('shared view is honest');
  // admin page
  await p.getByRole('link', { name: 'Administration' }).click(); await p.getByText(EMAIL).first().waitFor(); step('admin page'); await p.screenshot({ path: require('os').tmpdir() + '/e2e-admin.png' });
  // logout
  await p.getByRole('button', { name: 'Account menu' }).click(); await p.getByRole('menuitem', { name: 'Sign out' }).click(); await p.getByRole('heading', { name: 'Sign in' }).waitFor(); step('signed out');
  await p.goto(base + '/files'); await p.getByRole('heading', { name: 'Sign in' }).waitFor(); step('protected route redirects to sign in');

  console.log('EXTERNAL REQUESTS:', JSON.stringify([...ext]));
  console.log('ERRORS:', JSON.stringify(errs.filter(e => !/401/.test(e))));
  await b.close();
})().catch(e => { console.error('FAIL', e.message.split('\n').slice(0, 6).join('\n')); process.exit(1); });
