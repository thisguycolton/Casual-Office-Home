import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Client, PASSWORD, startApp, userClient, type TestApp } from './harness.ts';
import { _resetThrottle } from './auth/routes.ts';
import { createUser } from './auth/users.ts';

describe('authentication', () => {
  let t: TestApp;
  before(async () => { t = await startApp(); await createUser(t.app.ctx.db, { email: 'a@example.com', password: PASSWORD }); });
  after(() => t.close());

  it('rejects unauthenticated access to every protected route', async () => {
    const c = new Client(t);
    for (const [m, u] of [['GET', '/api/files'], ['GET', '/api/auth/me'], ['GET', '/api/storage'], ['GET', '/api/admin/users'], ['GET', '/api/files/x/content']]) {
      assert.equal((await c.req(m!, u!)).status, 401, `${m} ${u}`);
    }
    const w = await c.req('POST', '/api/folders', { body: { name: 'x' } });
    assert.equal(w.status, 401);
  });

  it('logs in, returns the user and a csrf token, and sets an HttpOnly cookie', async () => {
    const c = new Client(t);
    const r = await c.login('a@example.com');
    assert.equal(r.status, 200);
    assert.equal(r.json.user.email, 'a@example.com');
    assert.ok(r.json.csrfToken.length > 20);
    assert.equal(r.json.user.passwordHash, undefined, 'password hash must never be returned');
    assert.match(String(r.headers['set-cookie']), /HttpOnly/i);
    assert.match(String(r.headers['set-cookie']), /SameSite=Lax/i);
    assert.equal((await c.get('/api/auth/me')).status, 200);
  });

  it('gives the same error for wrong password and unknown user', async () => {
    const a = await new Client(t).login('a@example.com', 'wrong password!!');
    const b = await new Client(t).login('nobody@example.com', 'wrong password!!');
    assert.equal(a.status, 401); assert.equal(b.status, 401);
    assert.deepEqual(a.json, b.json);
  });

  it('stores only a hash of the session token and never the password', async () => {
    const c = new Client(t); await c.login('a@example.com');
    const token = c.cookie.split('=')[1]!;
    const rows = t.app.ctx.db.prepare('SELECT id_hash FROM sessions').all() as { id_hash: string }[];
    assert.ok(rows.length > 0 && rows.every((r) => r.id_hash !== token));
    const u = t.app.ctx.db.prepare('SELECT password_hash FROM users WHERE email = ?').get('a@example.com') as { password_hash: string };
    assert.match(u.password_hash, /^\$argon2id\$/);
  });

  it('enforces CSRF token and same-origin on state-changing requests', async () => {
    const c = new Client(t); await c.login('a@example.com');
    assert.equal((await c.req('POST', '/api/folders', { body: { name: 'f' }, csrf: false })).status, 403, 'missing csrf');
    assert.equal((await c.req('POST', '/api/folders', { body: { name: 'f' }, headers: { 'x-csrf-token': 'wrong' } })).status, 403, 'bad csrf');
    assert.equal((await c.req('POST', '/api/folders', { body: { name: 'f' }, headers: { origin: 'http://evil.test' } })).status, 403, 'cross-origin');
    assert.equal((await c.req('POST', '/api/folders', { body: { name: 'f' }, origin: false })).status, 403, 'no origin');
    assert.equal((await c.req('POST', '/api/folders', { body: { name: 'f' } })).status, 201, 'valid request still works');
  });

  it('login itself rejects cross-origin posts (login CSRF)', async () => {
    const r = await new Client(t).req('POST', '/api/auth/login', { body: { email: 'a@example.com', password: PASSWORD }, headers: { origin: 'http://evil.test' } });
    assert.equal(r.status, 403);
  });

  it('logout invalidates the session server-side', async () => {
    const c = new Client(t); await c.login('a@example.com');
    const old = c.cookie;
    assert.equal((await c.post('/api/auth/logout')).status, 200);
    const replay = new Client(t); replay.cookie = old;
    assert.equal((await replay.get('/api/auth/me')).status, 401);
  });

  it('refuses expired sessions', async () => {
    const c = new Client(t); await c.login('a@example.com');
    t.app.ctx.db.prepare('UPDATE sessions SET expires_at = 1').run();
    assert.equal((await c.get('/api/auth/me')).status, 401);
  });

  it('blocks registration by default and allows it when enabled', async () => {
    const r = await new Client(t).post('/api/auth/register', { email: 'new@example.com', password: PASSWORD });
    assert.equal(r.status, 403); assert.equal(r.json.error, 'registration_disabled');
    const t2 = await startApp({ ALLOW_REGISTRATION: 'true' });
    try {
      const c = new Client(t2);
      const ok = await c.post('/api/auth/register', { email: 'new@example.com', password: PASSWORD, displayName: 'New' });
      assert.equal(ok.status, 200); assert.equal(ok.json.user.role, 'user', 'self-registered users are never admins');
      assert.equal((await new Client(t2).post('/api/auth/register', { email: 'NEW@example.com', password: PASSWORD })).status, 409, 'case-insensitive duplicate');
    } finally { await t2.close(); }
  });

  it('enforces the password policy', async () => {
    const t2 = await startApp({ ALLOW_REGISTRATION: 'true' });
    try {
      const r = await new Client(t2).post('/api/auth/register', { email: 'x@example.com', password: 'short' });
      assert.equal(r.status, 400); assert.equal(r.json.error, 'weak_password');
      assert.equal((await new Client(t2).post('/api/auth/register', { email: 'not-an-email', password: PASSWORD })).status, 400);
    } finally { await t2.close(); }
  });

  it('disabling a user cuts off their live session immediately', async () => {
    const admin = await userClient(t, 'admin1@example.com', 'admin');
    const victim = await userClient(t, 'victim@example.com');
    assert.equal((await victim.get('/api/auth/me')).status, 200);
    const id = (await admin.get('/api/admin/users')).json.users.find((u: any) => u.email === 'victim@example.com').id;
    assert.equal((await admin.patch(`/api/admin/users/${id}`, { disabled: true })).status, 200);
    assert.equal((await victim.get('/api/auth/me')).status, 401);
    assert.equal((await new Client(t).login('victim@example.com')).status, 401, 'cannot log in while disabled');
  });

  it('changing password signs out other sessions', async () => {
    await createUser(t.app.ctx.db, { email: 'pw@example.com', password: PASSWORD });
    const one = new Client(t); await one.login('pw@example.com');
    const two = new Client(t); await two.login('pw@example.com');
    const r = await two.post('/api/auth/change-password', { currentPassword: PASSWORD, newPassword: 'another long passphrase' });
    assert.equal(r.status, 200);
    assert.equal((await one.get('/api/auth/me')).status, 401);
    assert.equal((await two.get('/api/auth/me')).status, 200);
    assert.equal((await new Client(t).login('pw@example.com', PASSWORD)).status, 401);
    assert.equal((await new Client(t).login('pw@example.com', 'another long passphrase')).status, 200);
    assert.equal((await two.post('/api/auth/change-password', { currentPassword: 'nope nope nope nope', newPassword: 'yet another passphrase' })).status, 403);
  });

  it('admin-issued reset tokens work exactly once and expire', async () => {
    const admin = await userClient(t, 'admin2@example.com', 'admin');
    await createUser(t.app.ctx.db, { email: 'forgot@example.com', password: PASSWORD });
    const id = (await admin.get('/api/admin/users')).json.users.find((u: any) => u.email === 'forgot@example.com').id;
    const { token } = (await admin.post(`/api/admin/users/${id}/reset-token`)).json;
    const anon = new Client(t);
    assert.equal((await anon.post('/api/auth/reset', { token: 'bogus', password: 'brand new passphrase' })).status, 400);
    assert.equal((await anon.post('/api/auth/reset', { token, password: 'brand new passphrase' })).status, 200);
    assert.equal((await anon.post('/api/auth/reset', { token, password: 'second use passphrase' })).status, 400, 'single use');
    assert.equal((await new Client(t).login('forgot@example.com', 'brand new passphrase')).status, 200);
    const { token: t2 } = (await admin.post(`/api/admin/users/${id}/reset-token`)).json;
    t.app.ctx.db.prepare('UPDATE password_resets SET expires_at = 1').run();
    assert.equal((await anon.post('/api/auth/reset', { token: t2, password: 'expired token passphrase' })).status, 400, 'expired');
  });

  it('throttles repeated failed logins for one account', async () => {
    _resetThrottle();
    for (let i = 0; i < 10; i++) await new Client(t).login('a@example.com', 'wrong password!!');
    const r = await new Client(t).login('a@example.com', PASSWORD);
    assert.equal(r.status, 429, 'even the right password is refused while throttled');
    _resetThrottle();
    assert.equal((await new Client(t).login('a@example.com', PASSWORD)).status, 200);
  });

  it('protects admin routes from non-admins and keeps the last admin', async () => {
    const user = await userClient(t, 'plain@example.com');
    assert.equal((await user.get('/api/admin/users')).status, 403);
    assert.equal((await user.post('/api/admin/users', { email: 'z@example.com', password: PASSWORD })).status, 403);
    const t2 = await startApp();
    try {
      const only = await userClient(t2, 'only@example.com', 'admin');
      const me = (await only.get('/api/auth/me')).json.user.id;
      assert.equal((await only.patch(`/api/admin/users/${me}`, { role: 'user' })).json.error, 'last_admin');
      assert.equal((await only.del(`/api/admin/users/${me}`)).status, 409);
    } finally { await t2.close(); }
  });
});

describe('bootstrap', () => {
  it('creates the administrator from the environment only when no users exist', async () => {
    const t = await startApp({ BOOTSTRAP_ADMIN_EMAIL: 'root@example.com', BOOTSTRAP_ADMIN_PASSWORD: PASSWORD });
    try {
      const c = new Client(t);
      const r = await c.login('root@example.com');
      assert.equal(r.status, 200); assert.equal(r.json.user.role, 'admin');
    } finally { await t.close(); }
  });
});
