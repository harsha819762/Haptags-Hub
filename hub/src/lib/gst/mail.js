'use strict';

const { db } = require('../../db');
const { nowSql, isEmail, formatDate } = require('../util');
const { sendMail } = require('../mailer');
const { renderPdf } = require('./pdf');
const { loadDocument } = require('./documents');
const { GstError } = require('./numbering');
const { audit } = require('./audit');
const { money, docTitle } = require('./format');

const fileName = (doc) => `${docTitle(doc).replace(/\s+/g, '-')}-${String(doc.number || `draft-${doc.id}`).replace(/\//g, '-')}.pdf`;

function defaultMessage(doc, supplier) {
  const what = docTitle(doc).toLowerCase().replace(/^\w/, (c) => c.toUpperCase());
  const lines = [`Please find attached ${what.toLowerCase()} ${doc.number} dated ${formatDate(doc.issue_date)} for ${money(doc.total, doc.currency)}.`];
  if (doc.kind === 'invoice' && doc.due_date && Number(doc.balance) > 0) lines.push(`Amount due: ${money(doc.balance, doc.currency)} by ${formatDate(doc.due_date)}.`);
  lines.push(`Thank you for your business.\n\n${supplier.legal_name}`);
  return lines.join('\n\n');
}

/** Emails a finalised document's PDF to the client (and anyone in cc). */
async function emailDocument(id, { to, cc, subject, message, duplicate }, who) {
  const bundle = await loadDocument(id);
  if (!bundle || !bundle.doc.number) throw new GstError('Finalise the document before emailing it.');
  const { doc, supplier } = bundle;
  const recipients = String(to || '').split(/[,;\s]+/).filter(Boolean);
  const copies = String(cc || '').split(/[,;\s]+/).filter(Boolean);
  if (!recipients.length || ![...recipients, ...copies].every(isEmail)) throw new GstError('Enter valid email addresses.');
  const pdf = await renderPdf(bundle, { copies: duplicate ? ['original', 'duplicate'] : ['original'] });
  const body = String(message || defaultMessage(doc, supplier));
  const ok = await sendMail({
    to: recipients.join(', '),
    cc: copies.length ? copies.join(', ') : undefined,
    replyTo: supplier.email || undefined,
    subject: String(subject || `${docTitle(doc)} ${doc.number} from ${supplier.legal_name}`).slice(0, 200),
    related: ['gst_document', doc.id],
    heading: `${docTitle(doc).replace(/\b\w+/g, (w) => w[0] + w.slice(1).toLowerCase())} ${doc.number}`,
    lines: body.split(/\n{2,}/),
    rows: [['Document', doc.number], ['Date', formatDate(doc.issue_date)], ['Amount', money(doc.total, doc.currency)]],
    attachments: [{ filename: fileName(doc), content: pdf, contentType: 'application/pdf' }],
  });
  await db('gst_documents').where({ id }).update({ emailed_at: nowSql() });
  await audit(who, { entity: 'document', id, action: 'emailed', summary: `PDF emailed to ${recipients.join(', ')}${copies.length ? ` (cc ${copies.join(', ')})` : ''}${ok ? '' : ' — not delivered, check the email settings'}` });
  return ok;
}

module.exports = { emailDocument, defaultMessage, fileName };
