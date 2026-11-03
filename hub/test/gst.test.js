'use strict';

// GST Invoices (/team/gst): tax arithmetic, GSTIN checks, numbering per financial year, locking,
// cancellation, proformas, credit/debit notes, exports under LUT, payments with TDS, PDFs,
// reports and the guarantees that nothing is ever deleted. Runs on a throwaway SQLite database.

const os = require('os');
const path = require('path');
const fs = require('fs');
const zlib = require('zlib');
const test = require('node:test');
const assert = require('node:assert/strict');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-gst-test-'));
Object.assign(process.env, {
  SQLITE_FILE: path.join(tmp, 'test.sqlite'),
  GST_BACKUP_DIR: path.join(tmp, 'backups'),
  ADMIN_EMAIL: 'owner@test.local',
  ADMIN_PASSWORD: 'owner-password-1',
  LMS_API_URL: '',
  HOLIDAYS_ICS_URL: '',
  NODE_ENV: 'test',
  ENABLE_ADMIN: '1',
});

const { db, migrate } = require('../src/db');
const { getSettings } = require('../src/lib/settings');
const { ensureOwner } = require('../src/lib/bootstrap');
const { hashPassword } = require('../src/lib/auth');
const { todayIST, addDays, financialYear, nowSql } = require('../src/lib/util');
const tax = require('../src/lib/gst/tax');
const { inWords } = require('../src/lib/gst/words');
const { parseGstin } = require('../src/lib/gst/gstin');
const { getProfile, setProfile } = require('../src/lib/gst/profile');
const { takeNumber } = require('../src/lib/gst/numbering');
const { previewNumber: legacyPreview } = require('../src/lib/billing');
const { writeBackup, listBackups } = require('../src/lib/gst/backup');

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
const docRow = (id) => db('gst_documents').where({ id }).first();

/** Invoice form fields for one or more lines. */
function lines(rows) {
  return {
    line_item_id: rows.map(() => ''),
    line_description: rows.map((r) => r.d || 'Website development'),
    line_sac: rows.map((r) => r.sac || '998314'),
    line_qty: rows.map((r) => String(r.q ?? 1)),
    line_unit: rows.map(() => 'Nos'),
    line_rate: rows.map((r) => String(r.rate)),
    line_discount: rows.map((r) => r.disc || ''),
    line_gst_rate: rows.map((r) => String(r.gst ?? 18)),
  };
}

