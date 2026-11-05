'use strict';

// The rules for the client portal and the company view, end to end against a throwaway database:
// project access per person, one group chat per client, read-only billing, internal notes, and that clients
// are never told team pages exist.

const os = require('os');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const test = require('node:test');
const assert = require('node:assert/strict');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-portal-'));
Object.assign(process.env, {
  SQLITE_FILE: path.join(tmp, 'test.sqlite'), GST_BACKUP_DIR: path.join(tmp, 'backups'), ADMIN_EMAIL: 'owner@test.local', ADMIN_PASSWORD: 'owner-password-1',
  LMS_API_URL: '', HOLIDAYS_ICS_URL: '', NODE_ENV: 'test', LMS_KEY_SHA256: crypto.createHash('sha256').update('k').digest('hex'),
});
delete process.env.ENABLE_ADMIN;

const { db, migrate } = require('../src/db');
const { ensureOwner } = require('../src/lib/bootstrap');
const { hashPassword } = require('../src/lib/auth');
const { inviteUser } = require('../src/lib/invites');
const { ensureClientGroup } = require('../src/lib/clientchat');
const B = require('../src/lib/billdocs');

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
  async post(p, data = {}, { json = false } = {}) {
    const headers = { cookie: this.header() };
    let payload;
    if (json) { headers['content-type'] = 'application/json'; headers['x-csrf-token'] = this.csrf; payload = JSON.stringify(data); }
    else {
      headers['content-type'] = 'application/x-www-form-urlencoded';
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries({ _csrf: this.csrf, ...data })) (Array.isArray(v) ? v : [v]).forEach((x) => params.append(k, x));
      payload = params.toString();
    }
    const res = await fetch(base + p, { method: 'POST', headers, body: payload, redirect: 'manual' });
    this.store(res);
    const text = await res.text();
    return { status: res.status, text, location: res.headers.get('location') };
  }
  async login(email, password) { await this.get('/login'); return this.post('/login', { email, password }); }
}

async function signIn(email, password) { const b = new Browser(); const r = await b.login(email, password); assert.equal(r.status, 302, `${email} can sign in`); await b.get('/'); return b; }

const world = {};

test.before(async () => {
  await migrate();
  await ensureOwner();
  const app = require('../src/app');
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;

  const owner = await db('users').where({ role: 'owner' }).first();
  world.owner = owner;
  const pw = await hashPassword('client-password-1');
  const staffId = (await db('users').insert({ name: 'Sam Staff', email: 'sam@test.local', role: 'staff', password_hash: await hashPassword('staff-password-1'), is_active: true, token_version: 1, created_at: NOW, updated_at: NOW }))[0];
  world.staffId = staffId;

  const mkClient = async (name) => { const [id] = await db('clients').insert({ name, status: 'active', created_at: NOW, updated_at: NOW }); await db('client_contacts').insert({ client_id: id, user_id: owner.id, created_at: NOW }); return id; };
  const mkProject = async (client_id, name) => (await db('projects').insert({ client_id, name, status: 'in_progress', progress: 40, budget: 0, created_at: NOW, updated_at: NOW }))[0];
  world.lvs = await mkClient('LVS');
  world.other = await mkClient('Other Co');
  world.web = await mkProject(world.lvs, 'LVS Website');
  world.app = await mkProject(world.lvs, 'LVS Mobile App');
  world.secret = await mkProject(world.other, 'Other Secret Project');

  const person = async (name, email, opts) => {
    const r = await inviteUser({ name, email, role: 'client', clientId: world.lvs, invitedBy: owner, send: false, ...opts });
    await db('users').where({ id: r.id }).update({ password_hash: pw, invite_token_hash: null });
    return r.id;
  };
  world.paru = await person('Paru', 'paru@lvs.test', { allProjects: false, projectIds: [world.web] });
  world.divya = await person('Divya', 'divya@lvs.test', { allProjects: false, projectIds: [world.app] });
  world.karan = await person('Karan', 'karan@lvs.test', { allProjects: true });
  const otherUser = await inviteUser({ name: 'Olive', email: 'olive@other.test', role: 'client', clientId: world.other, invitedBy: owner, send: false, allProjects: true });
  await db('users').where({ id: otherUser.id }).update({ password_hash: pw, invite_token_hash: null });

  const inv = (number, project_id, total) => db('invoices').insert({
    number, client_id: world.lvs, project_id, title: `Invoice ${number}`, issue_date: '2026-11-01', due_date: '2026-11-20', status: 'sent', total, subtotal: total,
    public_token: crypto.randomBytes(24).toString('hex'), created_at: NOW, updated_at: NOW,
  });
  await inv('TST/WEB', world.web, 100000); await inv('TST/APP', world.app, 200000); await inv('TST/GEN', null, 300000);
  world.task = (await db('project_tasks').insert({ project_id: world.web, title: 'Build homepage', status: 'review', priority: 'normal', created_at: NOW, updated_at: NOW }))[0];
  await db('task_comments').insert([
    { task_id: world.task, user_id: owner.id, body: 'Shared note for everyone', internal: false, created_at: NOW },
    { task_id: world.task, user_id: owner.id, body: 'SECRET internal note', internal: true, created_at: NOW },
  ]);
});

