'use strict';

const express = require('express');
const { db } = require('../../db');
const C = require('../../lib/gst/constants');
const { parseGstin, isPan } = require('../../lib/gst/gstin');
const { actor, audit, diff, trail } = require('../../lib/gst/audit');
const { OPEN, toInr } = require('../../lib/gst/reports');
const { nowSql, str, isEmail } = require('../../lib/util');
const { paginate } = require('../admin/_helpers');
const { idParam } = require('./_helpers');

const router = express.Router();

const FIELDS = ['name', 'client_type', 'contact_person', 'email', 'phone', 'address', 'city', 'pincode', 'country', 'state_code', 'state_name', 'gstin', 'pan', 'notes'];

/** Validates the client form. A GSTIN decides the state (its first two digits) and the PAN. */
async function parseClient(body, exceptId = 0) {
  const errors = {};
  const type = C.CLIENT_TYPES.some((t) => t[0] === body.client_type) ? body.client_type : 'b2b';
  const c = {
    name: str(body.name, 190),
    client_type: type,
    contact_person: str(body.contact_person, 190),
    email: str(body.email, 190),
    phone: str(body.phone, 40),
    address: str(body.address, 1000),
    city: str(body.city, 100),
    pincode: str(body.pincode, 12),
    country: type === 'export' ? str(body.country, 80) : 'India',
    state_code: type === 'export' ? '96' : (C.GST_STATES.find((s) => s[0] === body.state_code) || [])[0] || null,
    gstin: str(body.gstin, 20) ? String(body.gstin).toUpperCase().replace(/\s+/g, '') : null,
    pan: str(body.pan, 10) ? String(body.pan).toUpperCase().trim() : null,
    notes: str(body.notes, 2000),
  };
  if (!c.name) errors.name = 'Enter the client’s legal name.';
  if (c.email && !isEmail(c.email)) errors.email = 'Enter a valid email address.';
  if (type === 'export') {
    if (!c.country || C.isIndia(c.country)) errors.country = 'Choose the client’s country (outside India).';
    c.gstin = null;
  }
  if (type === 'b2b') {
    const g = parseGstin(c.gstin);
    if (!g.ok) errors.gstin = c.gstin ? g.error : 'A registered business needs its GSTIN.';
    else {
      c.gstin = g.gstin;
      c.state_code = g.stateCode; // the GSTIN decides the state
      if (!c.pan && g.pan) c.pan = g.pan;
      const dup = await db('gst_clients').where({ gstin: g.gstin }).whereNot('id', exceptId).first();
      if (dup) errors.gstin = `${dup.name} already has this GSTIN.`;
    }
  }
  if (type === 'b2c' && c.gstin) errors.gstin = 'A client with a GSTIN is a registered business: choose B2B.';
  if (type !== 'export' && !c.state_code) errors.state_code = 'Choose the state (it sets CGST + SGST or IGST).';
  if (c.pan && !isPan(c.pan)) errors.pan = 'A PAN is 5 letters, 4 digits and a letter, e.g. AASFH7857G.';
  c.state_name = C.stateName(c.state_code);
  return { client: c, errors };
}

router.get('/', async (req, res) => {
  const q = str(req.query.q, 100);
  const type = C.CLIENT_TYPES.some((t) => t[0] === req.query.type) ? req.query.type : '';
  const showInactive = req.query.inactive === '1';
  const query = db('gst_clients').orderBy('name');
  if (!showInactive) query.where({ is_active: true });
  if (type) query.where({ client_type: type });
  if (q) query.where((w) => w.where('name', 'like', `%${q}%`).orWhere('gstin', 'like', `%${q}%`).orWhere('email', 'like', `%${q}%`).orWhere('contact_person', 'like', `%${q}%`).orWhere('phone', 'like', `%${q}%`));
  const page = await paginate(query, req, 50);
  const hubCount = Number((await db('clients').where({ status: 'active', segment: 'business' })
    .whereNotIn('id', db('gst_clients').whereNotNull('hub_client_id').select('hub_client_id')).count({ n: '*' }).first()).n);
  res.render('gst/clients/index', { title: 'Clients · GST Invoices', ...page, q, type, showInactive, hubCount });
});

router.get('/new', (req, res) => {
  res.render('gst/clients/form', { title: 'New client · GST Invoices', client: { client_type: 'b2b', country: 'India' }, errors: {} });
});

router.post('/', async (req, res) => {
  const { client, errors } = await parseClient(req.body);
  if (Object.keys(errors).length) return res.status(422).render('gst/clients/form', { title: 'New client · GST Invoices', client, errors });
  const who = actor(req);
  const id = await db.transaction(async (trx) => {
    let [newId] = await trx('gst_clients').insert({ ...client, is_active: true, created_by: who.id, created_at: nowSql(), updated_at: nowSql() });
    if (typeof newId === 'object') newId = newId.id;
    await audit(who, { entity: 'client', id: newId, action: 'created', summary: `Client ${client.name} added (${client.client_type.toUpperCase()}${client.gstin ? `, ${client.gstin}` : ''})` }, trx);
    return newId;
  });
  req.flash('success', `${client.name} added.`);
  res.redirect(req.body.then === 'invoice' ? `/invoices/docs/new?kind=invoice&client_id=${id}` : `/invoices/clients/${id}`);
});

