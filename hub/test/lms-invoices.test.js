'use strict';

// Official GST tax invoices for lms.haptags.com payments (POST /api/v1/lms/invoice): the student
// becomes a Hub student client linked to the programme, the invoice is finalised in the HTG series
// with SAC 999293 and CGST+SGST (or IGST for another state), the PhonePe payment is recorded so it
// is issued PAID, the PDF renders, and a repeated or simultaneous call for the same order returns
// the same invoice. Runs on a throwaway SQLite database.

const os = require('os');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const test = require('node:test');
const assert = require('node:assert/strict');

const KEY = 'test-lms-key';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-lms-invoice-test-'));
Object.assign(process.env, {
  SQLITE_FILE: path.join(tmp, 'test.sqlite'),
  GST_BACKUP_DIR: path.join(tmp, 'backups'),
  ADMIN_EMAIL: 'owner@test.local',
  ADMIN_PASSWORD: 'owner-password-1',
  LMS_API_URL: '', // tests never call the real LMS
  HOLIDAYS_ICS_URL: '',
  NODE_ENV: 'test',
  LMS_KEY_SHA256: crypto.createHash('sha256').update(KEY).digest('hex'),
});

const { db, migrate } = require('../src/db');
const { getSettings } = require('../src/lib/settings');
const { ensureOwner } = require('../src/lib/bootstrap');
const { setProfile } = require('../src/lib/gst/profile');
const { financialYear, todayIST } = require('../src/lib/util');
const lmsInvoices = require('../src/lib/lms-invoices');

let server;
let base;
const fy = financialYear(todayIST());

const order = (over = {}) => ({
  merchant_order_id: 'HTG1762066800000ABCDE',
  order_id: 'ord000000000001',
  transaction_id: 'OM2611021234567890123',
  paid_at: new Date().toISOString().slice(0, 19).replace('T', ' ') + '.000Z',
  student: { name: 'Asha Rao', email: 'Asha@Example.com', phone: '9876543210', college: 'RV College of Engineering' },
  course: { lms_id: '74juyiav7upi34k', slug: 'cloud-computing-internship-training', title: 'Cloud Computing Internship Training' },
  plan: 'certificate',
  discount: 0,
  taxable: 99900,
  gst_rate: 18,
  total: 117900,
  coupon_code: '',
  ...over,
});

const post = (p, body, key = KEY) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': key }, body: JSON.stringify(body) });
const get = (p, key = KEY) => fetch(base + p, { headers: { 'x-api-key': key } });

