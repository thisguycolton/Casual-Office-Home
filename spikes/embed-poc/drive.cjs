const { chromium } = require('playwright');
const [,, app, docId, typed, cookie='valid'] = process.argv;
(async () => {
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 1400, height: 900 } });
  if (cookie) await ctx.addCookies([{ name: 'sid', value: cookie, url: 'http://localhost:18999' }]);
  const p = await ctx.newPage();
  const errs = []; p.on('pageerror', e => errs.push(String(e).slice(0,160))); p.on('console', m => { if (m.type()==='error') errs.push('console: '+m.text().slice(0,160)); });
  await p.goto(`http://localhost:18999/host.html?app=${app}&docId=${docId}`);
  await p.waitForTimeout(app === 'docs' ? 9000 : 15000);
  const fr = p.frames().find(f => f.url().includes('/embed/'));
  const text = fr ? (await fr.evaluate(() => document.body.innerText)).replace(/\s+/g,' ').slice(0, 300) : 'NO FRAME';
  console.log('events:', JSON.stringify(await p.evaluate(() => window.__events)));
  console.log('iframe text:', text);
  await p.screenshot({ path: `${app}-open.png` });
  if (typed) {
    if (app === 'docs') { await p.mouse.click(700, 300); } else { await p.mouse.click(420, 330); }
    await p.keyboard.type(typed); if (app!=='docs') await p.keyboard.press('Enter');
    await p.waitForTimeout(app === 'docs' ? 42000 : 1500);
    if (app !== 'docs') { await p.evaluate(() => window.__saveNow()); await p.waitForTimeout(8000); }
    await p.screenshot({ path: `${app}-edited.png` });
    console.log('events after edit:', JSON.stringify(await p.evaluate(() => window.__events)));
  }
  console.log('errors:', JSON.stringify(errs.slice(0,5)));
  await b.close();
})();
