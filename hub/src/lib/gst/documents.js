'use strict';

// Tax invoices, proformas and credit/debit notes. A document is a draft until it is finalised;
// finalising takes its number, freezes the supplier and recipient details as printed, and locks
// it. After that it can only be cancelled (the number stays used) or corrected with a note.
//
// Every function reads what it needs before opening its transaction: SQLite has one pooled
// connection, so a query outside a running transaction would wait for it forever.

const { db } = require('../../db');
const { nowSql, todayIST, addDays, isDate, isEmail, str, int, formatDate } = require('../util');
const C = require('./constants');
const { computeDocument, supplyTypeFor, parseDiscount } = require('./tax');
const { getProfile, homeStateCode, supplierSnapshot } = require('./profile');
const { GstError, prefixFor, takeNumber } = require('./numbering');
const { parseGstin } = require('./gstin');
const { audit, diff } = require('./audit');
const { money, toMinor } = require('./format');
const { freshClient, mirror } = require('./clients');
const { logActivity } = require('../activity');

const isFinal = (doc) => Boolean(doc.number) && doc.status !== 'draft';
const isTaxDocument = (kind) => kind !== 'proforma';
const toArray = (v) => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
const termDays = (terms) => (C.PAYMENT_TERMS.find((t) => t[0] === terms) || [null, null])[1];

/** Reads the editor form. Returns { input, lines, errors }; amounts in minor units. */
function parseForm(body, kind) {
  const desc = toArray(body.line_description);
  const cols = ['line_item_id', 'line_sac', 'line_unit', 'line_qty', 'line_rate', 'line_discount', 'line_gst_rate'].map((k) => toArray(body[k]));
  const [itemIds, sacs, units, qtys, rates, discounts, gstRates] = cols;
  const lines = [];
  const errors = {};
  for (let i = 0; i < desc.length; i += 1) {
    const description = str(desc[i], 500);
    const rate = toMinor(rates[i]);
    if (!description && !rate) continue; // an empty row
    const rawQty = String(qtys[i] ?? '').replace(/,/g, '').trim();
    const quantity = rawQty === '' ? 1 : Number(rawQty);
    const gstRate = Number(gstRates[i] ?? 18);
    const sac = String(sacs[i] || '').replace(/\D/g, '').slice(0, 8);
    lines.push({
      item_id: int(itemIds[i], 0) || null,
      description: description || '',
      sac: sac || null,
      unit: str(units[i], 20),
      quantity: Number.isFinite(quantity) ? quantity : 0,
      rate,
      discount: parseDiscount(discounts[i], Math.round((Number.isFinite(quantity) ? quantity : 0) * rate)),
      gst_rate: C.GST_RATES.includes(gstRate) ? gstRate : 18,
    });
    const n = lines.length;
    if (!description) errors.lines = `Line ${n} needs a description.`;
    else if (!(quantity > 0)) errors.lines = `Line ${n} needs a quantity above zero.`;
    else if (rate <= 0) errors.lines = `Line ${n} needs a rate.`;
    else if (sac && !/^\d{4,8}$/.test(sac)) errors.lines = `Line ${n}: a SAC/HSN code is 4 to 8 digits.`;
  }
  if (!lines.length) errors.lines = 'Add at least one line.';

  const currency = C.CURRENCIES[body.currency] ? body.currency : 'INR';
  const exchangeRate = Number(String(body.exchange_rate || '').replace(/,/g, ''));
  const input = {
    client_id: int(body.client_id, 0),
    original_id: int(body.original_id, 0) || null,
    issue_date: isDate(body.issue_date) ? body.issue_date : todayIST(),
    due_date: isDate(body.due_date) ? body.due_date : null,
    payment_terms: C.PAYMENT_TERMS.some((t) => t[0] === body.payment_terms) ? body.payment_terms : null,
    pos_code: C.POS_OPTIONS.some((s) => s[0] === body.pos_code) ? body.pos_code : null,
    currency,
    exchange_rate: Number.isFinite(exchangeRate) && exchangeRate > 0 ? Math.round(exchangeRate * 10000) / 10000 : null,
    subject: str(body.subject, 255),
    notes: str(body.notes, 5000),
    terms: str(body.terms, 5000),
    note_reason: str(body.note_reason, 255),
  };
  if (!input.client_id && !C.NOTE_KINDS.includes(kind)) errors.client_id = 'Choose a client.';
  if (C.NOTE_KINDS.includes(kind) && !input.original_id) errors.original_id = 'Choose the invoice this note adjusts.';
  if (C.NOTE_KINDS.includes(kind) && !input.note_reason) errors.note_reason = 'Give the reason for the note.';
  if (!input.due_date && input.payment_terms && termDays(input.payment_terms) !== null) input.due_date = addDays(input.issue_date, termDays(input.payment_terms));
  if (input.due_date && input.due_date < input.issue_date) errors.due_date = 'The due date can’t be before the document date.';
  if (currency !== 'INR' && !input.exchange_rate) errors.exchange_rate = `Enter the ${currency} to INR exchange rate.`;
  return { input, lines, errors };
}