test.after(async () => { server.closeAllConnections(); server.close(); await db.destroy(); fs.rmSync(tmp, { recursive: true, force: true }); });

test('a client person only sees the projects they were invited for', async () => {
  const paru = await signIn('paru@lvs.test', 'client-password-1');
  const home = (await paru.get('/portal')).text;
  assert.match(home, /LVS Website/);
  assert.doesNotMatch(home, /LVS Mobile App/);
  assert.doesNotMatch(home, /Other Secret Project/);
  assert.doesNotMatch(home, /TST\/APP|TST\/GEN/, 'invoices of other projects are hidden');

  const divya = await signIn('divya@lvs.test', 'client-password-1');
  const d = (await divya.get('/portal')).text;
  assert.match(d, /LVS Mobile App/);
  assert.doesNotMatch(d, /LVS Website/);

  const karan = await signIn('karan@lvs.test', 'client-password-1');
  const k = (await karan.get('/portal')).text;
  assert.match(k, /LVS Website/);
  assert.match(k, /LVS Mobile App/);
  assert.doesNotMatch(k, /Other Secret Project/);

  // Billing follows the same limit; company-wide people also see invoices that belong to no project.
  const pb = (await paru.get('/portal/billing')).text;
  assert.match(pb, /TST\/WEB/); assert.doesNotMatch(pb, /TST\/APP|TST\/GEN/);
  assert.match((await karan.get('/portal/billing')).text, /TST\/GEN/);
});

test('clients have no Projects section, no tasks and no approvals', async () => {
  const paru = await signIn('paru@lvs.test', 'client-password-1');
  for (const p of ['/portal/projects', `/portal/projects/${world.web}`, '/portal/projects/new']) {
    const r = await paru.get(p);
    assert.equal(r.status, 302, p); assert.equal(r.location, '/portal', p);
  }
  for (const p of [`/portal/tasks/${world.task}`, '/portal/billing/new', '/portal/calendar']) assert.equal((await paru.get(p)).status, 404, p);
  await paru.get('/portal');
  for (const p of [`/portal/tasks/${world.task}/approve`, `/portal/projects/${world.web}/tasks`, `/portal/projects/${world.web}/files`]) assert.equal((await paru.post(p)).status, 404, p);
  assert.doesNotMatch((await paru.get('/portal')).text, /Review &amp; approve|Waiting for your approval/);
  assert.equal((await db('project_tasks').where({ id: world.task }).first()).status, 'review', 'nothing changed');
});

