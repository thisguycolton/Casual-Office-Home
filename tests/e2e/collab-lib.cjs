// Shared helpers for the multi-user co-editing journeys: boots a throwaway app + collab service and gives each person
// their own browser context (separate cookies, i.e. separate sessions).
const { spawn, execFileSync } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path');
const root = path.resolve(__dirname, '../..');

const SECRET = 'e2e-secret-e2e-secret-e2e-secret-0123456789';
const PASSWORD = 'correct horse battery';

async function waitFor(url, ms = 20000) {
  const t = Date.now();
  while (Date.now() - t < ms) { try { const r = await fetch(url); if (r.ok) return; } catch { /* not up yet */ } await new Promise((r) => setTimeout(r, 200)); }
  throw new Error('timeout waiting for ' + url);
}

async function startStack({ collab = true, appPort = 3300, collabPort = 3301 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'collab-e2e-'));
  const procs = [];
  const logs = [];
  const run = (cwd, script, env) => {
    const p = spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', script], { cwd, env: { ...process.env, ...env } });
    p.stdout.on('data', (d) => logs.push(String(d))); p.stderr.on('data', (d) => logs.push(String(d)));
    procs.push(p); return p;
  };
  if (collab) {
    run(path.join(root, 'collab'), 'src/server.ts', { PORT: String(collabPort), HOST: '127.0.0.1', COLLAB_JWT_SECRET: SECRET, SEED_TIMEOUT_MS: '8000' });
    await waitFor(`http://127.0.0.1:${collabPort}/health`);
  }
  run(path.join(root, 'app'), 'src/server.ts', {
    PORT: String(appPort), HOST: '127.0.0.1', APP_ROOT: path.join(root, 'app'), DATA_DIR: path.join(dir, 'data'), PUBLIC_DIR: path.join(root, 'web/dist'), EDITORS_DIR: path.join(dir, 'none'),
    SECURE_COOKIES: 'false', ALLOW_REGISTRATION: 'true', RATE_LIMIT: 'false', LOG_LEVEL: 'warn',
    BOOTSTRAP_ADMIN_EMAIL: 'alice@example.com', BOOTSTRAP_ADMIN_PASSWORD: PASSWORD,
    ...(collab ? { COLLAB_JWT_SECRET: SECRET, COLLAB_INTERNAL_URL: `http://127.0.0.1:${collabPort}`, VERSION_INTERVAL_MIN: '0' } : {}),
  });
  const base = `http://127.0.0.1:${appPort}`;
  const stop = () => { for (const p of procs) p.kill('SIGKILL'); fs.rmSync(dir, { recursive: true, force: true }); };
  try { await waitFor(base + '/api/health'); }
  catch (e) { stop(); throw new Error(e.message + '\n' + logs.join('').split('\n').slice(-15).join('\n')); }
  return { base, dir, logs, stop };
}

/** A signed-in person with their own browser context. */
async function person(browser, base, email, { register = false, name } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  if (register) {
    const r = await ctx.request.post(base + '/api/auth/register', { data: { email, password: PASSWORD, displayName: name ?? email.split('@')[0] }, headers: { origin: base } });
    if (!r.ok()) throw new Error('register failed ' + r.status() + ' ' + await r.text());
  }
  await page.goto(base + '/');
  if (!register) { // registering already signed this context in
    await page.getByLabel('Email').fill(email); await page.getByLabel('Password').fill(PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();
  }
  await page.getByText(/^Welcome/).waitFor();
  const csrf = (await (await ctx.request.get(base + '/api/auth/me')).json()).csrfToken;
  const call = async (method, url, opts = {}) => {
    const r = await ctx.request.fetch(base + url, { method, headers: { origin: base, 'x-csrf-token': csrf, ...(opts.headers ?? {}) }, data: opts.data, ...(opts.json ? { data: JSON.stringify(opts.json), headers: { origin: base, 'x-csrf-token': csrf, 'content-type': 'application/json' } } : {}) });
    return r;
  };
  return {
    email, ctx, page, errors, call,
    async upload(name, buf) { const r = await call('POST', `/api/files?name=${encodeURIComponent(name)}`, { data: buf, headers: { 'content-type': 'application/octet-stream' } }); if (!r.ok()) throw new Error('upload ' + r.status() + await r.text()); return r.json(); },
    async share(id, email, role) { const r = await call('PUT', `/api/files/${id}/shares`, { json: { email, role } }); if (!r.ok()) throw new Error('share ' + r.status() + await r.text()); },
    async details(id) { return (await ctx.request.get(`${base}/api/files/${id}`)).json(); },
    async bytes(id) { return Buffer.from(await (await ctx.request.get(`${base}/api/files/${id}/content`)).body()); },
  };
}

function zipEntries(buf, dir) {
  const f = path.join(dir, 'z-' + Math.random().toString(36).slice(2) + '.zip'); fs.writeFileSync(f, buf);
  const py = `import zipfile,sys,json\nz=zipfile.ZipFile(sys.argv[1]);print(json.dumps({n:z.read(n).decode('utf8','ignore') if n.endswith('.xml') or n.endswith('.rels') else '' for n in z.namelist() if not n.endswith('/')}))`;
  return JSON.parse(execFileSync('python3', ['-I', '-c', py, f]).toString());
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 30000, what = 'condition') { const t = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t > ms) throw new Error('timeout: ' + what); await sleep(250); } }

module.exports = { startStack, person, zipEntries, until, sleep, PASSWORD, root };
