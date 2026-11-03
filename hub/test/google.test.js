'use strict';

// "Continue with Google": the button shows only when configured, Google's answer is checked
// (state, nonce, audience, issuer, expiry, verified email), and only existing active accounts get in.
// Google's token endpoint is faked; everything else runs against a throwaway SQLite database.

const os = require('os');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const test = require('node:test');
const assert = require('node:assert/strict');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-google-'));
Object.assign(process.env, {
  SQLITE_FILE: path.join(tmp, 'test.sqlite'), GST_BACKUP_DIR: path.join(tmp, 'backups'), ADMIN_EMAIL: 'owner@test.local', ADMIN_PASSWORD: 'owner-password-1',
  LMS_API_URL: '', HOLIDAYS_ICS_URL: '', NODE_ENV: 'test', LMS_KEY_SHA256: crypto.createHash('sha256').update('k').digest('hex'),
  GOOGLE_CLIENT_ID: 'test-client.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'test-secret',
});
delete process.env.ENABLE_ADMIN;

const config = require('../src/config');
const { db, migrate } = require('../src/db');
const { ensureOwner } = require('../src/lib/bootstrap');
const { hashPassword } = require('../src/lib/auth');

let server;
let base;
const NOW = '2026-01-01 00:00:00';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

// What the fake Google token endpoint answers next: claims for the ID token, or a whole response.
let google = null;
const realFetch = global.fetch;
global.fetch = async (url, opts) => {
  if (String(url) !== TOKEN_URL) return realFetch(url, opts);
  const sent = new URLSearchParams(opts.body);
  assert.equal(sent.get('client_secret'), 'test-secret');
  assert.equal(sent.get('grant_type'), 'authorization_code');
  if (google.status) return new Response(JSON.stringify({ error: 'invalid_grant' }), { status: google.status });
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const claims = {
    iss: 'https://accounts.google.com', aud: config.google.clientId, exp: Math.floor(Date.now() / 1000) + 3600,
    sub: '1234567890', email_verified: true, nonce: google.nonce, ...google.claims,
  };
  return new Response(JSON.stringify({ id_token: `${b64({ alg: 'RS256' })}.${b64(claims)}.sig`, access_token: 'x' }), { status: 200 });
};

