'use strict';

// Shared pieces of the quotation / invoice / receipt builder, used by the client portal and the company view.
const { db } = require('../db');
const money = require('./money');
const { financialYear, nowSql, str } = require('./util');

const DOC_TYPES = {
  quotation: { label: 'Quotation', prefix: 'QT' },
  invoice: { label: 'Invoice', prefix: 'INV' },
  receipt: { label: 'Receipt', prefix: 'RC' },
};
const PAY_METHODS = ['UPI', 'Bank transfer', 'Cash', 'Card', 'Cheque'];
const ymdOk = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(v || '') ? v : null);
const asList = (v) => (Array.isArray(v) ? v : v === undefined ? [] : [v]);
const taxMode = (gst, igst) => (Number(gst) === 0 ? 'none' : igst ? 'inter' : 'intra');

/** Next number for a document type, e.g. INV/26-27/0003. */
async function nextDocNumber(type, issueDate) {
  const base = `${DOC_TYPES[type].prefix}/${financialYear(issueDate)}/`;
  const last = await db('billing_docs').where({ type }).where('number', 'like', `${base}%`).orderBy('id', 'desc').first();
  const seq = last ? Number(last.number.slice(base.length)) + 1 : 1;
  return `${base}${String(seq).padStart(4, '0')}`;
}

/** Stored row -> everything the document view needs, with totals recomputed from the lines. */
function presentDoc(row) {
  const items = JSON.parse(row.items);
  const totals = money.computeTotals(items, { taxMode: taxMode(row.gst_rate, row.igst), gstRate: Number(row.gst_rate), discount: row.discount });
  return { ...row, totals };
}

/** The document shown in the builder's preview before anything is saved. */
function previewDoc(values, number) {
  const gst = Number(values.gst_rate) || 0;
  const totals = money.computeTotals(values.items, { taxMode: taxMode(gst, values.igst), gstRate: gst, discount: values.discount });
  return { ...values, number, gst_rate: gst, totals };
}

/** Reads the builder form. Returns the values to keep, the clean line items, the totals and any errors. */
function parseDocForm(body, today) {
  const type = DOC_TYPES[body.type] ? body.type : 'invoice';
  const descs = asList(body.item_desc);
  const qtys = asList(body.item_qty);
  const rates = asList(body.item_rate);
  const items = descs.map((d, i) => ({ description: str(d, 255) || '', quantity: Math.max(0, Number(qtys[i]) || 0), rate: money.toPaise(rates[i]) }))
    .filter((i) => i.description && i.quantity > 0);
  const gst = [0, 5, 12, 18, 28].includes(Number(body.gst_rate)) ? Number(body.gst_rate) : 0;
  const values = {
    type, issue_date: ymdOk(body.issue_date) || today, due_date: ymdOk(body.due_date),
    bill_name: str(body.bill_name, 190), bill_email: str(body.bill_email, 190), bill_phone: str(body.bill_phone, 40),
    bill_address: str(body.bill_address, 500), bill_gstin: (str(body.bill_gstin, 20) || '').toUpperCase(),
    gst_rate: gst, igst: Boolean(body.igst), discount: money.toPaise(body.discount),
    pay_method: str(body.pay_method, 40), pay_ref: str(body.pay_ref, 120), notes: str(body.notes, 1500),
  };
  const errors = {};
  if (!values.bill_name) errors.bill_name = 'Who is this for?';
  if (!items.length) errors.items = 'Add at least one item with a quantity.';
  const totals = money.computeTotals(items, { taxMode: taxMode(gst, values.igst), gstRate: gst, discount: values.discount });
  return { type, values, items, totals, errors };
}

async function saveDoc(clientId, parsed) {
  const { type, values, items, totals } = parsed;
  const number = await nextDocNumber(type, values.issue_date);
  const [id] = await db('billing_docs').insert({
    ...values, client_id: clientId, number, items: JSON.stringify(items), discount: totals.discount, total: totals.total, created_at: nowSql(),
  });
  return { id: Array.isArray(id) ? id[0] : id, number };
}

/** Closes an open invoice and creates the matching receipt. Returns the receipt's id and number. */
async function markInvoicePaid(row, { today, payMethod, payRef }) {
  const number = await nextDocNumber('receipt', today);
  const [rid] = await db('billing_docs').insert({
    client_id: row.client_id, type: 'receipt', number, issue_date: today, bill_name: row.bill_name, bill_email: row.bill_email, bill_phone: row.bill_phone,
    bill_address: row.bill_address, bill_gstin: row.bill_gstin, items: row.items, gst_rate: row.gst_rate, igst: row.igst, discount: row.discount, total: row.total,
    pay_method: str(payMethod, 40) || 'UPI', pay_ref: str(payRef, 120), notes: `Receipt for invoice ${row.number}`, status: 'paid', source_id: row.id, created_at: nowSql(),
  });
  await db('billing_docs').where({ id: row.id }).update({ status: 'paid' });
  return { id: Array.isArray(rid) ? rid[0] : rid, number };
}

module.exports = { DOC_TYPES, PAY_METHODS, ymdOk, nextDocNumber, presentDoc, previewDoc, parseDocForm, saveDoc, markInvoicePaid };
