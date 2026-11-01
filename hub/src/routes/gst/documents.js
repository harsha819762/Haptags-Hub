'use strict';

const express = require('express');
const { db } = require('../../db');
const C = require('../../lib/gst/constants');
const docs = require('../../lib/gst/documents');
const { recordPayment } = require('../../lib/gst/payments');
const { renderPdf } = require('../../lib/gst/pdf');
const { emailDocument, defaultMessage, fileName } = require('../../lib/gst/mail');
const { eligible, buildPayload } = require('../../lib/gst/einvoice');
const { previewNumber, prefixFor, GstError } = require('../../lib/gst/numbering');
const { getProfile, homeStateCode } = require('../../lib/gst/profile');
const { hubClients, gstView, mirror, pickedClient } = require('../../lib/gst/clients');
const { whereStatus } = require('../../lib/gst/reports');
const { actor, documentTrail } = require('../../lib/gst/audit');
const { displayStatus, docTitle } = require('../../lib/gst/format');
const { taxSummary } = require('../../lib/gst/tax');
const { inWords } = require('../../lib/gst/words');
const { mailEnabled } = require('../../lib/mailer');
const { todayIST, addDays, str, int, isDate } = require('../../lib/util');
const { paginate } = require('../admin/_helpers');
const { idParam } = require('./_helpers');

const router = express.Router();

const TYPES = {
  invoice: { kinds: ['invoice'], title: 'Tax invoices' },
  proforma: { kinds: ['proforma'], title: 'Proforma invoices' },
  notes: { kinds: ['credit_note', 'debit_note'], title: 'Credit & debit notes' },
};
const typeOf = (kind) => (C.NOTE_KINDS.includes(kind) ? 'notes' : kind);

router.get('/', async (req, res) => {
  const type = TYPES[req.query.type] ? req.query.type : 'invoice';
  const status = String(req.query.status || '');
  const q = str(req.query.q, 100);
  const clientId = int(req.query.client, 0) || null;
  const from = isDate(req.query.from) ? req.query.from : null;
  const to = isDate(req.query.to) ? req.query.to : null;
  const today = todayIST();
  const query = db('gst_documents as d').whereIn('d.kind', TYPES[type].kinds).whereNull('d.discarded_at')
    .orderByRaw('CASE WHEN d.number IS NULL THEN 0 ELSE 1 END').orderBy('d.issue_date', 'desc').orderBy('d.id', 'desc');
  if (status === 'open') query.whereIn('d.status', ['unpaid', 'partially_paid']);
  else if (status) whereStatus(query, status, today, (c) => `d.${c}`);
  if (clientId) query.where('d.client_id', clientId);
  if (from) query.where('d.issue_date', '>=', from);
  if (to) query.where('d.issue_date', '<=', to);
  if (q) query.where((w) => w.where('d.number', 'like', `%${q}%`).orWhere('d.bill_name', 'like', `%${q}%`).orWhere('d.subject', 'like', `%${q}%`).orWhere('d.bill_gstin', 'like', `%${q}%`));
  const page = await paginate(query.leftJoin('gst_clients as gc', 'gc.id', 'd.client_id').select('d.*', 'gc.hub_client_id'), req);
  const tabs = {
    invoice: [['', 'All'], ['open', 'Unpaid'], ['overdue', 'Overdue'], ['paid', 'Paid'], ['draft', 'Drafts'], ['cancelled', 'Cancelled']],
    proforma: [['', 'All'], ['issued', 'Issued'], ['converted', 'Converted'], ['draft', 'Drafts'], ['cancelled', 'Cancelled']],
    notes: [['', 'All'], ['issued', 'Issued'], ['draft', 'Drafts'], ['cancelled', 'Cancelled']],
  }[type];
  res.render('gst/documents/index', {
    title: `${TYPES[type].title} · GST Invoices`, type, typeTitle: TYPES[type].title, tabs, status, q, from, to, clientId, today, ...page,
    clients: await db('gst_clients').orderBy('name').select('id', 'name'),
  });
});

