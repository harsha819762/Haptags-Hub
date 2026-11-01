'use strict';

const fs = require('fs');
const path = require('path');
const { db } = require('../../db');
const { nowSql } = require('../util');
const { stateName } = require('./constants');

// Defaults are from the GST registration certificate (REG-06, issued 28/10/2026); all editable
// on the Business Profile page. Kept apart from the Hub's own settings on purpose.
const DEFAULTS = {
  legal_name: 'HAPTAGS LLP',
  trade_name: 'Haptags LLP',
  constitution: 'Limited Liability Partnership',
  gstin: '29AASFH7857G1ZK',
  pan: 'AASFH7857G',
  gst_registration_date: '2026-10-28',
  llpin: 'ACS-0435',
  address: 'Site No 1-2, Katha No 24/1/1-2, Mahadevapura\nBangalore North, Bengaluru Urban',
  city: 'Bengaluru',
  pincode: '560048',
  state_code: '29',
  email: 'info@haptags.com',
  phone: '+91 99868 61402',
  website: 'https://www.haptags.com',

  bank_account_name: 'HAPTAGS LLP',
  bank_account_number: '',
  bank_ifsc: '',
  bank_name: '',
  bank_branch: '',
  bank_swift: '',
  upi_id: '',
  upi_name: 'HAPTAGS LLP',

  lut_number: '',
  lut_valid_from: '',
  lut_valid_until: '',

  signatory_name: '',
  signatory_designation: 'Authorised Signatory',
  logo_file_id: '',
  signature_file_id: '',

  invoice_prefix: 'HT',
  proforma_prefix: 'PF',
  credit_prefix: 'CN',
  debit_prefix: 'DN',
  default_gst_rate: '18',
  default_payment_terms: 'Net 15',
  proforma_valid_days: '15',
  default_terms: '1. Please quote the invoice number with your payment.\n2. If you deduct TDS, please share the TDS certificate (Form 16A) each quarter.\n3. Subject to Bengaluru jurisdiction.',

  backup_last_run: '',
};

const DEFAULT_LOGO = path.join(__dirname, '..', '..', '..', 'public', 'img', 'haptags-mark.png');

let cache = null;

async function load() {
  const rows = await db('gst_profile').select('key', 'value');
  cache = { ...DEFAULTS, ...Object.fromEntries(rows.map((r) => [r.key, r.value])) };
  return cache;
}

/** Cached, so it is safe to read inside a transaction (SQLite has one pooled connection). */
async function getProfile() {
  return cache || load();
}

async function setProfile(values) {
  const entries = Object.entries(values).filter(([k]) => k in DEFAULTS);
  await db.transaction(async (trx) => {
    for (const [key, value] of entries) {
      const v = value === null || value === undefined ? '' : String(value);
      const updated = await trx('gst_profile').where({ key }).update({ value: v });
      if (!updated) await trx('gst_profile').insert({ key, value: v });
    }
  });
  return load();
}

/** Our state code: from the GSTIN when there is one, so CGST/SGST vs IGST always matches it. */
const homeStateCode = (p) => (/^\d{2}/.test(p.gstin || '') ? p.gstin.slice(0, 2) : p.state_code);

/** What a finalised document keeps of the profile, so later edits never change old invoices. */
function supplierSnapshot(p) {
  const keys = ['legal_name', 'trade_name', 'gstin', 'pan', 'llpin', 'address', 'city', 'pincode', 'email', 'phone', 'website',
    'bank_account_name', 'bank_account_number', 'bank_ifsc', 'bank_name', 'bank_branch', 'bank_swift', 'upi_id', 'upi_name',
    'signatory_name', 'signatory_designation', 'logo_file_id', 'signature_file_id'];
  const snap = Object.fromEntries(keys.map((k) => [k, p[k] || '']));
  snap.state_code = homeStateCode(p);
  snap.state_name = stateName(snap.state_code) || '';
  return snap;
}

/** Logo or signature image as { mime, data }, or null. The logo falls back to the brand mark. */
async function image(kind, fileId) {
  if (fileId) {
    const f = await db('files').where({ id: Number(fileId) }).first();
    if (f) return { mime: f.mime, data: Buffer.from(f.data) };
  }
  if (kind === 'logo' && fs.existsSync(DEFAULT_LOGO)) return { mime: 'image/png', data: fs.readFileSync(DEFAULT_LOGO) };
  return null;
}

let signatureCache = { id: null, uri: null };

/**
 * The authorised signature as a data: URI, for the Hub's own invoice pages. Inline, so the client
 * link (/i/…) shows it without the signature having a public URL of its own. Cached per file.
 */
async function signatureDataUri() {
  const p = await getProfile();
  const id = p.signature_file_id || '';
  if (signatureCache.id !== id) {
    const img = id ? await image('signature', id) : null;
    signatureCache = { id, uri: img ? `data:${img.mime};base64,${img.data.toString('base64')}` : null };
  }
  return signatureCache.uri;
}

/** Stores an uploaded logo/signature. The old file is kept, because finalised documents print it. */
async function saveImage(kind, { mime, data, name }, userId) {
  const [id] = await db('files').insert({
    name: String(name || `${kind}.png`).slice(0, 255), mime, size: data.length, data, uploaded_by: userId || null, created_at: nowSql(),
  });
  const fileId = typeof id === 'object' ? id.id : id;
  await setProfile({ [`${kind}_file_id`]: String(fileId) });
  return fileId;
}

module.exports = { DEFAULTS, getProfile, setProfile, homeStateCode, supplierSnapshot, image, saveImage, signatureDataUri, reloadProfile: load };