test('billing is read-only for clients: no creating, paying-off or deleting documents', async () => {
  const karan = await signIn('karan@lvs.test', 'client-password-1');
  const page = (await karan.get('/portal/billing')).text;
  assert.doesNotMatch(page, /billing\/new|New invoice/);
  const [docId] = await db('billing_docs').insert({
    client_id: world.lvs, type: 'invoice', number: 'INV/T/0001', issue_date: '2026-11-01', due_date: '2026-11-08', bill_name: 'LVS', items: JSON.stringify([{ description: 'Work', quantity: 1, rate: 100000 }]),
    gst_rate: 18, igst: false, discount: 0, total: 118000, status: 'open', created_at: NOW,
  });
  const doc = await karan.get(`/portal/billing/${docId}`);
  assert.equal(doc.status, 200);
  assert.doesNotMatch(doc.text, /Mark as paid|Delete this document|Turn into invoice|Make receipt/);
  await karan.get('/portal');
  for (const p of ['/portal/billing', `/portal/billing/${docId}/paid`, `/portal/billing/${docId}/accept`, `/portal/billing/${docId}/delete`]) assert.equal((await karan.post(p, { type: 'invoice' })).status, 404, p);
  assert.equal((await db('billing_docs').where({ id: docId }).first()).status, 'open');
  // A person limited to one project never sees company-wide documents.
  const paru = await signIn('paru@lvs.test', 'client-password-1');
  assert.doesNotMatch((await paru.get('/portal/billing')).text, /INV\/T\/0001/);
  assert.equal((await paru.get(`/portal/billing/${docId}`)).status, 404);
});

test('the team can edit a document number: unique per type, and new numbers carry on after it', async () => {
  const team = await signIn('owner@test.local', 'owner-password-1');
  const doc = (n) => ({
    client_id: world.lvs, type: 'invoice', number: n, issue_date: '2026-11-01', bill_name: 'LVS', items: JSON.stringify([{ description: 'Work', quantity: 1, rate: 100000 }]),
    gst_rate: 18, igst: false, discount: 0, total: 118000, status: 'open', created_at: NOW,
  });
  const [a] = await db('billing_docs').insert(doc('INV/26-27/0040'));
  const [b] = await db('billing_docs').insert(doc('INV/26-27/0041'));
  assert.match((await team.get(`/team/billing/${a}`)).text, /Edit number/);
  await team.post(`/team/billing/${a}/number`, { number: 'INV/26-27/0041' });
  assert.equal((await db('billing_docs').where({ id: a }).first()).number, 'INV/26-27/0040', 'a taken number is refused');
  await team.post(`/team/billing/${b}/number`, { number: 'INV/26-27/0090' });
  assert.equal((await db('billing_docs').where({ id: b }).first()).number, 'INV/26-27/0090');
  assert.equal(await B.nextDocNumber('invoice', '2026-11-05'), 'INV/26-27/0091');
  const staff = await signIn('sam@test.local', 'staff-password-1');
  assert.equal((await staff.post(`/team/billing/${a}/number`, { number: 'X1' })).status, 403);
  await db('billing_docs').whereIn('id', [a, b]).del();
});

