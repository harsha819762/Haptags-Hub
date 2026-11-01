'use strict';

// A4 PDF for tax invoices, export invoices, proformas and credit/debit notes, laid out for CGST
// Rule 46 (invoices) and Rule 53 (notes). Haptags navy on white, so it prints well in black.
// All positions are absolute and pages are broken by hand: pdfkit's own page breaks are off.

const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');
const QRCode = require('qrcode');
const C = require('./constants');
const { taxSummary } = require('./tax');
const { inWords } = require('./words');
const { image } = require('./profile');
const { amount, money, qty, docTitle } = require('./format');
const { formatDate } = require('../util');

const FONTS = Object.fromEntries(['Regular', 'SemiBold', 'Bold'].map((w) => [w, fs.readFileSync(path.join(__dirname, 'fonts', `PlusJakartaSans-${w}.ttf`))]));
const COLOR = {
  navy: '#02213d', text: '#0b1324', text2: '#334155', muted: '#64748b', line: '#94a3b8', hair: '#d5dde7', tint: '#eef2f7', red: '#c81e3a',
};
const PAGE_W = 595.28;
const PAGE_H = 841.89;
const X0 = 36;
const W = PAGE_W - 72;
const TOP = 34;
const LIMIT = PAGE_H - 52; // content stops here; the footer sits below
const TOTALS_W = 214; // right-hand column for totals and the signature
const LEFT_W = W - TOTALS_W - 16;

const COPY_LABELS = { original: 'ORIGINAL FOR RECIPIENT', duplicate: 'DUPLICATE FOR SUPPLIER' };
const EXPORT_DECLARATION = 'SUPPLY MEANT FOR EXPORT UNDER LUT WITHOUT PAYMENT OF IGST';

function upiLink(supplier, amountMinor, number) {
  const vpa = String(supplier.upi_id || '').trim().replace(/[^A-Za-z0-9.\-_@]/g, '');
  return `upi://pay?pa=${vpa}&pn=${encodeURIComponent(supplier.upi_name || supplier.legal_name)}&am=${(amountMinor / 100).toFixed(2)}&cu=INR&tn=${encodeURIComponent(`Invoice ${number}`.slice(0, 50))}`;
}

/** What the UPI QR asks for: the balance of a live INR invoice, or an issued proforma's total. */
function amountDue(doc) {
  if (doc.currency !== 'INR' || !doc.number || doc.status === 'cancelled') return 0;
  if (doc.kind === 'invoice') return Math.max(0, Number(doc.balance));
  if (doc.kind === 'proforma' && doc.status === 'issued') return Number(doc.total);
  return 0;
}

class Layout {
  constructor(pdf, ctx) {
    this.pdf = pdf;
    this.ctx = ctx;
    this.y = TOP;
  }

  set(font, size, color = COLOR.text) {
    this.pdf.font(font).fontSize(size).fillColor(color);
    return this;
  }

  height(str, width, font, size, opts = {}) {
    this.pdf.font(font).fontSize(size);
    return this.pdf.heightOfString(String(str ?? ''), { width, lineGap: 1.2, ...opts });
  }

  /** Draws text and returns its height. */
  text(str, x, y, width, font, size, color, opts = {}) {
    this.set(font, size, color);
    this.pdf.text(String(str ?? ''), x, y, { width, lineGap: 1.2, ...opts });
    return this.height(str, width, font, size, opts);
  }

  label(str, x, y, width = 200) {
    return this.text(str, x, y, width, 'SemiBold', 6.8, COLOR.muted, { characterSpacing: 0.8 });
  }

  rule(y, color = COLOR.hair, width = 0.6, x = X0, w = W) {
    this.pdf.save().lineWidth(width).strokeColor(color).moveTo(x, y).lineTo(x + w, y).stroke().restore();
  }

  box(x, y, w, h, { fill = null, stroke = COLOR.hair } = {}) {
    this.pdf.save().lineWidth(0.6);
    if (fill) this.pdf.rect(x, y, w, h).fillAndStroke(fill, stroke || fill);
    else this.pdf.rect(x, y, w, h).strokeColor(stroke).stroke();
    this.pdf.restore();
  }

