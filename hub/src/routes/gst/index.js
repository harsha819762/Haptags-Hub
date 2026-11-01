'use strict';

// GST Invoices (/invoices): tax invoices, proformas and credit/debit notes for Haptags LLP.
// Owners and admins only (app.js mounts it behind requireAdmin), with its own clients, items,
// payments and business profile, kept apart from the rest of the Hub.

const express = require('express');
const { db } = require('../../db');
const { getProfile } = require('../../lib/gst/profile');
const format = require('../../lib/gst/format');
const C = require('../../lib/gst/constants');
const { dashboard, financialYears } = require('../../lib/gst/reports');
const { pairChart } = require('../../lib/charts');
const { periodFrom, PRESETS } = require('../../lib/period');
const { int } = require('../../lib/util');
const { back } = require('./_helpers');
const { paginate } = require('../admin/_helpers');

const router = express.Router();

router.use(async (req, res, next) => {
  // Views live in views/gst/ and use the admin layout (sidebar and top bar).
  const render = res.render.bind(res);
  res.render = (view, locals = {}) => render(view, { layout: 'admin', ...locals });
  res.locals.profile = await getProfile();
  res.locals.g = { ...format, C };
  res.locals.styles = ['gst'];
  res.locals.scripts = ['gst'];
  next();
});

/** ?fy=26-27 picks a financial year; otherwise the usual period presets or a custom range. */
function periodFor(query, fys) {
  if (fys.includes(query.fy)) {
    const y = 2000 + Number(query.fy.slice(0, 2));
    return { key: `fy-${query.fy}`, from: `${y}-04-01`, to: `${y + 1}-03-31`, label: `Financial year 20${query.fy.slice(0, 2)}–${query.fy.slice(3)}` };
  }
  return periodFrom(query, { fallback: 'fy' });
}

router.get('/', async (req, res) => {
  const fys = await financialYears();
  const period = periodFor(req.query, fys);
  const clientId = int(req.query.client, 0) || null;
  const status = C.STATUS[req.query.status] && req.query.status !== 'draft' ? req.query.status : '';
  const data = await dashboard({ from: period.from, to: period.to, clientId, status });
  const recent = await db('gst_documents').whereNull('discarded_at').modify((q) => { if (clientId) q.where('client_id', clientId); })
    .orderBy('id', 'desc').limit(8);
  res.render('gst/dashboard', {
    title: 'GST Invoices',
    period,
    presets: PRESETS,
    fys,
    filters: { client: clientId || '', status, fy: fys.includes(req.query.fy) ? req.query.fy : '' },
    clients: await db('gst_clients').orderBy('name').select('id', 'name'),
    ...data,
    chart: pairChart(data.series, { label: 'Invoiced and collected per month', names: ['Invoiced', 'Collected'] }),
    recent,
    drafts: Number((await db('gst_documents').where({ status: 'draft' }).whereNull('discarded_at').count({ n: '*' }).first()).n),
  });
});

router.use('/docs', require('./documents'));
router.use('/clients', require('./clients'));
router.use('/items', require('./items'));
router.use('/payments', require('./payments'));
router.use('/reports', require('./reports'));
router.use('/profile', require('./profile'));

router.get('/audit', async (req, res) => {
  const entity = ['document', 'payment', 'client', 'item', 'profile', 'report', 'backup'].includes(req.query.entity) ? req.query.entity : '';
  const q = db('gst_audit').orderBy('id', 'desc');
  if (entity) q.where('entity_type', entity);
  const page = await paginate(q, req, 50);
  const docIds = page.rows.filter((r) => r.entity_type === 'document').map((r) => r.entity_id);
  const docs = Object.fromEntries((docIds.length ? await db('gst_documents').whereIn('id', docIds).select('id', 'number', 'kind') : []).map((d) => [d.id, d]));
  res.render('gst/audit', { title: 'Audit log · GST Invoices', ...page, entity, docs });
});

// A GstError is a rule the user can fix: show it and go back to where they were.
router.use((err, req, res, next) => {
  if (!err.gst) return next(err);
  req.flash('error', err.message);
  res.redirect(back(req, '/invoices'));
});

module.exports = router;