function billingFields(client) {
  const cityLine = [client.city, client.pincode].filter(Boolean).join(' – ');
  return {
    client_id: client.id,
    client_type: client.client_type,
    bill_name: client.name,
    bill_address: [client.address, cityLine].filter(Boolean).join('\n') || null,
    bill_country: client.country || 'India',
    bill_state_code: client.client_type === 'export' ? '96' : client.state_code,
    bill_state_name: client.client_type === 'export' ? C.EXPORT_POS[1] : client.state_name,
    bill_gstin: client.client_type === 'b2b' ? client.gstin : null,
    bill_pan: client.pan || null,
    bill_email: client.email || null,
    bill_phone: client.phone || null,
    bill_contact: client.contact_person || null,
  };
}

/**
 * Works out the stored row: recipient details, place of supply, CGST+SGST vs IGST vs export,
 * and totals. A note always follows its invoice's client, place of supply and currency.
 */
function buildRow(kind, input, lines, { client, profile, original }) {
  const home = homeStateCode(profile);
  let posCode = original ? original.pos_code : input.pos_code || client.state_code;
  if (!original && client.client_type === 'export') posCode = '96';
  if (!posCode) throw new GstError('Choose the place of supply (the client has no state on record).');
  const supplyType = original ? original.supply_type : supplyTypeFor({ clientType: client.client_type, posCode }, home);
  let currency = original ? original.currency : input.currency;
  if (supplyType !== 'export') currency = 'INR';
  const exchangeRate = currency === 'INR' ? 1 : Number(original ? original.exchange_rate : input.exchange_rate);
  if (!(exchangeRate > 0)) throw new GstError(`Enter the ${currency} to INR exchange rate.`);
  const totals = computeDocument(lines, { supplyType, currency, exchangeRate });
  const row = {
    ...billingFields(client),
    issue_date: input.issue_date,
    due_date: input.due_date,
    payment_terms: kind === 'invoice' ? input.payment_terms : null,
    pos_code: posCode,
    pos_name: C.stateName(posCode),
    supply_type: supplyType,
    currency,
    exchange_rate: exchangeRate,
    subject: input.subject,
    notes: input.notes,
    terms: input.terms,
    original_id: original ? original.id : null,
    note_reason: C.NOTE_KINDS.includes(kind) ? input.note_reason : null,
    lut_number: supplyType === 'export' ? profile.lut_number || null : null,
    lut_valid_until: supplyType === 'export' && isDate(profile.lut_valid_until) ? profile.lut_valid_until : null,
  };
  for (const k of ['gross', 'discount', 'taxable', 'cgst', 'sgst', 'igst', 'round_off', 'total', 'inr_taxable', 'inr_cgst', 'inr_sgst', 'inr_igst', 'inr_total']) row[k] = totals[k];
  return { row, lines: totals.lines };
}