test('each client company has exactly one group chat, and nothing else', async () => {
  const paru = await signIn('paru@lvs.test', 'client-password-1');
  let res = await paru.get('/portal/chat');
  assert.equal(res.status, 302);
  const id = Number(res.location.split('/').pop());
  const group = await db('channels').where({ id }).first();
  assert.equal(group.client_id, world.lvs);
  const members = await db('channel_members').where({ channel_id: id }).pluck('user_id');
  for (const u of [world.paru, world.divya, world.karan, world.owner.id]) assert.ok(members.includes(u), `user ${u} is in the group`);
  assert.ok(!members.includes(world.staffId), 'staff who are not contacts are not added');

  // Same group for everyone at LVS; a different one for the other company.
  assert.equal((await (await signIn('divya@lvs.test', 'client-password-1')).get('/portal/chat')).location, res.location);
  const other = await (await signIn('olive@other.test', 'client-password-1')).get('/portal/chat');
  assert.notEqual(other.location, res.location);
  assert.equal((await paru.get(other.location)).status, 404, 'another company’s chat is not found');

  // No starting private chats or groups, and the team list is only their own contacts.
  const page = (await paru.get(res.location)).text;
  assert.doesNotMatch(page, /New group|Direct messages/);
  assert.doesNotMatch(page, /Sam Staff/);
  assert.equal((await paru.post('/portal/chat/new', { user_ids: String(world.owner.id) })).status, 404);
  assert.equal((await paru.post('/portal/chat/groups', { name: 'x', user_ids: String(world.owner.id) })).status, 404);

  // A message reaches the whole company.
  const sent = await paru.post(`/portal/chat/${id}/messages`, { body: 'Hello from Paru' }, { json: true });
  assert.equal(sent.status, 201);
  const karan = await signIn('karan@lvs.test', 'client-password-1');
  assert.match((await karan.get(`/portal/chat/${id}/messages`)).text, /Hello from Paru/);
});

test('internal notes are never shown to clients', async () => {
  const paru = await signIn('paru@lvs.test', 'client-password-1');
  const team = await signIn('owner@test.local', 'owner-password-1');
  const t = (await team.get(`/team/tasks/${world.task}`)).text;
  assert.match(t, /SECRET internal note/); assert.match(t, /Shared note/);
  const body = JSON.stringify([(await paru.get('/portal')).text, (await paru.get('/portal/notifications')).text, (await paru.get('/portal/search?q=SECRET')).text]);
  assert.doesNotMatch(body, /SECRET internal note/);

  await team.post(`/team/projects/${world.web}/updates`, { body: 'INTERNAL only update', internal: '1' });
  await team.post(`/team/projects/${world.web}/updates`, { body: 'Public update for the client' });
  const home = (await paru.get('/portal')).text;
  assert.match(home, /Public update for the client/);
  assert.doesNotMatch(home, /INTERNAL only update/);
});

test('clients are never told that team pages exist, and staff only get what they need', async () => {
  const paru = await signIn('paru@lvs.test', 'client-password-1');
  for (const p of ['/team', '/team/clients', `/team/clients/${world.lvs}`, '/team/billing', '/team/finance', '/team/leave', '/team/people', '/team/chat', '/admin', '/invoices']) {
    const r = await paru.get(p);
    assert.equal(r.status, 404, p);
    assert.doesNotMatch(r.text, /don.t have access|Not allowed|administrator/i, p);
  }
  const staff = await signIn('sam@test.local', 'staff-password-1');
  for (const p of ['/team', '/team/clients', '/team/projects', '/team/leave', '/team/people', '/team/chat/meetings']) assert.equal((await staff.get(p)).status, 200, p);
  for (const p of ['/team/billing', '/team/billing/new', '/team/finance']) assert.equal((await staff.get(p)).status, 403, `${p} is for owners and admins`);
  const overview = (await staff.get('/team')).text;
  assert.doesNotMatch(overview, /owe you|Outstanding|₹/, 'staff never see money on the dashboard');
  assert.equal((await staff.get('/portal')).status, 403);
});