async function formData(kind, doc, errors = {}) {
  const profile = await getProfile();
  // The picker lists the Hub's active business clients (and the one already on this draft).
  if (!doc.hub_client_id && doc.client_id) doc.hub_client_id = (await db('gst_clients').where({ id: doc.client_id }).first() || {}).hub_client_id;
  const clients = (await hubClients().where((w) => w.where('status', 'active').orWhere('id', doc.hub_client_id || 0)).orderBy('name')).map(gstView);
  const items = await db('gst_items').where({ is_active: true }).orderBy('sort').orderBy('name');
  const invoices = C.NOTE_KINDS.includes(kind)
    ? await db('gst_documents').where({ kind: 'invoice' }).whereNotNull('number').whereNot('status', 'cancelled').orderBy('issue_date', 'desc').orderBy('id', 'desc').limit(500)
      .select('id', 'number', 'issue_date', 'bill_name', 'total', 'currency', 'credited', 'debited')
    : [];
  const original = doc.original_id ? await db('gst_documents').where({ id: doc.original_id }).first() : null;
  return {
    title: `${doc.id ? 'Edit' : 'New'} ${C.KINDS[kind].label.toLowerCase()} · GST Invoices`,
    kind, doc, errors, items, invoices, original,
    picked: clients.find((c) => c.id === Number(doc.hub_client_id)) || null,
    home: homeStateCode(profile),
    nextNumber: await previewNumber(prefixFor(kind, profile), doc.issue_date || todayIST()),
    editorData: {
      home: homeStateCode(profile),
      clients: Object.fromEntries(clients.map((c) => [c.id, {
        name: c.name, type: c.client_type, state: c.state_code, stateName: c.state_name, country: c.country, gstin: c.gstin,
        city: c.city, contact: c.contact_person, email: c.email, issues: c.issues,
      }])),
      items: Object.fromEntries(items.map((i) => [i.id, { name: i.name, description: i.description, sac: i.sac, unit: i.unit, rate: Number(i.rate), gst: Number(i.gst_rate) }])),
      terms: Object.fromEntries(C.PAYMENT_TERMS),
      original: original ? { pos: original.pos_code, supply: original.supply_type, currency: original.currency, fx: Number(original.exchange_rate) } : null,
    },
  };
}

function blankLine(profile) {
  return { description: '', sac: '', unit: '', quantity: 1, rate: 0, discount: 0, gst_rate: Number(profile.default_gst_rate) || 18 };
}

router.get('/new', async (req, res, next) => {
  const kind = C.KINDS[req.query.kind] ? req.query.kind : 'invoice';
  const { profile } = res.locals;
  const today = todayIST();
  const doc = { kind, issue_date: today, currency: 'INR', lines: [blankLine(profile)] };
  if (kind === 'invoice') {
    doc.payment_terms = profile.default_payment_terms;
    const days = docs.termDays(doc.payment_terms);
    doc.due_date = days === null ? '' : addDays(today, days);
  }
  if (kind === 'proforma') doc.due_date = addDays(today, Number(profile.proforma_valid_days) || 15);
  if (kind !== 'credit_note' && kind !== 'debit_note') doc.terms = profile.default_terms;
  const hub = await hubClients().where({ id: int(req.query.client_id, 0) }).first();
  if (hub) {
    doc.hub_client_id = hub.id;
    doc.pos_code = gstView(hub).state_code;
  }
  if (C.NOTE_KINDS.includes(kind) && req.query.original) {
    const original = await db('gst_documents').where({ id: int(req.query.original, 0), kind: 'invoice' }).first();
    if (!original || !docs.isFinal(original) || original.status === 'cancelled') return next(new GstError('Choose a finalised, uncancelled tax invoice to adjust.'));
    Object.assign(doc, {
      original_id: original.id, client_id: original.client_id, pos_code: original.pos_code, currency: original.currency,
      exchange_rate: Number(original.exchange_rate), subject: `Against invoice ${original.number}`,
      lines: (await docs.getLines(original.id)).map((l) => ({ ...l, item_id: l.item_id, discount: 0, quantity: l.quantity, rate: l.rate })),
    });
  }
  res.render('gst/documents/form', await formData(kind, doc));
});

/** The editor's values after a failed save, so nothing typed is lost. */
const formState = (kind, id, input, lines, body) => ({
  ...input, id, kind, lines: lines.length ? lines : [], hub_client_id: body.hub_client_id, client_search: body.client_search,
});

async function save(req, res, { kind, id = null }) {
  const who = actor(req);
  // The picker sends a Hub client; documents point at its GST mirror row.
  let clientId = req.body.client_id;
  if (!C.NOTE_KINDS.includes(kind)) {
    const hub = await pickedClient(req.body);
    clientId = hub ? await mirror(hub.id) : '';
  }
  const { input, lines, errors } = docs.parseForm({ ...req.body, client_id: clientId }, kind);
  const rerender = async (errs) => res.status(422).render('gst/documents/form', await formData(kind, formState(kind, id, input, lines, req.body), errs));
  if (Object.keys(errors).length) return rerender(errors);
  let docId;
  try {
    docId = await docs.saveDraft({ kind, id, input, lines, who });
  } catch (err) {
    if (!err.gst) throw err;
    return rerender({ form: err.message });
  }
  if (req.body.action === 'finalise') {
    try {
      const number = await docs.finalise(docId, who);
      req.flash('success', `${C.KINDS[kind].label} ${number} finalised and locked.`);
    } catch (err) {
      if (!err.gst) throw err;
      req.flash('error', `Saved as a draft, but not finalised: ${err.message}`);
    }
  } else {
    req.flash('success', 'Draft saved.');
  }
  return res.redirect(`/invoices/docs/${docId}`);
}

router.post('/', async (req, res) => save(req, res, { kind: C.KINDS[req.body.kind] ? req.body.kind : 'invoice' }));

async function load(req) {
  return db('gst_documents').where({ id: idParam(req) }).first();
}

