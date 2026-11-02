'use strict';

// Official GST tax invoices for lms.haptags.com payments.
//
// The LMS (apps/php-api on lms.haptags.com) calls issueInvoice() through POST /api/v1/lms/invoice
// once a PhonePe payment succeeds. The student becomes (or is matched to) a Hub student client,
// a tax invoice is drafted and finalised in GST Invoices — so it gets an HTG number, the frozen
// business profile (legal name, GSTIN, PAN, address), CGST+SGST or IGST by place of supply,
// SAC 999293 and the audit trail — and the PhonePe payment is recorded against it, so it is
// issued already PAID. The LMS prints the invoice details in its confirmation email, attaches the
// PDF rendered here, and lets the student download it again from their dashboard.
//
// Amounts in and out are integers in paise, like the rest of GST Invoices.

const config = require('../config');
const { db } = require('../db');
const { nowSql, todayIST, str, isEmail } = require('./util');
const C = require('./gst/constants');
const docs = require('./gst/documents');
const { recordPayment } = require('./gst/payments');
const { getProfile, homeStateCode } = require('./gst/profile');
const { renderPdf } = require('./gst/pdf');
const { inWords } = require('./gst/words');
const { stateCodeFor } = require('./gst/clients');
const { audit } = require('./gst/audit');
const { money } = require('./gst/format');

const LMS_SAC = '999293'; // Online training / LMS courses (seeded in gst_items by migration 008)
const LMS_HOST = 'lms.haptags.com';
const LMS_SITE = `https://${LMS_HOST}`;
const PLAN_LABELS = { internship: 'Full Package (Internship plan)', certificate: 'Certificate plan' };
const PLAN_INCLUDES = {
  internship: 'Includes lesson notes and quizzes, the final exam, daily live doubt-clearing sessions on hub.haptags.com, the capstone project with mentor review, the internship completion certificate and a letter of recommendation.',
  certificate: 'Includes lesson notes and quizzes, the final exam and the verifiable completion certificate.',
};
const TERMS = `Fee for online training on ${LMS_HOST}; course access is activated on payment. Refunds as per the refund policy at ${LMS_HOST}/refund-policy. Subject to Bengaluru jurisdiction.`;

class LmsError extends Error {
  constructor(message, status = 422) {
    super(message);
    this.status = status;
  }
}

const paise = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : NaN;
};

