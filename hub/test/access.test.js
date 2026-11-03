'use strict';

// Per-person access: owners and admins open sections (GST, Education, Billing, Income & expenses, clients,
// projects) to staff, and the menu and every route follow it. Owners can make other owners.

const os = require('os');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const test = require('node:test');
const assert = require('node:assert/strict');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-access-'));
Object.assign(process.env, {
  SQLITE_FILE: path.join(tmp, 'test.sqlite'), GST_BACKUP_DIR: path.join(tmp, 'backups'), ADMIN_EMAIL: 'owner@test.local', ADMIN_PASSWORD: 'owner-password-1',
  LMS_API_URL: '', HOLIDAYS_ICS_URL: '', NODE_ENV: 'test', LMS_KEY_SHA256: crypto.createHash('sha256').update('k').digest('hex'),
});
delete process.env.ENABLE_ADMIN;

const { db, migrate } = require('../src/db');
const { ensureOwner } = require('../src/lib/bootstrap');
const { hashPassword } = require('../src/lib/auth');

let server;
let base;
const NOW = '2026-01-01 00:00:00';
const world = {};

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
    for (const [k, v] of Object.entries({ _csrf: this.csrf, ...data })) [].concat(v).forEach((x) => params.append(k, x));
    const res = await fetch(base + p, { method: 'POST', headers: { cookie: this.header(), 'content-type': 'application/x-www-form-urlencoded' }, body: params.toString(), redirect: 'manual' });
    this.store(res);
    return { status: res.status, text: await res.text(), location: res.headers.get('location') };
  }
  async login(email, password) { await this.get('/login'); const r = await this.post('/login', { email, password }); assert.equal(r.status, 302, email); await this.get('/team'); return this; }
}

const SECTIONS = { billing: '/team/billing', gst: '/team/gst', education: '/team/education', finance: '/team/finance' };
const role = async (id) => (await db('users').where({ id }).first()).role;

test.before(async () => {
  await migrate();
  await ensureOwner();
  const app = require('../src/app');
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
  const hash = await hashPassword('member-password-1');
  const mk = async (fields) => (await db('users').insert({ password_hash: hash, is_active: true, token_version: 1, created_at: NOW, updated_at: NOW, ...fields }))[0];
  world.owner = (await db('users').where({ role: 'owner' }).first()).id;
  world.sam = await mk({ name: 'Sam Staff', email: 'sam@test.local', role: 'staff' });
  world.abhay = await mk({ name: 'Abhay Anantha', email: 'abhay@test.local', role: 'staff' });
  world.adele = await mk({ name: 'Adele Admin', email: 'adele@test.local', role: 'admin' });
  [world.client] = await db('clients').insert({ name: 'Acme', status: 'active', created_at: NOW, updated_at: NOW });
});

test.after(async () => { server.closeAllConnections(); server.close(); await db.destroy(); fs.rmSync(tmp, { recursive: true, force: true }); });

test('staff start with the standard access: no money sections in the menu or by address', async () => {
  const sam = await new Browser().login('sam@test.local', 'member-password-1');
  const home = (await sam.get('/team')).text;
  for (const url of Object.values(SECTIONS)) {
    assert.doesNotMatch(home, new RegExp(`href="${url}"`), `${url} not in the menu`);
    assert.equal((await sam.get(url)).status, 403, `${url} refused`);
  }
  assert.match((await sam.get('/team/gst')).text, /You don’t have access to GST Invoices/);
});