async function insertLines(trx, documentId, lines) {
  if (!lines.length) return;
  await trx('gst_document_lines').insert(lines.map((l, i) => ({
    document_id: documentId,
    sort: i,
    item_id: l.item_id || null,
    description: l.description,
    sac: l.sac || null,
    unit: l.unit || null,
    quantity: l.quantity,
    rate: l.rate,
    gross: l.gross,
    discount: l.discount,
    taxable: l.taxable,
    gst_rate: l.gst_rate,
    cgst: l.cgst,
    sgst: l.sgst,
    igst: l.igst,
    total: l.total,
  })));
}

async function getLines(documentId, trx = db) {
  const rows = await trx('gst_document_lines').where({ document_id: documentId }).orderBy('sort');
  return rows.map((r) => ({ ...r, quantity: Number(r.quantity), gst_rate: Number(r.gst_rate) }));
}

/** The invoice a note adjusts, checked. */
async function noteOriginal(originalId) {
  const original = await db('gst_documents').where({ id: originalId || 0, kind: 'invoice' }).first();
  if (!original || !isFinal(original)) throw new GstError('Credit and debit notes adjust a finalised tax invoice. Choose one.');
  if (original.status === 'cancelled') throw new GstError(`${original.number} is cancelled, so it can’t be adjusted.`);
  return original;
}

const AUDITED = ['bill_name', 'issue_date', 'due_date', 'pos_code', 'supply_type', 'currency', 'exchange_rate', 'subject', 'taxable', 'total'];

/** Creates a draft (id null) or updates one. Returns the document id. */
async function saveDraft({ kind, id = null, input, lines, who, extra = {} }) {
  if (!C.KINDS[kind]) throw new GstError('Unknown document type.');
  const profile = await getProfile();
  const original = C.NOTE_KINDS.includes(kind) ? await noteOriginal(input.original_id) : null;
  const client = await freshClient(original ? original.client_id : input.client_id);
  if (!client) throw new GstError('Choose a client.');
  const current = id ? await db('gst_documents').where({ id }).first() : null;
  if (id && (!current || current.kind !== kind || current.status !== 'draft' || current.discarded_at)) throw new GstError('Only drafts can be edited. Finalised documents are corrected with a credit or debit note.');
  const built = buildRow(kind, input, lines, { client, profile, original });
  const now = nowSql();
  return db.transaction(async (trx) => {
    let docId = id;
    if (current) {
      await trx('gst_documents').where({ id }).update({ ...built.row, updated_by: who.id, updated_at: now });
      await trx('gst_document_lines').where({ document_id: id }).del();
    } else {
      [docId] = await trx('gst_documents').insert({ kind, status: 'draft', ...built.row, ...extra, created_by: who.id, updated_by: who.id, created_at: now, updated_at: now });
      if (typeof docId === 'object') docId = docId.id;
    }
    await insertLines(trx, docId, built.lines);
    await audit(who, {
      entity: 'document',
      id: docId,
      action: current ? 'edited' : 'created',
      summary: `${C.KINDS[kind].label} draft ${current ? 'updated' : 'created'} for ${client.name}: ${built.lines.length} line${built.lines.length === 1 ? '' : 's'}, ${money(built.row.total, built.row.currency)}`,
      changes: current ? diff(current, built.row, AUDITED) : null,
    }, trx);
    return docId;
  });
}