  /** Starts a new page when the next block won't fit. */
  ensure(h) {
    if (this.y + h <= LIMIT) return;
    this.pdf.addPage();
    this.watermark();
    this.y = TOP;
    this.continuationHeader();
  }

  watermark() {
    const { doc } = this.ctx;
    const mark = doc.status === 'draft' ? 'DRAFT' : doc.status === 'cancelled' ? 'CANCELLED' : null;
    if (!mark) return;
    this.pdf.save();
    this.pdf.rotate(-35, { origin: [PAGE_W / 2, PAGE_H / 2] });
    this.pdf.font('Bold').fontSize(mark === 'DRAFT' ? 120 : 92).fillColor(mark === 'DRAFT' ? '#94a3b8' : COLOR.red).fillOpacity(0.1);
    this.pdf.text(mark, 0, PAGE_H / 2 - 60, { width: PAGE_W, align: 'center', lineBreak: false });
    this.pdf.restore();
  }

  continuationHeader() {
    const { doc, supplier } = this.ctx;
    this.text(`${supplier.legal_name}  ·  ${docTitle(doc)} ${doc.number || '(draft)'}  ·  continued`, X0, this.y, W, 'SemiBold', 8, COLOR.muted);
    this.y += 14;
    this.rule(this.y, COLOR.navy, 1);
    this.y += 10;
  }

