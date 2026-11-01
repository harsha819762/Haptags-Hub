'use strict';

const { STATES } = require('../constants');

// Recipient states: the GST state codes, plus 97 for "Other Territory" (offshore areas).
const GST_STATES = [...STATES, ['97', 'Other Territory']].sort((a, b) => a[0].localeCompare(b[0]));
// Place of supply adds 96, which GST returns use for supplies outside India (exports).
const EXPORT_POS = ['96', 'Other Countries'];
const POS_OPTIONS = [...GST_STATES, EXPORT_POS];

const stateName = (code) => (POS_OPTIONS.find((s) => s[0] === code) || [])[1] || null;

// The 2025 rate changes added a 40% slab; 12% and 28% stay for older items and corrections.
const GST_RATES = [0, 5, 12, 18, 28, 40];

const KINDS = {
  invoice: { label: 'Tax invoice', plural: 'Tax invoices', prefixKey: 'invoice_prefix', title: 'TAX INVOICE', short: 'Invoice' },
  proforma: { label: 'Proforma invoice', plural: 'Proforma invoices', prefixKey: 'proforma_prefix', title: 'PROFORMA INVOICE', short: 'Proforma' },
  credit_note: { label: 'Credit note', plural: 'Credit notes', prefixKey: 'credit_prefix', title: 'CREDIT NOTE', short: 'Credit note' },
  debit_note: { label: 'Debit note', plural: 'Debit notes', prefixKey: 'debit_prefix', title: 'DEBIT NOTE', short: 'Debit note' },
};
const NOTE_KINDS = ['credit_note', 'debit_note'];

const CLIENT_TYPES = [
  ['b2b', 'Registered business (B2B)'],
  ['b2c', 'Unregistered (B2C)'],
  ['export', 'Overseas (export)'],
];

const SUPPLY_TYPES = {
  intra: 'Intra-state · CGST + SGST',
  inter: 'Inter-state · IGST',
  export: 'Export of services · 0% IGST under LUT',
};

// Two decimals for all of them, so amounts are stored in minor units (paise, cents, pence).
const CURRENCIES = {
  INR: { symbol: '₹', major: 'Rupees', minor: 'Paise', locale: 'en-IN' },
  USD: { symbol: '$', major: 'US Dollars', minor: 'Cents', locale: 'en-US' },
  EUR: { symbol: '€', major: 'Euros', minor: 'Cents', locale: 'en-IE' },
  GBP: { symbol: '£', major: 'Pounds Sterling', minor: 'Pence', locale: 'en-GB' },
};

const PAYMENT_MODES = [
  ['upi', 'UPI'], ['neft', 'NEFT'], ['rtgs', 'RTGS'], ['imps', 'IMPS'], ['cheque', 'Cheque'], ['cash', 'Cash'],
  ['wire', 'International wire'], ['card', 'Card / payment gateway'], ['other', 'Other'],
];

// TDS presets: the client deducts on the taxable value (GST excluded, CBDT circular 23/2017).
const TDS_PRESETS = [
  ['194J', 10, '194J @ 10% (professional services)'],
  ['194J', 2, '194J @ 2% (technical services)'],
  ['194C', 2, '194C @ 2% (contract work)'],
  ['194C', 1, '194C @ 1% (contract work, individual/HUF)'],
];

const PAYMENT_TERMS = [['Due on receipt', 0], ['Net 7', 7], ['Net 15', 15], ['Net 30', 30], ['Net 45', 45], ['Net 60', 60]];

const STATUS = {
  draft: ['Draft', 'grey'],
  unpaid: ['Unpaid', 'blue'],
  partially_paid: ['Partially paid', 'amber'],
  paid: ['Paid', 'green'],
  overdue: ['Overdue', 'red'],
  issued: ['Issued', 'blue'],
  converted: ['Converted', 'green'],
  cancelled: ['Cancelled', 'grey'],
};

// Inter-state B2C invoices above this go to GSTR-1 table B2CL (₹1 lakh from 1 Aug 2024).
const B2CL_LIMIT = 10000000;

// Countries for export clients, with ISO codes for e-invoices.
const COUNTRIES = [
  ['India', 'IN'], ['United States', 'US'], ['United Kingdom', 'GB'], ['United Arab Emirates', 'AE'], ['Canada', 'CA'],
  ['Australia', 'AU'], ['Singapore', 'SG'], ['Germany', 'DE'], ['France', 'FR'], ['Netherlands', 'NL'], ['Ireland', 'IE'],
  ['Switzerland', 'CH'], ['Sweden', 'SE'], ['Norway', 'NO'], ['Denmark', 'DK'], ['Finland', 'FI'], ['Belgium', 'BE'],
  ['Spain', 'ES'], ['Italy', 'IT'], ['Portugal', 'PT'], ['Austria', 'AT'], ['Poland', 'PL'], ['New Zealand', 'NZ'],
  ['Saudi Arabia', 'SA'], ['Qatar', 'QA'], ['Oman', 'OM'], ['Kuwait', 'KW'], ['Bahrain', 'BH'], ['Israel', 'IL'],
  ['Japan', 'JP'], ['South Korea', 'KR'], ['China', 'CN'], ['Hong Kong', 'HK'], ['Malaysia', 'MY'], ['Thailand', 'TH'],
  ['Indonesia', 'ID'], ['Philippines', 'PH'], ['Vietnam', 'VN'], ['Sri Lanka', 'LK'], ['Bangladesh', 'BD'], ['Nepal', 'NP'],
  ['South Africa', 'ZA'], ['Kenya', 'KE'], ['Nigeria', 'NG'], ['Egypt', 'EG'], ['Mauritius', 'MU'], ['Brazil', 'BR'],
  ['Mexico', 'MX'], ['Turkey', 'TR'],
];
const countryCode = (name) => (COUNTRIES.find((c) => c[0].toLowerCase() === String(name || '').trim().toLowerCase()) || [])[1] || null;
const isIndia = (country) => !country || String(country).trim().toLowerCase() === 'india';

module.exports = {
  GST_STATES, EXPORT_POS, POS_OPTIONS, GST_RATES, KINDS, NOTE_KINDS, CLIENT_TYPES, SUPPLY_TYPES, CURRENCIES, PAYMENT_MODES,
  TDS_PRESETS, PAYMENT_TERMS, STATUS, B2CL_LIMIT, COUNTRIES, stateName, countryCode, isIndia,
  modeLabel: (v) => (PAYMENT_MODES.find((m) => m[0] === v) || [null, v])[1],
  clientTypeLabel: (v) => (CLIENT_TYPES.find((m) => m[0] === v) || [null, v])[1],
};
