'use strict';

// Projects: "New project" from the Projects page (existing or new client, optional first tasks), and the
// project board (To do, In progress, Under review, Done) with drag-and-drop moves and "Assign to".

const os = require('os');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const test = require('node:test');
const assert = require('node:assert/strict');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-board-'));
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
    for (const [k, v] of Object.entries({ _csrf: this.csrf, ...data })) params.append(k, v);
    const res = await fetch(base + p, { method: 'POST', headers: { cookie: this.header(), 'content-type': 'application/x-www-form-urlencoded' }, body: params.toString(), redirect: 'manual' });
    this.store(res);
    return { status: res.status, text: await res.text(), location: res.headers.get('location') };
  }
  /** What the board script sends: JSON with the CSRF token in a header. */
  async json(p, data, { csrf = true } = {}) {
    const res = await fetch(base + p, {
      method: 'POST', redirect: 'manual',
      headers: { cookie: this.header(), 'content-type': 'application/json', accept: 'application/json', ...(csrf ? { 'x-csrf-token': this.csrf } : {}) },
      body: JSON.stringify(data),
    });
    const text = await res.text();
    let body = null;
    try { body = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, body };
  }
  async login(email, password) { await this.get('/login'); const r = await this.post('/login', { email, password }); assert.equal(r.status, 302, `${email} signs in`); await this.get('/'); return this; }
}