/** Payments, TDS and notes → paid / tds / credited / debited / balance / status of an invoice. */
async function refreshSettlement(trx, invoiceId) {
  const inv = await trx('gst_documents').where({ id: invoiceId }).first();
  if (!inv || inv.kind !== 'invoice' || !isFinal(inv) || inv.status === 'cancelled') return inv;
  const pay = await trx('gst_payments').where({ document_id: invoiceId, status: 'active' })
    .sum({ amount: 'amount' }).sum({ tds: 'tds' }).max({ last: 'paid_on' }).first();
  const notes = await trx('gst_documents').where({ original_id: invoiceId, status: 'issued' })
    .select('kind').sum({ total: 'total' }).groupBy('kind');
  const noteTotal = (k) => Number((notes.find((n) => n.kind === k) || {}).total || 0);
  const paid = Number(pay.amount || 0);
  const tds = Number(pay.tds || 0);
  const credited = noteTotal('credit_note');
  const debited = noteTotal('debit_note');
  const balance = Number(inv.total) + debited - credited - paid - tds;
  const status = balance <= 0 ? 'paid' : paid + tds + credited > 0 ? 'partially_paid' : 'unpaid';
  const patch = {
    paid, tds, credited, debited, balance, status,
    settled_on: balance <= 0 ? inv.settled_on || pay.last || todayIST() : null,
    updated_at: nowSql(),
  };
  await trx('gst_documents').where({ id: invoiceId }).update(patch);
  return { ...inv, ...patch };
}

/** What can still be credited against an invoice. */
const creditable = (inv) => Number(inv.total) + Number(inv.debited) - Number(inv.credited);

/** Every rule a document must meet before it gets a number. Throws GstError. */
async function checkFinalisable(doc, lines, profile) {
  const label = C.KINDS[doc.kind].label.toLowerCase();
  if (!lines.length || Number(doc.total) <= 0) throw new GstError('Add at least one line with a value before finalising.');
  if (doc.issue_date > todayIST()) throw new GstError(`The ${label} is dated in the future. Date it today or earlier.`);
  if (!isTaxDocument(doc.kind)) return;
  const own = parseGstin(profile.gstin);
  if (!own.ok) throw new GstError('Add a valid GSTIN on the Business Profile page before issuing tax documents.');
  if (isDate(profile.gst_registration_date) && doc.issue_date < profile.gst_registration_date) {
    throw new GstError(`GST registration is effective from ${formatDate(profile.gst_registration_date)}; a tax document can’t be dated earlier.`);
  }
  const noSac = lines.findIndex((l) => !l.sac);
  if (noSac >= 0) throw new GstError(`Line ${noSac + 1} needs a SAC/HSN code.`);
  if (doc.client_type === 'b2b' && !parseGstin(doc.bill_gstin).ok) throw new GstError('This client is a registered business but has no valid GSTIN. Fix it on the client, then save the draft again.');
  // Rule 46(e): an unregistered recipient's address is required from ₹50,000.
  if (doc.client_type === 'b2c' && Number(doc.inr_taxable) >= 5000000 && !doc.bill_address) {
    throw new GstError('From ₹50,000, the invoice must show an unregistered client’s address. Add it on the client, then save the draft again.');
  }
  if (doc.supply_type === 'export') {
    if (!profile.lut_number) throw new GstError('Exports without IGST need your LUT number. Add it on the Business Profile page.');
    if (isDate(profile.lut_valid_from) && doc.issue_date < profile.lut_valid_from) throw new GstError(`Your LUT starts on ${formatDate(profile.lut_valid_from)}, after this invoice’s date.`);
    if (isDate(profile.lut_valid_until) && doc.issue_date > profile.lut_valid_until) throw new GstError(`Your LUT expired on ${formatDate(profile.lut_valid_until)}. File a new LUT and update it on the Business Profile page.`);
  }
  if (C.NOTE_KINDS.includes(doc.kind)) {
    const original = await noteOriginal(doc.original_id);
    if (doc.issue_date < original.issue_date) throw new GstError(`A note can’t be dated before its invoice (${formatDate(original.issue_date)}).`);
    if (doc.kind === 'credit_note' && Number(doc.total) > creditable(original)) {
      throw new GstError(`This credit note (${money(doc.total, doc.currency)}) is more than what is left on ${original.number} (${money(creditable(original), doc.currency)}).`);
    }
  }
}