test('inviting needs a project, and access can be limited or widened later', async () => {
  const team = await signIn('owner@test.local', 'owner-password-1');
  await team.get(`/team/clients/${world.lvs}`);
  let res = await team.post(`/team/clients/${world.lvs}/people`, { name: 'No Project', email: 'nobody@lvs.test' });
  assert.equal(res.status, 302);
  assert.equal(await db('users').where({ email: 'nobody@lvs.test' }).first(), undefined, 'an invite with no project is refused');

  await team.post(`/team/clients/${world.lvs}/people`, { name: 'Asha', email: 'asha@lvs.test', project_ids: String(world.app) });
  const asha = await db('users').where({ email: 'asha@lvs.test' }).first();
  assert.equal(Boolean(asha.all_projects), false);
  assert.deepEqual(await db('project_members').where({ user_id: asha.id }).pluck('project_id'), [world.app]);
  assert.ok((await db('channel_members').where({ user_id: asha.id }).first()), 'new people join the company chat');

  await team.post(`/team/clients/${world.lvs}/people/${asha.id}`, { action: 'access', all_projects: '1' });
  assert.equal(Boolean((await db('users').where({ id: asha.id }).first()).all_projects), true);
});

test('a new client company can be created with its first project and invitee', async () => {
  const team = await signIn('owner@test.local', 'owner-password-1');
  await team.get('/team/clients/new');
  let res = await team.post('/team/clients', { name: 'Acme', contact_name: 'Ann', contact_email: 'ann@acme.test' });
  assert.equal(res.status, 422, 'a project is required when inviting someone');
  res = await team.post('/team/clients', { name: 'Acme', contact_name: 'Ann', contact_email: 'ann@acme.test', first_project: 'Acme Site' });
  assert.equal(res.status, 302);
  const acme = await db('clients').where({ name: 'Acme' }).first();
  const project = await db('projects').where({ client_id: acme.id }).first();
  const ann = await db('users').where({ email: 'ann@acme.test' }).first();
  assert.equal(project.name, 'Acme Site');
  assert.equal(Boolean(ann.all_projects), false);
  assert.deepEqual(await db('project_members').where({ user_id: ann.id }).pluck('project_id'), [project.id]);
  assert.ok(await ensureClientGroup(acme.id));
});

test('a client request reaches the team, gets answered, and internal notes stay internal', async () => {
  const paru = await signIn('paru@lvs.test', 'client-password-1');
  await paru.get('/portal/tickets/new');
  let res = await paru.post('/portal/tickets', { subject: 'Change the logo', body: 'Please use the blue one', priority: 'high', project_id: String(world.web) });
  assert.match(res.location, /^\/portal\/tickets\/\d+$/);
  const ticketId = Number(res.location.split('/').pop());

  const team = await signIn('owner@test.local', 'owner-password-1');
  const list = (await team.get('/team/support')).text;
  assert.match(list, /Change the logo/);
  assert.match(list, /LVS/);

  const detail = await team.get(`/team/support/${ticketId}`);
  assert.equal(detail.status, 200);
  assert.match(detail.text, /Please use the blue one/);
  await team.post(`/team/support/${ticketId}/reply`, { body: 'Done, take a look' });
  await team.post(`/team/support/${ticketId}/reply`, { body: 'INTERNAL: check with design first', internal: '1' });
  assert.equal((await db('tickets').where({ id: ticketId }).first()).status, 'awaiting_client');

  const seen = (await paru.get(`/portal/tickets/${ticketId}`)).text;
  assert.match(seen, /Done, take a look/);
  assert.doesNotMatch(seen, /INTERNAL: check with design/);

  // A different client can never open it.
  const olive = await signIn('olive@other.test', 'client-password-1');
  assert.equal((await olive.get(`/portal/tickets/${ticketId}`)).status, 404);
  // The team can close and reopen it.
  await team.post(`/team/support/${ticketId}/status`, { status: 'closed' });
  assert.equal((await db('tickets').where({ id: ticketId }).first()).status, 'closed');
});