const idFrom = (location) => Number(String(location).match(/(\d+)(?:[?#].*)?$/)[1]);

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
  [world.acme] = await db('clients').insert({ name: 'Acme Interiors', status: 'active', created_at: NOW, updated_at: NOW });
  world.clientUser = await mk({ name: 'Priya Client', email: 'priya@test.local', role: 'client', client_id: world.acme });
});

test.after(async () => { server.closeAllConnections(); server.close(); await db.destroy(); fs.rmSync(tmp, { recursive: true, force: true }); });

test('owners create a project from the Projects page, with its first tasks in To do', async () => {
  const owner = await new Browser().login('owner@test.local', 'owner-password-1');
  const page = (await owner.get('/team/projects')).text;
  assert.match(page, /data-dialog="#new-project"/, 'New project button');
  assert.match(page, /<option value="new">\+ New client…<\/option>/);

  const r = await owner.post('/team/projects', { name: 'Website redesign', client_id: String(world.acme), due_date: '2026-12-31', tasks: 'Wireframes\r\n\r\n  Homepage design  \nContent from client' });
  assert.equal(r.status, 302);
  world.project = idFrom(r.location);
  assert.equal(r.location, `/team/projects/${world.project}`, 'lands on the new project');
  const p = await db('projects').where({ id: world.project }).first();
  assert.equal(p.client_id, world.acme);
  assert.equal(String(p.due_date).slice(0, 10), '2026-12-31');
  const tasks = await db('project_tasks').where({ project_id: world.project }).orderBy('id');
  assert.deepEqual(tasks.map((t) => [t.title, t.status]), [['Wireframes', 'todo'], ['Homepage design', 'todo'], ['Content from client', 'todo']]);
  world.tasks = tasks.map((t) => t.id);
});

test('a project can be created with a brand-new client, and bad input is sent back', async () => {
  const owner = await new Browser().login('owner@test.local', 'owner-password-1');
  await owner.get('/team/projects');
  const r = await owner.post('/team/projects', { name: 'Brand film', client_id: 'new', new_client: 'Zenith Studios' });
  assert.equal(r.status, 302);
  const client = await db('clients').where({ name: 'Zenith Studios' }).first();
  assert.ok(client, 'client created');
  assert.equal(client.segment, 'business');
  assert.ok(await db('channels').where({ client_id: client.id }).first(), 'the client gets its group chat');
  assert.ok(await db('projects').where({ client_id: client.id, name: 'Brand film' }).first());

  for (const body of [{ name: '', client_id: String(world.acme) }, { name: 'X', client_id: 'new', new_client: '' }, { name: 'X', client_id: '' }]) {
    const bad = await owner.post('/team/projects', body);
    assert.equal(bad.location, '/team/projects?new=1', JSON.stringify(body));
  }
  assert.match((await owner.get('/team/projects?new=1')).text, /id="new-project"[^>]*data-open/, 'the form reopens');
});

test('staff see the board but cannot create projects', async () => {
  const sam = await new Browser().login('sam@test.local', 'staff-password-1');
  assert.doesNotMatch((await sam.get('/team/projects')).text, /data-dialog="#new-project"/);
  assert.equal((await sam.post('/team/projects', { name: 'Sneaky', client_id: String(world.acme) })).status, 403);
  const page = (await sam.get(`/team/projects/${world.project}`)).text;
  for (const label of ['To do', 'In progress', 'Under review', 'Done']) assert.match(page, new RegExp(`<b>${label}</b>`), label);
  assert.match(page, /id="board"/);
  assert.match(page, /draggable="true" data-id="\d+"/);
  assert.match(page, /class="assign-select"/);
  assert.match(page, /<option value="\d+">Ria Rao<\/option>/, 'the team is in the Assign to list');
});

test('dragging a card moves the task and updates the project progress', async () => {
  const sam = await new Browser().login('sam@test.local', 'staff-password-1');
  await sam.get(`/team/projects/${world.project}`);
  const [a, b, c] = world.tasks;

  let r = await sam.json(`/team/tasks/${a}/move`, { column: 'doing' });
  assert.equal(r.status, 200);
  assert.equal(r.body.progress, 0);
  assert.equal((await db('projects').where({ id: world.project }).first()).status, 'in_progress', 'work started');

  r = await sam.json(`/team/tasks/${a}/move`, { column: 'done' });
  assert.equal(r.body.progress, 33);
  await sam.json(`/team/tasks/${b}/move`, { column: 'review' });
  assert.equal((await db('project_tasks').where({ id: b }).first()).status, 'review', 'sent to the client for approval');

  assert.equal((await sam.json(`/team/tasks/${c}/move`, { column: 'nowhere' })).status, 422);
  assert.equal((await sam.json(`/team/tasks/${c}/move`, { column: 'done' }, { csrf: false })).status, 403, 'CSRF is required');
  assert.equal((await db('project_tasks').where({ id: c }).first()).status, 'todo');

  await sam.json(`/team/tasks/${b}/move`, { column: 'done' });
  r = await sam.json(`/team/tasks/${c}/move`, { column: 'done' });
  assert.equal(r.body.progress, 100);
  assert.equal(r.body.projectStatus, 'completed');
  r = await sam.json(`/team/tasks/${c}/move`, { column: 'doing' });
  assert.equal(r.body.projectStatus, 'in_progress', 'reopened when a task moves back');
});

test('Assign to sets a teammate on the card, can be cleared, and typed names match the team', async () => {
  const sam = await new Browser().login('sam@test.local', 'staff-password-1');
  await sam.get(`/team/projects/${world.project}`);
  const [a] = world.tasks;

  let r = await sam.json(`/team/tasks/${a}/assign`, { user_id: String(world.ria) });
  assert.equal(r.status, 200);
  assert.equal(r.body.name, 'Ria Rao');
  let t = await db('project_tasks').where({ id: a }).first();
  assert.equal(t.assigned_to, world.ria);
  assert.equal(t.assignee, 'Ria Rao');
  assert.match((await sam.get(`/team/projects/${world.project}`)).text, new RegExp(`<option value="${world.ria}" selected>Ria Rao</option>`));

  r = await sam.json(`/team/tasks/${a}/assign`, { user_id: '' });
  assert.equal(r.body.name, null);
  t = await db('project_tasks').where({ id: a }).first();
  assert.equal(t.assigned_to, null);

  // A client account can't be assigned work.
  r = await sam.json(`/team/tasks/${a}/assign`, { user_id: String(world.clientUser) });
  assert.equal((await db('project_tasks').where({ id: a }).first()).assigned_to, null);

  // The task page still takes a typed name; a teammate's name links to their account.
  await sam.get(`/team/tasks/${a}`);
  await sam.post(`/team/tasks/${a}/assign`, { assignee: 'sam staff' });
  t = await db('project_tasks').where({ id: a }).first();
  assert.equal(t.assigned_to, world.sam);

  // Adding a task from the board can assign it straight away.
  await sam.get(`/team/projects/${world.project}`);
  await sam.post(`/team/projects/${world.project}/tasks`, { title: 'QA pass', user_id: String(world.ria), priority: 'high' });
  t = await db('project_tasks').where({ title: 'QA pass' }).first();
  assert.equal(t.assigned_to, world.ria);
  assert.equal(t.status, 'todo');
});

test('clients never reach the team board or its actions', async () => {
  const priya = await new Browser().login('priya@test.local', 'staff-password-1');
  assert.equal((await priya.get(`/team/projects/${world.project}`)).status, 404);
  assert.equal((await priya.json(`/team/tasks/${world.tasks[0]}/move`, { column: 'done' })).status, 404);
  assert.equal((await priya.post('/team/projects', { name: 'Mine', client_id: String(world.acme) })).status, 404);
});

test('the Projects page opens as the list, each project opens its own board, and Board shows all projects by phase', async () => {
  const owner = await new Browser().login('owner@test.local', 'owner-password-1');
  const [held] = await db('projects').insert({ client_id: world.acme, name: 'Paused app', status: 'on_hold', progress: 20, budget: 0, created_at: NOW, updated_at: NOW });
  const [fresh] = await db('projects').insert({ client_id: world.acme, name: 'Fresh logo', status: 'planning', progress: 0, budget: 0, created_at: NOW, updated_at: NOW });
  world.fresh = fresh;
  const list0 = (await owner.get('/team/projects')).text;
  assert.match(list0, /class="plist-row tl" href="\/team\/projects\/\d+"/, 'the list is the default, and each row opens its project');
  assert.doesNotMatch(list0, /id="board"/);
  assert.match(list0, /aria-current="page"><svg[^]*?List<\/a>/, 'List is the current view');
  assert.match((await owner.get(`/team/projects/${fresh}`)).text, /id="board" data-move-url="\/team\/tasks\/\{id\}\/move"/, 'the project shows its task board');

  const page = (await owner.get('/team/projects?view=board')).text;
  assert.match(page, /id="board" data-kind="project"/);
  const column = (col) => page.split(`data-col="${col}"`)[1].split('data-col=')[0];
  assert.match(column('todo'), /Fresh logo/);
  assert.match(column('doing'), /Paused app/);
  assert.match(column('doing'), /On hold/);
  assert.match(page, /aria-current="page"><svg[^]*?Board<\/a>/, 'Board is the current view');

  const list = (await owner.get('/team/projects?status=on_hold')).text;
  assert.match(list, /class="plist-row tl"/);
  assert.match(list, /Paused app/);
  assert.doesNotMatch(list, /Fresh logo/, 'list filters still work');
  assert.doesNotMatch(list, /id="board"/);
  // Dropping an on-hold project back into In progress leaves it on hold.
  await owner.get('/team/projects');
  const r = await owner.json(`/team/projects/${held}/move`, { column: 'doing' });
  assert.equal(r.body.status, 'on_hold');
});

test('dragging a project card changes its phase, and Assign to sets its owner', async () => {
  const sam = await new Browser().login('sam@test.local', 'staff-password-1');
  await sam.get('/team/projects');
  const id = world.fresh;
  let r = await sam.json(`/team/projects/${id}/move`, { column: 'doing' });
  assert.equal(r.status, 200);
  assert.equal(r.body.status, 'in_progress');
  r = await sam.json(`/team/projects/${id}/move`, { column: 'review' });
  assert.equal(r.body.status, 'review');
  r = await sam.json(`/team/projects/${id}/move`, { column: 'done' });
  assert.equal(r.body.status, 'completed');
  assert.equal(r.body.progress, 100);
  assert.equal((await sam.json(`/team/projects/${id}/move`, { column: 'sideways' })).status, 422);
  assert.equal((await sam.json(`/team/projects/${id}/move`, { column: 'todo' }, { csrf: false })).status, 403);
  assert.equal((await sam.json('/team/projects/999999/move', { column: 'todo' })).status, 404);

  r = await sam.json(`/team/projects/${id}/assign`, { user_id: String(world.ria) });
  assert.equal(r.body.name, 'Ria Rao');
  const p = await db('projects').where({ id }).first();
  assert.equal(p.assigned_to, world.ria);
  assert.match((await sam.get('/team/projects?view=board')).text, new RegExp(`<option value="${world.ria}" selected>Ria Rao</option>`));
  r = await sam.json(`/team/projects/${id}/assign`, { user_id: '' });
  assert.equal((await db('projects').where({ id }).first()).assigned_to, null);

  const priya = await new Browser().login('priya@test.local', 'staff-password-1');
  await priya.get('/portal'); // a real page, so the request carries her CSRF token
  assert.equal((await priya.json(`/team/projects/${id}/move`, { column: 'todo' })).status, 404, 'clients can’t move projects');
});

test('every column has its own add box: tasks land in that column, projects in that phase', async () => {
  const owner = await new Browser().login('owner@test.local', 'owner-password-1');
  const page = (await owner.get(`/team/projects/${world.project}`)).text;
  for (const col of ['todo', 'doing', 'review', 'done']) assert.match(page, new RegExp(`name="status" value="${col}"`), `${col} has an add box`);
  for (const col of ['doing', 'review']) {
    const r = await owner.post(`/team/projects/${world.project}/tasks`, { title: `Straight to ${col}`, status: col });
    assert.equal(r.status, 302);
    assert.equal((await db('project_tasks').where({ title: `Straight to ${col}` }).first()).status, col);
  }
  await owner.post(`/team/projects/${world.project}/tasks`, { title: 'Odd column', status: 'nowhere' });
  assert.equal((await db('project_tasks').where({ title: 'Odd column' }).first()).status, 'todo');

  const board = (await owner.get('/team/projects?view=board')).text;
  for (const col of ['todo', 'doing', 'review', 'done']) assert.match(board, new RegExp(`data-phase="${col}"`), `${col} has New project`);
  const r = await owner.post('/team/projects', { name: 'Already rolling', client_id: String(world.acme), phase: 'doing' });
  assert.equal((await db('projects').where({ id: idFrom(r.location) }).first()).status, 'in_progress');
  const sam = await new Browser().login('sam@test.local', 'staff-password-1');
  assert.doesNotMatch((await sam.get('/team/projects?view=board')).text, /data-phase=/, 'staff don’t get New project');
});
