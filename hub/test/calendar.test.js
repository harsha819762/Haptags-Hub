'use strict';

// Team calendar: festivals and holidays highlighted on the month, meetings, task and project due dates,
// leave, the Mine / Whole team switch, the Festivals toggle, and company holidays for owners and admins.

const os = require('os');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const test = require('node:test');
const assert = require('node:assert/strict');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-cal-'));
Object.assign(process.env, {
  SQLITE_FILE: path.join(tmp, 'test.sqlite'), GST_BACKUP_DIR: path.join(tmp, 'backups'), ADMIN_EMAIL: 'owner@test.local', ADMIN_PASSWORD: 'owner-password-1',
  LMS_API_URL: '', HOLIDAYS_ICS_URL: '', NODE_ENV: 'test', LMS_KEY_SHA256: crypto.createHash('sha256').update('k').digest('hex'),
});
delete process.env.ENABLE_ADMIN;

const { db, migrate } = require('../src/db');
const { ensureOwner } = require('../src/lib/bootstrap');
const { hashPassword } = require('../src/lib/auth');
const { istToUtc } = require('../src/lib/util');

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
    const params = new URLSearchParams({ _csrf: this.csrf, ...data });
    const res = await fetch(base + p, { method: 'POST', headers: { cookie: this.header(), 'content-type': 'application/x-www-form-urlencoded' }, body: params.toString(), redirect: 'manual' });
    this.store(res);
    return { status: res.status, text: await res.text(), location: res.headers.get('location') };
  }
  async login(email, password) { await this.get('/login'); const r = await this.post('/login', { email, password }); assert.equal(r.status, 302); await this.get('/'); return this; }
}

/** The HTML of one day's cell. */
const cell = (page, date) => {
  const i = page.indexOf(`data-date="${date}"`);
  assert.ok(i > 0, `${date} is on the grid`);
  const start = page.lastIndexOf('<div class="tcal-day', i);
  const next = page.indexOf('<div class="tcal-day', i);
  return page.slice(start, next === -1 ? page.indexOf('</div>\n</div>', i) : next);
};

test.before(async () => {
  await migrate();
  await ensureOwner();
  const app = require('../src/app');
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
  const hash = await hashPassword('staff-password-1');
  const mk = async (fields) => (await db('users').insert({ password_hash: hash, is_active: true, token_version: 1, created_at: NOW, updated_at: NOW, ...fields }))[0];
  world.sam = await mk({ name: 'Sam Staff', email: 'sam@test.local', role: 'staff' });
  world.ria = await mk({ name: 'Ria Rao', email: 'ria@test.local', role: 'staff' });
  const [client] = await db('clients').insert({ name: 'Acme', status: 'active', created_at: NOW, updated_at: NOW });
  world.client = await mk({ name: 'Priya Client', email: 'priya@test.local', role: 'client', client_id: client });

  await db('holidays').insert([
    { date: '2026-11-08', name: 'Diwali/Deepavali', kind: 'public', source: 'google', tentative: false, created_at: NOW },
    { date: '2026-11-11', name: 'Bhai Duj', kind: 'observance', source: 'google', tentative: false, created_at: NOW },
  ]);
  const [pid] = await db('projects').insert({ client_id: client, name: 'Website', status: 'in_progress', progress: 0, budget: 0, due_date: '2026-11-20', assigned_to: world.ria, created_at: NOW, updated_at: NOW });
  await db('project_tasks').insert([
    { project_id: pid, title: 'Sam’s homepage', status: 'doing', priority: 'normal', due_date: '2026-11-12', assigned_to: world.sam, created_at: NOW, updated_at: NOW },
    { project_id: pid, title: 'Ria’s footer', status: 'todo', priority: 'normal', due_date: '2026-11-13', assigned_to: world.ria, created_at: NOW, updated_at: NOW },
    { project_id: pid, title: 'Finished thing', status: 'done', priority: 'normal', due_date: '2026-11-14', assigned_to: world.sam, created_at: NOW, updated_at: NOW },
  ]);
  await db('meetings').insert({ title: 'Sprint review', starts_at: istToUtc('2026-11-10', '11:30'), duration_min: 30, room_token: crypto.randomBytes(12).toString('hex'), status: 'scheduled', created_by: world.ria, created_at: NOW });
  await db('leave_requests').insert({ user_id: world.ria, type: 'casual', start_date: '2026-11-16', end_date: '2026-11-17', days: 2, half_day: false, status: 'approved', created_at: NOW });
});

test.after(async () => { server.closeAllConnections(); server.close(); await db.destroy(); fs.rmSync(tmp, { recursive: true, force: true }); });

