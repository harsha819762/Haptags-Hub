'use strict';

// Team management: sales logging, adding team members with a password, and archiving or deleting clients.

const os = require('os');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const test = require('node:test');
const assert = require('node:assert/strict');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-team-'));
Object.assign(process.env, {
  SQLITE_FILE: path.join(tmp, 'test.sqlite'), GST_BACKUP_DIR: path.join(tmp, 'backups'), ADMIN_EMAIL: 'owner@test.local', ADMIN_PASSWORD: 'owner-password-1',
  LMS_API_URL: '', HOLIDAYS_ICS_URL: '', NODE_ENV: 'test', LMS_KEY_SHA256: crypto.createHash('sha256').update('k').digest('hex'),
});
delete process.env.ENABLE_ADMIN;

const { db, migrate } = require('../src/db');
const { ensureOwner } = require('../src/lib/bootstrap');
const { hashPassword } = require('../src/lib/auth');
const { inviteUser } = require('../src/lib/invites');

let server;
let base;
const NOW = '2026-01-01 00:00:00';

class Browser {
  constructor() { this.cookies = {}; }
  header() { return Object.entries(this.cookies).map(([k, v]) => `${k}=${v}`).join('; '); }
  store(res) { for (const c of res.headers.getSetCookie()) { const [pair] = c.split(';'); const i = pair.indexOf('='); this.cookies[pair.slice(0, i)] = pair.slice(i + 1); } }
  async get(p) {
    const res = await fetch(base + p, { headers: { cookie: this.header() }, redirect: 'manual' });
    this.store(res);
    const text = await res.text();
    const m = text.match(/name="csrf-token" content="([^"]+)"/);
    if (m) this.csrf = m[1];
    return { status: res.status, text, location: res.headers.get('location') };
  }
  async post(p, data = {}) {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries({ _csrf: this.csrf, ...data })) (Array.isArray(v) ? v : [v]).forEach((x) => params.append(k, x));
    const res = await fetch(base + p, { method: 'POST', headers: { cookie: this.header(), 'content-type': 'application/x-www-form-urlencoded' }, body: params.toString(), redirect: 'manual' });
    this.store(res);
    const text = await res.text();
    return { status: res.status, text, location: res.headers.get('location') };
  }
  async login(email, password) { await this.get('/login'); return this.post('/login', { email, password }); }
}

async function signIn(email, password) { const b = new Browser(); const r = await b.login(email, password); assert.equal(r.status, 302, `${email} can sign in`); await b.get('/'); return b; }

const world = {};
const today = () => new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);

test.before(async () => {
  await migrate();
  await ensureOwner();
  const app = require('../src/app');
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
  const hash = await hashPassword('staff-password-1');
  const mk = async (name, email, role) => (await db('users').insert({ name, email, role, password_hash: hash, is_active: true, token_version: 1, created_at: NOW, updated_at: NOW }))[0];
  world.sam = await mk('Sam Staff', 'sam@test.local', 'staff');
  world.ria = await mk('Ria Staff', 'ria@test.local', 'staff');
  world.owner = await db('users').where({ role: 'owner' }).first();
});

test.after(async () => { server.closeAllConnections(); server.close(); await db.destroy(); fs.rmSync(tmp, { recursive: true, force: true }); });

test('teammates log sales and see only their own; the owner sees everyone', async () => {
  const sam = await signIn('sam@test.local', 'staff-password-1');
  const ria = await signIn('ria@test.local', 'staff-password-1');
  const owner = await signIn('owner@test.local', 'owner-password-1');
  assert.match((await sam.get('/team')).text, /href="\/team\/sales"/, 'Sales is in the team navigation');

  await sam.get('/team/sales');
  // Staff cannot credit a sale to someone else, even by sending user_id.
  const add = await sam.post('/team/sales', { title: 'Zebra build', customer: 'Acme Ltd', amount: '50,000', sale_date: today(), status: 'won', user_id: world.ria });
  assert.equal(add.status, 302);
  await ria.get('/team/sales');
  await ria.post('/team/sales', { title: 'Yak pack', customer: 'Bolt Co', amount: '12000', sale_date: today(), status: 'pipeline' });

  const rows = await db('sales').orderBy('id');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].user_id, world.sam);
  assert.equal(Number(rows[0].amount), 5000000, 'stored in paise');

  const samPage = (await sam.get('/team/sales')).text;
  assert.match(samPage, /Zebra build/); assert.doesNotMatch(samPage, /Yak pack/);
  assert.doesNotMatch(samPage, /By teammate/, 'no leaderboard for staff');
  const riaPage = (await ria.get('/team/sales')).text;
  assert.match(riaPage, /Yak pack/); assert.doesNotMatch(riaPage, /Zebra build|Acme/);

  const all = (await owner.get('/team/sales')).text;
  assert.match(all, /Zebra build/); assert.match(all, /Yak pack/); assert.match(all, /By teammate/);
  assert.match(all, /Sam Staff/); assert.match(all, /₹50,000\.00/);
  const onlyRia = (await owner.get(`/team/sales?who=${world.ria}`)).text;
  assert.match(onlyRia, /Yak pack/); assert.doesNotMatch(onlyRia, /Zebra build/);

  // The owner can credit a sale to a teammate.
  await owner.get('/team/sales');
  await owner.post('/team/sales', { title: 'AMC', customer: 'Acme Ltd', amount: '8000', sale_date: today(), status: 'won', user_id: world.ria });
  assert.equal((await db('sales').where({ title: 'AMC' }).first()).user_id, world.ria);
});