test.before(async () => {
  await migrate();
  await getSettings();
  await ensureOwner();
  // Tests date documents "today"; keep the registration date out of the way.
  await setProfile({ gst_registration_date: '2017-07-01' });
  await db('clients').insert({ name: 'Student Only', segment: 'student', status: 'active', country: 'India', created_at: nowSql(), updated_at: nowSql() });
  await db('users').insert({ name: 'Sam Staff', email: 'staff@test.local', role: 'staff', password_hash: await hashPassword('staff-password-1'), is_active: true, token_version: 1, created_at: nowSql(), updated_at: nowSql() });
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

test('tax engine: per-line tax, CGST/SGST vs IGST vs export, rupee round-off', () => {
  const home = '29';
  assert.equal(tax.supplyTypeFor({ clientType: 'b2b', posCode: '29' }, home), 'intra');
  assert.equal(tax.supplyTypeFor({ clientType: 'b2c', posCode: '27' }, home), 'inter');
  assert.equal(tax.supplyTypeFor({ clientType: 'export', posCode: '96' }, home), 'export');

  // Two lines taxed separately, then summed: 333.33 × 18% and 0.55 × 18%.
  const intra = tax.computeDocument([{ quantity: 1, rate: 33333, gst_rate: 18 }, { quantity: 1, rate: 55, gst_rate: 18 }], { supplyType: 'intra' });
  assert.deepEqual(intra.lines.map((l) => [l.cgst, l.sgst]), [[3000, 3000], [5, 5]]);
  assert.equal(intra.taxable, 33388);
  assert.equal(intra.cgst + intra.sgst, 6010);
  assert.equal(intra.total, 39400); // 393.98 rounds to 394.00
  assert.equal(intra.round_off, 2);

  const inter = tax.computeDocument([{ quantity: 2.5, rate: 100000, discount: 10000, gst_rate: 18 }], { supplyType: 'inter' });
  assert.deepEqual([inter.gross, inter.discount, inter.taxable, inter.igst, inter.cgst], [250000, 10000, 240000, 43200, 0]);

  const exp = tax.computeDocument([{ quantity: 1, rate: 125050, gst_rate: 18 }], { supplyType: 'export', currency: 'USD', exchangeRate: 83.5 });
  assert.deepEqual([exp.igst, exp.round_off, exp.total, exp.inr_total, exp.lines[0].gst_rate], [0, 0, 125050, 10441675, 0]);

  assert.equal(tax.parseDiscount('10%', 50000), 5000);
  assert.equal(tax.parseDiscount('1,250.50', 999999), 125050);
  const summary = tax.taxSummary(intra.lines.concat([{ sac: '998313', gst_rate: 18, taxable: 100, cgst: 9, sgst: 9, igst: 0 }]));
  assert.equal(summary.length, 2);
});

test('amounts in words and GSTIN checks', () => {
  assert.equal(inWords(12000000), 'Rupees One Lakh Twenty Thousand Only');
  assert.equal(inWords(1234567800), 'Rupees One Crore Twenty Three Lakh Forty Five Thousand Six Hundred Seventy Eight Only');
  assert.equal(inWords(125050, 'USD'), 'US Dollars One Thousand Two Hundred Fifty and Fifty Cents Only');
  assert.equal(inWords(150000000, 'GBP'), 'Pounds Sterling One Million Five Hundred Thousand Only');

  const own = parseGstin('29aasfh7857g1zk');
  assert.deepEqual([own.ok, own.stateCode, own.stateName, own.pan], [true, '29', 'Karnataka', 'AASFH7857G']);
  assert.equal(parseGstin('29AASFH7857G1ZA').ok, false); // wrong check digit
  assert.equal(parseGstin('99AASFH7857G1ZK').ok, false); // not a state
});

test('business profile starts from the GST certificate, with the signature', async () => {
  const p = await getProfile();
  assert.equal(p.legal_name, 'HAPTAGS LLP');
  assert.equal(p.gstin, '29AASFH7857G1ZK');
  assert.equal(p.pan, 'AASFH7857G');
  assert.equal(p.invoice_prefix, 'HTG');
  const sig = await db('files').where({ id: Number(p.signature_file_id) }).first();
  assert.equal(sig.mime, 'image/png');
  assert.ok(Number(sig.size) > 1000);
  const items = await db('gst_items').orderBy('sort');
  assert.deepEqual(items.map((i) => i.sac), ['998314', '998313', '998365', '999293']);
});

test('only owners and admins can open GST Invoices', async () => {
  const anon = new Browser();
  assert.match((await anon.get('/team/gst')).location, /^\/login/);
  const staff = new Browser();
  await staff.login('staff@test.local', 'staff-password-1');
  assert.equal((await staff.get('/team/gst')).status, 403);
  assert.equal((await staff.get('/team/gst/docs/new')).status, 403);
  const staffHome = await staff.get('/admin');
  assert.doesNotMatch(staffHome.text, /href="\/invoices"/);
  const owner = new Browser();
  await owner.login('owner@test.local', 'owner-password-1');
  const page = await owner.get('/team/gst');
  assert.equal(page.status, 200);
  assert.match(page.text, /GST Invoices/);
  assert.match((await owner.get('/admin')).text, /href="\/invoices"/);
});

test('full flow: clients, invoices, numbering, locking, payments, notes, proformas, exports, reports', async () => {
  const b = new Browser();
  await b.login('owner@test.local', 'owner-password-1');
  await b.get('/team/gst/clients/new');

  // Clients: the GSTIN decides the state; a bad GSTIN is refused.
  let r = await b.post('/team/gst/clients', { client_type: 'b2b', name: 'Bad GSTIN Ltd', gstin: '29AASFH7857G1ZA', state_code: '29' });
  assert.equal(r.status, 422);
  r = await b.post('/team/gst/clients', { client_type: 'b2b', name: 'Menon Exports Pvt Ltd', gstin: '29AASFH7857G1ZK', state_code: '07', address: '12, Indiranagar', city: 'Bengaluru', pincode: '560038', email: 'asha@menon.test' });
  const kaId = idFrom(r.location);
  // Clients are the Hub's own: the GSTIN set the state and PAN on the Hub client.
  const ka = await db('clients').where({ id: kaId }).first();
  assert.deepEqual([ka.segment, ka.state, ka.pan, ka.gstin], ['business', 'Karnataka', 'AASFH7857G', '29AASFH7857G1ZK']);
  r = await b.post('/team/gst/clients', { client_type: 'b2b', name: 'Sharma Traders', gstin: '27AAPFU0939F1ZV', address: 'Pune' });
  const mhId = idFrom(r.location);
  r = await b.post('/team/gst/clients', { client_type: 'export', name: 'Acme Inc.', country: 'United States', address: '500 Market St', city: 'San Francisco' });
  const usId = idFrom(r.location);
  assert.deepEqual(Object.values(await db('clients').where({ id: usId }).first('country', 'state')), ['United States', null]);

  // An intra-state invoice: CGST + SGST, saved as a draft (no number yet).
  await b.get('/team/gst/docs/new?kind=invoice');
  r = await b.post('/team/gst/docs', {
    kind: 'invoice', action: 'draft', hub_client_id: kaId, issue_date: today, payment_terms: 'Net 15', subject: 'Website',
    ...lines([{ rate: '1,00,000', disc: '10%' }, { d: 'Consulting', sac: '998313', q: 4, rate: '2500' }]),
  });
  const inv1 = idFrom(r.location);
  let d = await docRow(inv1);
  assert.equal(d.number, null);
  assert.equal(d.status, 'draft');
  assert.equal(d.supply_type, 'intra');
  assert.deepEqual([d.taxable, d.cgst, d.sgst, d.igst, d.total], [10000000, 900000, 900000, 0, 11800000]);
  assert.equal(d.due_date, addDays(today, 15));

  // Finalise: number HT/FY/0001, locked, supplier details frozen.
  r = await b.post(`/team/gst/docs/${inv1}/finalise`);
  d = await docRow(inv1);
  assert.equal(d.number, `HTG/${fy}/0001`);
  assert.ok(d.number.length <= 16);
  assert.equal(d.status, 'unpaid');
  assert.equal(JSON.parse(d.supplier_json).gstin, '29AASFH7857G1ZK');
  r = await b.get(`/team/gst/docs/${inv1}/edit`);
  assert.equal(r.location, `/team/gst/docs/${inv1}`);
  await b.post(`/team/gst/docs/${inv1}`, { kind: 'invoice', action: 'draft', hub_client_id: kaId, ...lines([{ rate: '1' }]) });
  assert.equal((await docRow(inv1)).total, 11800000);

  // The document page and PDF (original + duplicate).
  const show = await b.get(`/team/gst/docs/${inv1}`);
  assert.match(show.text, /Rupees One Lakh Eighteen Thousand Only/);
  assert.match(show.text, /Whether tax is payable under reverse charge: No/);
  const pdf = await b.get(`/team/gst/docs/${inv1}/pdf?copies=both`, { binary: true });
  assert.equal(pdf.type, 'application/pdf');
  assert.equal(pdf.body.subarray(0, 5).toString(), '%PDF-');

  // Inter-state: IGST at the full rate.
  r = await b.post('/team/gst/docs', { kind: 'invoice', action: 'finalise', hub_client_id: mhId, issue_date: today, payment_terms: 'Net 30', ...lines([{ rate: '50000' }]) });
  const inv2 = idFrom(r.location);
  d = await docRow(inv2);
  assert.deepEqual([d.number, d.supply_type, d.igst, d.cgst, d.pos_code], [`HTG/${fy}/0002`, 'inter', 900000, 0, '27']);

  // Export: refused without an LUT, then 0% IGST in USD with the INR equivalent.
  r = await b.post('/team/gst/docs', { kind: 'invoice', action: 'finalise', hub_client_id: usId, issue_date: today, payment_terms: 'Net 30', currency: 'USD', exchange_rate: '88.25', ...lines([{ rate: '4,250' }]) });
  const inv3 = idFrom(r.location);
  assert.equal((await docRow(inv3)).status, 'draft');
  await setProfile({ lut_number: 'AD2903260012345', lut_valid_from: '2017-07-01', lut_valid_until: addDays(today, 200) });
  await b.post(`/team/gst/docs/${inv3}/finalise`);
  d = await docRow(inv3);
  assert.deepEqual([d.number, d.supply_type, d.currency, d.igst, d.total, d.inr_total, d.lut_number], [`HTG/${fy}/0003`, 'export', 'USD', 0, 425000, 37506250, 'AD2903260012345']);
  const expPdf = await b.get(`/team/gst/docs/${inv3}/pdf`, { binary: true });
  assert.equal(expPdf.body.subarray(0, 5).toString(), '%PDF-');

  // Cancelling keeps the number; the next invoice never reuses it.
  r = await b.post(`/team/gst/docs/${inv2}/cancel`, { reason: 'Raised in error' });
  d = await docRow(inv2);
  assert.deepEqual([d.status, d.number, d.cancel_reason], ['cancelled', `HTG/${fy}/0002`, 'Raised in error']);
  r = await b.post('/team/gst/docs', { kind: 'invoice', action: 'finalise', hub_client_id: mhId, issue_date: today, ...lines([{ rate: '1000' }]) });
  assert.equal((await docRow(idFrom(r.location))).number, `HTG/${fy}/0004`);
  // The Hub's older invoice screen has its own HT series, which GST invoices don't advance.
  assert.equal(await legacyPreview('HT', today), `HT/${fy}/0001`);

  // Payments: partial with TDS u/s 194J @ 10% of the taxable value, then the rest.
  r = await b.post(`/team/gst/docs/${inv1}/payments`, { amount: '50000', tds_preset: '194J-10', mode: 'neft', reference: 'UTR123', paid_on: today });
  d = await docRow(inv1);
  assert.deepEqual([d.paid, d.tds, d.balance, d.status], [5000000, 1000000, 5800000, 'partially_paid']);
  r = await b.post(`/team/gst/docs/${inv1}/payments`, { amount: '60000', mode: 'upi', paid_on: today });
  assert.equal((await docRow(inv1)).status, 'partially_paid'); // more than the balance: refused
  // An invoice with payments can't be cancelled.
  await b.post(`/team/gst/docs/${inv1}/cancel`, { reason: 'test' });
  assert.equal((await docRow(inv1)).status, 'partially_paid');

  // Credit note against the invoice: its own series, linked, reduces the balance.
  await b.get(`/team/gst/docs/new?kind=credit_note&original=${inv1}`);
  r = await b.post('/team/gst/docs', { kind: 'credit_note', action: 'finalise', original_id: inv1, note_reason: 'Discount agreed', issue_date: today, ...lines([{ rate: '10000' }]) });
  const cn = await docRow(idFrom(r.location));
  assert.deepEqual([cn.number, cn.status, cn.original_id, cn.client_id, cn.total], [`CN/${fy}/0001`, 'issued', inv1, (await docRow(inv1)).client_id, 1180000]);
  d = await docRow(inv1);
  assert.deepEqual([d.credited, d.balance], [1180000, 4620000]);
  // A credit note can't exceed what is left on the invoice.
  r = await b.post('/team/gst/docs', { kind: 'credit_note', action: 'finalise', original_id: inv1, note_reason: 'Too much', issue_date: today, ...lines([{ rate: '200000' }]) });
  assert.equal((await docRow(idFrom(r.location))).status, 'draft');
  // A debit note adds to it.
  r = await b.post('/team/gst/docs', { kind: 'debit_note', action: 'finalise', original_id: inv1, note_reason: 'Extra hours', issue_date: today, ...lines([{ rate: '1000', sac: '998313' }]) });
  assert.equal((await docRow(idFrom(r.location))).number, `DN/${fy}/0001`);
  d = await docRow(inv1);
  assert.equal(d.balance, 4620000 + 118000);
  r = await b.post(`/team/gst/docs/${inv1}/payments`, { amount: String(d.balance / 100), mode: 'upi', paid_on: today });
  assert.equal((await docRow(inv1)).status, 'paid');

  // Proforma: its own series; one click drafts the tax invoice; finalising marks it converted.
  r = await b.post('/team/gst/docs', { kind: 'proforma', action: 'finalise', hub_client_id: kaId, issue_date: today, due_date: addDays(today, 15), ...lines([{ rate: '20000' }]) });
  const pf = idFrom(r.location);
  assert.equal((await docRow(pf)).number, `PF/${fy}/0001`);
  r = await b.post(`/team/gst/docs/${pf}/convert`);
  const fromPf = idFrom(r.location);
  d = await docRow(fromPf);
  assert.deepEqual([d.kind, d.status, d.source_id, d.total], ['invoice', 'draft', pf, 2360000]);
  await b.post(`/team/gst/docs/${fromPf}/finalise`);
  assert.equal((await docRow(pf)).status, 'converted');
  assert.equal((await docRow(pf)).converted_id, fromPf);

  // Numbers run in date order within a series.
  const yesterday = addDays(today, -1);
  if (financialYear(yesterday) === fy) {
    r = await b.post('/team/gst/docs', { kind: 'invoice', action: 'finalise', hub_client_id: kaId, issue_date: yesterday, ...lines([{ rate: '100' }]) });
    assert.equal((await docRow(idFrom(r.location))).status, 'draft');
  }

  // Overdue is derived from the due date.
  await db('gst_documents').where({ id: inv3 }).update({ due_date: addDays(today, -3) });
  const overdueList = await b.get('/team/gst/docs?type=invoice&status=overdue');
  assert.match(overdueList.text, new RegExp(`HTG/${fy}/0003`));

  // Email the PDF: logged even without SMTP.
  await b.get(`/team/gst/docs/${inv3}`);
  await b.post(`/team/gst/docs/${inv3}/email`, { to: 'john@acme.test', subject: 'Invoice', message: 'Please find attached.' });
  assert.ok(await db('email_log').where({ related_type: 'gst_document', related_id: inv3 }).first());

  // Reports: sales register (xlsx/csv), GSTR-1 workbook, outstanding.
  const from = `${today.slice(0, 7)}-01`;
  const reg = await b.get(`/team/gst/reports/sales-register.xlsx?from=${from}&to=${today}`, { binary: true });
  assert.equal(reg.body.subarray(0, 2).toString(), 'PK');
  const csv = await b.get(`/team/gst/reports/sales-register.csv?from=${from}&to=${today}`);
  assert.match(csv.text, new RegExp(`CN/${fy}/0001`));
  assert.match(csv.text, /Cancelled: Raised in error/);
  const gstr1 = await b.get(`/team/gst/reports/gstr1.xlsx?from=${from}&to=${today}`, { binary: true });
  const names = gstr1.body.toString('latin1');
  for (const sheet of ['xl/worksheets/sheet10.xml', 'xl/workbook.xml']) assert.ok(names.includes(sheet), sheet);
  const outstanding = await b.get('/team/gst/reports/outstanding');
  assert.match(outstanding.text, new RegExp(`HTG/${fy}/0003`));
  assert.equal((await b.get('/team/gst')).status, 200);
  assert.equal((await b.get(`/team/gst?fy=${fy}&status=paid`)).status, 200);

  // E-invoice request for a B2B invoice.
  const irp = JSON.parse((await b.get(`/team/gst/docs/${inv1}/einvoice.json`)).text);
  assert.deepEqual([irp.Version, irp.DocDtls.No, irp.SellerDtls.Gstin, irp.BuyerDtls.Gstin, irp.ValDtls.TotInvVal], ['1.1', `HTG/${fy}/0001`, '29AASFH7857G1ZK', '29AASFH7857G1ZK', 118000]);

  // Audit log: who created, finalised, cancelled.
  const actions = await db('gst_audit').where({ entity_type: 'document', entity_id: inv2 }).pluck('action');
  assert.deepEqual(actions.sort(), ['cancelled', 'created', 'finalised']);
  assert.ok((await db('gst_audit').where({ action: 'finalised' }).first()).user_name);
  assert.equal((await b.get('/team/gst/audit')).status, 200);
});

test('invoices bill the Hub’s existing clients directly, picked by search', async () => {
  const b = new Browser();
  await b.login('owner@test.local', 'owner-password-1');
  await b.get('/admin/clients/new');
  // A client added in the Hub's own Clients screen…
  let r = await b.post('/admin/clients', { name: 'Kumar Textiles', gstin: '27AAPFK1234M1Z0', state: 'Maharashtra', city: 'Pune', country: 'India', email: 'ops@kumar.test' });
  const hubId = idFrom(r.location);
  // …is in the invoice editor's client search, with no dropdown and nothing to copy first.
  const form = await b.get('/team/gst/docs/new?kind=invoice');
  assert.match(form.text, /data-client-search/);
  assert.doesNotMatch(form.text, /<select[^>]+name="client_id"/);
  const data = JSON.parse(form.text.match(/<script type="application\/json" id="gst-editor-data">([\s\S]*?)<\/script>/)[1]);
  assert.deepEqual([data.clients[hubId].name, data.clients[hubId].type, data.clients[hubId].state], ['Kumar Textiles', 'b2b', '27']);
  assert.ok(!Object.values(data.clients).some((c) => c.name === 'Student Only'));
  r = await b.post('/team/gst/docs', { kind: 'invoice', action: 'finalise', hub_client_id: hubId, issue_date: today, ...lines([{ rate: '1000' }]) });
  let d = await docRow(idFrom(r.location));
  assert.deepEqual([d.status, d.bill_name, d.supply_type, d.pos_code, d.bill_gstin], ['unpaid', 'Kumar Textiles', 'inter', '27', '27AAPFK1234M1Z0']);
  assert.equal((await db('gst_clients').where({ id: d.client_id }).first()).hub_client_id, hubId);
  // Without JavaScript, the typed name is enough.
  r = await b.post('/team/gst/docs', { kind: 'invoice', action: 'draft', client_search: 'kumar textiles', issue_date: today, ...lines([{ rate: '500' }]) });
  d = await docRow(idFrom(r.location));
  assert.equal(d.bill_name, 'Kumar Textiles');
  // Editing the Hub client updates the next draft save; the finalised invoice keeps what it printed.
  await b.get(`/admin/clients/${hubId}/edit`);
  await b.post(`/admin/clients/${hubId}`, { name: 'Kumar Textiles Pvt Ltd', gstin: '27AAPFK1234M1Z0', state: 'Maharashtra', country: 'India' });
  await b.post(`/team/gst/docs/${d.id}`, { kind: 'invoice', action: 'draft', hub_client_id: hubId, issue_date: today, ...lines([{ rate: '500' }]) });
  assert.equal((await docRow(d.id)).bill_name, 'Kumar Textiles Pvt Ltd');
  // The GST client pages are the same Hub clients.
  assert.match((await b.get('/team/gst/clients')).text, /Kumar Textiles Pvt Ltd/);
  assert.equal((await b.get(`/team/gst/clients/${hubId}`)).status, 200);

  // Clients that had been added only inside GST Invoices join the Hub list (by GSTIN match first).
  await db('gst_clients').insert([
    { name: 'Kumar dup', client_type: 'b2b', gstin: '27AAPFK1234M1Z0', country: 'India', state_code: '27', is_active: true, created_at: nowSql(), updated_at: nowSql() },
    { name: 'Only In GST', client_type: 'b2c', country: 'India', state_code: '33', state_name: 'Tamil Nadu', is_active: true, created_at: nowSql(), updated_at: nowSql() },
  ]);
  await require('../src/migrations/009_gst_hub_clients').up(db);
  assert.equal((await db('gst_clients').where({ name: 'Kumar dup' }).first()).hub_client_id, hubId);
  const moved = await db('clients').where({ name: 'Only In GST' }).first();
  assert.deepEqual([moved.segment, moved.state], ['business', 'Tamil Nadu']);
});

test('the Hub’s own invoices show the authorised signature once issued', async () => {
  const { createInvoice, issueInvoice } = require('../src/lib/billing');
  const [clientId] = await db('clients').insert({ name: 'Sign Test Ltd', segment: 'business', status: 'active', country: 'India', state: 'Karnataka', created_at: nowSql(), updated_at: nowSql() });
  const make = () => db.transaction((trx) => createInvoice(trx, {
    client_id: clientId, issue_date: today, due_date: addDays(today, 7), tax_mode: 'intra', gst_rate: 18, discount: 0,
  }, [{ description: 'Training', quantity: 1, rate: 1200000 }]));
  const issued = await make();
  await db.transaction((trx) => issueInvoice(trx, issued));
  const draft = await make();
  const token = async (id) => (await db('invoices').where({ id }).first()).public_token;
  const b = new Browser();
  const pub = await b.get(`/i/${await token(issued)}`);
  assert.match(pub.text, /<img class="doc-sign-img" src="data:image\/png;base64,/);
  assert.match(pub.text, /Authorised signatory/);
  assert.doesNotMatch((await b.get(`/i/${await token(draft)}`)).text, /doc-sign-img/);
  await b.login('owner@test.local', 'owner-password-1');
  assert.match((await b.get(`/admin/invoices/${issued}`)).text, /class="doc-sign-img"/);
});

test('the name and address on a finalised invoice can be corrected, and nothing else', async () => {
  const b = new Browser();
  await b.login('owner@test.local', 'owner-password-1');
  await b.get('/admin/clients/new');
  const hubId = idFrom((await b.post('/admin/clients', { name: 'Shree Construtions', address: 'Old Road', city: 'Mysuru', pincode: '570001', state: 'Karnataka', country: 'India', email: 'old@shree.test' })).location);
  await b.get('/team/gst/docs/new?kind=invoice');
  const id = idFrom((await b.post('/team/gst/docs', { kind: 'invoice', action: 'finalise', hub_client_id: hubId, issue_date: today, ...lines([{ rate: '1000' }]) })).location);
  const before = await docRow(id);
  assert.equal(before.bill_address, 'Old Road\nMysuru – 570001');

  const page = (await b.get(`/team/gst/docs/${id}`)).text;
  assert.match(page, /id="recipient-dialog"/);
  assert.match(page, /name="city" type="text" maxlength="100" value="Mysuru"/, 'the form is split like the client record');

  let r = await b.post(`/team/gst/docs/${id}/recipient`, {
    name: 'Shree Constructions', address: '12, 1st Main, Mahadevapura', city: 'Bengaluru', pincode: '560048', contact: 'Ravi', phone: '9000000009', email: 'accounts@shree.test',
    reason: 'Name misspelt', update_client: '1', bill_gstin: '29AASFH7857G1ZK', total: '1',
  });
  assert.equal(r.status, 302);
  const after = await docRow(id);
  assert.deepEqual([after.bill_name, after.bill_address, after.bill_email, after.bill_contact], ['Shree Constructions', '12, 1st Main, Mahadevapura\nBengaluru – 560048', 'accounts@shree.test', 'Ravi']);
  for (const k of ['number', 'status', 'total', 'cgst', 'sgst', 'igst', 'bill_gstin', 'bill_state_code', 'pos_code', 'client_type']) assert.equal(after[k], before[k], k);
  const note = await db('gst_audit').where({ entity_type: 'document', entity_id: id, action: 'recipient_corrected' }).first();
  assert.match(note.summary, /Name misspelt/);
  assert.deepEqual(JSON.parse(note.changes).bill_name, ['Shree Construtions', 'Shree Constructions']);
  // The client is updated too, so the next invoice prints the same.
  const hub = await db('clients').where({ id: hubId }).first();
  assert.deepEqual([hub.name, hub.address, hub.city, hub.pincode, hub.email], ['Shree Constructions', '12, 1st Main, Mahadevapura', 'Bengaluru', '560048', 'accounts@shree.test']);
  assert.equal((await db('gst_clients').where({ hub_client_id: hubId }).first()).name, 'Shree Constructions');

  // Only this document, when asked.
  await b.get(`/team/gst/docs/${id}`);
  await b.post(`/team/gst/docs/${id}/recipient`, { name: 'Shree Constructions Pvt Ltd', address: '12, 1st Main, Mahadevapura', city: 'Bengaluru', pincode: '560048' });
  assert.equal((await docRow(id)).bill_name, 'Shree Constructions Pvt Ltd');
  assert.equal((await db('clients').where({ id: hubId }).first()).name, 'Shree Constructions');
  // A name is required, and a cancelled invoice stays as issued.
  r = await b.post(`/team/gst/docs/${id}/recipient`, { name: '' });
  assert.match((await b.get(r.location)).text, /Enter the name to print/);
  await b.post(`/team/gst/docs/${id}/cancel`, { reason: 'test' });
  await b.post(`/team/gst/docs/${id}/recipient`, { name: 'Changed After Cancelling' });
  assert.equal((await docRow(id)).bill_name, 'Shree Constructions Pvt Ltd');
  assert.doesNotMatch((await b.get(`/team/gst/docs/${id}`)).text, /id="recipient-dialog"/);
});

test('documents and payments are never deleted, and numbers never change', async () => {
  const doc = await db('gst_documents').whereNotNull('number').first();
  await assert.rejects(() => db('gst_documents').where({ id: doc.id }).del(), /never deleted/);
  await assert.rejects(() => db('gst_documents').where({ id: doc.id }).update({ number: 'HT/XX/9999' }), /cannot be changed/);
  await assert.rejects(() => db('gst_document_lines').where({ document_id: doc.id }).del(), /cannot be removed/);
  const pay = await db('gst_payments').first();
  await assert.rejects(() => db('gst_payments').where({ id: pay.id }).del(), /never deleted/);
  assert.ok(await db('gst_documents').where({ id: doc.id }).first());
});

test('numbering restarts every financial year and backups are written', async () => {
  const next = await db.transaction((trx) => takeNumber(trx, 'HT', '2099-04-01'));
  assert.equal(next.number, 'HT/99-00/0001');
  const march = await db.transaction((trx) => takeNumber(trx, 'HT', '2100-03-31'));
  assert.equal(march.number, 'HT/99-00/0002');

  const name = await writeBackup({ force: true });
  assert.match(name, /^gst-\d{4}-\d{2}-\d{2}\.json\.gz$/);
  assert.equal(listBackups().length, 1);
  const snap = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(process.env.GST_BACKUP_DIR, name))).toString());
  assert.equal(snap.format, 'haptags-gst-backup');
  assert.ok(snap.tables.gst_documents.length >= 5);
  assert.ok(snap.files.some((f) => f.mime === 'image/png'));
});