test('a payment a client reports is confirmed by the team; the team can also record one', async () => {
  const inv = await db('invoices').where({ number: 'TST/WEB' }).first();
  const client = new Browser();
  await client.get(`/i/${inv.public_token}`);
  const reported = await client.post(`/i/${inv.public_token}/report-payment`, { amount: '400', reference: 'UTR123456', method: 'upi' });
  assert.equal(reported.status, 302);
  const pending = await db('payments').where({ invoice_id: inv.id, status: 'pending' }).first();
  assert.ok(pending, 'the report is waiting for confirmation');
  assert.equal(Number((await db('invoices').where({ id: inv.id }).first()).amount_paid), 0, 'nothing is counted as paid yet');

  const staff = await signIn('sam@test.local', 'staff-password-1');
  await staff.get('/team');
  assert.equal((await staff.post(`/team/payments/${pending.id}/status`, { status: 'confirmed' })).status, 403, 'staff cannot confirm money');

  const team = await signIn('owner@test.local', 'owner-password-1');
  assert.match((await team.get('/team/billing')).text, /Payments to confirm[\s\S]*UTR123456/);
  await team.post(`/team/payments/${pending.id}/status`, { status: 'confirmed' });
  assert.equal((await db('payments').where({ id: pending.id }).first()).status, 'confirmed');
  assert.equal(Number((await db('invoices').where({ id: inv.id }).first()).amount_paid), 40000);

  // Recording the rest by hand; over-paying is refused.
  await team.get('/team/billing');
  await team.post(`/team/billing/invoices/${inv.id}/payment`, { amount: '5000', method: 'cash' });
  assert.equal(Number((await db('invoices').where({ id: inv.id }).first()).amount_paid), 40000, 'more than is due is refused');
  await team.post(`/team/billing/invoices/${inv.id}/payment`, { amount: '600', method: 'bank_transfer', reference: 'NEFT789' });
  const after = await db('invoices').where({ id: inv.id }).first();
  assert.equal(Number(after.amount_paid), 100000);
  assert.equal(after.status, 'paid');
  // The client now sees it as paid.
  const paru = await signIn('paru@lvs.test', 'client-password-1');
  assert.match((await paru.get('/portal/billing')).text, /Paid/);
});

test('calls: a client starts one, the team joins, and nobody outside can get in', async () => {
  const paru = await signIn('paru@lvs.test', 'client-password-1');
  const gid = Number((await paru.get('/portal/chat')).location.split('/').pop());
  await paru.get(`/portal/chat/${gid}`);
  const video = await paru.post(`/portal/chat/${gid}/call`, {});
  assert.match(video.location, /^\/meet\/[a-f0-9]{32}$/);
  const voice = await paru.post(`/portal/chat/${gid}/call`, { voice: '1' });
  assert.match(voice.location, /^\/meet\/[a-f0-9]{32}\?voice=1$/);
  const token = video.location.split('/meet/')[1];

  // The call page has the controls, including screen sharing, and the voice link opens with the camera off.
  const room = (await paru.get(video.location)).text;
  for (const control of ['mic', 'cam', 'share', 'hand']) assert.match(room, new RegExp(`data-ctl="${control}"`), control);
  assert.match((await paru.get(voice.location)).text, /"voice":\s*true/);

  // Both sides can join: the client who started it, and a team member who is in the group.
  const pj = await paru.post(`/meet/${token}/join`, { name: 'Paru', mic: '1' }, { json: true });
  assert.equal(pj.status, 200);
  const owner = await signIn('owner@test.local', 'owner-password-1');
  await owner.get(`/meet/${token}`);
  assert.equal((await owner.post(`/meet/${token}/join`, { name: 'Owner', mic: '1' }, { json: true })).status, 200);

  // Someone signed out, and a client from another company, are both turned away, on the page and when joining.
  const stranger = new Browser();
  assert.equal((await stranger.get(`/meet/${token}`)).status, 403);
  assert.equal((await stranger.post(`/meet/${token}/join`, { name: 'Intruder' }, { json: true })).status, 403);
  const olive = await signIn('olive@other.test', 'client-password-1');
  assert.equal((await olive.get(`/meet/${token}`)).status, 403);
  assert.equal((await olive.post(`/meet/${token}/join`, { name: 'Olive' }, { json: true })).status, 403);
});
