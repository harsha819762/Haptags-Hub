'use strict';

const express = require('express');
const { db } = require('../../db');
const C = require('../../lib/gst/constants');
const { toMinor } = require('../../lib/gst/format');
const { actor, audit, diff } = require('../../lib/gst/audit');
const { nowSql, str } = require('../../lib/util');
const { idParam } = require('./_helpers');

const router = express.Router();

const FIELDS = ['name', 'description', 'sac', 'unit', 'rate', 'gst_rate'];

function parseItem(body) {
  const errors = {};
  const gstRate = Number(body.gst_rate);
  const item = {
    name: str(body.name, 190),
    description: str(body.description, 500),
    sac: String(body.sac || '').replace(/\D/g, '').slice(0, 8),
    unit: str(body.unit, 20) || 'Nos',
    rate: toMinor(body.rate),
    gst_rate: C.GST_RATES.includes(gstRate) ? gstRate : 18,
  };
  if (!item.name) errors.name = 'Name the service.';
  if (!/^\d{4,8}$/.test(item.sac)) errors.sac = 'Enter the SAC (services) or HSN (goods) code: 4 to 8 digits, e.g. 998314.';
  if (item.rate < 0) errors.rate = 'The rate can’t be negative.';
  return { item, errors };
}

router.get('/', async (req, res) => {
  const items = await db('gst_items').orderBy('is_active', 'desc').orderBy('sort').orderBy('name');
  res.render('gst/items/index', { title: 'Services · GST Invoices', items });
});

router.get('/new', (req, res) => {
  res.render('gst/items/form', { title: 'New service · GST Invoices', item: { unit: 'Nos', gst_rate: Number(res.locals.profile.default_gst_rate) || 18 }, errors: {} });
});

router.post('/', async (req, res) => {
  const { item, errors } = parseItem(req.body);
  if (Object.keys(errors).length) return res.status(422).render('gst/items/form', { title: 'New service · GST Invoices', item, errors });
  const max = await db('gst_items').max({ s: 'sort' }).first();
  await db.transaction(async (trx) => {
    let [id] = await trx('gst_items').insert({ ...item, is_active: true, sort: Number(max.s || 0) + 1, created_at: nowSql(), updated_at: nowSql() });
    if (typeof id === 'object') id = id.id;
    await audit(actor(req), { entity: 'item', id, action: 'created', summary: `Service ${item.name} (SAC ${item.sac}, ${item.gst_rate}%) added` }, trx);
  });
  req.flash('success', `${item.name} added to the catalog.`);
  res.redirect('/team/gst/items');
});

router.get('/:id/edit', async (req, res, next) => {
  const item = await db('gst_items').where({ id: idParam(req) }).first();
  if (!item) return next();
  res.render('gst/items/form', { title: `Edit ${item.name} · GST Invoices`, item: { ...item, gst_rate: Number(item.gst_rate) }, errors: {} });
});

router.post('/:id', async (req, res, next) => {
  const current = await db('gst_items').where({ id: idParam(req) }).first();
  if (!current) return next();
  const { item, errors } = parseItem(req.body);
  if (Object.keys(errors).length) return res.status(422).render('gst/items/form', { title: `Edit ${current.name} · GST Invoices`, item: { ...item, id: current.id }, errors });
  await db.transaction(async (trx) => {
    await trx('gst_items').where({ id: current.id }).update({ ...item, updated_at: nowSql() });
    await audit(actor(req), { entity: 'item', id: current.id, action: 'edited', summary: `Service ${item.name} updated`, changes: diff({ ...current, gst_rate: Number(current.gst_rate) }, item, FIELDS) }, trx);
  });
  req.flash('success', 'Service saved. Documents already written keep their own lines.');
  res.redirect('/team/gst/items');
});

router.post('/:id/active', async (req, res, next) => {
  const item = await db('gst_items').where({ id: idParam(req) }).first();
  if (!item) return next();
  const active = req.body.active === '1';
  await db('gst_items').where({ id: item.id }).update({ is_active: active, updated_at: nowSql() });
  await audit(actor(req), { entity: 'item', id: item.id, action: active ? 'reactivated' : 'deactivated', summary: `Service ${item.name} ${active ? 'shown again' : 'hidden'}` });
  res.redirect('/team/gst/items');
});

module.exports = router;