// GST invoices issued in the shared HT series before it was split off move into HTG.
test('GST tax invoices move from the shared HT series into their own HTG series', async () => {
  const { setProfile: set, reloadProfile } = require('../src/lib/gst/profile');
  await set({ invoice_prefix: 'HT' }); // as on the live site before the split
  const b = new Browser();
  await b.login('owner@test.local', 'owner-password-1');
  await b.get('/team/gst/docs/new?kind=invoice');
  const hub = await db('clients').where({ name: 'Kumar Textiles Pvt Ltd' }).first();
  const ids = [];
  for (const rate of ['1000', '2000']) {
    const r = await b.post('/team/gst/docs', { kind: 'invoice', action: 'finalise', hub_client_id: hub.id, issue_date: today, ...lines([{ rate }]) });
    ids.push(idFrom(r.location));
  }
  const old = await Promise.all(ids.map(docRow));
  assert.ok(old.every((d) => d.series === 'HT'));
  const htgBefore = Number((await db('gst_documents').where({ series: 'HTG' }).max({ m: 'seq' }).first()).m || 0);

  await require('../src/migrations/011_gst_own_series').up(db);
  await reloadProfile();

  const moved = await Promise.all(ids.map(docRow));
  assert.deepEqual(moved.map((d) => d.number), [1, 2].map((i) => `HTG/${fy}/${String(htgBefore + i).padStart(4, '0')}`));
  assert.ok(moved.every((d) => d.series === 'HTG'));
  assert.equal((await getProfile()).invoice_prefix, 'HTG');
  // The older screen's HT counter is back at its own last number.
  const legacyMax = Math.max(0, ...(await db('invoices').where('number', 'like', `HT/${fy}/%`).pluck('number')).map((n) => Number(n.split('/').pop())));
  assert.equal(await legacyPreview('HT', today), `HT/${fy}/${String(legacyMax + 1).padStart(4, '0')}`);
  const note = await db('gst_audit').where({ entity_type: 'document', entity_id: ids[0], action: 'renumbered' }).first();
  assert.match(note.summary, new RegExp(`from ${old[0].number} to ${moved[0].number}`));
  // The number lock is back, and running it again changes nothing.
  await assert.rejects(() => db('gst_documents').where({ id: ids[0] }).update({ number: 'X/1' }), /cannot be changed/);
  await require('../src/migrations/011_gst_own_series').up(db);
  assert.equal((await docRow(ids[0])).number, moved[0].number);
  // The profile won't take a prefix the older screens use.
  await b.get('/team/gst/profile');
  const form = { ...(await getProfile()), invoice_prefix: 'HT' };
  for (const k of ['logo_file_id', 'signature_file_id', 'backup_last_run']) delete form[k];
  const r = await b.post('/team/gst/profile', form);
  assert.equal(r.status, 422);
  assert.match(r.text, /used by the Hub’s older Invoices or Quotations screen/);
});

