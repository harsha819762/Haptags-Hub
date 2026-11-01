'use strict';

const fs = require('fs');
const express = require('express');
const C = require('../../lib/gst/constants');
const { DEFAULTS, getProfile, setProfile, image, saveImage, homeStateCode } = require('../../lib/gst/profile');
const { parseGstin, isPan } = require('../../lib/gst/gstin');
const { previewNumber, advanceSeries, MAX_LENGTH } = require('../../lib/gst/numbering');
const { gzipped, writeBackup, listBackups, backupPath } = require('../../lib/gst/backup');
const { actor, audit, diff } = require('../../lib/gst/audit');
const { str, isDate, isEmail, int, todayIST, financialYear } = require('../../lib/util');
const { sendFile } = require('./_helpers');

const router = express.Router();

const FIELDS = [
  'legal_name', 'trade_name', 'constitution', 'gstin', 'pan', 'gst_registration_date', 'llpin', 'address', 'city', 'pincode', 'state_code',
  'email', 'phone', 'website', 'bank_account_name', 'bank_account_number', 'bank_ifsc', 'bank_name', 'bank_branch', 'bank_swift', 'upi_id', 'upi_name',
  'lut_number', 'lut_valid_from', 'lut_valid_until', 'signatory_name', 'signatory_designation',
  'invoice_prefix', 'proforma_prefix', 'credit_prefix', 'debit_prefix', 'default_gst_rate', 'default_payment_terms', 'proforma_valid_days', 'default_terms',
];
const PREFIXES = ['invoice_prefix', 'proforma_prefix', 'credit_prefix', 'debit_prefix'];
const DATES = ['gst_registration_date', 'lut_valid_from', 'lut_valid_until'];

function parseProfile(body) {
  const v = {};
  for (const f of FIELDS) v[f] = str(body[f], f === 'default_terms' || f === 'address' ? 3000 : 190) || '';
  const errors = {};
  if (!v.legal_name) errors.legal_name = 'Enter the legal name as on the GST certificate.';
  v.gstin = v.gstin.toUpperCase().replace(/\s+/g, '');
  if (v.gstin) {
    const g = parseGstin(v.gstin);
    if (!g.ok) errors.gstin = g.error;
    else {
      v.state_code = g.stateCode;
      if (!v.pan) v.pan = g.pan;
      else if (g.pan && v.pan.toUpperCase() !== g.pan) errors.pan = `The PAN in this GSTIN is ${g.pan}.`;
    }
  } else if (!C.GST_STATES.some((s) => s[0] === v.state_code)) errors.state_code = 'Choose the state.';
  v.pan = v.pan.toUpperCase();
  if (v.pan && !isPan(v.pan)) errors.pan = 'A PAN is 5 letters, 4 digits and a letter.';
  for (const d of DATES) if (v[d] && !isDate(v[d])) errors[d] = 'Enter a valid date.';
  if (v.lut_valid_from && v.lut_valid_until && v.lut_valid_until < v.lut_valid_from) errors.lut_valid_until = 'The LUT can’t end before it starts.';
  if (v.email && !isEmail(v.email)) errors.email = 'Enter a valid email address.';
  v.bank_ifsc = v.bank_ifsc.toUpperCase();
  if (v.bank_ifsc && !/^[A-Z]{4}0[A-Z0-9]{6}$/.test(v.bank_ifsc)) errors.bank_ifsc = 'An IFSC is 11 characters, e.g. HDFC0001234.';
  v.bank_swift = v.bank_swift.toUpperCase();
  if (v.bank_swift && !/^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$/.test(v.bank_swift)) errors.bank_swift = 'A SWIFT/BIC code is 8 or 11 characters.';
  v.bank_account_number = v.bank_account_number.replace(/\s+/g, '');
  if (v.upi_id && !/^[\w.-]{2,}@[A-Za-z][\w.-]{1,}$/.test(v.upi_id)) errors.upi_id = 'A UPI ID looks like name@bank.';
  for (const p of PREFIXES) {
    v[p] = v[p].toUpperCase();
    if (!/^[A-Z0-9]{1,5}$/.test(v[p])) errors[p] = 'Up to 5 letters or digits, so numbers stay within 16 characters.';
  }
  if (new Set(PREFIXES.map((p) => v[p])).size < PREFIXES.length) errors.debit_prefix = 'Each document type needs its own prefix.';
  if (!C.GST_RATES.includes(Number(v.default_gst_rate))) v.default_gst_rate = '18';
  if (!C.PAYMENT_TERMS.some((t) => t[0] === v.default_payment_terms)) v.default_payment_terms = DEFAULTS.default_payment_terms;
  v.proforma_valid_days = String(Math.min(365, Math.max(1, int(v.proforma_valid_days, 15))));
  return { values: v, errors };
}

async function pageData(profile) {
  const today = todayIST();
  const series = await Promise.all(Object.entries(C.KINDS).map(async ([kind, k]) => ({
    kind, label: k.label, prefix: profile[k.prefixKey], next: await previewNumber(profile[k.prefixKey], today),
  })));
  return { fy: financialYear(today), series, backups: listBackups(), home: homeStateCode(profile) };
}

