'use strict';

const { db } = require('../../db');
const { nowSql, todayIST, isDate, str } = require('../util');
const C = require('./constants');
const { GstError } = require('./numbering');
const { refreshSettlement, isFinal } = require('./documents');
const { audit } = require('./audit');
const { money, toMinor } = require('./format');

/** Reads the payment form. TDS can be typed, or picked as a preset (section + rate). */
function parsePayment(body, invoice) {
  const amount = toMinor(body.amount);
  const preset = C.TDS_PRESETS.find((p) => `${p[0]}-${p[1]}` === body.tds_preset);
  let tds = toMinor(body.tds);
  if (preset && !String(body.tds || '').trim()) tds = Math.round((Number(invoice.taxable) * preset[1]) / 100);
  const fx = Number(invoice.exchange_rate) || 1;
  const inrTyped = toMinor(body.inr_amount);
  return {
    amount,
    tds,
    tds_section: preset ? preset[0] : str(body.tds_section, 10),
    tds_rate: preset ? preset[1] : null,
    inr_amount: invoice.currency === 'INR' ? amount : inrTyped || Math.round(amount * fx),
    paid_on: isDate(body.paid_on) ? body.paid_on : todayIST(),
    mode: C.PAYMENT_MODES.some((m) => m[0] === body.mode) ? body.mode : 'other',
    reference: str(body.reference, 190),
    notes: str(body.notes, 1000),
  };
}

async function recordPayment(invoiceId, body, who) {
  const inv = await db('gst_documents').where({ id: invoiceId }).first();
  if (!inv || inv.kind !== 'invoice' || !isFinal(inv)) throw new GstError('Payments are recorded against finalised tax invoices.');
  if (inv.status === 'cancelled') throw new GstError(`${inv.number} is cancelled.`);
  const p = parsePayment(body, inv);
  if (p.amount < 0 || p.tds < 0 || p.amount + p.tds <= 0) throw new GstError('Enter the amount received (and any TDS deducted).');
  if (p.amount + p.tds > Number(inv.balance)) {
    throw new GstError(`That is more than the balance of ${money(inv.balance, inv.currency)}. Record only what settles this invoice.`);
  }
  if (p.paid_on > todayIST()) throw new GstError('The payment date can’t be in the future.');
  return db.transaction(async (trx) => {
    let [id] = await trx('gst_payments').insert({ document_id: inv.id, ...p, status: 'active', created_by: who.id, created_at: nowSql() });
    if (typeof id === 'object') id = id.id;
    const updated = await refreshSettlement(trx, inv.id);
    const mode = C.modeLabel(p.mode);
    await audit(who, {
      entity: 'payment',
      id,
      action: 'recorded',
      summary: `${money(p.amount, inv.currency)} received on ${p.paid_on} via ${mode}${p.reference ? ` (ref ${p.reference})` : ''}${p.tds ? ` + TDS ${money(p.tds, inv.currency)}${p.tds_section ? ` u/s ${p.tds_section}` : ''}` : ''} for ${inv.number}. Balance ${money(updated.balance, inv.currency)}.`,
    }, trx);
    return { id, invoice: updated };
  });
}

/** Payments are never deleted: a mistaken one is reversed, and stays on record. */
async function reversePayment(paymentId, reason, who) {
  const p = await db('gst_payments').where({ id: paymentId }).first();
  if (!p || p.status !== 'active') throw new GstError('That payment is already reversed.');
  if (!reason) throw new GstError('Give a reason for reversing the payment.');
  const inv = await db('gst_documents').where({ id: p.document_id }).first();
  await db.transaction(async (trx) => {
    await trx('gst_payments').where({ id: p.id }).update({ status: 'reversed', reversed_at: nowSql(), reversed_by: who.id, reverse_reason: reason });
    await refreshSettlement(trx, p.document_id);
    await audit(who, { entity: 'payment', id: p.id, action: 'reversed', summary: `Payment of ${money(p.amount, inv.currency)} on ${inv.number} reversed: ${reason}` }, trx);
  });
  return inv;
}

module.exports = { recordPayment, reversePayment, parsePayment };