test('sales are validated, and nobody can touch someone else’s entry', async () => {
  const sam = await signIn('sam@test.local', 'staff-password-1');
  const ria = await signIn('ria@test.local', 'staff-password-1');
  await sam.get('/team/sales');
  const count = async () => Number((await db('sales').count({ n: '*' }).first()).n);
  const before = await count();
  await sam.post('/team/sales', { title: 'No amount', customer: 'X', amount: '', sale_date: today() });
  await sam.post('/team/sales', { title: '', customer: 'X', amount: '10', sale_date: today() });
  await sam.post('/team/sales', { title: 'Huge', customer: 'X', amount: '99999999999999', sale_date: today() });
  assert.equal(await count(), before, 'invalid entries are not saved');

  const samSale = await db('sales').where({ user_id: world.sam }).first();
  assert.equal((await ria.get(`/team/sales/${samSale.id}`)).status, 404);
  await ria.get('/team/sales');
  assert.equal((await ria.post(`/team/sales/${samSale.id}`, { title: 'Hijacked', customer: 'X', amount: '1', sale_date: today() })).status, 404);
  assert.equal((await ria.post(`/team/sales/${samSale.id}/delete`)).status, 404);
  assert.equal((await db('sales').where({ id: samSale.id }).first()).title, 'Zebra build');

  await sam.get(`/team/sales/${samSale.id}`);
  const edit = await sam.post(`/team/sales/${samSale.id}`, { title: 'Zebra build v2', customer: 'Acme Ltd', amount: '60000', sale_date: today(), status: 'won' });
  assert.equal(edit.status, 302);
  assert.equal(Number((await db('sales').where({ id: samSale.id }).first()).amount), 6000000);
  await sam.post(`/team/sales/${samSale.id}/delete`);
  assert.equal(await db('sales').where({ id: samSale.id }).first(), undefined);
});

test('clients cannot reach Sales', async () => {
  const [cid] = await db('clients').insert({ name: 'Sales Test Co', status: 'active', created_at: NOW, updated_at: NOW });
  const r = await inviteUser({ name: 'Cy', email: 'cy@sales.test', role: 'client', clientId: cid, invitedBy: world.owner, send: false, allProjects: true });
  await db('users').where({ id: r.id }).update({ password_hash: await hashPassword('client-password-1'), invite_token_hash: null });
  const cy = await signIn('cy@sales.test', 'client-password-1');
  assert.equal((await cy.get('/team/sales')).status, 404);
});

test('the owner adds a team member with a password, and can edit and reset them', async () => {
  const owner = await signIn('owner@test.local', 'owner-password-1');
  const sam = await signIn('sam@test.local', 'staff-password-1');
  const page = (await owner.get('/team/people')).text;
  assert.match(page, /Add member/); assert.match(page, /Sales this month/);
  assert.doesNotMatch((await sam.get('/team/people')).text, /Add member|Sales this month/, 'staff can see the team but not manage it or see sales');

  const added = await owner.post('/team/people', { name: 'New Hire', email: 'hire@test.local', role: 'staff', job_title: 'Designer', password: 'hire-password-1' });
  assert.equal(added.status, 302);
  const hire = await signIn('hire@test.local', 'hire-password-1');
  assert.equal((await hire.get('/team')).status, 200, 'the new member can sign in at once');

  await owner.get('/team/people');
  await owner.post('/team/people', { name: 'Weak', email: 'weak@test.local', role: 'staff', password: 'short' });
  assert.equal(await db('users').where({ email: 'weak@test.local' }).first(), undefined, 'a weak password is refused');

  const hireRow = await db('users').where({ email: 'hire@test.local' }).first();
  await owner.post(`/team/people/${hireRow.id}`, { action: 'details', name: 'New Hire Kumar', job_title: 'Lead Designer' });
  assert.equal((await db('users').where({ id: hireRow.id }).first()).job_title, 'Lead Designer');
  await owner.post(`/team/people/${hireRow.id}`, { action: 'password', password: 'brand-new-password-2' });
  const old = new Browser();
  assert.equal((await old.login('hire@test.local', 'hire-password-1')).status, 401, 'old password no longer works');
  await signIn('hire@test.local', 'brand-new-password-2');
  assert.equal((await hire.get('/team')).status, 302, 'their old session was signed out');

  await sam.get('/team/people');
  await sam.post(`/team/people/${hireRow.id}`, { action: 'password', password: 'hacked-password-9' });
  await signIn('hire@test.local', 'brand-new-password-2'); // staff could not change it
});

