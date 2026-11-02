'use strict';

// Programmes from lms.haptags.com: the 43 published courses are added by migration 013 with their
// Internship and Certificate plan fees, kept in step by "Sync from LMS", and picked when enrolling
// a student (the plan is named on the invoice) and when writing their offer letter.

const os = require('os');
const path = require('path');
const fs = require('fs');
const test = require('node:test');
const assert = require('node:assert/strict');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-programs-test-'));
Object.assign(process.env, {
  SQLITE_FILE: path.join(tmp, 'test.sqlite'),
  GST_BACKUP_DIR: path.join(tmp, 'backups'),
  ADMIN_EMAIL: 'owner@test.local',
  ADMIN_PASSWORD: 'owner-password-1',
  LMS_API_URL: '', // tests never call the real LMS
  HOLIDAYS_ICS_URL: '',
  NODE_ENV: 'test',
});

const { db, migrate } = require('../src/db');
const { getSettings } = require('../src/lib/settings');
const { ensureOwner } = require('../src/lib/bootstrap');
const { nowSql } = require('../src/lib/util');
const { fromLms, upsertPrograms } = require('../src/lib/lms-programs');
const offers = require('../src/lib/offers');

let server;
let base;

class Browser {
  constructor() { this.cookies = {}; }
  header() { return Object.entries(this.cookies).map(([k, v]) => `${k}=${v}`).join('; '); }
  store(res) {
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      this.cookies[pair.slice(0, i)] = pair.slice(i + 1);
    }
  }
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
  async login(email, password) {
    await this.get('/login');
    return this.post('/login', { email, password });
  }
}

test.before(async () => {
  await migrate();
  await getSettings();
  await ensureOwner();
  const app = require('../src/app');
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  server.closeAllConnections();
  server.close();
  await db.destroy();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('the 43 LMS courses are programmes with both plan fees', async () => {
  const rows = await db('programs').whereNotNull('lms_id');
  assert.equal(rows.length, 43);
  assert.ok(rows.every((p) => p.is_active && Number(p.fee) === 249900 && Number(p.certificate_fee) === 99900), '₹2,499 Internship and ₹999 Certificate plans');
  assert.equal(new Set(rows.map((p) => p.category)).size, 7);
  const java = rows.find((p) => p.lms_slug === 'java-internship-training');
  assert.equal(java.name, 'Java Internship Training');
  assert.equal(java.category, 'IT & Software');
  assert.equal(java.kind, 'internship');
  assert.ok(java.fee_includes_gst);
  assert.equal(offers.roleFor(java.name), 'Java Intern');
  assert.equal(offers.roleFor('Food Technology'), 'Food Technology Intern');
});

test('upsert: no duplicates, first match by name, archive what the LMS dropped', async () => {
  const trx = await db.transaction();
  try {
    const current = (await trx('programs').whereNotNull('lms_id')).map((p) => ({ ...p, description: null }));
    // Running the seed again only updates.
    let r = await upsertPrograms(trx, current);
    assert.deepEqual(r, { added: 0, updated: 43, archived: 0 });

    // A programme typed in by hand is linked to the LMS course of the same name, not duplicated.
    const [own] = await trx('programs').insert({ name: 'Drone Technology', kind: 'internship', fee: 500000, description: 'Our own words', is_active: true, created_at: nowSql(), updated_at: nowSql() });
    const drone = fromLms({
      id: 'dronecourse0001', slug: 'drone-technology-internship-training', title: 'drone technology', subtitle: 'UAV design', expand: { category: { name: 'Robotics' } },
      plan_internship_price: 2999, plan_certificate_price: 1199,
    });
    r = await upsertPrograms(trx, [...current, drone], { archiveMissing: true });
    assert.deepEqual(r, { added: 0, updated: 44, archived: 0 });
    const linked = await trx('programs').where({ id: own }).first();
    assert.equal(linked.lms_id, 'dronecourse0001');
    assert.equal(Number(linked.fee), 299900);
    assert.equal(Number(linked.certificate_fee), 119900);
    assert.equal(linked.description, 'Our own words', 'a description written in the Hub is kept');

    // A new LMS course is added; one no longer published is archived, not deleted.
    const quantum = fromLms({ id: 'quantum00000001', slug: 'quantum', title: 'Quantum Computing', price: 1999, expand: {} });
    r = await upsertPrograms(trx, [...current.slice(1), drone, quantum], { archiveMissing: true });
    assert.deepEqual(r, { added: 1, updated: 43, archived: 1 });
    assert.equal((await trx('programs').where({ lms_id: current[0].lms_id }).first()).is_active ? 1 : 0, 0);
    const q = await trx('programs').where({ lms_id: 'quantum00000001' }).first();
    assert.equal(Number(q.fee), 199900, 'a course with one price uses it for both plans');
    assert.equal(q.category, null);
  } finally {
    await trx.rollback();
  }
});

test('programs page, enrolment on the Certificate plan, and the offer letter', async () => {
  const b = new Browser();
  await b.login('owner@test.local', 'owner-password-1');

  let page = (await b.get('/admin/education/programs')).text;
  assert.match(page, /43 active/);
  assert.match(page, /Biology &amp; Life Sciences/);
  assert.match(page, /Certificate ₹999/);
  assert.match(page, /title="Open on lms\.haptags\.com"/);
  assert.match(page, /lms\.haptags\.com\/course\/java-internship-training/);
  assert.doesNotMatch(page, /Sync from LMS/, 'no sync button without an LMS address');

  const java = await db('programs').where({ lms_slug: 'java-internship-training' }).first();
  page = (await b.get(`/admin/education/students/new?program=${java.id}`)).text;
  assert.match(page, /<optgroup label="IT &amp; Software">/);
  assert.match(page, new RegExp(`value="${java.id}" data-fee="2499" data-cert-fee="999"`));
  assert.match(page, /name="plan"/);

  let res = await b.post('/admin/education/students', {
    name: 'Meghana S', phone: '9876512345', email: 'meghana@college.test', program_id: String(java.id), plan: 'certificate', fee: '999', installments: '1', state: 'Karnataka',
  });
  assert.equal(res.status, 302);
  const studentId = Number(res.location.split('/').pop());
  const [inv] = await db('invoices').where({ client_id: studentId });
  assert.equal(Number(inv.total), 99900);
  assert.match(inv.title, /^Java Internship Training \(Certificate plan\)/);

  // The offer letter takes the position from the programme and the fee they were billed.
  const student = await db('clients').where({ id: studentId }).first();
  const letter = await offers.defaultsFor(student);
  assert.equal(letter.role_title, 'Java Intern');
  assert.equal(letter.programme, 'Java Internship Training');
  assert.equal(letter.fee, 99900);

  // Programmes without a certificate fee keep a single fee and no plan in the title.
  await b.post('/admin/education/programs', { name: 'Campus Ambassador', kind: 'internship', fee: '500', fee_includes_gst: '1' });
  const own = await db('programs').where({ name: 'Campus Ambassador' }).first();
  res = await b.post('/admin/education/students', { name: 'Rahul P', phone: '9876598765', program_id: String(own.id), plan: 'certificate', fee: '500', state: 'Karnataka' });
  const [inv2] = await db('invoices').where({ client_id: Number(res.location.split('/').pop()) });
  assert.match(inv2.title, /^Campus Ambassador/);
  assert.doesNotMatch(inv2.title, /plan\)/);
});