// Copies the Hub's active business clients that aren't here yet. They start as B2B when they
// have a valid GSTIN, otherwise B2C (or export outside India); check each before invoicing.
router.post('/import-hub', async (req, res) => {
  const who = actor(req);
  const taken = await db('gst_clients').whereNotNull('hub_client_id').pluck('hub_client_id');
  const hub = await db('clients').where({ status: 'active', segment: 'business' }).whereNotIn('id', taken.length ? taken : [0]);
  let added = 0;
  await db.transaction(async (trx) => {
    for (const h of hub) {
      const g = parseGstin(h.gstin);
      const abroad = !C.isIndia(h.country);
      const state = g.ok ? g.stateCode : (C.GST_STATES.find((s) => h.state && s[1].toLowerCase() === String(h.state).toLowerCase()) || [])[0] || null;
      const dup = g.ok && await trx('gst_clients').where({ gstin: g.gstin }).first();
      if (dup) continue;
      const type = abroad ? 'export' : g.ok ? 'b2b' : 'b2c';
      let [id] = await trx('gst_clients').insert({
        name: h.name, client_type: type, contact_person: h.contact_name, email: h.email, phone: h.phone, address: h.address, city: h.city,
        pincode: h.pincode, country: abroad ? h.country : 'India', state_code: abroad ? '96' : state, state_name: C.stateName(abroad ? '96' : state),
        gstin: g.ok ? g.gstin : null, pan: g.ok ? g.pan : null, hub_client_id: h.id, is_active: true, created_by: who.id, created_at: nowSql(), updated_at: nowSql(),
      });
      if (typeof id === 'object') id = id.id;
      await audit(who, { entity: 'client', id, action: 'imported', summary: `Client ${h.name} copied from the Hub (${type.toUpperCase()})` }, trx);
      added += 1;
    }
  });
  req.flash('success', added ? `Copied ${added} client${added === 1 ? '' : 's'} from the Hub. Check each one’s type, state and GSTIN before invoicing.` : 'No new Hub clients to copy.');
  res.redirect('/invoices/clients');
});

async function load(req) {
  return db('gst_clients').where({ id: idParam(req) }).first();
}

router.get('/:id', async (req, res, next) => {
  const client = await load(req);
  if (!client) return next();
  const documents = await db('gst_documents').where({ client_id: client.id }).whereNull('discarded_at').orderBy('issue_date', 'desc').orderBy('id', 'desc').limit(100);
  const live = documents.filter((d) => d.kind === 'invoice' && d.number && d.status !== 'cancelled');
  const stats = {
    invoiced: live.reduce((s, d) => s + Number(d.inr_total), 0),
    outstanding: live.filter((d) => OPEN.includes(d.status)).reduce((s, d) => s + toInr(d, d.balance), 0),
    count: live.length,
  };
  res.render('gst/clients/show', { title: `${client.name} · GST Invoices`, client, documents, stats, trail: await trail('client', client.id) });
});

router.get('/:id/edit', async (req, res, next) => {
  const client = await load(req);
  if (!client) return next();
  res.render('gst/clients/form', { title: `Edit ${client.name} · GST Invoices`, client, errors: {} });
});

router.post('/:id', async (req, res, next) => {
  const current = await load(req);
  if (!current) return next();
  const { client, errors } = await parseClient(req.body, current.id);
  if (Object.keys(errors).length) return res.status(422).render('gst/clients/form', { title: `Edit ${current.name} · GST Invoices`, client: { ...client, id: current.id }, errors });
  await db.transaction(async (trx) => {
    await trx('gst_clients').where({ id: current.id }).update({ ...client, updated_at: nowSql() });
    await audit(actor(req), { entity: 'client', id: current.id, action: 'edited', summary: `Client ${client.name} updated`, changes: diff(current, client, FIELDS) }, trx);
  });
  req.flash('success', 'Client saved. Drafts pick up the change when next saved; finalised documents keep what they printed.');
  res.redirect(`/invoices/clients/${current.id}`);
});

// Clients are never deleted (documents refer to them); they can be hidden from new documents.
router.post('/:id/active', async (req, res, next) => {
  const client = await load(req);
  if (!client) return next();
  const active = req.body.active === '1';
  await db('gst_clients').where({ id: client.id }).update({ is_active: active, updated_at: nowSql() });
  await audit(actor(req), { entity: 'client', id: client.id, action: active ? 'reactivated' : 'deactivated', summary: `Client ${client.name} ${active ? 'reactivated' : 'deactivated'}` });
  req.flash('success', active ? `${client.name} is active again.` : `${client.name} is hidden from new documents. Its documents are kept.`);
  res.redirect(`/invoices/clients/${client.id}`);
});

module.exports = router;