test('clients can be added quickly, archived, restored and deleted', async () => {
  const ROW = /class="strong" href="\/team\/clients\/\d+">Zed Corp/; // the table row, not the flash message
  const owner = await signIn('owner@test.local', 'owner-password-1');
  const sam = await signIn('sam@test.local', 'staff-password-1');
  assert.doesNotMatch((await sam.get('/team/clients')).text, /id="quick-add"/, 'staff do not get the add form');
  assert.equal((await sam.post('/team/clients', { name: 'Nope Ltd' })).status, 403);

  await owner.get('/team/clients');
  const made = await owner.post('/team/clients', { name: 'Zed Corp', contact_name: 'Zed', contact_email: 'zed@zed.test', first_project: 'Zed Website', send_invite: '1' });
  assert.equal(made.status, 302);
  const zed = await db('clients').where({ name: 'Zed Corp' }).first();
  assert.ok(zed);
  assert.match((await owner.get('/team/clients')).text, ROW);

  const zedUser = await db('users').where({ email: 'zed@zed.test' }).first();
  await db('users').where({ id: zedUser.id }).update({ password_hash: await hashPassword('zed-password-1'), invite_token_hash: null });
  const zedSession = await signIn('zed@zed.test', 'zed-password-1');
  assert.equal((await zedSession.get('/portal')).status, 200);

  assert.equal((await owner.post(`/team/clients/${zed.id}/archive`)).status, 302);
  assert.equal((await db('clients').where({ id: zed.id }).first()).status, 'archived');
  assert.doesNotMatch((await owner.get('/team/clients')).text, ROW, 'gone from the active list');
  assert.match((await owner.get('/team/clients?show=archived')).text, ROW);
  assert.notEqual((await zedSession.get('/portal')).status, 200, 'their session ends');
  const blocked = new Browser();
  assert.equal((await blocked.login('zed@zed.test', 'zed-password-1')).status, 401, 'cannot sign in while archived');

  assert.equal((await sam.post(`/team/clients/${zed.id}/restore`)).status, 403);
  await owner.post(`/team/clients/${zed.id}/restore`);
  assert.equal((await db('clients').where({ id: zed.id }).first()).status, 'active');
  await signIn('zed@zed.test', 'zed-password-1');

  await owner.post(`/team/clients/${zed.id}/delete`);
  assert.ok(await db('clients').where({ id: zed.id }).first(), 'an active client cannot be deleted');
  await owner.post(`/team/clients/${zed.id}/archive`);
  await owner.post(`/team/clients/${zed.id}/delete`);
  assert.equal(await db('clients').where({ id: zed.id }).first(), undefined, 'deleted');
  assert.equal(await db('users').where({ email: 'zed@zed.test' }).first(), undefined, 'and their logins with it');

  const [bid] = await db('clients').insert({ name: 'Billed Co', status: 'archived', created_at: NOW, updated_at: NOW });
  await db('invoices').insert({ number: 'T/1', client_id: bid, title: 'x', issue_date: '2026-01-01', due_date: '2026-01-20', status: 'sent', total: 100, subtotal: 100, public_token: 'tok-billed-1', created_at: NOW, updated_at: NOW });
  await owner.post(`/team/clients/${bid}/delete`);
  assert.ok(await db('clients').where({ id: bid }).first(), 'billing records are kept');
});

test('students stay under Education: they are not listed as clients and cannot be archived from there', async () => {
  const owner = await signIn('owner@test.local', 'owner-password-1');
  const [sid] = await db('clients').insert({ name: 'Student Sundar', segment: 'student', status: 'active', created_at: NOW, updated_at: NOW });
  assert.doesNotMatch((await owner.get('/team/clients')).text, /Student Sundar/);
  await owner.post(`/team/clients/${sid}/archive`);
  assert.equal((await db('clients').where({ id: sid }).first()).status, 'active', 'untouched');
});
