// Two (and then three) people co-edit one .docx through the real stack: app + collab service + Chromium.
// Usage: node tests/e2e/collab-docs.cjs        (needs web/dist built: cd web && npx vite build)
const { chromium } = require('playwright');
const { execFileSync } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path');
const { startStack, person, zipEntries, until, sleep } = require('./collab-lib.cjs');
const step = (m) => console.log('•', m);
// The editor repaints its page DOM constantly, so locators go stale between lookup and click; read the rect in one evaluate.
async function runRect(page, text) {
  return until(() => page.evaluate((t) => {
    const el = [...document.querySelectorAll('.layout-run')].find((e) => e.textContent.includes(t));
    if (!el) return null; const r = el.getBoundingClientRect(); return r.width ? { x: r.x, y: r.y, width: r.width, height: r.height } : null;
  }, text), 20000, 'painted text ' + text);
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-e2e-'));

function makeFixture() {
  const out = path.join(tmp, 'rich.docx');
  const py = `
import sys, docx
from docx.shared import Pt
d = docx.Document()
d.add_heading('Quarterly plan', 1)
p = d.add_paragraph('Intro paragraph with '); r = p.add_run('bold text'); r.bold = True
d.add_paragraph('First bullet', style='List Bullet'); d.add_paragraph('Second bullet', style='List Bullet')
t = d.add_table(rows=2, cols=2); t.style = 'Table Grid'
for i, c in enumerate(['A1','B1','A2','B2']): t.cell(i//2, i%2).text = c
d.sections[0].header.paragraphs[0].text = 'HEADER-MARK'
d.sections[0].footer.paragraphs[0].text = 'FOOTER-MARK'
d.add_paragraph('Commented sentence.')
d.add_comment(d.paragraphs[-1].runs, text='COMMENT-MARK', author='Fixture', initials='FX')
d.add_paragraph('END-OF-FIXTURE')
d.save(sys.argv[1])`;
  execFileSync('python3', ['-I', '-c', py, out]); return fs.readFileSync(out);
}

(async () => {
  const stack = await startStack();
  const browser = await chromium.launch();
  let failed = false;
  try {
    const alice = await person(browser, stack.base, 'alice@example.com');
    const bob = await person(browser, stack.base, 'bob@example.com', { register: true, name: 'Bob' });
    const carol = await person(browser, stack.base, 'carol@example.com', { register: true, name: 'Carol' });
    const original = makeFixture();
    const file = await alice.upload('plan.docx', original);
    await alice.share(file.id, 'bob@example.com', 'editor');
    await alice.share(file.id, 'carol@example.com', 'viewer');
    step('fixture uploaded and shared (bob: editor, carol: viewer)');

    await bob.page.goto(`${stack.base}/shared`);
    await bob.page.getByText('plan.docx').first().waitFor({ timeout: 15000 });
    await bob.page.getByText(/can edit/).first().waitFor();
    step('the file shows up in Bob’s Shared Files with the owner and his access');

    // Alice and Bob open at the same moment: exactly one of them must seed.
    await Promise.all([alice.page.goto(`${stack.base}/open/${file.id}`), bob.page.goto(`${stack.base}/open/${file.id}`)]);
    for (const who of [alice, bob]) await who.page.getByText(/^Live — changes are shared/).waitFor({ timeout: 60000 });
    step('both editors are live');
    for (const who of [alice, bob]) await who.page.getByText('Quarterly plan').first().waitFor({ timeout: 20000 });
    // The editor paints the text in more than one layer, so compare the two people's views with each other; the stored
    // file is checked for duplicated content below (a double-seed would show up there).
    const counts = await Promise.all([alice, bob].map((w) => w.page.getByText('END-OF-FIXTURE').count()));
    if (counts[0] !== counts[1] || counts[0] < 1) throw new Error('views differ after seeding: ' + counts);
    step('document seeded; both people see the same content');
    await alice.page.screenshot({ path: path.join(tmp, 'alice-live.png') });

    // Type in both.
    const typeInto = async (who, text) => {
      // The editor repaints constantly, so a stability-checking click never settles; click by coordinates instead.
      const box = await runRect(who.page, 'END-OF-FIXTURE');
      await who.page.mouse.click(box.x + box.width - 2, box.y + box.height / 2);
      await who.page.keyboard.press('End'); await who.page.keyboard.type(text);
    };
    await typeInto(alice, ' ALICE-WAS-HERE');
    await bob.page.getByText(/ALICE-WAS-HERE/).first().waitFor({ timeout: 15000 });
    await typeInto(bob, ' BOB-TOO');
    await alice.page.getByText(/BOB-TOO/).first().waitFor({ timeout: 15000 });
    step('typing flows both ways in real time');

    // Carol (viewer) sees it live and cannot change it.
    await carol.page.goto(`${stack.base}/open/${file.id}`);
    await carol.page.getByText(/^Live — changes are shared/).waitFor({ timeout: 60000 });
    await carol.page.getByText(/BOB-TOO/).first().waitFor({ timeout: 15000 });
    await carol.page.getByText('View only').waitFor();
    const cb = await runRect(carol.page, 'END-OF-FIXTURE');
    await carol.page.mouse.click(cb.x + cb.width - 2, cb.y + cb.height / 2); await carol.page.keyboard.press('End'); await carol.page.keyboard.type('CAROL-SHOULD-NOT');
    await sleep(1500);
    if (await alice.page.getByText(/CAROL-SHOULD-NOT/).count()) throw new Error('viewer edit reached the room');
    step('viewer sees live content; their keystrokes never reach the room');

    // One save, containing both edits and the document's original parts.
    const v0 = (await alice.details(file.id)).version;
    const saved = await until(async () => { const d = await alice.details(file.id); return d.version > v0 ? d : null; }, 40000, 'autosave');
    await sleep(6000); // let any (wrong) second writer show itself
    const final = await alice.details(file.id);
    step(`stored versions ${v0} → ${final.version} (saves by leader only)`);
    if (final.version - v0 > 2) throw new Error('too many saves: ' + (final.version - v0));
    const parts = zipEntries(await alice.bytes(file.id), tmp);
    const names = Object.keys(parts);
    const origNames = Object.keys(zipEntries(original, tmp));
    const missing = origNames.filter((n) => !names.includes(n));
    if (missing.length) throw new Error('saved file lost package parts: ' + missing.join(', '));
    const body = parts['word/document.xml'];
    for (const m of ['ALICE-WAS-HERE', 'BOB-TOO', 'Quarterly plan', 'END-OF-FIXTURE']) if (!body.includes(m)) throw new Error('document.xml missing ' + m);
    if (body.includes('CAROL-SHOULD-NOT')) throw new Error('viewer text persisted');
    const all = Object.values(parts).join('\n');
    for (const m of ['HEADER-MARK', 'FOOTER-MARK', 'COMMENT-MARK']) if (!all.includes(m)) throw new Error('saved file lost ' + m);
    if ((body.match(/END-OF-FIXTURE/g) ?? []).length !== 1) throw new Error('fixture text duplicated in stored file');
    step('stored .docx has both edits, no viewer edit, and keeps header/footer/comment/styles/numbering');

    const liveErrors = [alice, bob, carol].map((w) => w.errors.length);
    // Close everything, reopen alone: the room is gone, the file is the truth.
    await alice.page.goto(stack.base + '/'); await bob.page.goto(stack.base + '/'); await carol.page.goto(stack.base + '/');
    await sleep(1500);
    await alice.page.goto(`${stack.base}/open/${file.id}`);
    await alice.page.getByText(/^Live — changes are shared/).waitFor({ timeout: 60000 });
    await alice.page.getByText(/ALICE-WAS-HERE/).first().waitFor({ timeout: 20000 });
    await alice.page.getByText(/BOB-TOO/).first().waitFor({ timeout: 5000 });
    step('reopened alone: both edits present (loaded from the saved file)');

    [alice, bob, carol].forEach((w, i) => { if (liveErrors[i]) console.log('page errors DURING live editing for', w.email, w.errors.slice(0, liveErrors[i])); if (w.errors.length > liveErrors[i]) console.log('page errors while leaving the editor for', w.email, w.errors.slice(liveErrors[i], liveErrors[i] + 2)); });
    console.log('\nPASS: docs co-editing journey');
  } catch (e) {
    failed = true; console.error('\nFAIL:', e.message); console.error(stack.logs.join('').split('\n').slice(-25).join('\n'));
  } finally {
    await browser.close(); stack.stop(); console.log('artifacts:', tmp);
    process.exit(failed ? 1 : 0);
  }
})();
