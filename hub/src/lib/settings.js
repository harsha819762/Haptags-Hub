'use strict';

const { db } = require('../db');
const { randomToken } = require('./util');

// Defaults come from haptags.com; everything is editable under Settings.
const DEFAULTS = {
  company_name: 'Haptags',
  legal_name: 'Haptags LLP',
  tagline: 'Build. Automate. Scale.',
  address: 'Near Maheshwarramma Temple Road, Mahadevapura',
  city: 'Bengaluru',
  state: 'Karnataka',
  pincode: '560048',
  gstin: '',
  pan: '',
  llpin: 'ACS-0435',
  udyam: 'UDYAM-KR-03-0633150',
  email: 'info@haptags.com',
  phone: '+91 99868 61402',
  website: 'https://www.haptags.com',
  whatsapp: '919986861402',

  invoice_prefix: 'HT',
  quote_prefix: 'HTQ',
  default_due_days: '7',
  quote_valid_days: '15',
  default_gst_rate: '18',
  default_sac: '998314',
  invoice_terms: 'Payment due by the date shown. Please quote the invoice number with your payment.\nTDS, if deducted, should be reported with the challan details.',
  quote_terms: '50% advance to start, balance on delivery.\nPrices are valid until the date shown.\nHosting, domains and third-party licences are billed at actuals unless listed.',

  upi_id: '',
  upi_name: 'Haptags LLP',
  bank_name: '',
  bank_account_name: 'Haptags LLP',
  bank_account_number: '',
  bank_ifsc: '',
  bank_branch: '',

  // Student & internship invoices: their own number series, SAC and terms.
  edu_invoice_prefix: 'HTE',
  edu_sac: '999293',
  edu_gst_rate: '18',
  edu_due_days: '7',
  edu_terms: 'Fees once paid are non-refundable after the program starts.\nPlease quote the invoice number with your payment.',

  // Internship offer letters (Education → Offer letters). Terms: one per paragraph, "Heading: text".
  offer_prefix: 'HTOL',
  offer_signatory_name: '',
  offer_signatory_designation: 'Chief Executive Officer',
  offer_reporting_to: '',
  offer_reporting_designation: '',
  offer_mode: 'onsite',
  offer_location: 'Haptags LLP, Mahadevapura, Bengaluru',
  offer_schedule: 'Monday to Saturday, 10:00 am to 6:00 pm',
  offer_respond_days: '7',
  offer_terms: [
    'Nature of the internship: This internship is for learning and practical training. It is not an offer of employment and does not create an employer–employee relationship. Any offer of employment would be made separately, in writing.',
    'Attendance and leave: You are expected to attend on all working days and to maintain at least 80% attendance. Please inform your reporting manager in advance of any leave.',
    'Conduct: You will follow the Company’s policies and instructions, behave professionally and respectfully with colleagues and clients, and help keep the workplace free of harassment and discrimination.',
    'Confidentiality: You will keep confidential all non-public information you come across during the internship, including client data, source code, designs, passwords and business plans, both during and after the internship. You will not share it on social media, in personal repositories or with anyone outside the Company without written permission.',
    'Intellectual property: All work you create during the internship, including code, designs, content and documents, belongs to the Company. You may describe your role and the skills you gained in your résumé or portfolio, but you may not share confidential material.',
    'Systems and equipment: You will use Company accounts, systems and equipment only for internship work, and return all access and equipment on or before your last day.',
    'Stipend and fees: Any stipend is paid monthly for the days you attend and is subject to applicable tax. Programme fees, where applicable, are payable as per your fee invoice and are non-refundable once the internship has started.',
    'Certificate: When you complete the internship successfully, meeting the attendance requirement and completing your assigned work and final evaluation, you will receive a certificate of completion from the Company.',
    'Ending the internship: Either party may end the internship with seven days’ written notice. The Company may end it immediately for misconduct, a breach of confidentiality, or unexplained absence of more than three consecutive working days; a completion certificate may then not be issued.',
    'Documents: Before you join, please share a copy of your college ID card and a government-issued photo ID, and a no-objection certificate from your college if your college requires one.',
    'Governing law: This letter is governed by the laws of India, and the courts at Bengaluru have jurisdiction.',
  ].join('\n\n'),

  auto_reminders: '1',
  lead_auto_reply: '1',
  lead_api_key: '',
  automation_last_run: '',
  holidays_synced_at: '',
};

// The cache is loaded at startup and reloaded after every write, so getSettings() never has to
// query inside someone else's transaction (SQLite has a single pooled connection).
let cache = null;

async function load() {
  const rows = await db('settings').select('key', 'value');
  cache = { ...DEFAULTS, ...Object.fromEntries(rows.map((r) => [r.key, r.value])) };
  return cache;
}

async function getSettings() {
  if (cache) return cache;
  await load();
  if (!cache.lead_api_key) await setSettings({ lead_api_key: `hl_${randomToken(20)}` });
  return cache;
}

async function setSettings(values) {
  const entries = Object.entries(values).filter(([k]) => k in DEFAULTS);
  await db.transaction(async (trx) => {
    for (const [key, value] of entries) {
      const v = value === null || value === undefined ? '' : String(value);
      const existing = await trx('settings').where({ key }).first();
      if (existing) await trx('settings').where({ key }).update({ value: v });
      else await trx('settings').insert({ key, value: v });
    }
  });
  await load();
}

module.exports = { getSettings, setSettings, DEFAULTS };
