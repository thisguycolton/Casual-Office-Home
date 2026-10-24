// A Markdown file converts into a new Word document and opens in live Docs; the .md is untouched.
const { chromium } = require('playwright');
const { startStack, person } = require('./collab-lib.cjs');
(async () => {
  const stack = await startStack(); const browser = await chromium.launch(); let failed = false;
  try {
    const a = await person(browser, stack.base, 'alice@example.com');
    const md = '# Hello Markdown\n\nSome **bold** text.\n\n- item-one\n- item-two\n';
    const f = await a.upload('notes.md', Buffer.from(md));
    await a.page.goto(`${stack.base}/open/${f.id}`);
    await a.page.getByRole('button', { name: 'Open in Docs' }).click();
    await a.page.getByText(/^Live — changes are shared/).waitFor({ timeout: 60000 });
    for (const t of ['Hello Markdown', 'item-two']) await a.page.getByText(t).first().waitFor({ timeout: 20000 });
    const list = await (await a.ctx.request.get(`${stack.base}/api/files`)).json();
    const names = list.items.map((i) => i.name).sort();
    if (names.join() !== 'notes.docx,notes.md') throw new Error('files: ' + names);
    const orig = Buffer.from(await (await a.ctx.request.get(`${stack.base}/api/files/${f.id}/content`)).body()).toString();
    if (orig !== md) throw new Error('original .md changed');
    console.log('PASS: markdown → Word → live Docs; original untouched');
  } catch (e) { failed = true; console.error('FAIL:', e.message); } finally { await browser.close(); stack.stop(); process.exit(failed ? 1 : 0); }
})();