  header(copy) {
    const { doc, supplier, logo } = this.ctx;
    const startY = this.y;
    let textX = X0;
    if (logo) {
      try {
        this.pdf.image(logo.data, X0, startY, { fit: [46, 50], valign: 'top' });
        textX = X0 + 56;
      } catch { /* unreadable image: print without it */ }
    }
    const leftW = W - 190 - (textX - X0);
    let y = startY;
    y += this.text(supplier.legal_name, textX, y, leftW, 'Bold', 14, COLOR.navy);
    if (supplier.trade_name && supplier.trade_name.toLowerCase() !== supplier.legal_name.toLowerCase()) {
      y += this.text(`Trade name: ${supplier.trade_name}`, textX, y, leftW, 'Regular', 8, COLOR.text2);
    }
    const address = [String(supplier.address || '').replace(/\s*\n\s*/g, ', '), [supplier.city, supplier.pincode].filter(Boolean).join(' – ')].filter(Boolean).join(', ');
    y += 1 + this.text(address, textX, y + 1, leftW, 'Regular', 8, COLOR.text2);
    y += this.text([`State: ${supplier.state_name} (${supplier.state_code})`, supplier.llpin && `LLPIN: ${supplier.llpin}`].filter(Boolean).join('   ·   '), textX, y, leftW, 'Regular', 8, COLOR.text2);
    y += this.text([`GSTIN: ${supplier.gstin}`, supplier.pan && `PAN: ${supplier.pan}`].filter(Boolean).join('   ·   '), textX, y + 1, leftW, 'SemiBold', 8.4, COLOR.text) + 1;
    const contact = [supplier.email, supplier.phone, String(supplier.website || '').replace(/^https?:\/\//, '')].filter(Boolean).join('   ·   ');
    if (contact) y += this.text(contact, textX, y, leftW, 'Regular', 8, COLOR.text2);

    const rightX = X0 + W - 190;
    let ry = startY;
    ry += this.text(docTitle(doc), rightX, ry, 190, 'Bold', 17, COLOR.navy, { align: 'right', characterSpacing: 0.6 });
    const label = doc.status === 'draft' ? 'DRAFT · NOT VALID FOR GST' : doc.kind === 'proforma' ? 'NOT A TAX INVOICE' : COPY_LABELS[copy];
    const color = doc.status === 'draft' ? COLOR.red : COLOR.navy;
    this.set('SemiBold', 7.2);
    const lw = this.pdf.widthOfString(label, { characterSpacing: 0.8 }) + 14;
    ry += 4;
    this.box(X0 + W - lw, ry, lw, 15, { stroke: color });
    this.text(label, X0 + W - lw, ry + 4, lw, 'SemiBold', 7.2, color, { align: 'center', characterSpacing: 0.8 });
    ry += 15;
    if (doc.status === 'cancelled') {
      ry += 4 + this.text(`CANCELLED${doc.cancelled_at ? ` ON ${formatDate(doc.cancelled_at.slice(0, 10)).toUpperCase()}` : ''}`, rightX, ry + 4, 190, 'Bold', 9, COLOR.red, { align: 'right' });
    }
    this.y = Math.max(y, ry) + 8;
    this.rule(this.y, COLOR.navy, 1.4);
    this.y += 10;
  }

  parties() {
    const { doc } = this.ctx;
    const leftW = 298;
    const gap = 10;
    const rightW = W - leftW - gap;
    const pad = 8;

    const lines = [];
    if (doc.bill_address) lines.push(['Regular', doc.bill_address]);
    lines.push(['Regular', doc.client_type === 'export' ? `Country: ${doc.bill_country}` : `State: ${doc.bill_state_name || '—'} (${doc.bill_state_code || '—'})`]);
    if (doc.bill_gstin) lines.push(['SemiBold', `GSTIN: ${doc.bill_gstin}`]);
    else if (doc.client_type !== 'export') lines.push(['Regular', 'GSTIN: Unregistered']);
    if (doc.bill_pan) lines.push(['Regular', `PAN: ${doc.bill_pan}`]);
    const contact = [doc.bill_contact, doc.bill_phone, doc.bill_email].filter(Boolean).join('  ·  ');
    if (contact) lines.push(['Regular', contact]);
    const innerW = leftW - pad * 2;
    let leftH = pad + 11 + this.height(doc.bill_name, innerW, 'SemiBold', 10) + 2;
    for (const [f, t] of lines) leftH += this.height(t, innerW, f, 8) + 1;
    leftH += pad;

    const kv = this.details();
    const kW = 84;
    const vW = rightW - pad * 2 - kW;
    let rightH = pad;
    for (const [k, v] of kv) rightH += Math.max(this.height(k, kW, 'Regular', 7.6), this.height(v, vW, 'SemiBold', 8)) + 3;
    rightH += pad - 3;

    const h = Math.max(leftH, rightH);
    this.ensure(h + 8);
    const y0 = this.y;
    this.box(X0, y0, leftW, h);
    this.box(X0 + leftW + gap, y0, rightW, h, { fill: '#f8fafc' });

    let y = y0 + pad;
    this.label(C.NOTE_KINDS.includes(doc.kind) ? 'RECIPIENT' : 'BILL TO', X0 + pad, y, innerW);
    y += 11;
    y += this.text(doc.bill_name, X0 + pad, y, innerW, 'SemiBold', 10, COLOR.text) + 2;
    for (const [f, t] of lines) y += this.text(t, X0 + pad, y, innerW, f, 8, f === 'SemiBold' ? COLOR.text : COLOR.text2) + 1;

    const rx = X0 + leftW + gap + pad;
    y = y0 + pad;
    for (const [k, v] of kv) {
      const hk = this.text(k, rx, y + 0.6, kW, 'Regular', 7.6, COLOR.muted);
      const hv = this.text(v, rx + kW, y, vW, 'SemiBold', 8, COLOR.text);
      y += Math.max(hk, hv) + 3;
    }
    this.y = y0 + h + 8;
  }

  details() {
    const { doc, original } = this.ctx;
    const kind = doc.kind;
    const noLabel = { invoice: 'Invoice No.', proforma: 'Proforma No.', credit_note: 'Credit Note No.', debit_note: 'Debit Note No.' }[kind];
    const dateLabel = { invoice: 'Invoice Date', proforma: 'Date', credit_note: 'Note Date', debit_note: 'Note Date' }[kind];
    const kv = [[noLabel, doc.number || 'Draft (not numbered)'], [dateLabel, formatDate(doc.issue_date)]];
    if (kind === 'invoice' && doc.due_date) kv.push(['Due Date', `${formatDate(doc.due_date)}${doc.payment_terms ? ` (${doc.payment_terms})` : ''}`]);
    if (kind === 'proforma' && doc.due_date) kv.push(['Valid Until', formatDate(doc.due_date)]);
    if (original) kv.push(['Against Invoice', `${original.number} dated ${formatDate(original.issue_date)}`]);
    if (doc.note_reason) kv.push(['Reason', doc.note_reason]);
    kv.push(['Place of Supply', `${doc.pos_name} (${doc.pos_code})`]);
    kv.push(['Reverse Charge', doc.reverse_charge ? 'Yes' : 'No']);
    if (doc.currency !== 'INR') kv.push(['Currency', `${doc.currency}  ·  1 ${doc.currency} = ₹${Number(doc.exchange_rate).toFixed(4)}`]);
    if (doc.irn) kv.push(['IRN', doc.irn], ['Ack No. / Date', `${doc.irn_ack_no || ''}${doc.irn_ack_date ? ` / ${formatDate(doc.irn_ack_date.slice(0, 10))}` : ''}`]);
    return kv;
  }

  subject() {
    const { doc } = this.ctx;
    if (!doc.subject) return;
    const h = this.height(`Subject: ${doc.subject}`, W, 'SemiBold', 8.5);
    this.ensure(h + 6);
    this.text(`Subject: ${doc.subject}`, X0, this.y, W, 'SemiBold', 8.5, COLOR.text);
    this.y += h + 6;
  }

  lineColumns() {
    const { doc, lines } = this.ctx;
    const cur = doc.currency === 'INR' ? '₹' : doc.currency;
    const cols = [
      { key: 'n', label: '#', w: 24, align: 'left' },
      { key: 'desc', label: 'Description', w: 0, align: 'left' },
      { key: 'sac', label: 'SAC', w: 44, align: 'left' },
      { key: 'qty', label: 'Qty', w: 46, align: 'right' },
      { key: 'rate', label: `Rate (${cur})`, w: 66, align: 'right' },
      ...(lines.some((l) => Number(l.discount) > 0) ? [{ key: 'disc', label: 'Discount', w: 56, align: 'right' }] : []),
      { key: 'gst', label: doc.supply_type === 'intra' ? 'GST %' : 'IGST %', w: 38, align: 'right' },
      { key: 'taxable', label: `Taxable (${cur})`, w: 76, align: 'right' },
    ];
    cols[1].w = W - cols.reduce((s, c) => s + c.w, 0);
    return cols;
  }

  tableHeader(cols) {
    this.pdf.save().rect(X0, this.y, W, 17).fill(COLOR.tint).restore();
    let x = X0;
    for (const c of cols) {
      this.text(c.label.toUpperCase(), x + 4, this.y + 5, c.w - 8, 'SemiBold', 6.6, COLOR.navy, { align: c.align, characterSpacing: 0.3, lineBreak: false });
      x += c.w;
    }
    this.y += 17;
  }

  linesTable() {
    const { doc, lines } = this.ctx;
    const cols = this.lineColumns();
    this.ensure(17 + 24);
    this.tableHeader(cols);
    lines.forEach((l, i) => {
      const cells = {
        n: String(i + 1),
        desc: l.description,
        sac: l.sac || '',
        qty: `${qty(l.quantity)}${l.unit ? ` ${l.unit}` : ''}`,
        rate: amount(l.rate, doc.currency),
        disc: Number(l.discount) ? amount(l.discount, doc.currency) : '',
        gst: `${Number(l.gst_rate)}%`,
        taxable: amount(l.taxable, doc.currency),
      };
      const h = Math.max(...cols.map((c) => this.height(cells[c.key], c.w - 8, 'Regular', 8))) + 9;
      if (this.y + h > LIMIT) {
        this.ensure(h + 40);
        this.tableHeader(cols);
      }
      let x = X0;
      for (const c of cols) {
        this.text(cells[c.key], x + 4, this.y + 4.5, c.w - 8, 'Regular', 8, c.key === 'desc' ? COLOR.text : COLOR.text2, { align: c.align });
        x += c.w;
      }
      this.y += h;
      this.rule(this.y);
    });
    this.y += 10;
  }

  totalRows() {
    const { doc } = this.ctx;
    const cur = doc.currency;
    const rows = [];
    if (Number(doc.discount)) rows.push(['Gross value', amount(doc.gross, cur)], ['Less: discount', `(${amount(doc.discount, cur)})`]);
    rows.push(['Taxable value', amount(doc.taxable, cur)]);
    if (doc.supply_type === 'intra') rows.push(['CGST', amount(doc.cgst, cur)], ['SGST', amount(doc.sgst, cur)]);
    else rows.push([doc.supply_type === 'export' ? 'IGST @ 0% (LUT)' : 'IGST', amount(doc.igst, cur)]);
    if (cur === 'INR') {
      const ro = Number(doc.round_off);
      rows.push(['Round off', ro < 0 ? `(${amount(-ro, cur)})` : amount(ro, cur)]);
    }
    const after = [];
    if (cur !== 'INR') after.push([`INR equivalent @ ₹${Number(doc.exchange_rate).toFixed(4)}`, money(doc.inr_total, 'INR')]);
    const settled = Number(doc.paid) || Number(doc.tds) || Number(doc.credited) || Number(doc.debited);
    if (doc.kind === 'invoice' && doc.number && doc.status !== 'cancelled' && settled) {
      if (Number(doc.debited)) after.push(['Add: debit notes', amount(doc.debited, cur)]);
      if (Number(doc.credited)) after.push(['Less: credit notes', `(${amount(doc.credited, cur)})`]);
      if (Number(doc.paid)) after.push(['Less: received', `(${amount(doc.paid, cur)})`]);
      if (Number(doc.tds)) after.push(['Less: TDS deducted', `(${amount(doc.tds, cur)})`]);
      after.push(['Balance due', money(Math.max(0, doc.balance), cur)]);
    }
    return { rows, after };
  }

  bankRows() {
    const { doc, supplier } = this.ctx;
    if (doc.kind === 'credit_note') return [];
    return [
      ['Account name', supplier.bank_account_name],
      ['Account no.', supplier.bank_account_number],
      ['IFSC', supplier.bank_ifsc],
      ['Bank', [supplier.bank_name, supplier.bank_branch].filter(Boolean).join(', ')],
      ['SWIFT', doc.currency !== 'INR' ? supplier.bank_swift : ''],
      ['UPI ID', doc.currency === 'INR' ? supplier.upi_id : ''],
    ].filter(([, v]) => v);
  }

  /** Left: amount in words, export declaration, reverse charge, bank details and UPI QR. Right: totals. */
  totals() {
    const { doc, qr } = this.ctx;
    const cur = doc.currency;
    const { rows, after } = this.totalRows();
    const words = inWords(doc.total, cur);
    const lutLine = `LUT ARN: ${doc.lut_number || this.ctx.profile.lut_number || '—'}${doc.lut_valid_until ? `  (valid till ${formatDate(doc.lut_valid_until)})` : ''}`;
    const inner = LEFT_W - 16;
    const bank = this.bankRows();
    const qrSize = 74;
    const valueW = inner - 64 - (qr ? qrSize + 10 : 0);

    const wordsH = 18 + this.height(words, inner, 'SemiBold', 8.5) + 6;
    const declH = doc.supply_type === 'export' ? 12 + this.height(EXPORT_DECLARATION, inner, 'Bold', 8.5) + this.height(lutLine, inner, 'Regular', 8) + 6 : 0;
    const bankRowsH = bank.reduce((s, [, v]) => s + Math.max(12, this.height(v, valueW, 'SemiBold', 7.8) + 2), 0);
    const bankH = bank.length || qr ? 8 + 12 + Math.max(bankRowsH, qr ? qrSize + 12 : 0) + 6 : 0;
    const leftH = wordsH + 8 + (declH ? declH + 8 : 0) + (doc.kind !== 'proforma' ? 16 : 0) + bankH;
    const rightH = rows.length * 14 + 28 + after.length * 14;
    this.ensure(Math.max(leftH, rightH) + 8);
    const y0 = this.y;

    let y = y0;
    this.box(X0, y, LEFT_W, wordsH);
    this.label('AMOUNT IN WORDS', X0 + 8, y + 6, inner);
    this.text(words, X0 + 8, y + 16, inner, 'SemiBold', 8.5, COLOR.text);
    y += wordsH + 8;
    if (declH) {
      this.box(X0, y, LEFT_W, declH, { stroke: COLOR.navy });
      const h1 = this.text(EXPORT_DECLARATION, X0 + 8, y + 6, inner, 'Bold', 8.5, COLOR.navy);
      this.text(lutLine, X0 + 8, y + 7 + h1, inner, 'Regular', 8, COLOR.text2);
      y += declH + 8;
    }
    if (doc.kind !== 'proforma') {
      this.text(`Whether tax is payable under reverse charge: ${doc.reverse_charge ? 'Yes' : 'No'}`, X0, y, LEFT_W, 'Regular', 8, COLOR.text2);
      y += 16;
    }
    if (bankH) {
      this.box(X0, y, LEFT_W, bankH);
      this.label('PAYMENT DETAILS', X0 + 8, y + 7, inner);
      let by = y + 20;
      for (const [k, v] of bank) {
        this.text(k, X0 + 8, by + 0.4, 62, 'Regular', 7.6, COLOR.muted);
        const hv = this.text(v, X0 + 72, by, valueW, 'SemiBold', 7.8, COLOR.text);
        by += Math.max(12, hv + 2);
      }
      if (qr) {
        const qx = X0 + LEFT_W - qrSize - 8;
        this.pdf.image(qr.png, qx, y + 8, { width: qrSize, height: qrSize });
        this.text(`Scan to pay ${money(qr.amount, 'INR')}`, qx - 20, y + 8 + qrSize + 1, qrSize + 28, 'SemiBold', 6.8, COLOR.navy, { align: 'center' });
      }
      y += bankH;
    }

    const tx = X0 + W - TOTALS_W;
    let ry = y0;
    for (const [k, v] of rows) {
      this.text(k, tx, ry, TOTALS_W - 100, 'Regular', 8.4, COLOR.text2);
      this.text(v, tx + TOTALS_W - 100, ry, 100, 'Regular', 8.4, COLOR.text, { align: 'right' });
      ry += 14;
    }
    ry += 2;
    this.pdf.save().rect(tx, ry, TOTALS_W, 22).fill(COLOR.navy).restore();
    const grand = doc.kind === 'credit_note' ? 'Total credit' : doc.kind === 'debit_note' ? 'Total debit' : 'Grand total';
    this.text(`${grand} (${cur === 'INR' ? '₹' : cur})`, tx + 8, ry + 6.5, TOTALS_W - 110, 'SemiBold', 9, '#ffffff');
    this.text(money(doc.total, cur), tx + TOTALS_W - 118, ry + 6, 110, 'Bold', 10, '#ffffff', { align: 'right' });
    ry += 28;
    for (const [k, v] of after) {
      const bold = k === 'Balance due';
      this.text(k, tx, ry, TOTALS_W - 100, bold ? 'SemiBold' : 'Regular', 8.2, bold ? COLOR.text : COLOR.text2);
      this.text(v, tx + TOTALS_W - 100, ry, 100, bold ? 'Bold' : 'Regular', 8.2, COLOR.text, { align: 'right' });
      ry += 14;
    }
    this.y = Math.max(y, ry) + 8;
  }

  taxTable() {
    const { doc, lines } = this.ctx;
    const groups = taxSummary(lines);
    const cur = doc.currency;
    const intra = doc.supply_type === 'intra';
    const cols = intra
      ? [['SAC', 70, 'left'], ['Taxable value', 97, 'right'], ['CGST rate', 52, 'right'], ['CGST amount', 80, 'right'], ['SGST rate', 52, 'right'], ['SGST amount', 80, 'right'], ['Total tax', W - 431, 'right']]
      : [['SAC', 90, 'left'], ['Taxable value', 120, 'right'], ['IGST rate', 70, 'right'], ['IGST amount', 120, 'right'], ['Total tax', W - 400, 'right']];
    const rowOf = (g) => (intra
      ? [g.sac, amount(g.taxable, cur), `${g.gst_rate / 2}%`, amount(g.cgst, cur), `${g.gst_rate / 2}%`, amount(g.sgst, cur), amount(g.tax, cur)]
      : [g.sac, amount(g.taxable, cur), `${g.gst_rate}%`, amount(g.igst, cur), amount(g.tax, cur)]);
    const sum = (k) => groups.reduce((s, g) => s + g[k], 0);
    const totalRow = intra
      ? ['Total', amount(sum('taxable'), cur), '', amount(sum('cgst'), cur), '', amount(sum('sgst'), cur), amount(sum('tax'), cur)]
      : ['Total', amount(sum('taxable'), cur), '', amount(sum('igst'), cur), amount(sum('tax'), cur)];
    const rowH = 15;
    this.ensure(12 + 16 + rowH * (groups.length + 1) + 10);
    this.label('TAX SUMMARY BY SAC', X0, this.y, W);
    this.y += 12;
    this.pdf.save().rect(X0, this.y, W, 16).fill(COLOR.tint).restore();
    let x = X0;
    for (const [label, w, align] of cols) {
      this.text(label.toUpperCase(), x + 4, this.y + 5, w - 8, 'SemiBold', 6.6, COLOR.navy, { align, lineBreak: false, characterSpacing: 0.3 });
      x += w;
    }
    this.y += 16;
    for (const [i, values] of [...groups.map(rowOf), totalRow].entries()) {
      const last = i === groups.length;
      x = X0;
      values.forEach((v, j) => {
        this.text(v, x + 4, this.y + 4, cols[j][1] - 8, last ? 'SemiBold' : 'Regular', 8, COLOR.text, { align: cols[j][2], lineBreak: false });
        x += cols[j][1];
      });
      this.y += rowH;
      this.rule(this.y, last ? COLOR.line : COLOR.hair);
    }
    this.y += 12;
  }

  /** Notes and terms on the left; the authorised signatory on the right. */
  closing() {
    const { doc, supplier, signature } = this.ctx;
    const blocks = [];
    if (doc.kind === 'proforma') blocks.push(['', 'This is a proforma invoice, not a tax invoice. A tax invoice will be issued on receipt of payment or on supply.']);
    if (doc.notes) blocks.push(['NOTES', doc.notes]);
    if (doc.terms) blocks.push(['TERMS & CONDITIONS', doc.terms]);
    const notesH = blocks.reduce((s, [label, body]) => s + (label ? 11 : 0) + this.height(body, LEFT_W, 'Regular', 7.8) + 8, 0);
    const showImage = signature && doc.status !== 'draft';
    const signH = 14 + (showImage ? 70 : 40) + (supplier.signatory_name ? 22 : 12);
    this.ensure(Math.max(notesH, signH));
    const y0 = this.y;

    let y = y0;
    for (const [label, body] of blocks) {
      if (label) {
        this.label(label, X0, y, LEFT_W);
        y += 11;
      }
      y += this.text(body, X0, y, LEFT_W, 'Regular', 7.8, COLOR.text2) + 8;
    }

    const sx = X0 + W - TOTALS_W;
    let sy = y0;
    this.text(`For ${supplier.legal_name}`, sx, sy, TOTALS_W, 'SemiBold', 8.5, COLOR.text, { align: 'center' });
    sy += 14;
    if (showImage) {
      try {
        this.pdf.image(signature.data, sx + 22, sy, { fit: [TOTALS_W - 44, 66], align: 'center', valign: 'center' });
      } catch { /* unreadable image */ }
      sy += 70;
    } else {
      if (doc.status === 'draft') this.text('Signature is added when finalised', sx, sy + 18, TOTALS_W, 'Regular', 7, COLOR.muted, { align: 'center' });
      sy += 36;
      this.rule(sy, COLOR.line, 0.6, sx + 30, TOTALS_W - 60);
      sy += 4;
    }
    if (supplier.signatory_name) {
      sy += this.text(supplier.signatory_name, sx, sy, TOTALS_W, 'SemiBold', 8.2, COLOR.text, { align: 'center' });
      this.text(supplier.signatory_designation || 'Authorised Signatory', sx, sy, TOTALS_W, 'Regular', 7.6, COLOR.muted, { align: 'center' });
    } else if (!showImage) {
      this.text(supplier.signatory_designation || 'Authorised Signatory', sx, sy, TOTALS_W, 'Regular', 7.6, COLOR.muted, { align: 'center' });
    }
    this.y = y0 + Math.max(notesH, signH);
  }
}

function footers(pdf, doc, ranges) {
  for (const { start, count } of ranges) {
    for (let i = 0; i < count; i += 1) {
      pdf.switchToPage(start + i);
      const y = PAGE_H - 38;
      pdf.save().lineWidth(0.5).strokeColor(COLOR.hair).moveTo(X0, y).lineTo(X0 + W, y).stroke().restore();
      const left = doc.status === 'draft'
        ? 'Draft for review. Not a valid tax document until finalised.'
        : `This is a computer-generated ${doc.kind === 'invoice' ? 'invoice' : 'document'}.`;
      pdf.font('Regular').fontSize(7).fillColor(COLOR.muted);
      pdf.text(left, X0, y + 6, { width: W * 0.6, lineBreak: false });
      pdf.text(`${doc.number || 'Draft'}  ·  Page ${i + 1} of ${count}`, X0 + W * 0.5, y + 6, { width: W * 0.5, align: 'right', lineBreak: false });
    }
  }
}

/**
 * Renders a document bundle (from documents.loadDocument) to a PDF Buffer.
 * copies: ['original'], or ['original', 'duplicate'] to add the supplier's copy.
 */
async function renderPdf(bundle, { copies = ['original'] } = {}) {
  const { doc, supplier } = bundle;
  const [logo, signature] = await Promise.all([image('logo', supplier.logo_file_id), image('signature', supplier.signature_file_id)]);
  const due = amountDue(doc);
  const qr = due > 0 && supplier.upi_id
    ? { amount: due, png: await QRCode.toBuffer(upiLink(supplier, due, doc.number), { type: 'png', margin: 1, width: 260, errorCorrectionLevel: 'M' }) }
    : null;
  const ctx = { ...bundle, logo, signature, qr };
  const pdf = new PDFDocument({
    size: 'A4',
    margin: 0,
    bufferPages: true,
    autoFirstPage: false,
    info: {
      Title: `${docTitle(doc)} ${doc.number || '(draft)'}`,
      Author: supplier.legal_name,
      Subject: `${docTitle(doc)} for ${doc.bill_name}`,
      Creator: 'Haptags Hub',
    },
  });
  pdf.registerFont('Regular', FONTS.Regular);
  pdf.registerFont('SemiBold', FONTS.SemiBold);
  pdf.registerFont('Bold', FONTS.Bold);
  const chunks = [];
  pdf.on('data', (c) => chunks.push(c));
  const done = new Promise((resolve, reject) => { pdf.on('end', resolve); pdf.on('error', reject); });

  const ranges = [];
  for (const copy of copies) {
    const start = pdf.bufferedPageRange().count;
    pdf.addPage();
    const layout = new Layout(pdf, ctx);
    layout.watermark();
    layout.header(copy);
    layout.parties();
    layout.subject();
    layout.linesTable();
    layout.totals();
    layout.taxTable();
    layout.closing();
    ranges.push({ start, count: pdf.bufferedPageRange().count - start });
  }
  footers(pdf, doc, ranges);
  pdf.end();
  await done;
  return Buffer.concat(chunks);
}

module.exports = { renderPdf, amountDue, upiLink };