// Runs last: it removes every GST document.
test('one-off fresh start removes the trial documents and restarts the numbering', async () => {
  const before = Number((await db('gst_documents').count({ n: '*' }).first()).n);
  assert.ok(before >= 5);
  assert.ok(await db('gst_payments').first());
  assert.ok(await db('gst_documents').where({ kind: 'credit_note' }).first());
  // The older Invoices screen issued a number in the shared HT series (the signature test).
  const legacy = await db('invoices').where('number', 'like', `HT/${fy}/%`).orderBy('number', 'desc').first();
  assert.ok(legacy);

  await require('../src/migrations/010_gst_fresh_start').up(db);

  for (const t of ['gst_documents', 'gst_document_lines', 'gst_payments']) assert.equal(Number((await db(t).count({ n: '*' }).first()).n), 0, t);
  assert.ok(await db('invoices').where({ id: legacy.id }).first(), 'the Hub’s own invoices are untouched');
  assert.ok(await db('gst_clients').first(), 'clients are untouched');
  const reset = await db('gst_audit').where({ action: 'reset' }).first();
  assert.match(reset.summary, /Fresh start/);
  assert.equal(await db('gst_audit').where({ entity_type: 'document' }).whereNotNull('entity_id').first(), undefined);
  // The safety triggers are back.
  const triggers = await db.raw("select name from sqlite_master where type = 'trigger' and name like 'gst_%'");
  assert.equal(triggers.length, 4);
  // A kept backup holds what was removed.
  const kept = listBackups().find((b) => b.name.startsWith('gst-before-fresh-start-'));
  const snap = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(process.env.GST_BACKUP_DIR, kept.name))).toString());
  assert.equal(snap.tables.gst_documents.length, before);

  // HT continues after the older screen's number; the GST-only series start again at 0001.
  const { previewNumber } = require('../src/lib/gst/numbering');
  const legacySeq = Number(legacy.number.split('/').pop());
  assert.equal(await previewNumber('HT', today), `HT/${fy}/${String(legacySeq + 1).padStart(4, '0')}`);
  for (const p of ['HTG', 'PF', 'CN', 'DN']) assert.equal(await previewNumber(p, today), `${p}/${fy}/0001`);
  // Running it again does nothing.
  await require('../src/migrations/010_gst_fresh_start').up(db);
  assert.equal(Number((await db('gst_audit').where({ action: 'reset' }).count({ n: '*' }).first()).n), 1);
});

