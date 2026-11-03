'use strict';

const express = require('express');
const { db } = require('../../db');
const C = require('../../lib/gst/constants');
const { reversePayment } = require('../../lib/gst/payments');
const { actor } = require('../../lib/gst/audit');
const { str, isDate } = require('../../lib/util');
const { paginate } = require('../admin/_helpers');
const { idParam } = require('./_helpers');

const router = express.Router();

router.get('/', async (req, res) => {
  const from = isDate(req.query.from) ? req.query.from : null;
  const to = isDate(req.query.to) ? req.query.to : null;
  const mode = C.PAYMENT_MODES.some((m) => m[0] === req.query.mode) ? req.query.mode : '';
  const q = str(req.query.q, 100);
  const query = db('gst_payments as p').join('gst_documents as d', 'd.id', 'p.document_id').leftJoin('users as u', 'u.id', 'p.created_by')
    .select('p.*', 'd.number', 'd.bill_name', 'd.client_id', 'd.currency', 'd.exchange_rate', 'u.name as created_by_name')
    .orderBy('p.paid_on', 'desc').orderBy('p.id', 'desc');
  if (from) query.where('p.paid_on', '>=', from);
  if (to) query.where('p.paid_on', '<=', to);
  if (mode) query.where('p.mode', mode);
  if (q) query.where((w) => w.where('d.number', 'like', `%${q}%`).orWhere('d.bill_name', 'like', `%${q}%`).orWhere('p.reference', 'like', `%${q}%`));
  const totalsQ = db('gst_payments as p').join('gst_documents as d', 'd.id', 'p.document_id').where('p.status', 'active');
  if (from) totalsQ.where('p.paid_on', '>=', from);
  if (to) totalsQ.where('p.paid_on', '<=', to);
  if (mode) totalsQ.where('p.mode', mode);
  const totals = await totalsQ.sum({ inr: 'p.inr_amount' }).count({ n: '*' }).first();
  res.render('gst/payments/index', {
    title: 'Payments · GST Invoices', ...(await paginate(query, req, 50)), from, to, mode, q,
    totals: { inr: Number(totals.inr || 0), n: Number(totals.n || 0) },
  });
});

router.post('/:id/reverse', async (req, res, next) => {
  const p = await db('gst_payments').where({ id: idParam(req) }).first();
  if (!p) return next();
  await reversePayment(p.id, str(req.body.reason, 255), actor(req));
  req.flash('success', 'Payment reversed. It stays on record, and the invoice balance is updated.');
  res.redirect(`/team/gst/docs/${p.document_id}#payments`);
});

module.exports = router;
