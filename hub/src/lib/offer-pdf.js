'use strict';

// A4 PDF of an internship offer letter, from offers.letterContent(): letterhead, reference and
// date, the key terms, numbered conditions, the signed stamp, and the intern's acceptance.
// Positions are absolute and pages are broken by hand (pdfkit's own breaks are off).

const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');
const { image } = require('./gst/profile');

const FONT_DIR = path.join(__dirname, 'gst', 'fonts');
const FONTS = Object.fromEntries(['Regular', 'SemiBold', 'Bold'].map((w) => [w, fs.readFileSync(path.join(FONT_DIR, `PlusJakartaSans-${w}.ttf`))]));
const COLOR = { navy: '#02213d', text: '#0b1324', text2: '#334155', muted: '#64748b', hair: '#d5dde7', tint: '#f3f6fa', green: '#15803d', red: '#c81e3a' };
const PAGE_W = 595.28;
const PAGE_H = 841.89;
const X0 = 56;
const W = PAGE_W - X0 * 2;
const TOP = 44;
const LIMIT = PAGE_H - 74;
const BODY = { font: 'Regular', size: 9.4, gap: 2 };

class Letter {
  constructor(pdf, c, images) {
    this.pdf = pdf;
    this.c = c;
    this.images = images;
    this.y = TOP;
  }

  height(str, width, font, size, opts = {}) {
    this.pdf.font(font).fontSize(size);
    return this.pdf.heightOfString(String(str ?? ''), { width, lineGap: BODY.gap, ...opts });
  }

  text(str, x, y, width, font, size, color, opts = {}) {
    this.pdf.font(font).fontSize(size).fillColor(color);
    this.pdf.text(String(str ?? ''), x, y, { width, lineGap: BODY.gap, ...opts });
    return this.height(str, width, font, size, opts);
  }

  rule(y, color = COLOR.hair, width = 0.6, x = X0, w = W) {
    this.pdf.save().lineWidth(width).strokeColor(color).moveTo(x, y).lineTo(x + w, y).stroke().restore();
  }

  ensure(h) {
    if (this.y + h <= LIMIT) return;
    this.pdf.addPage();
    this.watermark();
    this.y = TOP;
    this.text(`${this.c.company.legal_name}  ·  ${this.c.title}  ·  Ref ${this.c.reference}  ·  continued`, X0, this.y, W, 'SemiBold', 7.8, COLOR.muted);
    this.y += 14;
    this.rule(this.y, COLOR.navy, 1);
    this.y += 16;
  }

  watermark() {
    const mark = { draft: 'DRAFT', withdrawn: 'WITHDRAWN' }[this.c.status];
    if (!mark) return;
    this.pdf.save().rotate(-35, { origin: [PAGE_W / 2, PAGE_H / 2] });
    this.pdf.font('Bold').fontSize(mark === 'DRAFT' ? 120 : 84).fillColor(mark === 'DRAFT' ? '#94a3b8' : COLOR.red).fillOpacity(0.1);
    this.pdf.text(mark, 0, PAGE_H / 2 - 56, { width: PAGE_W, align: 'center', lineBreak: false });
    this.pdf.restore();
  }

  letterhead() {
    const { company: co } = this.c;
    let x = X0;
    if (this.images.logo) {
      try {
        this.pdf.image(this.images.logo.data, X0, this.y, { fit: [38, 42], valign: 'top' });
        x = X0 + 48;
      } catch { /* unreadable image */ }
    }
    let ly = this.y + 2;
    ly += this.text(co.legal_name, x, ly, 230, 'Bold', 15, COLOR.navy);
    if (co.tagline) ly += this.text(co.tagline, x, ly, 230, 'Regular', 8, COLOR.muted);
    const rx = X0 + W - 250;
    let ry = this.y + 1;
    for (const line of [co.address, [co.email, co.phone].filter(Boolean).join('  ·  '), co.website]) {
      if (line) ry += this.text(line, rx, ry, 250, 'Regular', 7.6, COLOR.text2, { align: 'right', lineGap: 1.2 });
    }
    this.y = Math.max(ly, ry, this.y + 42) + 8;
    this.rule(this.y, COLOR.navy, 1.4);
    this.y += 16;
  }