/** Assigns the number, freezes what is printed, and locks the document. */
async function finalise(id, who) {
  const profile = await getProfile();
  const doc = await db('gst_documents').where({ id }).first();
  if (!doc || doc.discarded_at) throw new GstError('Document not found.');
  if (doc.status !== 'draft') throw new GstError(`${doc.number || 'This document'} is already finalised.`);
  const lines = await getLines(id);
  await checkFinalisable(doc, lines, profile);
  const prefix = prefixFor(doc.kind, profile);
  return db.transaction(async (trx) => {
    const fresh = await trx('gst_documents').where({ id }).first();
    if (fresh.status !== 'draft') throw new GstError('This document was finalised by someone else a moment ago.');
    const { number, fy, seq } = await takeNumber(trx, prefix, doc.issue_date);
    // Numbers must run in date order within a series, or the register reads out of sequence.
    const later = await trx('gst_documents').where({ series: prefix, fy }).whereNotNull('number')
      .where('issue_date', '>', doc.issue_date).orderBy('issue_date', 'desc').first();
    if (later) throw new GstError(`${later.number} is already dated ${formatDate(later.issue_date)}. Numbers run in date order, so date this one ${formatDate(later.issue_date)} or later.`);
    const now = nowSql();
    await trx('gst_documents').where({ id }).update({
      number, series: prefix, fy, seq,
      status: doc.kind === 'invoice' ? 'unpaid' : 'issued',
      supplier_json: JSON.stringify(supplierSnapshot(profile)),
      lut_number: doc.supply_type === 'export' ? profile.lut_number : null,
      lut_valid_until: doc.supply_type === 'export' && isDate(profile.lut_valid_until) ? profile.lut_valid_until : null,
      balance: doc.kind === 'invoice' ? doc.total : 0,
      finalised_at: now, finalised_by: who.id, updated_at: now, updated_by: who.id,
    });
    if (doc.kind === 'invoice') await refreshSettlement(trx, id);
    if (C.NOTE_KINDS.includes(doc.kind)) await refreshSettlement(trx, doc.original_id);
    if (doc.source_id) await trx('gst_documents').where({ id: doc.source_id }).update({ status: 'converted', converted_id: id, updated_at: now });
    await audit(who, { entity: 'document', id, action: 'finalised', summary: `Finalised as ${number} (${money(doc.total, doc.currency)}). Locked for editing.` }, trx);
    return number;
  });
}

async function cancel(id, reason, who) {
  const doc = await db('gst_documents').where({ id }).first();
  if (!doc || !isFinal(doc)) throw new GstError('Only finalised documents can be cancelled. Discard a draft instead.');
  if (doc.status === 'cancelled') throw new GstError(`${doc.number} is already cancelled.`);
  if (doc.status === 'converted') throw new GstError(`${doc.number} was converted to a tax invoice; cancel that invoice instead.`);
  if (!reason) throw new GstError('Give a reason for cancelling.');
  if (doc.kind === 'invoice') {
    const pays = await db('gst_payments').where({ document_id: id, status: 'active' }).first();
    if (pays) throw new GstError('This invoice has payments recorded. Reverse them first, or issue a credit note instead.');
    const note = await db('gst_documents').where({ original_id: id, status: 'issued' }).first();
    if (note) throw new GstError(`${note.number} adjusts this invoice. Cancel that note first, or issue a credit note instead.`);
  }
  await db.transaction(async (trx) => {
    const now = nowSql();
    await trx('gst_documents').where({ id }).update({
      status: 'cancelled', balance: 0, cancelled_at: now, cancelled_by: who.id, cancel_reason: reason, updated_at: now, updated_by: who.id,
    });
    if (C.NOTE_KINDS.includes(doc.kind)) await refreshSettlement(trx, doc.original_id);
    // The proforma it came from can be converted again.
    if (doc.source_id) await trx('gst_documents').where({ id: doc.source_id, converted_id: id }).update({ status: 'issued', converted_id: null, updated_at: now });
    await audit(who, { entity: 'document', id, action: 'cancelled', summary: `${doc.number} cancelled: ${reason}. The number stays used.` }, trx);
  });
}