test('an owner opens GST and Education to one staff member, and only those', async () => {
  const owner = await new Browser().login('owner@test.local', 'owner-password-1');
  const people = (await owner.get('/team/people')).text;
  assert.match(people, /name="perms" value="gst"/, 'access checkboxes on the Team page');
  let r = await owner.post(`/team/people/${world.sam}`, { action: 'access', perms: ['gst', 'education', 'not-a-section'] });
  assert.equal(r.location, '/team/people');
  assert.deepEqual(JSON.parse((await db('users').where({ id: world.sam }).first()).permissions), ['gst', 'education']);
  assert.match((await owner.get('/team/people')).text, /<span class="chip">[^<]*<svg[^]*?GST Invoices<\/span>/, 'shown on their row');

  const sam = await new Browser().login('sam@test.local', 'member-password-1');
  const home = (await sam.get('/team')).text;
  assert.match(home, /href="\/team\/gst"/);
  assert.match(home, /href="\/team\/education"/);
  assert.doesNotMatch(home, /href="\/team\/billing"/);
  assert.doesNotMatch(home, /href="\/team\/finance"/);
  assert.equal((await sam.get('/team/gst')).status, 200);
  assert.equal((await sam.get('/team/gst/docs')).status, 200);
  assert.equal((await sam.get('/team/education')).status, 200);
  assert.equal((await sam.get('/team/billing')).status, 403);
  assert.equal((await sam.get('/team/finance')).status, 403);
  // Abhay, also staff, is untouched.
  const abhay = await new Browser().login('abhay@test.local', 'member-password-1');
  assert.equal((await abhay.get('/team/gst')).status, 403);

  // Taking it away again closes it.
  await owner.get('/team/people');
  await owner.post(`/team/people/${world.sam}`, { action: 'access' });
  assert.equal((await db('users').where({ id: world.sam }).first()).permissions, null);
  assert.equal((await sam.get('/team/gst')).status, 403);
});

test('client and project management can be opened too; admins can grant, staff can’t', async () => {
  const adele = await new Browser().login('adele@test.local', 'member-password-1');
  await adele.get('/team/people');
  await adele.post(`/team/people/${world.abhay}`, { action: 'access', perms: ['projects', 'billing'] });
  const abhay = await new Browser().login('abhay@test.local', 'member-password-1');
  assert.equal((await abhay.get('/team/billing')).status, 200);
  assert.match((await abhay.get('/team/projects')).text, /data-dialog="#new-project"/);
  let r = await abhay.post('/team/projects', { name: 'Abhay’s project', client_id: String(world.client) });
  assert.match(r.location, /^\/team\/projects\/\d+$/);
  r = await abhay.post('/team/projects', { name: 'With a new client', client_id: 'new', new_client: 'Sneaky Co' });
  assert.equal(r.location, '/team/projects?new=1', 'adding a client needs client management');
  assert.equal(await db('clients').where({ name: 'Sneaky Co' }).first(), undefined);
  assert.equal((await abhay.post('/team/clients', { name: 'Direct Co' })).status, 403);

  const sam = await new Browser().login('sam@test.local', 'member-password-1');
  await sam.get('/team/people');
  await sam.post(`/team/people/${world.sam}`, { action: 'access', perms: ['finance'] });
  await sam.post(`/team/people/${world.abhay}`, { action: 'access', perms: ['finance'] });
  assert.equal((await db('users').where({ id: world.sam }).first()).permissions, null, 'staff can’t open sections, even to themselves');
  assert.doesNotMatch((await db('users').where({ id: world.abhay }).first()).permissions, /finance/);

  // Admins and owners already have everything; there's nothing to store for them.
  await adele.post(`/team/people/${world.owner}`, { action: 'access', perms: ['gst'] });
  assert.equal((await db('users').where({ id: world.owner }).first()).permissions, null);
});

