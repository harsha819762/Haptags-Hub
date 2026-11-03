'use strict';

// Owners and admins hear about leave requests and about work moving to Under review: a live pop-up in their
// open tabs and an email. Every owner gets every leave request; the person who acted isn't told about it.

const os = require('os');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const test = require('node:test');
const assert = require('node:assert/strict');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-notify-'));
Object.assign(process.env, {
  SQLITE_FILE: path.join(tmp, 'test.sqlite'), GST_BACKUP_DIR: path.join(tmp, 'backups'), ADMIN_EMAIL: 'owner@test.local', ADMIN_PASSWORD: 'owner-password-1',
  LMS_API_URL: '', HOLIDAYS_ICS_URL: '', NODE_ENV: 'test', LMS_KEY_SHA256: crypto.createHash('sha256').update('k').digest('hex'),
});
delete process.env.ENABLE_ADMIN;

const { db, migrate } = require('../src/db');
const { ensureOwner } = require('../src/lib/bootstrap');
const { hashPassword } = require('../src/lib/auth');
const rt = require('../src/lib/realtime');
const { notifyLeaders } = require('../src/lib/team-notify');

// Record every live notice instead of only sending it.
const notices = [];
const realPublish = rt.publish;
rt.publish = (target, type, data) => { if (type === 'team.notice') notices.push({ users: [...target.users].sort((a, b) => a - b), ...data }); return realPublish(target, type, data); };

let server;
let base;
const NOW = '2026-01-01 00:00:00';
const w = {};

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
    return { status: res.status, text };
  }
  async post(p, data = {}) {
    const res = await fetch(base + p, { method: 'POST', headers: { cookie: this.header(), 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ _csrf: this.csrf, ...data }).toString(), redirect: 'manual' });
    this.store(res);
    return { status: res.status, location: res.headers.get('location') };
  }
  async json(p, data) {
    const res = await fetch(base + p, { method: 'POST', headers: { cookie: this.header(), 'content-type': 'application/json', 'x-csrf-token': this.csrf }, body: JSON.stringify(data) });
    return { status: res.status, body: await res.json() };
  }
  async login(email, password) { await this.get('/login'); await this.post('/login', { email, password }); await this.get('/team'); return this; }
}

const sorted = (...ids) => ids.sort((a, b) => a - b);
const last = () => notices[notices.length - 1];
/** Emails sent since `mark` (they go out in the background, so wait for them first). */
const emailsSince = async (mark) => { await notifyLeaders.lastEmails; return db('email_log').where('id', '>', mark).orderBy('id'); };
const mark = async () => Number((await db('email_log').max({ m: 'id' }).first()).m || 0);

test.before(async () => {
  await migrate();
  await ensureOwner();
  const app = require('../src/app');
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
  const hash = await hashPassword('member-password-1');
  const mk = async (fields) => (await db('users').insert({ password_hash: hash, is_active: true, token_version: 1, created_at: NOW, updated_at: NOW, ...fields }))[0];
  w.owner = (await db('users').where({ role: 'owner' }).first()).id;
  w.abhay = await mk({ name: 'Abhay Anantha', email: 'abhay@test.local', role: 'owner' });
  w.adele = await mk({ name: 'Adele Admin', email: 'adele@test.local', role: 'admin' });
  w.sam = await mk({ name: 'Sam Staff', email: 'sam@test.local', role: 'staff' });
  w.ria = await mk({ name: 'Ria Rao', email: 'ria@test.local', role: 'staff' });
  await mk({ name: 'Gone Owner', email: 'gone@test.local', role: 'owner', is_active: false });
  const [client] = await db('clients').insert({ name: 'Acme', status: 'active', created_at: NOW, updated_at: NOW });
  [w.project] = await db('projects').insert({ client_id: client, name: 'Website', status: 'in_progress', progress: 0, budget: 0, created_at: NOW, updated_at: NOW });
  [w.task] = await db('project_tasks').insert({ project_id: w.project, title: 'Homepage', status: 'doing', priority: 'normal', created_at: NOW, updated_at: NOW });
});

test.after(async () => { rt.publish = realPublish; server.closeAllConnections(); server.close(); await db.destroy(); fs.rmSync(tmp, { recursive: true, force: true }); });