  heading() {
    const { c } = this;
    this.text(c.title.toUpperCase(), X0, this.y, W, 'Bold', 12.5, COLOR.navy, { align: 'center', characterSpacing: 1.4 });
    this.y += 22;
    this.text(`Ref: ${c.reference}`, X0, this.y, W / 2, 'SemiBold', 9, COLOR.text);
    this.text(`Date: ${c.date}`, X0 + W / 2, this.y, W / 2, 'SemiBold', 9, COLOR.text, { align: 'right' });
    this.y += 18;
    this.text('To,', X0, this.y, W, 'Regular', 9.6, COLOR.text2);
    this.y += 14;
    c.to.forEach((line, i) => { this.y += this.text(line, X0, this.y, W * 0.7, i ? 'Regular' : 'SemiBold', i ? 9.4 : 10.2, i ? COLOR.text2 : COLOR.text, { lineGap: 1.4 }); });
    this.y += 12;
    this.y += this.text(`Subject: ${c.subject}`, X0, this.y, W, 'SemiBold', 10, COLOR.text) + 10;
    this.y += this.text(c.salutation, X0, this.y, W, BODY.font, BODY.size, COLOR.text) + 6;
  }

  paragraph(str, gapAfter = 7) {
    const h = this.height(str, W, BODY.font, BODY.size, { align: 'justify' });
    this.ensure(h + gapAfter);
    this.text(str, X0, this.y, W, BODY.font, BODY.size, COLOR.text, { align: 'justify' });
    this.y += h + gapAfter;
  }

  label(str) {
    this.ensure(30);
    this.text(str.toUpperCase(), X0, this.y, W, 'SemiBold', 7.6, COLOR.navy, { characterSpacing: 1 });
    this.y += 14;
  }

  details() {
    const rows = this.c.details;
    const kW = 150;
    const pad = 5.5;
    const heights = rows.map(([k, v]) => Math.max(this.height(k, kW - pad * 2, 'Regular', 9, { lineGap: 1.2 }), this.height(v, W - kW - pad * 2, 'SemiBold', 9.4, { lineGap: 1.2 })) + pad * 2);
    this.ensure(heights.reduce((a, b) => a + b, 0) + 12);
    const y0 = this.y;
    let y = y0;
    rows.forEach(([k, v], i) => {
      this.pdf.save().rect(X0, y, kW, heights[i]).fill(COLOR.tint).restore();
      this.text(k, X0 + pad, y + pad, kW - pad * 2, 'Regular', 9, COLOR.muted, { lineGap: 1.2 });
      this.text(v, X0 + kW + pad, y + pad - 0.5, W - kW - pad * 2, 'SemiBold', 9.4, COLOR.text, { lineGap: 1.2 });
      y += heights[i];
      if (i < rows.length - 1) this.rule(y);
    });
    this.pdf.save().lineWidth(0.6).strokeColor(COLOR.hair).rect(X0, y0, W, y - y0).stroke().restore();
    this.y = y + 12;
  }

  terms() {
    this.label('Terms and conditions');
    this.c.terms.forEach((t, i) => {
      const body = t.heading ? `${t.heading}: ${t.text}` : t.text;
      const h = this.height(body, W - 20, 'Regular', 9) + 2;
      this.ensure(h + 4);
      this.text(`${i + 1}.`, X0, this.y, 18, 'SemiBold', 9, COLOR.navy);
      this.pdf.fillColor(COLOR.text);
      if (t.heading) {
        this.pdf.font('SemiBold').fontSize(9).text(`${t.heading}: `, X0 + 20, this.y, { width: W - 20, lineGap: BODY.gap, continued: true, align: 'justify' });
        this.pdf.font('Regular').fillColor(COLOR.text2).text(t.text, { lineGap: BODY.gap, align: 'justify' });
      } else {
        this.text(t.text, X0 + 20, this.y, W - 20, 'Regular', 9, COLOR.text2, { align: 'justify' });
      }
      this.y += h + 4;
    });
    this.y += 6;
  }

