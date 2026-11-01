'use strict';

const { CURRENCIES, STATUS, KINDS, SUPPLY_TYPES } = require('./constants');
const { todayIST } = require('../util');

const formatters = {};
function formatter(currency, symbol) {
  const key = `${currency}:${symbol}`;
  if (!formatters[key]) {
    const c = CURRENCIES[currency] || CURRENCIES.INR;
    formatters[key] = new Intl.NumberFormat(c.locale, symbol
      ? { style: 'currency', currency, minimumFractionDigits: 2 }
      : { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  return formatters[key];
}

/** 12000000 → '₹1,20,000.00' (INR groups in lakhs; other currencies in thousands). */
const money = (minor, currency = 'INR') => formatter(currency, true).format((Number(minor) || 0) / 100);
/** The same without the symbol, for table cells. */
const amount = (minor, currency = 'INR') => formatter(currency, false).format((Number(minor) || 0) / 100);
/** For form inputs: '120000' or '1250.5'. */
const inputValue = (minor) => (minor ? (Number(minor) / 100).toFixed(2).replace(/\.00$/, '') : '');

/** '1,25,000.50' or '$1,250' → minor units. Blank or invalid → 0. */
function toMinor(value) {
  if (value === undefined || value === null || value === '') return 0;
  const n = Number(String(value).replace(/[₹$€£,\s]/g, ''));
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

/** Overdue isn't stored: an unpaid invoice past its due date shows as overdue. */
function displayStatus(doc, today = todayIST()) {
  if (doc.kind === 'invoice' && ['unpaid', 'partially_paid'].includes(doc.status) && doc.due_date && doc.due_date < today) return 'overdue';
  return doc.status;
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function badge(status) {
  const [label, tone] = STATUS[status] || [status, 'grey'];
  return `<span class="badge tone-${tone}">${esc(label)}</span>`;
}

const qty = (q) => String(Number(q)).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
const docTitle = (doc) => (doc.kind === 'invoice' && doc.supply_type === 'export' ? 'EXPORT INVOICE' : KINDS[doc.kind].title);
const docLabel = (doc) => (doc.number || `Draft ${KINDS[doc.kind].short.toLowerCase()} #${doc.id}`);

module.exports = {
  money, amount, inputValue, toMinor, displayStatus, badge, qty, docTitle, docLabel,
  statusLabel: (s) => (STATUS[s] || [s])[0],
  supplyLabel: (t) => SUPPLY_TYPES[t] || t,
  kindLabel: (k) => (KINDS[k] || {}).label || k,
};