/** Abandons a draft: hidden from lists, kept in the database. */
async function discard(id, who) {
  const doc = await db('gst_documents').where({ id }).first();
  if (!doc || doc.status !== 'draft' || doc.discarded_at) throw new GstError('Only drafts can be discarded.');
  await db.transaction(async (trx) => {
    await trx('gst_documents').where({ id }).update({ discarded_at: nowSql(), updated_at: nowSql(), updated_by: who.id });
    await audit(who, { entity: 'document', id, action: 'discarded', summary: `${C.KINDS[doc.kind].label} draft discarded.` }, trx);
  });
}

/** Proforma → a draft tax invoice with the same client and lines, dated today. Returns its id. */
async function convertProforma(id, who) {
  const pf = await db('gst_documents').where({ id, kind: 'proforma' }).first();
  if (!pf || pf.status !== 'issued') throw new GstError('Only an issued proforma can be converted.');
  const existing = await db('gst_documents').where({ source_id: id, kind: 'invoice' }).whereNull('discarded_at').whereNot('status', 'cancelled').first();
  if (existing) return existing.id;
  const profile = await getProfile();
  const today = todayIST();
  const terms = profile.default_payment_terms;
  const lines = await getLines(id);
  const input = {
    client_id: pf.client_id,
    issue_date: today,
    due_date: termDays(terms) !== null ? addDays(today, termDays(terms)) : null,
    payment_terms: terms,
    pos_code: pf.pos_code,
    currency: pf.currency,
    exchange_rate: Number(pf.exchange_rate),
    subject: pf.subject,
    notes: pf.notes,
    terms: pf.terms,
  };
  const invoiceId = await saveDraft({ kind: 'invoice', input, lines, who, extra: { source_id: id } });
  await audit(who, { entity: 'document', id, action: 'converted', summary: `Converted to a draft tax invoice (#${invoiceId}).` });
  return invoiceId;
}

// ---------------- Correcting the recipient's name and address ----------------
// What is printed for the recipient can be corrected after finalising (a misspelt name, a new
// address). GSTIN, state, place of supply and amounts stay as issued: they change the tax, so they
// need a note. Every change is in the audit log with its before and after.

const RECIPIENT = ['bill_name', 'bill_address', 'bill_contact', 'bill_email', 'bill_phone'];

/** The correction form, filled from the document (split into address, city and PIN like the client). */
function recipientForm(doc, client) {
  const fromClient = client && billingFields(client).bill_address === doc.bill_address;
  return {
    name: doc.bill_name,
    address: fromClient ? client.address || '' : doc.bill_address || '',
    city: fromClient ? client.city || '' : '',
    pincode: fromClient ? client.pincode || '' : '',
    contact: doc.bill_contact || (client && client.contact_person) || '',
    email: doc.bill_email || (client && client.email) || '',
    phone: doc.bill_phone || (client && client.phone) || '',
  };
}

/**
 * Saves a corrected name, address and contact details on a document. With `update_client` (always
 * for a draft, which follows its client), the Hub client gets them too, for future documents.
 * Returns { changed, clientUpdated }.
 */
