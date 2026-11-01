'use strict';

// GST Invoices bills the Hub's own business clients: one client list for the whole company.
// Documents point at gst_clients, a mirror row per Hub client that is refreshed from the Hub
// record whenever a draft is saved, so a client's details are only ever edited in one place.

const { db } = require('../../db');
const { nowSql } = require('../util');
const C = require('./constants');
const { parseGstin } = require('./gstin');

const stateCodeFor = (name) => (C.GST_STATES.find((s) => name && s[1].toLowerCase() === String(name).trim().toLowerCase()) || [])[0] || null;

/**
 * A Hub client as GST sees it. Outside India is an export; any GSTIN makes it B2B (the GSTIN is
 * checked before finalising); otherwise B2C. `issues` lists what would stop a tax invoice.
 */
function gstView(h) {
  const abroad = !C.isIndia(h.country);
  const gstin = abroad ? null : String(h.gstin || '').toUpperCase().replace(/\s+/g, '') || null;
  const g = parseGstin(gstin);
  const type = abroad ? 'export' : gstin ? 'b2b' : 'b2c';
  const stateCode = abroad ? '96' : g.ok ? g.stateCode : stateCodeFor(h.state);
  const issues = [];
  if (type === 'b2b' && !g.ok) issues.push(`GSTIN ${gstin} isn’t valid`);
  if (type !== 'export' && !stateCode) issues.push('no state on record');
  return {
    id: h.id,
    name: h.name,
    client_type: type,
    contact_person: h.contact_name || null,
    email: h.email || null,
    phone: h.phone || null,
    address: h.address || null,
    city: h.city || null,
    pincode: h.pincode || null,
    country: abroad ? h.country : 'India',
    state_code: stateCode,
    state_name: C.stateName(stateCode),
    gstin: type === 'b2b' ? gstin : null,
    pan: h.pan || (g.ok ? g.pan : null),
    notes: h.notes || null,
    is_active: h.status !== 'inactive',
    issues,
  };
}

const MIRRORED = ['name', 'client_type', 'contact_person', 'email', 'phone', 'address', 'city', 'pincode', 'country', 'state_code', 'state_name', 'gstin', 'pan', 'notes', 'is_active'];

/** The Hub's business clients (students and interns are billed under Education). */
const hubClients = () => db('clients').where({ segment: 'business' });

/** The gst_clients row for a Hub client, created or refreshed from the Hub record. Returns its id. */
async function mirror(hubClientId) {
  const h = await hubClients().where({ id: hubClientId }).first();
  if (!h) return null;
  const v = gstView(h);
  const row = Object.fromEntries(MIRRORED.map((k) => [k, v[k]]));
  const existing = await db('gst_clients').where({ hub_client_id: h.id }).orderBy('id').first();
  if (existing) {
    await db('gst_clients').where({ id: existing.id }).update({ ...row, updated_at: nowSql() });
    return existing.id;
  }
  const [id] = await db('gst_clients').insert({ ...row, hub_client_id: h.id, created_at: nowSql(), updated_at: nowSql() });
  return typeof id === 'object' ? id.id : id;
}

/** A document's client, re-read from the Hub first (drafts always bill the current details). */
async function freshClient(gstClientId) {
  const row = await db('gst_clients').where({ id: gstClientId || 0 }).first();
  if (row && row.hub_client_id) await mirror(row.hub_client_id);
  return db('gst_clients').where({ id: gstClientId || 0 }).first();
}

/** The Hub client a form picked: by id, or (without JavaScript) by its exact name. */
async function pickedClient(body) {
  const id = Number(body.hub_client_id) || 0;
  if (id) return hubClients().where({ id }).first();
  const name = String(body.client_search || '').trim().toLowerCase();
  if (!name) return null;
  const matches = await hubClients().whereRaw('lower(name) = ?', [name]).limit(2);
  return matches.length === 1 ? matches[0] : null;
}

/** Hub client id for each gst_clients id, for linking to the client pages. */
async function hubIds(gstClientIds) {
  const ids = [...new Set(gstClientIds.filter(Boolean))];
  if (!ids.length) return {};
  const rows = await db('gst_clients').whereIn('id', ids).select('id', 'hub_client_id');
  return Object.fromEntries(rows.map((r) => [r.id, r.hub_client_id]));
}

module.exports = { gstView, hubClients, mirror, freshClient, pickedClient, hubIds, stateCodeFor };
