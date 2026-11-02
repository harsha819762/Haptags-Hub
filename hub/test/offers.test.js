'use strict';

// Internship offer letters: drafted from a student, issued with a number, read and accepted (or
// declined) by the student at /o/<token>, withdrawn, revised, and rendered as a PDF.

const os = require('os');
const path = require('path');
const fs = require('fs');
const test = require('node:test');
const assert = require('node:assert/strict');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-offer-test-'));
Object.assign(process.env, {
  SQLITE_FILE: path.join(tmp, 'test.sqlite'),
  GST_BACKUP_DIR: path.join(tmp, 'backups'),
  ADMIN_EMAIL: 'owner@test.local',
  ADMIN_PASSWORD: 'owner-password-1',
  LMS_API_URL: '',
  HOLIDAYS_ICS_URL: '',
  NODE_ENV: 'test',
});

const { db, migrate } = require('../src/db');
const { getSettings, setSettings } = require('../src/lib/settings');
const { ensureOwner } = require('../src/lib/bootstrap');
const { todayIST, addDays, financialYear, nowSql } = require('../src/lib/util');
const offers = require('../src/lib/offers');

let server;
let base;
const today = todayIST();
const fy = financialYear(today);

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
  async get(p, { binary = false } = {}) {
    const res = await fetch(base + p, { headers: { cookie: this.header() }, redirect: 'manual' });
    this.store(res);
    const body = binary ? Buffer.from(await res.arrayBuffer()) : await res.text();
    if (!binary) {
      const m = body.match(/name="csrf-token" content="([^"]+)"/);
      if (m) this.csrf = m[1];
    }
    return { status: res.status, text: binary ? '' : body, body, location: res.headers.get('location'), type: res.headers.get('content-type') };
  }
  async post(p, data = {}) {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries({ _csrf: this.csrf, ...data })) (Array.isArray(v) ? v : [v]).forEach((x) => params.append(k, x));
    const res = await fetch(base + p, { method: 'POST', headers: { cookie: this.header(), 'content-type': 'application/x-www-form-urlencoded' }, body: params.toString(), redirect: 'manual' });
    this.store(res);
    return { status: res.status, text: await res.text(), location: res.headers.get('location') };
  }
  async login(email, password) {
    await this.get('/login');
    return this.post('/login', { email, password });
  }
}