test.before(async () => {
  await migrate();
  await getSettings();
  await ensureOwner();
  // Tests date documents "today"; keep the registration date out of the way.
  await setProfile({ gst_registration_date: '2017-07-01' });
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

test('request parsing: dates land on the India calendar day; bad input is refused', () => {
  assert.equal(lmsInvoices.istDate('2026-11-02 20:00:00.000Z'), '2026-11-03'); // 01:30 IST next day
  assert.equal(lmsInvoices.istDate('2026-11-02T05:00:00Z'), '2026-11-02');
  assert.equal(lmsInvoices.istDate('2026-11-02'), '2026-11-02');
  assert.throws(() => lmsInvoices.parseRequest(order({ merchant_order_id: '' })), /merchant_order_id/);
  assert.throws(() => lmsInvoices.parseRequest(order({ student: { name: 'X', email: 'nope' } })), /student\.email/);
  assert.throws(() => lmsInvoices.parseRequest(order({ taxable: 0 })), /taxable/);
  assert.throws(() => lmsInvoices.parseRequest(order({ gst_rate: 17 })), /gst_rate/);
  const r = lmsInvoices.parseRequest(order({ student: { name: 'Asha', email: 'a@b.co', state: 'Telangana' } }));
  assert.equal(r.student.stateCode, '36');
  assert.equal(r.student.email, 'a@b.co');
});

test('the API needs the LMS key and valid input', async () => {
  assert.equal((await post('/api/v1/lms/invoice', order(), 'wrong-key')).status, 401);
  const bad = await post('/api/v1/lms/invoice', order({ student: { name: 'X' } }));
  assert.equal(bad.status, 422);
  assert.match((await bad.json()).error, /student\.email/);
  assert.equal((await get('/api/v1/lms/invoice/NOPE123')).status, 404);
});

test('issues a PAID HTG tax invoice for a student (CGST + SGST by default) with the PDF', async () => {
  const res = await post('/api/v1/lms/invoice?pdf=1', order());
  assert.equal(res.status, 201);
  const inv = await res.json();
  assert.equal(inv.created, true);
  assert.equal(inv.warning, undefined);
  assert.match(inv.number, new RegExp(`^HTG/${fy}/\\d{4}$`));
  assert.equal(inv.status, 'paid');
  assert.equal(inv.supply_type, 'intra');
  assert.equal(inv.pos_code, '29');
  assert.equal(inv.pos_name, 'Karnataka');
  assert.deepEqual(
    [inv.gross, inv.discount, inv.taxable, inv.cgst, inv.sgst, inv.igst, inv.round_off, inv.total, inv.paid, inv.balance],
    [99900, 0, 99900, 8991, 8991, 0, 18, 117900, 117900, 0],
  );
  assert.equal(inv.sac, '999293');
  assert.equal(inv.gst_rate, 18);
  assert.equal(inv.supplier.legal_name, 'HAPTAGS LLP');
  assert.equal(inv.supplier.gstin, '29AASFH7857G1ZK');
  assert.equal(inv.supplier.pan, 'AASFH7857G');
  assert.match(inv.supplier.address, /Mahadevapura/);
  assert.equal(inv.recipient.name, 'Asha Rao');
  assert.equal(inv.recipient.email, 'asha@example.com');
  assert.equal(inv.recipient.type, 'b2c');
  assert.match(inv.amount_in_words, /thousand/i);
  assert.equal(inv.lines.length, 1);
  assert.match(inv.lines[0].description, /Cloud Computing Internship Training — Certificate plan/);
  assert.equal(inv.payments.length, 1);
  assert.deepEqual([inv.payments[0].amount, inv.payments[0].mode, inv.payments[0].reference], [117900, 'card', 'PhonePe OM2611021234567890123']);
  assert.equal(inv.issue_date, todayIST());
  assert.match(inv.hub_url, /\/invoices\/docs\/\d+$/);
  assert.equal(Buffer.from(inv.pdf_base64, 'base64').subarray(0, 4).toString(), '%PDF');

  // The student is a Hub student client, linked to the LMS programme, with a B2C GST mirror.
  const client = await db('clients').where({ segment: 'student' }).whereRaw('LOWER(email) = ?', ['asha@example.com']).first();
  assert.ok(client);
  assert.equal(client.college, 'RV College of Engineering');
  const program = await db('programs').where({ id: client.program_id }).first();
  assert.equal(program.lms_slug, 'cloud-computing-internship-training');
  const gc = await db('gst_clients').where({ hub_client_id: client.id }).first();
  assert.equal(gc.client_type, 'b2c');
  assert.equal(gc.state_code, '29');

  // The audit log says it was automatic.
  const trail = await db('gst_audit').where({ entity_type: 'document', entity_id: inv.document_id }).orderBy('id');
  assert.ok(trail.some((a) => a.action === 'lms-issued' && a.user_name === 'Haptags LMS'));
});

test('the same order again (webhook + status poll, or a resync) returns the same invoice', async () => {
  const res = await post('/api/v1/lms/invoice', order());
  assert.equal(res.status, 200);
  const inv = await res.json();
  assert.equal(inv.created, false);
  assert.equal(inv.pdf_base64, undefined);
  const first = await db('lms_invoices').where({ merchant_order_id: 'HTG1762066800000ABCDE' }).first();
  assert.equal(inv.document_id, first.document_id);
  const count = await db('gst_documents').where({ client_id: (await db('gst_documents').where({ id: first.document_id }).first()).client_id }).count({ n: '*' }).first();
  assert.equal(Number(count.n), 1);

  const again = await get('/api/v1/lms/invoice/HTG1762066800000ABCDE');
  assert.equal(again.status, 200);
  assert.equal((await again.json()).number, inv.number);
  const pdf = await get('/api/v1/lms/invoice/HTG1762066800000ABCDE/pdf');
  assert.equal(pdf.status, 200);
  assert.match(pdf.headers.get('content-type'), /pdf/);
  assert.match(pdf.headers.get('content-disposition'), /Tax-Invoice-HTG-/);
  assert.equal(Buffer.from(await pdf.arrayBuffer()).subarray(0, 4).toString(), '%PDF');
});

test('two simultaneous calls for one order issue one invoice', async () => {
  const body = order({ merchant_order_id: 'HTG1762066800001FGHIJ', order_id: 'ord000000000002', student: { name: 'Bala K', email: 'bala@example.com' } });
  const [a, b] = await Promise.all([post('/api/v1/lms/invoice', body), post('/api/v1/lms/invoice', body)]);
  assert.ok([200, 201].includes(a.status) && [200, 201].includes(b.status), `${a.status} ${b.status}`);
  const [ia, ib] = await Promise.all([a.json(), b.json()]);
  assert.equal(ia.number, ib.number);
  assert.equal(Number((await db('lms_invoices').where({ merchant_order_id: body.merchant_order_id }).count({ n: '*' }).first()).n), 1);
});

test('another state is IGST, a coupon shows as a discount, and the Full Package names its plan', async () => {
  const res = await post('/api/v1/lms/invoice', order({
    merchant_order_id: 'HTG1762066800002KLMNO',
    order_id: 'ord000000000003',
    student: { name: 'Ravi Teja', email: 'ravi@example.com', state_code: '36' },
    plan: 'internship',
    discount: 50000,
    taxable: 199900,
    total: 235900,
    coupon_code: 'WELCOME500',
  }));
  assert.equal(res.status, 201);
  const inv = await res.json();
  assert.equal(inv.supply_type, 'inter');
  assert.equal(inv.pos_name, 'Telangana');
  assert.deepEqual([inv.gross, inv.discount, inv.taxable, inv.cgst, inv.sgst, inv.igst, inv.round_off, inv.total, inv.balance], [249900, 50000, 199900, 0, 0, 35982, 18, 235900, 0]);
  assert.equal(inv.status, 'paid');
  assert.match(inv.lines[0].description, /Full Package \(Internship plan\)/);
  assert.match(inv.lines[0].description, /coupon WELCOME500/);
  // Numbers run consecutively within the series.
  const numbers = (await db('gst_documents').where({ kind: 'invoice', series: 'HTG' }).orderBy('seq').pluck('number'));
  assert.deepEqual(numbers.map((n) => Number(n.split('/')[2])), numbers.map((_, i) => i + 1));
});