test('a staff leave request reaches every owner and every admin, live and by email', async () => {
  const m = await mark();
  const sam = await new Browser().login('sam@test.local', 'member-password-1');
  await sam.get('/team/leave');
  const r = await sam.post('/team/leave', { type: 'casual', start_date: '2027-03-03', end_date: '2027-03-03', reason: 'Family function' });
  assert.equal(r.location, '/team/leave');
  assert.deepEqual(last().users, sorted(w.owner, w.abhay, w.adele), 'both owners and the admin, not Sam, Ria or a removed owner');
  assert.equal(last().title, 'Leave request from Sam Staff');
  assert.match(last().body, /1 day of casual leave \(2027-03-03 to 2027-03-03\)\. Reason: Family function/);
  assert.equal(last().url, '/team/leave');
  const mails = await emailsSince(m);
  assert.deepEqual(mails.map((e) => e.to_email || e.to || e.recipient).sort(), ['abhay@test.local', 'adele@test.local', 'owner@test.local']);
});

test('an admin’s request goes to the owners; an owner’s own leave is shared with the other owners and admins', async () => {
  const adele = await new Browser().login('adele@test.local', 'member-password-1');
  await adele.get('/team/leave');
  await adele.post('/team/leave', { type: 'casual', start_date: '2027-03-10', end_date: '2027-03-10' });
  assert.deepEqual(last().users, sorted(w.owner, w.abhay), 'admin requests are decided by owners');

  const abhay = await new Browser().login('abhay@test.local', 'member-password-1');
  await abhay.get('/team/leave');
  await abhay.post('/team/leave', { type: 'casual', start_date: '2027-03-17', end_date: '2027-03-17' });
  const row = await db('leave_requests').where({ user_id: w.abhay }).first();
  assert.equal(row.status, 'approved', 'an owner’s leave needs no approval');
  assert.deepEqual(last().users, sorted(w.owner, w.adele), 'the other owner and the admin are told');
  assert.equal(last().title, 'Abhay Anantha is taking leave');
});

test('the person who asked hears the decision', async () => {
  const owner = await new Browser().login('owner@test.local', 'owner-password-1');
  await owner.get('/team/leave');
  const req = await db('leave_requests').where({ user_id: w.sam, status: 'pending' }).first();
  await owner.post(`/team/leave/${req.id}/decide`, { action: 'approve' });
  assert.deepEqual(last().users, [w.sam]);
  assert.equal(last().title, 'Your leave was approved');
});

test('moving a task or a project to Under review notifies owners and admins, but not whoever moved it', async () => {
  const sam = await new Browser().login('sam@test.local', 'member-password-1');
  await sam.get(`/team/projects/${w.project}`);
  let m = await mark();
  let count = notices.length;
  await sam.json(`/team/tasks/${w.task}/move`, { column: 'review' });
  assert.equal(notices.length, count + 1);
  assert.deepEqual(last().users, sorted(w.owner, w.abhay, w.adele));
  assert.equal(last().title, 'In review: Homepage');
  assert.match(last().body, /Sam Staff moved the task “Homepage” on Website to Under review\./);
  assert.equal(last().url, `/team/tasks/${w.task}`);
  assert.equal((await emailsSince(m)).length, 3, 'and by email');

  // Other moves don't notify anyone.
  count = notices.length;
  await sam.json(`/team/tasks/${w.task}/move`, { column: 'doing' });
  await sam.json(`/team/tasks/${w.task}/move`, { column: 'doing' });
  assert.equal(notices.length, count);

  // An admin moving it is left out of their own notice; the status menu and "Add a task" in the column count too.
  const adele = await new Browser().login('adele@test.local', 'member-password-1');
  await adele.get(`/team/tasks/${w.task}`);
  await adele.post(`/team/tasks/${w.task}/status`, { status: 'review' });
  assert.deepEqual(last().users, sorted(w.owner, w.abhay));
  await adele.get(`/team/projects/${w.project}`);
  await adele.post(`/team/projects/${w.project}/tasks`, { title: 'Logo options', status: 'review' });
  assert.equal(last().title, 'In review: Logo options');

  // Projects: dragged on the Projects board, or set from the status menu.
  m = await mark();
  await sam.get('/team/projects?view=board');
  await sam.json(`/team/projects/${w.project}/move`, { column: 'review' });
  assert.equal(last().title, 'Project in review: Website');
  assert.match(last().body, /Sam Staff moved the project “Website” for Acme to Under review\./);
  assert.deepEqual(last().users, sorted(w.owner, w.abhay, w.adele));
  await sam.json(`/team/projects/${w.project}/move`, { column: 'doing' });
  count = notices.length;
  const owner = await new Browser().login('owner@test.local', 'owner-password-1');
  await owner.get(`/team/projects/${w.project}`);
  await owner.post(`/team/projects/${w.project}/status`, { status: 'review' });
  assert.equal(notices.length, count + 1);
  assert.deepEqual(last().users, sorted(w.abhay, w.adele), 'the owner who moved it is left out');
  await owner.post(`/team/projects/${w.project}/status`, { status: 'review' });
  assert.equal(notices.length, count + 1, 'saving the same status again sends nothing');
});