const idFrom = (location) => Number(String(location).split('/').pop().split(/[?#]/)[0]);
const row = (id) => db('offer_letters').where({ id }).first();

/** The offer form as the browser would send it, from a letter object. */
function formFrom(l, extra = {}) {
  const out = {};
  for (const k of ['candidate_name', 'candidate_email', 'candidate_phone', 'college', 'course', 'candidate_address', 'role_title', 'programme', 'start_date',
    'end_date', 'duration', 'mode', 'location', 'schedule', 'reporting_to', 'reporting_designation', 'respond_by', 'joining_instructions', 'extra_terms']) out[k] = l[k] ?? '';
  out.stipend = l.stipend ? String(l.stipend / 100) : '';
  out.fee = l.fee ? String(l.fee / 100) : '';
  if (l.show_fee) out.show_fee = '1';
  return { ...out, ...extra };
}

let studentId;

test.before(async () => {
  await migrate();
  await getSettings();
  await ensureOwner();
  await setSettings({ offer_signatory_name: 'Asha Rao', offer_reporting_to: 'Ravi Kumar', offer_reporting_designation: 'Technical Lead' });
  const [pid] = await db('programs').insert({ name: 'Java Full Stack Development Internship', kind: 'internship', fee: 1200000, duration: '3 months', is_active: true, created_at: nowSql(), updated_at: nowSql() });
  [studentId] = await db('clients').insert({
    name: 'Divya Nagaraj', email: 'divya@college.test', phone: '9876543210', college: 'RV College of Engineering', course: 'B.E. CSE, 3rd year',
    city: 'Bengaluru', state: 'Karnataka', segment: 'student', program_id: pid, status: 'active', created_at: nowSql(), updated_at: nowSql(),
  });
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

test('helpers: position, duration and terms', () => {
  assert.equal(offers.roleFor('Java Full Stack Development Internship'), 'Java Full Stack Development Intern');
  assert.equal(offers.roleFor('Python Internship Training'), 'Python Intern');
  assert.equal(offers.roleFor(''), 'Intern');
  assert.equal(offers.durationText('2026-11-09', '2027-02-08'), '3 months');
  assert.equal(offers.durationText('2026-11-09', '2026-12-20'), '6 weeks');
  assert.equal(offers.durationText('2026-11-09', '2026-11-18'), '10 days');
  const t = offers.parseTerms('Conduct: Be kind.\n\nNo heading here.');
  assert.deepEqual(t, [{ heading: 'Conduct', text: 'Be kind.' }, { heading: '', text: 'No heading here.' }]);
});

test('offer letter: draft from a student, issue, PDF, accept online', async () => {
  const b = new Browser();
  await b.login('owner@test.local', 'owner-password-1');

  // The student page offers to create one; the form is filled from the student and programme.
  assert.match((await b.get(`/admin/education/students/${studentId}`)).text, /Create offer letter/);
  assert.match((await b.get('/admin/education/offers')).text, /Offer letters/);
  const form = await b.get(`/admin/education/offers/new?student=${studentId}`);
  assert.equal(form.status, 200);
  assert.match(form.text, /value="Java Full Stack Development Intern"/);
  assert.match(form.text, new RegExp(`HTOL/${fy}/0001`));

  const st = await db('clients').where({ id: studentId }).first();
  const d = await offers.defaultsFor(st);
  assert.equal(d.duration, '3 months');
  assert.equal(offers.durationText(d.start_date, d.end_date), '3 months');

  // Invalid: end before start.
  let r = await b.post('/admin/education/offers', { client_id: studentId, action: 'draft', ...formFrom(d, { end_date: addDays(d.start_date, -1) }) });
  assert.equal(r.status, 422);

  r = await b.post('/admin/education/offers', { client_id: studentId, action: 'draft', ...formFrom(d, { stipend: '5000' }) });
  const id = idFrom(r.location);
  let o = await row(id);
  assert.deepEqual([o.status, o.number, o.stipend], ['draft', null, 500000]);
  // A draft isn't visible on the public link.
  const anon = new Browser();
  assert.equal((await anon.get(`/o/${o.public_token}`)).status, 404);

  // Issue: numbered, wording frozen.
  await b.post(`/admin/education/offers/${id}/issue`);
  o = await row(id);
  assert.equal(o.number, `HTOL/${fy}/0001`);
  assert.equal(o.status, 'issued');
  assert.equal(o.signatory_name, 'Asha Rao');
  assert.match(o.terms, /Confidentiality:/);
  await setSettings({ offer_signatory_name: 'Someone Else' });
  const show = await b.get(`/admin/education/offers/${id}`);
  assert.match(show.text, /Asha Rao/);
  assert.match(show.text, /INTERNSHIP OFFER LETTER|Internship Offer Letter/);
  assert.match(show.text, /₹5,000.00 per month/);
  assert.doesNotMatch((await b.get(`/admin/education/offers/${id}/edit`)).text, /name="role_title"/);

  // PDFs: admin and the student's link.
  const pdf = await b.get(`/admin/education/offers/${id}/pdf`, { binary: true });
  assert.equal(pdf.type, 'application/pdf');
  assert.equal(pdf.body.subarray(0, 5).toString(), '%PDF-');
  assert.equal((await anon.get(`/o/${o.public_token}/pdf`, { binary: true })).body.subarray(0, 5).toString(), '%PDF-');

  // Email (logged without SMTP).
  await b.post(`/admin/education/offers/${id}/email`, { to: 'divya@college.test' });
  assert.ok(await db('email_log').where({ related_type: 'offer', related_id: id }).first());

  // The student reads it, must tick the box, then accepts.
  const page = await anon.get(`/o/${o.public_token}`);
  assert.equal(page.status, 200);
  assert.match(page.text, /Accept your internship offer/);
  assert.match(page.text, /Divya Nagaraj/);
  r = await anon.post(`/o/${o.public_token}/respond`, { decision: 'accept', name: 'Divya Nagaraj' });
  assert.equal((await row(id)).status, 'issued');
  r = await anon.post(`/o/${o.public_token}/respond`, { decision: 'accept', name: 'Divya Nagaraj', agree: '1' });
  o = await row(id);
  assert.deepEqual([o.status, o.responded_name], ['accepted', 'Divya Nagaraj']);
  assert.ok(o.responded_ip);
  assert.match((await anon.get(`/o/${o.public_token}`)).text, /You accepted this offer/);
  // It can't be answered twice.
  await anon.post(`/o/${o.public_token}/respond`, { decision: 'decline', name: 'Divya' });
  assert.equal((await row(id)).status, 'accepted');
  const history = await db('activities').where({ entity_type: 'offer', entity_id: id }).pluck('body');
  assert.ok(history.some((h) => /Accepted online by Divya Nagaraj/.test(h)));

  // A revised copy is a new draft; withdrawing the old one closes its link.
  r = await b.post(`/admin/education/offers/${id}/revise`);
  const copyId = idFrom(r.location.replace(/\/edit$/, ''));
  assert.equal((await row(copyId)).status, 'draft');
  await b.post(`/admin/education/offers/${id}/withdraw`, { reason: 'Dates changed' });
  assert.equal((await row(id)).status, 'withdrawn');
  assert.match((await anon.get(`/o/${o.public_token}`)).text, /has been withdrawn/);

  // Declining, and an expired offer.
  await b.post(`/admin/education/offers/${copyId}/issue`);
  const copy = await row(copyId);
  assert.equal(copy.number, `HTOL/${fy}/0002`);
  await anon.get(`/o/${copy.public_token}`);
  await anon.post(`/o/${copy.public_token}/respond`, { decision: 'decline', name: 'Divya Nagaraj', note: 'Joining another programme' });
  assert.equal((await row(copyId)).status, 'declined');

  // Drafts can be deleted; issued letters can't.
  r = await b.post('/admin/education/offers', { client_id: studentId, action: 'draft', ...formFrom(d) });
  const draftId = idFrom(r.location);
  await b.post(`/admin/education/offers/${draftId}/delete`);
  assert.equal(await row(draftId), undefined);
  await b.post(`/admin/education/offers/${copyId}/delete`);
  assert.ok(await row(copyId));
  assert.equal(offers.displayStatus({ status: 'issued', respond_by: addDays(today, -1) }), 'expired');

  // Settings tab.
  const settings = await b.get('/admin/settings?tab=offers');
  assert.match(settings.text, /Offer letter settings|Save offer letter settings/);
  assert.match(settings.text, /Governing law/);
});