class Browser {
  constructor() { this.cookies = {}; }
  header() { return Object.entries(this.cookies).map(([k, v]) => `${k}=${v}`).join('; '); }
  store(res) { for (const c of res.headers.getSetCookie()) { const [pair] = c.split(';'); const i = pair.indexOf('='); this.cookies[pair.slice(0, i)] = pair.slice(i + 1); } }
  async get(p) {
    const res = await realFetch(base + p, { headers: { cookie: this.header() }, redirect: 'manual' });
    this.store(res);
    return { status: res.status, text: await res.text(), location: res.headers.get('location') };
  }
  /** Starts Google sign-in and comes back from Google with `claims` in the ID token. */
  async google(claims = {}, { next, state, tamperNonce } = {}) {
    const start = await this.get(`/auth/google${next ? `?next=${encodeURIComponent(next)}` : ''}`);
    assert.equal(start.status, 302);
    const to = new URL(start.location);
    assert.equal(to.origin + to.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
    assert.equal(to.searchParams.get('redirect_uri'), `${config.baseUrl}/auth/google/callback`);
    google = { claims, nonce: tamperNonce ? 'someone-elses-nonce' : to.searchParams.get('nonce') };
    return this.get(`/auth/google/callback?code=abc&state=${encodeURIComponent(state || to.searchParams.get('state'))}`);
  }
}

test.before(async () => {
  await migrate();
  await ensureOwner();
  const app = require('../src/app');
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
  const hash = await hashPassword('staff-password-1');
  const mk = (fields) => db('users').insert({ password_hash: hash, is_active: true, token_version: 1, created_at: NOW, updated_at: NOW, ...fields });
  await mk({ name: 'Sam Staff', email: 'sam@gmail.com', role: 'staff' });
  await mk({ name: 'Old Staff', email: 'gone@gmail.com', role: 'staff', is_active: false });
  const [clientId] = await db('clients').insert({ name: 'Sunrise Interiors', status: 'active', created_at: NOW, updated_at: NOW });
  await mk({ name: 'Priya', email: 'priya@gmail.com', role: 'client', client_id: clientId });
});

test.after(async () => { global.fetch = realFetch; server.closeAllConnections(); server.close(); await db.destroy(); fs.rmSync(tmp, { recursive: true, force: true }); });

test('the Google button shows only when Google sign-in is configured', async () => {
  const b = new Browser();
  assert.match((await b.get('/login')).text, /href="\/auth\/google"/);
  assert.match((await b.get('/login?next=%2Fteam%2Fsales')).text, /href="\/auth\/google\?next=%2Fteam%2Fsales"/);
  const saved = config.google.clientId;
  config.google.clientId = '';
  try {
    assert.doesNotMatch((await b.get('/login')).text, /auth\/google/);
    assert.equal((await b.get('/auth/google')).status, 404);
  } finally {
    config.google.clientId = saved;
  }
});

test('a team member with a matching account signs in with Google and lands where they were going', async () => {
  const b = new Browser();
  const r = await b.google({ email: 'Sam@Gmail.com' }, { next: '/team/sales' });
  assert.equal(r.status, 302);
  assert.equal(r.location, '/team/sales');
  assert.equal((await b.get('/team')).status, 200);
  assert.ok((await db('users').where({ email: 'sam@gmail.com' }).first()).last_login_at, 'last sign-in is recorded');
});

test('a client signs in with Google but is never sent to a team page', async () => {
  const b = new Browser();
  const r = await b.google({ email: 'priya@gmail.com' }, { next: '/team' });
  assert.equal(r.location, '/portal');
  assert.equal((await b.get('/portal')).status, 200);
});

test('Google never creates accounts or lets in removed people', async () => {
  for (const email of ['stranger@gmail.com', 'gone@gmail.com']) {
    const b = new Browser();
    const r = await b.google({ email });
    assert.equal(r.status, 401);
    assert.match(r.text, /No active account uses/);
    assert.equal((await b.get('/team')).status, 302, `${email} is not signed in`);
  }
  assert.equal(await db('users').where({ email: 'stranger@gmail.com' }).first(), undefined);
});

test('Google answers that fail the checks are refused', async () => {
  const cases = [
    [{ email: 'sam@gmail.com', email_verified: false }, {}, 401, /hasn’t verified the email/],
    [{ email: 'sam@gmail.com', aud: 'another-app.apps.googleusercontent.com' }, {}, 401, /didn’t complete/],
    [{ email: 'sam@gmail.com', iss: 'https://evil.example' }, {}, 401, /didn’t complete/],
    [{ email: 'sam@gmail.com', exp: Math.floor(Date.now() / 1000) - 10 }, {}, 401, /didn’t complete/],
    [{ email: 'sam@gmail.com' }, { tamperNonce: true }, 401, /didn’t complete/],
    [{ email: 'sam@gmail.com' }, { state: 'forged-state' }, 400, /expired/],
  ];
  for (const [claims, opts, status, message] of cases) {
    const b = new Browser();
    const r = await b.google(claims, opts);
    assert.equal(r.status, status, JSON.stringify({ claims, opts }));
    assert.match(r.text, message);
    assert.equal((await b.get('/team')).status, 302, 'not signed in');
  }
});

test('a callback without a sign-in started here, a cancelled one, or a rejected code signs nobody in', async () => {
  const b = new Browser();
  assert.equal((await b.get('/auth/google/callback?code=abc&state=xyz')).status, 400);
  await b.get('/auth/google');
  const cancelled = await b.get('/auth/google/callback?error=access_denied');
  assert.equal(cancelled.status, 400);
  assert.match(cancelled.text, /cancelled/);

  const c = new Browser();
  const start = new URL((await c.get('/auth/google')).location);
  google = { status: 400 };
  const r = await c.get(`/auth/google/callback?code=used&state=${start.searchParams.get('state')}`);
  assert.equal(r.status, 401);
  // The state is single-use: replaying the same callback is refused.
  assert.equal((await c.get(`/auth/google/callback?code=used&state=${start.searchParams.get('state')}`)).status, 400);
  assert.equal((await c.get('/team')).status, 302);
});