  signoff() {
    const { signoff: s } = this.c;
    const showSign = this.images.signature && this.c.status !== 'draft';
    this.ensure(16 + 16 + (showSign ? 76 : 40) + 30);
    this.y += this.text(s.lead, X0, this.y, W, BODY.font, BODY.size, COLOR.text) + 6;
    this.y += this.text(s.company, X0, this.y, W, 'SemiBold', 9.8, COLOR.text) + 4;
    if (showSign) {
      try {
        this.pdf.image(this.images.signature.data, X0 - 4, this.y, { fit: [164, 72], valign: 'center' });
      } catch { /* unreadable image */ }
      this.y += 76;
    } else {
      if (this.c.status === 'draft') this.text('The signature is added when the letter is issued.', X0, this.y + 14, W, 'Regular', 7.6, COLOR.muted);
      this.y += 40;
    }
    if (s.name) this.y += this.text(s.name, X0, this.y, W, 'SemiBold', 9.8, COLOR.text);
    this.y += this.text(s.designation, X0, this.y, W, 'Regular', 9, COLOR.muted) + 14;
  }

  acceptance() {
    const { acceptance: a } = this.c;
    const textH = this.height(a.text, W, BODY.font, BODY.size);
    this.ensure(24 + textH + 60);
    if (this.y > TOP + 40) { // no second rule right under a continuation header
      this.rule(this.y, COLOR.navy, 0.8);
      this.y += 12;
    }
    this.label(a.heading);
    this.y += this.text(a.text, X0, this.y, W, BODY.font, BODY.size, COLOR.text, { align: 'justify' }) + 12;
    if (a.accepted) {
      const h = this.height(a.accepted, W - 20, 'SemiBold', 9.2) + 16;
      this.pdf.save().lineWidth(1).strokeColor(COLOR.green).rect(X0, this.y, W, h).stroke().restore();
      this.text(a.accepted, X0 + 10, this.y + 8, W - 20, 'SemiBold', 9.2, COLOR.green);
      this.y += h + 8;
      return;
    }
    const col = (W - 24) / 3;
    ['Signature', 'Name', 'Date'].forEach((k, i) => {
      const x = X0 + i * (col + 12);
      this.rule(this.y + 24, COLOR.text2, 0.6, x, col);
      this.text(k, x, this.y + 28, col, 'Regular', 8.4, COLOR.muted);
    });
    this.y += 46;
  }
}

function footers(pdf, c) {
  const { start, count } = pdf.bufferedPageRange();
  const co = c.company;
  for (let i = 0; i < count; i += 1) {
    pdf.switchToPage(start + i);
    const y = PAGE_H - 50;
    pdf.save().lineWidth(0.5).strokeColor(COLOR.hair).moveTo(X0, y).lineTo(X0 + W, y).stroke().restore();
    pdf.font('Regular').fontSize(7).fillColor(COLOR.muted);
    pdf.text([co.legal_name, co.llpin && `LLPIN ${co.llpin}`, co.gstin && `GSTIN ${co.gstin}`].filter(Boolean).join('  ·  '), X0, y + 6, { width: W * 0.7, lineBreak: false });
    pdf.text(`Ref ${c.reference}  ·  Page ${i + 1} of ${count}`, X0 + W * 0.5, y + 6, { width: W * 0.5, align: 'right', lineBreak: false });
    pdf.text(`Registered office: ${co.address}`, X0, y + 16, { width: W, lineBreak: false, ellipsis: true });
  }
}

/** content: from offers.letterContent(). Returns a PDF Buffer. */
async function renderOfferPdf(content) {
  const [logo, signature] = await Promise.all([image('logo', content.company.logo_file_id), image('signature', content.company.signature_file_id)]);
  const pdf = new PDFDocument({
    size: 'A4', margin: 0, bufferPages: true, autoFirstPage: false,
    info: { Title: `${content.title} ${content.reference}`, Author: content.company.legal_name, Subject: content.subject, Creator: 'Haptags Hub' },
  });
  for (const [name, data] of Object.entries(FONTS)) pdf.registerFont(name, data);
  const chunks = [];
  pdf.on('data', (b) => chunks.push(b));
  const done = new Promise((resolve, reject) => { pdf.on('end', resolve); pdf.on('error', reject); });

  pdf.addPage();
  const l = new Letter(pdf, content, { logo, signature });
  l.watermark();
  l.letterhead();
  l.heading();
  content.intro.forEach((p) => l.paragraph(p));
  l.details();
  if (content.joining) {
    l.label('Joining');
    l.paragraph(content.joining, 12);
  }
  l.terms();
  content.closing.forEach((p) => l.paragraph(p));
  l.y += 4;
  l.signoff();
  l.acceptance();
  footers(pdf, content);
  pdf.end();
  await done;
  return Buffer.concat(chunks);
}

module.exports = { renderOfferPdf };