router.get('/', async (req, res) => {
  const profile = await getProfile();
  res.render('gst/profile', { title: 'Business profile · GST Invoices', form: profile, errors: {}, ...(await pageData(profile)) });
});

router.post('/', async (req, res) => {
  const before = await getProfile();
  const { values, errors } = parseProfile(req.body);
  if (Object.keys(errors).length) {
    return res.status(422).render('gst/profile', { title: 'Business profile · GST Invoices', form: { ...before, ...values }, errors, ...(await pageData(before)) });
  }
  const changes = diff(before, values, FIELDS);
  await setProfile(values);
  if (Object.keys(changes).length) await audit(actor(req), { entity: 'profile', action: 'edited', summary: `Business profile updated (${Object.keys(changes).join(', ')})`, changes });
  req.flash('success', 'Business profile saved. New documents use it; finalised ones keep what they printed.');
  res.redirect('/invoices/profile');
});

// Logo and signature: PNG or JPEG sent as the raw request body (see public/js/gst.js).
const KINDS = ['logo', 'signature'];
const isPng = (b) => b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
const isJpeg = (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;

router.post('/image/:kind', express.raw({ type: ['image/png', 'image/jpeg'], limit: '2mb' }), async (req, res) => {
  if (!KINDS.includes(req.params.kind)) return res.status(404).json({ ok: false, message: 'Unknown image.' });
  const data = Buffer.isBuffer(req.body) ? req.body : null;
  if (!data || !(isPng(data) || isJpeg(data))) return res.status(422).json({ ok: false, message: 'Upload a PNG or JPEG image (up to 2 MB).' });
  await saveImage(req.params.kind, { mime: isPng(data) ? 'image/png' : 'image/jpeg', data, name: decodeURIComponent(req.get('x-file-name') || '') }, req.user.id);
  await audit(actor(req), { entity: 'profile', action: `${req.params.kind}_uploaded`, summary: `New ${req.params.kind === 'logo' ? 'logo' : 'signature image'} uploaded` });
  res.json({ ok: true });
});

router.post('/image/:kind/remove', async (req, res, next) => {
  if (!KINDS.includes(req.params.kind)) return next();
  await setProfile({ [`${req.params.kind}_file_id`]: '' });
  await audit(actor(req), { entity: 'profile', action: `${req.params.kind}_removed`, summary: `${req.params.kind === 'logo' ? 'Logo reset to the Haptags mark' : 'Signature image removed'}` });
  req.flash('success', req.params.kind === 'logo' ? 'Logo reset to the Haptags mark.' : 'Signature image removed. Documents show a blank signature line instead.');
  res.redirect('/invoices/profile#images');
});

router.get('/image/:kind', async (req, res, next) => {
  if (!KINDS.includes(req.params.kind)) return next();
  const profile = await getProfile();
  const img = await image(req.params.kind, profile[`${req.params.kind}_file_id`]);
  if (!img) return res.status(404).end();
  res.set({ 'Content-Type': img.mime, 'Cache-Control': 'private, no-store' });
  res.send(img.data);
});

// Continue a series from a later number (e.g. after invoices issued elsewhere). Only forwards.
router.post('/numbering', async (req, res) => {
  const profile = await getProfile();
  const today = todayIST();
  const moved = [];
  for (const [kind, k] of Object.entries(C.KINDS)) {
    const n = int(req.body[`next_${kind}`], 0);
    const prefix = profile[k.prefixKey];
    if (n >= 1 && n <= 99999 && `${prefix}/${financialYear(today)}/${String(n).padStart(4, '0')}`.length <= MAX_LENGTH && await advanceSeries(prefix, today, n)) {
      moved.push(await previewNumber(prefix, today));
    }
  }
  if (moved.length) await audit(actor(req), { entity: 'profile', action: 'numbering', summary: `Number series moved forward; next: ${moved.join(', ')}` });
  req.flash(moved.length ? 'success' : 'info', moved.length ? `Next numbers: ${moved.join(', ')}.` : 'Nothing changed. A series can only move forward, never back to a number already passed.');
  res.redirect('/invoices/profile#numbering');
});

router.get('/backup', async (req, res) => {
  await audit(actor(req), { entity: 'backup', action: 'downloaded', summary: 'Full GST backup downloaded' });
  sendFile(res, { name: `haptags-gst-backup-${todayIST()}.json.gz`, type: 'gz', body: await gzipped() });
});

router.post('/backup', async (req, res) => {
  const name = await writeBackup({ force: true });
  await audit(actor(req), { entity: 'backup', action: 'written', summary: `Backup ${name} written to the server` });
  req.flash('success', `Backup ${name} saved on the server.`);
  res.redirect('/invoices/profile#backups');
});

router.get('/backups/:name', async (req, res, next) => {
  const file = backupPath(req.params.name);
  if (!file) return next();
  await audit(actor(req), { entity: 'backup', action: 'downloaded', summary: `Backup ${req.params.name} downloaded` });
  sendFile(res, { name: req.params.name, type: 'gz', body: fs.readFileSync(file) });
});

module.exports = router;