test('Calendar is in the team menu, and festivals and holidays are highlighted', async () => {
  const sam = await new Browser().login('sam@test.local', 'staff-password-1');
  assert.match((await sam.get('/team')).text, /href="\/team\/calendar"/);
  const page = (await sam.get('/team/calendar?month=2026-11')).text;
  assert.match(page, /<h2 class="mb-0">November 2026<\/h2>/);

  const diwali = cell(page, '2026-11-08');
  assert.match(diwali, /class="tcal-day[^"]* holiday"/, 'a public holiday is highlighted strongly');
  assert.match(diwali, /off-tag">Holiday/);
  assert.match(diwali, /Diwali\/Deepavali/);
  const bhaiDuj = cell(page, '2026-11-11');
  assert.match(bhaiDuj, /class="tcal-day[^"]* festival"/, 'a festival is highlighted lightly');
  assert.match(bhaiDuj, /Bhai Duj/);
  assert.doesNotMatch(cell(page, '2026-11-09'), / holiday"| festival"/);
  assert.match(page, /Festivals &amp; holidays in November 2026/);

  const hidden = (await sam.get('/team/calendar?month=2026-11&festivals=0')).text;
  assert.doesNotMatch(cell(hidden, '2026-11-11'), /Bhai Duj| festival"/, 'the Festivals toggle hides observances');
  assert.match(cell(hidden, '2026-11-08'), /Diwali/, 'holidays stay');
});

test('meetings, task and project due dates and leave are on their days; Mine narrows them', async () => {
  const sam = await new Browser().login('sam@test.local', 'staff-password-1');
  const team = (await sam.get('/team/calendar?month=2026-11')).text;
  assert.match(cell(team, '2026-11-10'), /class="ev k-meeting"[^>]*>.*11:30.*Sprint review/s);
  assert.match(cell(team, '2026-11-12'), /k-task.*Sam’s homepage/s);
  assert.match(cell(team, '2026-11-13'), /Ria’s footer/);
  assert.doesNotMatch(cell(team, '2026-11-14'), /Finished thing/, 'done tasks are left off');
  assert.match(cell(team, '2026-11-20'), /k-project.*Website due/s);
  assert.match(cell(team, '2026-11-16'), /Ria Rao on leave/);
  assert.match(cell(team, '2026-11-17'), /Ria Rao on leave/);

  const mine = (await sam.get('/team/calendar?month=2026-11&scope=mine')).text;
  assert.match(cell(mine, '2026-11-12'), /Sam’s homepage/);
  for (const [date, text] of [['2026-11-13', 'Ria’s footer'], ['2026-11-10', 'Sprint review'], ['2026-11-20', 'Website due'], ['2026-11-16', 'on leave']]) {
    assert.doesNotMatch(cell(mine, date), new RegExp(text), `Mine hides ${text}`);
  }
  assert.match(cell(mine, '2026-11-08'), /Diwali/, 'festivals show for everyone');
});

test('owners and admins add and remove company holidays; staff and clients can’t', async () => {
  const owner = await new Browser().login('owner@test.local', 'owner-password-1');
  await owner.get('/team/calendar?month=2026-12');
  let r = await owner.post('/team/calendar/holidays', { date: '2026-12-01', name: 'Haptags Foundation Day', note: 'Office closed', month: '2026-12' });
  assert.equal(r.location, '/team/calendar?month=2026-12#holidays');
  const page = (await owner.get('/team/calendar?month=2026-12')).text;
  assert.match(cell(page, '2026-12-01'), /class="tcal-day[^"]* holiday"/);
  assert.match(page, /Company holiday · office closed · Office closed/);
  r = await owner.post('/team/calendar/holidays', { date: '2026-12-01', name: 'Haptags Foundation Day' });
  assert.equal((await db('holidays').where({ name: 'Haptags Foundation Day' })).length, 1, 'no duplicates');
  await owner.post('/team/calendar/holidays', { date: 'not-a-date', name: 'Bad' });
  assert.equal(await db('holidays').where({ name: 'Bad' }).first(), undefined);

  const sam = await new Browser().login('sam@test.local', 'staff-password-1');
  const samPage = (await sam.get('/team/calendar?month=2026-12')).text;
  assert.doesNotMatch(samPage, /Add a company holiday/);
  assert.equal((await sam.post('/team/calendar/holidays', { date: '2026-12-02', name: 'Sneaky' })).status, 403);
  const hd = await db('holidays').where({ name: 'Haptags Foundation Day' }).first();
  assert.equal((await sam.post(`/team/calendar/holidays/${hd.id}/delete`)).status, 403);

  // Holidays from Google can't be deleted here, only company ones.
  const diwali = await db('holidays').where({ name: 'Diwali/Deepavali' }).first();
  await owner.get('/team/calendar?month=2026-11');
  await owner.post(`/team/calendar/holidays/${diwali.id}/delete`);
  assert.ok(await db('holidays').where({ id: diwali.id }).first());
  await owner.post(`/team/calendar/holidays/${hd.id}/delete`);
  assert.equal(await db('holidays').where({ id: hd.id }).first(), undefined);

  const priya = await new Browser().login('priya@test.local', 'staff-password-1');
  assert.equal((await priya.get('/team/calendar')).status, 404);
});

test('the calendar opens on the current month and moves between months', async () => {
  const sam = await new Browser().login('sam@test.local', 'staff-password-1');
  const page = (await sam.get('/team/calendar')).text;
  assert.match(page, /class="tcal-day[^"]* today/);
  assert.match(page, /aria-label="Previous month"/);
  const jan = (await sam.get('/team/calendar?month=2027-01')).text;
  assert.match(jan, /January 2027/);
  assert.match(jan, /href="\/team\/calendar\?month=2026-12"/);
  assert.equal((await sam.get('/team/calendar?month=garbage')).status, 200);
});
