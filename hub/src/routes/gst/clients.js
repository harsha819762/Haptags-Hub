'use strict';

// The Hub's own business clients, seen and edited with their GST details. There is one client
// list: adding or editing a client here updates the Hub's Clients too.

const express = require('express');
const { db } = require('../../db');
const C = require('../../lib/gst/constants');
const { parseGstin, isPan } = require('../../lib/gst/gstin');
const { hubClients, gstView } = require('../../lib/gst/clients');
const { actor, audit, diff, trail } = require('../../lib/gst/audit');
const { logActivity } = require('../../lib/activity');
const { OPEN, toInr } = require('../../lib/gst/reports');
const { nowSql, str, isEmail } = require('../../lib/util');
const { PER_PAGE } = require('../admin/_helpers');
const { idParam } = require('./_helpers');

const router = express.Router();

const FIELDS = ['name', 'contact_name', 'email', 'phone', 'gstin', 'pan', 'address', 'city', 'state', 'pincode', 'country', 'notes'];

/**
 * Validates the GST client form into Hub client columns. The type decides what is needed: a
 * GSTIN for B2B (its first two digits set the state), a state for B2C, a country for exports.
 */
async function parseClient(body, exceptId = 0) {
  const errors = {};
  const type = C.CLIENT_TYPES.some((t) => t[0] === body.client_type) ? body.client_type : 'b2b';
  const form = {
    name: str(body.name, 190),
    client_type: type,
    contact_person: str(body.contact_person, 190),
    email: (str(body.email, 190) || '').toLowerCase() || null,
    phone: str(body.phone, 40),
    address: str(body.address, 1000),
    city: str(body.city, 100),
    pincode: str(body.pincode, 12),
    country: type === 'export' ? str(body.country, 80) : 'India',
    state_code: type === 'export' ? '96' : (C.GST_STATES.find((s) => s[0] === body.state_code) || [])[0] || null,
    gstin: type === 'b2b' && str(body.gstin, 20) ? String(body.gstin).toUpperCase().replace(/\s+/g, '') : null,
    pan: str(body.pan, 10) ? String(body.pan).toUpperCase().trim() : null,
    notes: str(body.notes, 5000),
  };
  if (!form.name) errors.name = 'Enter the client’s legal name.';
  if (form.email && !isEmail(form.email)) errors.email = 'Enter a valid email address.';
  if (type === 'export' && (!form.country || C.isIndia(form.country))) errors.country = 'Choose the client’s country (outside India).';
  if (type === 'b2b') {
    const g = parseGstin(form.gstin);
    if (!g.ok) errors.gstin = form.gstin ? g.error : 'A registered business needs its GSTIN.';
    else {
      form.gstin = g.gstin;
      form.state_code = g.stateCode; // the GSTIN decides the state
      if (!form.pan && g.pan) form.pan = g.pan;
      const dup = await hubClients().where({ gstin: g.gstin }).whereNot('id', exceptId).first();
      if (dup) errors.gstin = `${dup.name} already has this GSTIN.`;
    }
  }
  if (type !== 'export' && !form.state_code) errors.state_code = 'Choose the state (it sets CGST + SGST or IGST).';
  if (form.pan && !isPan(form.pan)) errors.pan = 'A PAN is 5 letters, 4 digits and a letter, e.g. AASFH7857G.';
  form.state_name = C.stateName(form.state_code);
  const hub = {
    name: form.name, contact_name: form.contact_person, email: form.email, phone: form.phone, gstin: form.gstin, pan: form.pan,
    address: form.address, city: form.city, state: type === 'export' ? null : form.state_name, pincode: form.pincode,
    country: form.country, notes: form.notes,
  };
  return { form, hub, errors };
}