async function editRecipient(id, body, who) {
  const doc = await db('gst_documents').where({ id }).first();
  if (!doc || doc.discarded_at) throw new GstError('That document isn’t available.');
  const label = doc.number || `this draft ${C.KINDS[doc.kind].short.toLowerCase()}`;
  if (doc.status === 'cancelled') throw new GstError(`${doc.number} is cancelled, so it stays as it was issued.`);
  if (doc.irn) throw new GstError(`${doc.number} has an e-invoice IRN, so its details can’t be changed here. Cancel it on the IRP within 24 hours and issue a new invoice.`);
  const f = {
    name: str(body.name, 190),
    address: str(body.address, 1000),
    city: str(body.city, 100),
    pincode: str(body.pincode, 12),
    contact: str(body.contact, 190),
    email: (str(body.email, 190) || '').toLowerCase() || null,
    phone: str(body.phone, 40),
  };
  if (!f.name) throw new GstError('Enter the name to print on the document.');
  if (f.email && !isEmail(f.email)) throw new GstError(`${f.email} isn’t a valid email address.`);
  const after = {
    bill_name: f.name,
    bill_address: [f.address, [f.city, f.pincode].filter(Boolean).join(' – ')].filter(Boolean).join('\n') || null,
    bill_contact: f.contact,
    bill_email: f.email,
    bill_phone: f.phone,
  };
  const changes = diff(doc, after, RECIPIENT);
  const reason = str(body.reason, 200);

  const client = await db('gst_clients').where({ id: doc.client_id }).first();
  const hub = (doc.status === 'draft' || body.update_client) && client && client.hub_client_id
    ? await db('clients').where({ id: client.hub_client_id }).first() : null;
  const hubAfter = { name: f.name, address: f.address, city: f.city, pincode: f.pincode, contact_name: f.contact, email: f.email, phone: f.phone };
  const hubChanges = hub ? diff(hub, hubAfter, Object.keys(hubAfter)) : {};

  await db.transaction(async (trx) => {
    if (Object.keys(changes).length) {
      await trx('gst_documents').where({ id }).update({ ...after, updated_at: nowSql(), updated_by: who.id });
      await audit(who, {
        entity: 'document', id, action: 'recipient_corrected', changes,
        summary: `Recipient’s name and address corrected on ${label}${reason ? `: ${reason}` : ''}. GSTIN, place of supply and amounts are unchanged.`,
      }, trx);
    }
    if (Object.keys(hubChanges).length) {
      await trx('clients').where({ id: hub.id }).update({ ...hubAfter, updated_at: nowSql() });
      await audit(who, { entity: 'client', id: hub.id, action: 'edited', changes: hubChanges, summary: `Client ${f.name} updated from ${label}` }, trx);
    }
  });
  if (Object.keys(hubChanges).length) {
    await mirror(hub.id);
    await logActivity('client', hub.id, who.id, 'system', `Client details updated from GST Invoices (${label})`);
  }
  return { changed: Object.keys(changes).length > 0, clientUpdated: Object.keys(hubChanges).length > 0 };
}

async function loadDocument(id) {
  const doc = await db('gst_documents').where({ id }).first();
  if (!doc) return null;
  const profile = await getProfile();
  const lines = await getLines(id);
  const client = await db('gst_clients').where({ id: doc.client_id }).first();
  const payments = await db('gst_payments as p').leftJoin('users as u', 'u.id', 'p.created_by')
    .where('p.document_id', id).orderBy('p.paid_on').orderBy('p.id').select('p.*', 'u.name as created_by_name');
  const notes = await db('gst_documents').where({ original_id: id }).whereNull('discarded_at').orderBy('id');
  const original = doc.original_id ? await db('gst_documents').where({ id: doc.original_id }).first() : null;
  const source = doc.source_id ? await db('gst_documents').where({ id: doc.source_id }).first() : null;
  const converted = doc.kind === 'proforma'
    ? await db('gst_documents').where({ source_id: id, kind: 'invoice' }).whereNull('discarded_at').orderBy('id', 'desc').first()
    : null;
  const supplier = doc.supplier_json ? JSON.parse(doc.supplier_json) : supplierSnapshot(profile);
  return { doc, lines, client, payments, notes, original, source, converted, supplier, profile };
}

module.exports = {
  parseForm, saveDraft, finalise, cancel, discard, convertProforma, loadDocument, getLines, refreshSettlement, recipientForm, editRecipient,
  creditable, isFinal, isTaxDocument, termDays, noteOriginal,
};