router.get('/:id', async (req, res, next) => {
  const bundle = await docs.loadDocument(idParam(req));
  if (!bundle) return next();
  const { doc } = bundle;
  const status = displayStatus(doc);
  res.render('gst/documents/show', {
    title: `${doc.number || `Draft ${C.KINDS[doc.kind].short.toLowerCase()}`} · GST Invoices`,
    ...bundle,
    status,
    type: typeOf(doc.kind),
    trail: await documentTrail(doc.id),
    canEinvoice: eligible(doc),
    mailEnabled,
    emailMessage: doc.number ? defaultMessage(doc, bundle.supplier) : '',
    creditable: doc.kind === 'invoice' ? docs.creditable(doc) : 0,
    tax: taxSummary(bundle.lines),
    words: inWords(doc.total, doc.currency),
    nextNumber: doc.status === 'draft' ? await previewNumber(prefixFor(doc.kind, res.locals.profile), doc.issue_date) : null,
  });
});

router.get('/:id/edit', async (req, res, next) => {
  const doc = await load(req);
  if (!doc || doc.discarded_at) return next();
  if (doc.status !== 'draft') {
    req.flash('error', `${doc.number} is finalised and locked. Correct it with a credit or debit note.`);
    return res.redirect(`/invoices/docs/${doc.id}`);
  }
  const lines = await docs.getLines(doc.id);
  res.render('gst/documents/form', await formData(doc.kind, { ...doc, exchange_rate: Number(doc.exchange_rate), lines }));
});

router.post('/:id', async (req, res, next) => {
  const doc = await load(req);
  if (!doc) return next();
  if (doc.status !== 'draft' || doc.discarded_at) return res.redirect(`/invoices/docs/${doc.id}`);
  return save(req, res, { kind: doc.kind, id: doc.id });
});

router.post('/:id/finalise', async (req, res, next) => {
  const doc = await load(req);
  if (!doc) return next();
  const number = await docs.finalise(doc.id, actor(req));
  req.flash('success', `${C.KINDS[doc.kind].label} ${number} finalised and locked.`);
  res.redirect(`/invoices/docs/${doc.id}`);
});

router.post('/:id/cancel', async (req, res, next) => {
  const doc = await load(req);
  if (!doc) return next();
  await docs.cancel(doc.id, str(req.body.reason, 255), actor(req));
  req.flash('success', `${doc.number} cancelled. The number stays used and the record is kept.`);
  res.redirect(`/invoices/docs/${doc.id}`);
});

router.post('/:id/discard', async (req, res, next) => {
  const doc = await load(req);
  if (!doc) return next();
  await docs.discard(doc.id, actor(req));
  req.flash('success', 'Draft discarded.');
  res.redirect(`/invoices/docs?type=${typeOf(doc.kind)}`);
});

router.post('/:id/convert', async (req, res, next) => {
  const doc = await load(req);
  if (!doc) return next();
  const invoiceId = await docs.convertProforma(doc.id, actor(req));
  req.flash('success', `Tax invoice drafted from ${doc.number}. Check the date and details, then finalise it.`);
  res.redirect(`/invoices/docs/${invoiceId}`);
});

router.get('/:id/pdf', async (req, res, next) => {
  const bundle = await docs.loadDocument(idParam(req));
  if (!bundle) return next();
  const copies = req.query.copies === 'both' ? ['original', 'duplicate'] : req.query.copies === 'duplicate' ? ['duplicate'] : ['original'];
  const pdf = await renderPdf(bundle, { copies });
  res.set({
    'Content-Type': 'application/pdf',
    'Content-Disposition': `${req.query.download ? 'attachment' : 'inline'}; filename="${fileName(bundle.doc)}"`,
    'Cache-Control': 'private, no-store',
  });
  res.send(pdf);
});

router.post('/:id/email', async (req, res, next) => {
  const doc = await load(req);
  if (!doc) return next();
  const ok = await emailDocument(doc.id, {
    to: req.body.to, cc: req.body.cc, subject: str(req.body.subject, 200), message: str(req.body.message, 5000), duplicate: req.body.duplicate === '1',
  }, actor(req));
  req.flash(ok ? 'success' : 'error', ok ? `${docTitle(doc)} ${doc.number} emailed with the PDF attached.` : 'The email could not be sent. Check the SMTP settings; the attempt is in the audit log.');
  res.redirect(`/invoices/docs/${doc.id}`);
});

router.post('/:id/payments', async (req, res, next) => {
  const doc = await load(req);
  if (!doc) return next();
  const { invoice } = await recordPayment(doc.id, req.body, actor(req));
  req.flash('success', invoice.status === 'paid' ? `Payment recorded. ${doc.number} is fully paid.` : 'Payment recorded.');
  res.redirect(`/invoices/docs/${doc.id}#payments`);
});

// The e-invoice (IRP) request for this document, ready for when e-invoicing is switched on.
router.get('/:id/einvoice.json', async (req, res, next) => {
  const bundle = await docs.loadDocument(idParam(req));
  if (!bundle) return next();
  const payload = buildPayload(bundle);
  res.set({ 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': `attachment; filename="einvoice-${String(bundle.doc.number).replace(/\//g, '-')}.json"` });
  res.send(JSON.stringify(payload, null, 2));
});

module.exports = router;