router.get('/', async (req, res) => {
  const q = str(req.query.q, 100);
  const type = C.CLIENT_TYPES.some((t) => t[0] === req.query.type) ? req.query.type : '';
  const showInactive = req.query.inactive === '1';
  const query = hubClients().orderBy('name');
  if (!showInactive) query.where({ status: 'active' });
  if (q) query.where((w) => w.where('name', 'like', `%${q}%`).orWhere('gstin', 'like', `%${q}%`).orWhere('email', 'like', `%${q}%`).orWhere('contact_name', 'like', `%${q}%`).orWhere('phone', 'like', `%${q}%`).orWhere('city', 'like', `%${q}%`));
  // The GST type is worked out from each client's details, so filter after reading.
  const all = (await query).map(gstView).filter((c) => !type || c.client_type === type);
  const page = Math.max(1, Number(req.query.page) || 1);
  const rows = all.slice((page - 1) * PER_PAGE, page * PER_PAGE);
  res.render('gst/clients/index', {
    title: 'Clients · GST Invoices', rows, page, hasPrev: page > 1, hasNext: all.length > page * PER_PAGE, q, type, showInactive,
    total: all.length, needsFixing: all.filter((c) => c.issues.length).length,
  });
});

router.get('/new', (req, res) => {
  res.render('gst/clients/form', { title: 'New client · GST Invoices', client: { client_type: 'b2b', country: 'India' }, errors: {} });
});

router.post('/', async (req, res) => {
  const { form, hub, errors } = await parseClient(req.body);
  if (Object.keys(errors).length) return res.status(422).render('gst/clients/form', { title: 'New client · GST Invoices', client: form, errors });
  const who = actor(req);
  let [id] = await db('clients').insert({ ...hub, segment: 'business', status: 'active', created_at: nowSql(), updated_at: nowSql() });
  if (typeof id === 'object') id = id.id;
  await logActivity('client', id, req.user.id, 'system', 'Client created from GST Invoices');
  await audit(who, { entity: 'client', id, action: 'created', summary: `Client ${hub.name} added (${form.client_type.toUpperCase()}${hub.gstin ? `, ${hub.gstin}` : ''})` });
  req.flash('success', `${hub.name} added to your clients.`);
  res.redirect(req.body.then === 'invoice' ? `/invoices/docs/new?kind=invoice&client_id=${id}` : `/invoices/clients/${id}`);
});

async function load(req) {
  return hubClients().where({ id: idParam(req) }).first();
}

router.get('/:id', async (req, res, next) => {
  const hub = await load(req);
  if (!hub) return next();
  const client = gstView(hub);
  const mirrorIds = await db('gst_clients').where({ hub_client_id: hub.id }).pluck('id');
  const documents = mirrorIds.length
    ? await db('gst_documents').whereIn('client_id', mirrorIds).whereNull('discarded_at').orderBy('issue_date', 'desc').orderBy('id', 'desc').limit(100)
    : [];
  const live = documents.filter((d) => d.kind === 'invoice' && d.number && d.status !== 'cancelled');
  const stats = {
    invoiced: live.reduce((s, d) => s + Number(d.inr_total), 0),
    outstanding: live.filter((d) => OPEN.includes(d.status)).reduce((s, d) => s + toInr(d, d.balance), 0),
    count: live.length,
  };
  res.render('gst/clients/show', { title: `${hub.name} · GST Invoices`, client, documents, stats, trail: await trail('client', hub.id), mirrorIds });
});

router.get('/:id/edit', async (req, res, next) => {
  const hub = await load(req);
  if (!hub) return next();
  res.render('gst/clients/form', { title: `Edit ${hub.name} · GST Invoices`, client: gstView(hub), errors: {} });
});

router.post('/:id', async (req, res, next) => {
  const current = await load(req);
  if (!current) return next();
  const { form, hub, errors } = await parseClient(req.body, current.id);
  if (Object.keys(errors).length) {
    return res.status(422).render('gst/clients/form', { title: `Edit ${current.name} · GST Invoices`, client: { ...form, id: current.id }, errors });
  }
  await db('clients').where({ id: current.id }).update({ ...hub, updated_at: nowSql() });
  await logActivity('client', current.id, req.user.id, 'system', 'Client details updated from GST Invoices');
  await audit(actor(req), { entity: 'client', id: current.id, action: 'edited', summary: `Client ${hub.name} updated`, changes: diff(current, hub, FIELDS) });
  req.flash('success', 'Client saved. Drafts pick up the change when next saved; finalised documents keep what they printed.');
  res.redirect(`/invoices/clients/${current.id}`);
});

module.exports = router;