/** A UTC timestamp from the LMS ('2026-11-02 07:15:00.000Z' or ISO) → the date in India; today if unreadable. */
function istDate(value) {
  if (!value) return todayIST();
  let s = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  s = s.replace(' ', 'T');
  if (!/(Z|z|[+-]\d{2}:?\d{2})$/.test(s)) s += 'Z';
  const ms = new Date(s).getTime();
  if (Number.isNaN(ms)) return todayIST();
  return new Date(ms + 5.5 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/** Validates what the LMS sent. Throws LmsError (422) on anything missing. */
function parseRequest(b = {}) {
  const merchantOrderId = str(b.merchant_order_id, 100);
  if (!merchantOrderId || !/^[A-Za-z0-9_-]{6,100}$/.test(merchantOrderId)) throw new LmsError('merchant_order_id is required.');
  const student = b.student || {};
  const course = b.course || {};
  const email = String(student.email || '').trim().toLowerCase();
  if (!isEmail(email)) throw new LmsError('student.email is not valid.');
  const title = str(course.title, 160);
  if (!title) throw new LmsError('course.title is required.');
  const plan = b.plan === 'certificate' ? 'certificate' : 'internship';
  const taxable = paise(b.taxable);
  const discount = Math.max(0, paise(b.discount) || 0);
  const total = paise(b.total);
  const gstRate = Number(b.gst_rate);
  if (!(taxable > 0)) throw new LmsError('taxable must be a positive amount in paise.');
  if (!(total > 0)) throw new LmsError('total must be a positive amount in paise.');
  if (!C.GST_RATES.includes(gstRate)) throw new LmsError(`gst_rate must be one of ${C.GST_RATES.join(', ')}.`);
  const code = String(student.state_code || '').trim();
  const stateCode = /^\d{2}$/.test(code) && C.GST_STATES.some((s) => s[0] === code) ? code : stateCodeFor(student.state);
  return {
    merchantOrderId,
    lmsOrderId: str(b.order_id, 40),
    transactionId: str(b.transaction_id, 190),
    paidOn: istDate(b.paid_at),
    student: { name: str(student.name, 190) || email.split('@')[0], email, phone: str(student.phone, 40), college: str(student.college, 190), stateCode },
    course: { title, slug: str(course.slug, 190), lmsId: str(course.lms_id, 30) },
    plan,
    planLabel: PLAN_LABELS[plan],
    taxable,
    discount,
    total,
    gstRate,
    couponCode: str(b.coupon_code, 100),
  };
}

/** The Hub user the invoice is recorded under: the owner, or the first admin. */
async function systemActor(ip) {
  const u = await db('users').where({ is_active: true }).whereIn('role', ['owner', 'admin'])
    .orderByRaw("CASE WHEN role = 'owner' THEN 0 ELSE 1 END").orderBy('id').first();
  if (!u) throw new LmsError('No active owner/admin in Hub to issue invoices.', 503);
  return { id: u.id, name: 'Haptags LMS', ip: ip || null };
}

/** The student as a Hub client (Education → Students), matched by email, linked to the programme. */
async function studentClient(r) {
  const now = nowSql();
  const program = r.course.lmsId || r.course.slug
    ? await db('programs').where((w) => {
      if (r.course.lmsId) w.orWhere('lms_id', r.course.lmsId);
      if (r.course.slug) w.orWhere('lms_slug', r.course.slug);
    }).orderBy('id').first()
    : null;
  const stateName = r.student.stateCode ? C.stateName(r.student.stateCode) : null;
  const existing = await db('clients').where({ segment: 'student' }).whereRaw('LOWER(email) = ?', [r.student.email]).orderBy('id').first();
  if (existing) {
    const patch = { updated_at: now };
    if (!existing.phone && r.student.phone) patch.phone = r.student.phone;
    if (!existing.college && r.student.college) patch.college = r.student.college;
    if (!existing.state && stateName) patch.state = stateName;
    if (!existing.program_id && program) patch.program_id = program.id;
    if (existing.status !== 'active') patch.status = 'active';
    await db('clients').where({ id: existing.id }).update(patch);
    return { ...existing, ...patch };
  }
  const row = {
    name: r.student.name, email: r.student.email, phone: r.student.phone, college: r.student.college,
    state: stateName, country: 'India', segment: 'student', program_id: program ? program.id : null,
    status: 'active', notes: `Added from a payment on ${LMS_HOST}.`, created_at: now, updated_at: now,
  };
  const [id] = await db('clients').insert(row);
  return { ...row, id: typeof id === 'object' ? id.id : id };
}

/**
 * The gst_clients row for a student. gst/clients.js mirrors only business clients, so students
 * get their mirror here: unregistered (B2C), in India, state from the LMS or the Hub record when
 * known. With no address on record the place of supply is the supplier's own state
 * (IGST Act s.12(2)(b)(ii)), so CGST + SGST applies.
 */
async function gstClient(client, r, profile) {
  const now = nowSql();
  const stateCode = r.student.stateCode || stateCodeFor(client.state) || homeStateCode(profile);
  const row = {
    name: client.name, client_type: 'b2c', contact_person: null, email: client.email, phone: client.phone,
    address: client.address || null, city: client.city || null, pincode: client.pincode || null, country: 'India',
    state_code: stateCode, state_name: C.stateName(stateCode), gstin: null, pan: null,
    notes: `Haptags LMS student${client.college ? ` · ${client.college}` : ''}`, is_active: true, updated_at: now,
  };
  const existing = await db('gst_clients').where({ hub_client_id: client.id }).orderBy('id').first();
  if (existing) {
    await db('gst_clients').where({ id: existing.id }).update(row);
    return { ...existing, ...row };
  }
  const [id] = await db('gst_clients').insert({ ...row, hub_client_id: client.id, created_at: now });
  return { ...row, id: typeof id === 'object' ? id.id : id, hub_client_id: client.id };
}

/** Claims the order so only one invoice is issued for it. Returns { claimed } or { existing }. */
async function claim(r) {
  const existing = await db('lms_invoices').where({ merchant_order_id: r.merchantOrderId }).first();
  if (existing) return { existing };
  try {
    await db('lms_invoices').insert({
      merchant_order_id: r.merchantOrderId, lms_order_id: r.lmsOrderId, request_json: JSON.stringify(r), created_at: nowSql(), updated_at: nowSql(),
    });
    return { claimed: true };
  } catch (err) {
    const again = await db('lms_invoices').where({ merchant_order_id: r.merchantOrderId }).first();
    if (again) return { existing: again };
    throw err;
  }
}

/** Waits for a concurrent request that claimed the same order; null once that request gave up. */
async function awaitDocument(merchantOrderId, tries = 30) {
  for (let i = 0; i < tries; i += 1) {
    const row = await db('lms_invoices').where({ merchant_order_id: merchantOrderId }).first();
    if (!row) return null;
    if (row.document_id) return row;
    await new Promise((resolve) => { setTimeout(resolve, 500); });
  }
  throw new LmsError('The invoice for this order is still being issued. Try again shortly.', 409);
}

const pick = (obj, keys) => Object.fromEntries(keys.map((k) => [k, obj && obj[k] !== undefined && obj[k] !== null ? obj[k] : '']));

/** Everything the LMS prints about an invoice. pdf: true adds the PDF (base64). */
async function summary(documentId, { pdf = false } = {}) {
  const bundle = await docs.loadDocument(documentId);
  if (!bundle) throw new LmsError('Invoice not found.', 404);
  const { doc, lines, supplier, payments } = bundle;
  const n = (v) => Number(v) || 0;
  const line = lines[0] || {};
  const out = {
    number: doc.number,
    document_id: doc.id,
    kind: doc.kind,
    status: doc.status,
    issue_date: String(doc.issue_date || '').slice(0, 10),
    due_date: doc.due_date ? String(doc.due_date).slice(0, 10) : null,
    finalised_at: doc.finalised_at || null,
    supply_type: doc.supply_type,
    supply_label: C.SUPPLY_TYPES[doc.supply_type] || doc.supply_type,
    pos_code: doc.pos_code,
    pos_name: doc.pos_name,
    currency: doc.currency,
    gross: n(doc.gross),
    discount: n(doc.discount),
    taxable: n(doc.taxable),
    cgst: n(doc.cgst),
    sgst: n(doc.sgst),
    igst: n(doc.igst),
    round_off: n(doc.round_off),
    total: n(doc.total),
    paid: n(doc.paid),
    balance: n(doc.balance),
    gst_rate: n(line.gst_rate),
    sac: line.sac || LMS_SAC,
    amount_in_words: inWords(doc.total, doc.currency),
    recipient: {
      name: doc.bill_name, email: doc.bill_email || '', phone: doc.bill_phone || '', address: doc.bill_address || '',
      state_code: doc.bill_state_code || '', state_name: doc.bill_state_name || '', type: doc.client_type,
    },
    supplier: pick(supplier, ['legal_name', 'trade_name', 'gstin', 'pan', 'llpin', 'address', 'city', 'pincode', 'state_code', 'state_name', 'email', 'phone', 'website']),
    lines: lines.map((l) => ({
      description: l.description, sac: l.sac || '', unit: l.unit || '', quantity: n(l.quantity), rate: n(l.rate), gross: n(l.gross),
      discount: n(l.discount), taxable: n(l.taxable), gst_rate: n(l.gst_rate), cgst: n(l.cgst), sgst: n(l.sgst), igst: n(l.igst), total: n(l.total),
    })),
    payments: payments.filter((p) => p.status === 'active').map((p) => ({
      paid_on: String(p.paid_on || '').slice(0, 10), amount: n(p.amount), mode: p.mode, mode_label: C.modeLabel(p.mode), reference: p.reference || '',
    })),
    hub_url: `${config.baseUrl}/invoices/docs/${doc.id}`,
    issued_via: 'Haptags Hub · hub.haptags.com',
  };
  if (pdf) out.pdf_base64 = (await renderPdf(bundle)).toString('base64');
  return out;
}

/**
 * Issues the official tax invoice for a paid LMS order, or returns the one already issued.
 * Resolves to the summary plus `created` (true the first time) and, on a partial failure after
 * the number was taken, `warning`.
 */
async function issueInvoice(body, { ip = null, pdf = false, attempt = 0 } = {}) {
  const r = parseRequest(body);
  const c = await claim(r);
  if (c.existing) {
    const row = c.existing.document_id ? c.existing : await awaitDocument(r.merchantOrderId);
    if (row) return { created: false, ...(await summary(row.document_id, { pdf })) };
    // The other request released its claim (it failed); have one more go ourselves.
    if (attempt >= 1) throw new LmsError('Could not issue the invoice for this order. Try again.', 503);
    return issueInvoice(body, { ip, pdf, attempt: attempt + 1 });
  }

  let documentId = null;
  let warning = null;
  try {
    const profile = await getProfile();
    const who = await systemActor(ip);
    const client = await studentClient(r);
    const gc = await gstClient(client, r, profile);
    const item = await db('gst_items').where({ sac: LMS_SAC }).orderBy('id').first();
    const today = todayIST();
    const description = `${r.course.title} — ${r.planLabel}, online training on ${LMS_HOST}${r.couponCode ? ` (coupon ${r.couponCode})` : ''}`;
    const input = {
      client_id: gc.id,
      issue_date: today,
      due_date: today,
      payment_terms: 'Due on receipt',
      pos_code: gc.state_code,
      currency: 'INR',
      exchange_rate: 1,
      subject: `${r.course.title} — ${r.planLabel} · LMS order ${r.merchantOrderId}`.slice(0, 255),
      notes: [
        `Paid online via PhonePe on ${r.paidOn}${r.transactionId ? ` (transaction ${r.transactionId})` : ''}; LMS order ${r.merchantOrderId}.`,
        PLAN_INCLUDES[r.plan],
        `Course access: ${LMS_SITE}/dashboard.`,
      ].join(' '),
      terms: TERMS,
    };
    const lines = [{
      item_id: item ? item.id : null,
      description: description.slice(0, 500),
      sac: LMS_SAC,
      unit: 'Nos',
      quantity: 1,
      rate: r.taxable + r.discount, // the plan price; the coupon shows as the discount
      discount: r.discount,
      gst_rate: r.gstRate,
    }];
    documentId = await docs.saveDraft({ kind: 'invoice', input, lines, who });
    const number = await docs.finalise(documentId, who);
    await db('lms_invoices').where({ merchant_order_id: r.merchantOrderId }).update({ document_id: documentId, client_id: client.id, updated_at: nowSql() });
    const doc = await db('gst_documents').where({ id: documentId }).first();
    if (Number(doc.total) !== r.total) {
      await audit(who, { entity: 'document', id: documentId, action: 'lms-mismatch', summary: `The LMS collected ${money(r.total)} for order ${r.merchantOrderId} but ${number} totals ${money(doc.total)}. Check the rounding.` });
    }
    try {
      await recordPayment(documentId, {
        amount: (Math.min(Number(doc.balance), r.total) / 100).toFixed(2),
        paid_on: r.paidOn <= today ? r.paidOn : today,
        mode: 'card',
        reference: r.transactionId ? `PhonePe ${r.transactionId}` : `PhonePe order ${r.merchantOrderId}`,
        notes: `Collected by PhonePe on ${LMS_HOST} (order ${r.merchantOrderId}).`,
      }, who);
    } catch (err) {
      warning = `Invoice issued but the payment could not be recorded: ${err.message}`;
      console.error(`[lms-invoice] ${warning}`);
    }
    await audit(who, { entity: 'document', id: documentId, action: 'lms-issued', summary: `${number} issued automatically for ${LMS_HOST} order ${r.merchantOrderId} (${r.student.email}, ${r.course.title}, ${r.planLabel}).` });
  } catch (err) {
    if (documentId) {
      // The number is taken: keep the mapping so the order is not invoiced twice.
      await db('lms_invoices').where({ merchant_order_id: r.merchantOrderId }).update({ document_id: documentId, updated_at: nowSql() });
    } else {
      // Nothing was issued: release the claim so the LMS (or a resync) can try again.
      await db('lms_invoices').where({ merchant_order_id: r.merchantOrderId }).whereNull('document_id').del();
    }
    throw err;
  }
  const out = { created: true, ...(await summary(documentId, { pdf })) };
  if (warning) out.warning = warning;
  return out;
}

/** The lms_invoices row for an order, or null. */
function findByOrder(merchantOrderId) {
  return db('lms_invoices').where({ merchant_order_id: String(merchantOrderId || '') }).whereNotNull('document_id').first();
}

/** The PDF of an order's invoice as { filename, pdf }, or null when there is none. */
async function invoicePdf(merchantOrderId) {
  const row = await findByOrder(merchantOrderId);
  if (!row) return null;
  const bundle = await docs.loadDocument(row.document_id);
  if (!bundle || !bundle.doc.number) return null;
  return { filename: `Tax-Invoice-${String(bundle.doc.number).replace(/\//g, '-')}.pdf`, pdf: await renderPdf(bundle) };
}

module.exports = { issueInvoice, summary, findByOrder, invoicePdf, parseRequest, istDate, LmsError, LMS_SAC, PLAN_LABELS };