test('an owner makes Abhay an owner; admins can’t make or change owners', async () => {
  const adele = await new Browser().login('adele@test.local', 'member-password-1');
  assert.doesNotMatch((await adele.get('/team/people')).text, /Make owner/);
  await adele.post(`/team/people/${world.abhay}`, { action: 'role', role: 'owner' });
  assert.equal(await role(world.abhay), 'staff', 'an admin can’t make an owner');
  await adele.post(`/team/people/${world.owner}`, { action: 'role', role: 'staff' });
  assert.equal(await role(world.owner), 'owner', 'an admin can’t demote an owner');
  await adele.post('/team/people', { name: 'New Person', email: 'new@test.local', role: 'owner', password: 'new-password-123' });
  assert.equal((await db('users').where({ email: 'new@test.local' }).first()).role, 'staff', 'an admin adding an "owner" gets staff');

  const owner = await new Browser().login('owner@test.local', 'owner-password-1');
  const page = (await owner.get('/team/people')).text;
  assert.match(page, new RegExp(`action="/team/people/${world.abhay}"[^>]*data-confirm="Make Abhay Anantha an owner\\?`));
  let r = await owner.post(`/team/people/${world.abhay}`, { action: 'role', role: 'owner' });
  assert.equal(r.location, '/team/people');
  assert.equal(await role(world.abhay), 'owner');
  assert.match((await owner.get('/team/people')).text, /Abhay Anantha is now an owner, with full access/);

  const abhay = await new Browser().login('abhay@test.local', 'member-password-1');
  for (const url of Object.values(SECTIONS)) assert.equal((await abhay.get(url)).status, 200, `owner Abhay opens ${url}`);
  // Once an owner, always protected: not by themselves, not by another owner.
  await abhay.get('/team/people');
  await abhay.post(`/team/people/${world.abhay}`, { action: 'role', role: 'staff' });
  assert.equal(await role(world.abhay), 'owner', 'nobody changes their own role');
  await owner.post(`/team/people/${world.abhay}`, { action: 'role', role: 'admin' });
  assert.equal(await role(world.abhay), 'owner', 'another owner can’t demote Abhay');
  await abhay.post(`/team/people/${world.owner}`, { action: 'toggle' });
  assert.equal((await db('users').where({ id: world.owner }).first()).is_active ? 1 : 0, 1, 'and Abhay can’t remove the first owner');

  r = await owner.post('/team/people', { name: 'Second Owner', email: 'second@test.local', role: 'owner', password: 'second-password-1' });
  assert.equal((await db('users').where({ email: 'second@test.local' }).first()).role, 'owner', 'owners can add owners');
  r = await owner.post('/team/people', { name: 'Gst Clerk', email: 'clerk@test.local', role: 'staff', password: 'clerk-password-1', perms: ['gst'] });
  assert.deepEqual(JSON.parse((await db('users').where({ email: 'clerk@test.local' }).first()).permissions), ['gst'], 'access can be set when adding someone');
});

test('owners are protected: nobody can remove an owner’s access, role or details, not even another owner', async () => {
  const owner = await new Browser().login('owner@test.local', 'owner-password-1');
  const [co] = await db('users').insert({ name: 'Co Owner', email: 'co@test.local', role: 'owner', password_hash: await hashPassword('co-password-123'), is_active: true, token_version: 1, created_at: NOW, updated_at: NOW });
  const page = (await owner.get('/team/people')).text;
  const row = page.slice(page.indexOf('Co Owner'), page.indexOf('</li>', page.indexOf('Co Owner')));
  assert.doesNotMatch(row, /Remove access|Remove owner role|name="action"/, 'no controls on another owner’s row');
  assert.match(row, /Owners are protected\. Nobody can remove or change an owner\./);
  assert.match(page, /You can’t change your own role or access\./);

  const before = await db('users').where({ id: co }).first();
  for (const body of [{ action: 'toggle' }, { action: 'role', role: 'admin' }, { action: 'role', role: 'staff' }, { action: 'details', name: 'Renamed' }, { action: 'password', password: 'new-password-123' }, { action: 'access', perms: 'gst' }]) {
    await owner.post(`/team/people/${co}`, body);
  }
  const after = await db('users').where({ id: co }).first();
  assert.deepEqual([after.role, Boolean(after.is_active), after.name, after.password_hash, after.token_version], [before.role, Boolean(before.is_active), before.name, before.password_hash, before.token_version], 'nothing about the owner changed');
  assert.match((await owner.get('/team/people')).text, /Co Owner is an owner\. Owners can’t be removed or changed, even by another owner\./);

  const adele = await new Browser().login('adele@test.local', 'member-password-1');
  await adele.get('/team/people');
  await adele.post(`/team/people/${co}`, { action: 'toggle' });
  assert.equal((await db('users').where({ id: co }).first()).is_active ? 1 : 0, 1, 'admins can’t either');
  assert.ok(await new Browser().login('co@test.local', 'co-password-123'), 'the owner still signs in');
});