// After the fresh start: the live series on 2 Nov 2026 was 0001 LVS (cancelled, re-raised as 0002)
// and 0003 CMR. The cancelled 0001 is removed and CMR becomes 0001.
test('one-off: the cancelled LVS 0001 is removed and CMR becomes HTG/26-27/0001', { skip: fy !== '26-27' && 'only for FY 26-27' }, async () => {
  const b = new Browser();
  await b.login('owner@test.local', 'owner-password-1');
  await b.get('/admin/clients/new');
  const ids = {};
  for (const name of ['LVS Constructions', 'LVS BUILDERS LLP', 'CMR CONSTRUTIONS']) {
    const hubId = idFrom((await b.post('/admin/clients', { name, state: 'Karnataka', city: 'Bengaluru', country: 'India' })).location);
    await b.get('/team/gst/docs/new?kind=invoice');
    const r = await b.post('/team/gst/docs', { kind: 'invoice', action: 'finalise', hub_client_id: hubId, issue_date: today, ...lines([{ rate: name.startsWith('CMR') ? '500' : '30000' }]) });
    ids[name] = idFrom(r.location);
  }
  const before = await Promise.all(Object.values(ids).map(docRow));
  assert.deepEqual(before.map((d) => d.number), ['HTG/26-27/0001', 'HTG/26-27/0002', 'HTG/26-27/0003']);
  const migration = require('../src/migrations/015_gst_cmr_first');

  // While 0001 is still live, nothing happens.
  await migration.up(db);
  assert.equal((await docRow(ids['CMR CONSTRUTIONS'])).number, 'HTG/26-27/0003');

  await b.get(`/team/gst/docs/${ids['LVS Constructions']}`);
  await b.post(`/team/gst/docs/${ids['LVS Constructions']}/cancel`, { reason: 'Wrong client name; re-raised to LVS BUILDERS LLP' });
  await migration.up(db);

  assert.equal(await docRow(ids['LVS Constructions']), undefined);
  assert.equal(await db('gst_document_lines').where({ document_id: ids['LVS Constructions'] }).first(), undefined);
  const cmr = await docRow(ids['CMR CONSTRUTIONS']);
  assert.deepEqual([cmr.number, cmr.seq, cmr.status, Number(cmr.total)], ['HTG/26-27/0001', 1, 'unpaid', 59000]);
  assert.equal((await docRow(ids['LVS BUILDERS LLP'])).number, 'HTG/26-27/0002');
  const { previewNumber } = require('../src/lib/gst/numbering');
  assert.equal(await previewNumber('HTG', today), 'HTG/26-27/0003');
  assert.match((await db('gst_audit').where({ action: 'removed' }).first()).summary, /Removed the cancelled HTG\/26-27\/0001 to LVS Constructions \(₹35,400\.00/);
  assert.match((await db('gst_audit').where({ entity_id: cmr.id, action: 'renumbered' }).first()).summary, /from HTG\/26-27\/0003 to HTG\/26-27\/0001/);
  assert.ok(listBackups().some((k) => k.name.startsWith('gst-before-cmr-first-')));
  // The safety triggers are back, and running it again changes nothing.
  assert.equal((await db.raw("select name from sqlite_master where type = 'trigger' and name like 'gst_%'")).length, 4);
  await assert.rejects(() => db('gst_documents').where({ id: cmr.id }).update({ number: 'X/1' }), /cannot be changed/);
  await migration.up(db);
  assert.equal((await docRow(cmr.id)).number, 'HTG/26-27/0001');
  assert.match((await b.get(`/team/gst/docs/${cmr.id}`)).text, /HTG\/26-27\/0001/);
});
