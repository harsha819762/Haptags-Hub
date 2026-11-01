'use strict';

// GSTR-1 workbook for the CA, with the sheet names and column headings of the GST offline
// tool's Excel template: b2b, b2cl, b2cs, exp, cdnr, cdnur, hsn(b2b), hsn(b2c) and docs.
// Amounts are INR. Cancelled documents appear only in `docs`, as cancelled.

const { db } = require('../../db');
const C = require('./constants');

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const gstDate = (ymd) => `${ymd.slice(8, 10)}-${MONTHS[Number(ymd.slice(5, 7)) - 1]}-${ymd.slice(0, 4)}`;
const pos = (d) => `${d.pos_code}-${d.pos_name}`;
const toInr = (d, minor) => (d.currency === 'INR' ? Number(minor) : Math.round(Number(minor) * Number(d.exchange_rate)));

/** Which GSTR-1 table an invoice belongs to. */
function section(inv) {
  if (inv.supply_type === 'export') return 'exp';
  if (inv.client_type === 'b2b' && inv.bill_gstin) return 'b2b';
  if (inv.supply_type === 'inter' && Number(inv.inr_total) > C.B2CL_LIMIT) return 'b2cl';
  return 'b2cs';
}

/** A document's lines grouped by tax rate, in INR. */
function byRate(doc, lines) {
  const groups = new Map();
  for (const l of lines) {
    const rate = Number(l.gst_rate);
    const g = groups.get(rate) || { rate, taxable: 0, igst: 0, cgst: 0, sgst: 0 };
    g.taxable += Number(l.taxable);
    g.igst += Number(l.igst);
    g.cgst += Number(l.cgst);
    g.sgst += Number(l.sgst);
    groups.set(rate, g);
  }
  return [...groups.values()].sort((a, b) => a.rate - b.rate).map((g) => ({
    rate: g.rate, taxable: toInr(doc, g.taxable), igst: toInr(doc, g.igst), cgst: toInr(doc, g.cgst), sgst: toInr(doc, g.sgst),
  }));
}

const money = (header, width = 14) => ({ header, type: 'money', width });
const rateCol = { header: 'Rate', type: 'rate', width: 8 };
const cess = money('Cess Amount', 11);

async function buildGstr1({ from, to }) {
  const docs = await db('gst_documents').whereIn('kind', ['invoice', 'credit_note', 'debit_note']).whereNotNull('number')
    .whereBetween('issue_date', [from, to]).orderBy('issue_date').orderBy('seq');
  const live = docs.filter((d) => d.status !== 'cancelled');
  const lines = live.length ? await db('gst_document_lines').whereIn('document_id', live.map((d) => d.id)).orderBy('sort') : [];
  const linesOf = (id) => lines.filter((l) => l.document_id === id);
  const originalIds = [...new Set(live.map((d) => d.original_id).filter(Boolean))];
  const originals = Object.fromEntries((originalIds.length ? await db('gst_documents').whereIn('id', originalIds) : []).map((o) => [o.id, o]));
  const items = await db('gst_items').select('sac', 'name').orderBy('sort');

  const b2b = []; const b2cl = []; const exp = []; const cdnr = []; const cdnur = [];
  const b2cs = new Map();
  const hsn = { b2b: new Map(), b2c: new Map() };
  const addB2cs = (d, g, sign) => {
    const key = `${d.pos_code}|${g.rate}`;
    const row = b2cs.get(key) || { pos: pos(d), rate: g.rate, taxable: 0 };
    row.taxable += sign * g.taxable;
    b2cs.set(key, row);
  };
  const addHsn = (table, d, sign) => {
    for (const l of linesOf(d.id)) {
      const key = `${l.sac}|${Number(l.gst_rate)}`;
      const h = table.get(key) || { sac: l.sac || '', rate: Number(l.gst_rate), quantity: 0, value: 0, taxable: 0, igst: 0, cgst: 0, sgst: 0, desc: '' };
      const service = String(l.sac || '').startsWith('99');
      h.desc = h.desc || (items.find((i) => i.sac === l.sac) || {}).name || l.description;
      if (!service) h.quantity += sign * Number(l.quantity);
      h.taxable += sign * toInr(d, l.taxable);
      h.igst += sign * toInr(d, l.igst);
      h.cgst += sign * toInr(d, l.cgst);
      h.sgst += sign * toInr(d, l.sgst);
      h.value += sign * toInr(d, l.total);
      table.set(key, h);
    }
  };

  for (const d of live) {
    const groups = byRate(d, linesOf(d.id));
    if (d.kind === 'invoice') {
      const s = section(d);
      for (const g of groups) {
        if (s === 'b2b') b2b.push([d.bill_gstin, d.bill_name, d.number, gstDate(d.issue_date), Number(d.inr_total), pos(d), 'N', '', 'Regular B2B', '', g.rate, g.taxable, 0]);
        else if (s === 'b2cl') b2cl.push([d.number, gstDate(d.issue_date), Number(d.inr_total), pos(d), '', g.rate, g.taxable, 0, '']);
        else if (s === 'exp') exp.push(['WOPAY', d.number, gstDate(d.issue_date), Number(d.inr_total), '', '', '', g.rate, g.taxable, 0]);
        else addB2cs(d, g, 1);
      }
      addHsn(s === 'b2b' ? hsn.b2b : hsn.b2c, d, 1);
      continue;
    }
    // Credit and debit notes follow the table of the invoice they adjust.
    const orig = originals[d.original_id] || d;
    const s = section(orig);
    const type = d.kind === 'credit_note' ? 'C' : 'D';
    const sign = d.kind === 'credit_note' ? -1 : 1;
    for (const g of groups) {
      if (s === 'b2b') cdnr.push([d.bill_gstin, d.bill_name, d.number, gstDate(d.issue_date), type, pos(d), 'N', 'Regular B2B', Number(d.inr_total), '', g.rate, g.taxable, 0]);
      else if (s === 'b2cl' || s === 'exp') cdnur.push([s === 'exp' ? 'EXPWOP' : 'B2CL', d.number, gstDate(d.issue_date), type, pos(d), Number(d.inr_total), '', g.rate, g.taxable, 0]);
      else addB2cs(d, g, sign);
    }
    addHsn(s === 'b2b' ? hsn.b2b : hsn.b2c, d, sign);
  }

  const hsnRows = (table) => [...table.values()].sort((a, b) => a.sac.localeCompare(b.sac) || a.rate - b.rate)
    .map((h) => [h.sac, String(h.desc).slice(0, 30), h.sac.startsWith('99') ? 'NA' : 'OTH', h.quantity, h.value, h.rate, h.taxable, h.igst, h.cgst, h.sgst, 0]);
  const hsnColumns = [
    { header: 'HSN', width: 10 }, { header: 'Description', width: 30 }, { header: 'UQC', width: 8 }, { header: 'Total Quantity', type: 'rate', width: 13 },
    money('Total Value', 15), rateCol, money('Taxable Value', 15), money('Integrated Tax Amount', 15), money('Central Tax Amount', 15),
    money('State/UT Tax Amount', 15), cess,
  ];

  // Table 13: documents issued, per series, cancelled ones included.
  const docRows = [];
  const series = new Map();
  for (const d of docs) {
    const key = `${d.kind}|${d.series}|${d.fy}`;
    const s = series.get(key) || { kind: d.kind, first: d, last: d, total: 0, cancelled: 0 };
    if (d.seq < s.first.seq) s.first = d;
    if (d.seq > s.last.seq) s.last = d;
    s.total += 1;
    if (d.status === 'cancelled') s.cancelled += 1;
    series.set(key, s);
  }
  const nature = { invoice: 'Invoices for outward supply', credit_note: 'Credit Note', debit_note: 'Debit Note' };
  const order = Object.keys(nature);
  for (const s of [...series.values()].sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind) || a.first.fy.localeCompare(b.first.fy))) {
    docRows.push([nature[s.kind], s.first.number, s.last.number, s.total, s.cancelled]);
  }

  const b2csRows = [...b2cs.values()].sort((a, b) => a.pos.localeCompare(b.pos) || a.rate - b.rate).map((r) => ['OE', r.pos, '', r.rate, r.taxable, 0, '']);
  const net = (k) => live.reduce((s, d) => s + (d.kind === 'credit_note' ? -1 : 1) * Number(d[k]), 0);

  return [
    {
      name: 'summary',
      columns: [{ header: 'GSTR-1 working', width: 34 }, { header: 'Value', width: 40 }],
      rows: [
        ['Period', `${gstDate(from)} to ${gstDate(to)}`],
        ['Documents (incl. cancelled)', String(docs.length)],
        ['Cancelled', String(docs.length - live.length)],
        ['B2B invoice rows', String(b2b.length)],
        ['B2CL invoice rows', String(b2cl.length)],
        ['B2CS rows (by place of supply and rate)', String(b2csRows.length)],
        ['Export rows (WOPAY)', String(exp.length)],
        ['Credit/debit notes, registered (CDNR)', String(cdnr.length)],
        ['Credit/debit notes, unregistered (CDNUR)', String(cdnur.length)],
        ['Net taxable value (INR)', (net('inr_taxable') / 100).toFixed(2)],
        ['Net IGST (INR)', (net('inr_igst') / 100).toFixed(2)],
        ['Net CGST (INR)', (net('inr_cgst') / 100).toFixed(2)],
        ['Net SGST (INR)', (net('inr_sgst') / 100).toFixed(2)],
        ['Note', 'Sheet names and headings follow the GST offline tool template. Review before filing.'],
      ],
    },
    {
      name: 'b2b',
      columns: [
        { header: 'GSTIN/UIN of Recipient', width: 18 }, { header: 'Receiver Name', width: 28 }, { header: 'Invoice Number', width: 16 },
        { header: 'Invoice date', width: 12 }, money('Invoice Value'), { header: 'Place Of Supply', width: 20 }, { header: 'Reverse Charge', width: 9 },
        { header: 'Applicable % of Tax Rate', width: 10 }, { header: 'Invoice Type', width: 13 }, { header: 'E-Commerce GSTIN', width: 16 },
        rateCol, money('Taxable Value'), cess,
      ],
      rows: b2b,
    },
    {
      name: 'b2cl',
      columns: [
        { header: 'Invoice Number', width: 16 }, { header: 'Invoice date', width: 12 }, money('Invoice Value'), { header: 'Place Of Supply', width: 20 },
        { header: 'Applicable % of Tax Rate', width: 10 }, rateCol, money('Taxable Value'), cess, { header: 'E-Commerce GSTIN', width: 16 },
      ],
      rows: b2cl,
    },
    {
      name: 'b2cs',
      columns: [
        { header: 'Type', width: 6 }, { header: 'Place Of Supply', width: 20 }, { header: 'Applicable % of Tax Rate', width: 10 }, rateCol,
        money('Taxable Value'), cess, { header: 'E-Commerce GSTIN', width: 16 },
      ],
      rows: b2csRows,
    },
    {
      name: 'exp',
      columns: [
        { header: 'Export Type', width: 9 }, { header: 'Invoice Number', width: 16 }, { header: 'Invoice date', width: 12 }, money('Invoice Value'),
        { header: 'Port Code', width: 9 }, { header: 'Shipping Bill Number', width: 14 }, { header: 'Shipping Bill Date', width: 14 }, rateCol,
        money('Taxable Value'), cess,
      ],
      rows: exp,
    },
    {
      name: 'cdnr',
      columns: [
        { header: 'GSTIN/UIN of Recipient', width: 18 }, { header: 'Receiver Name', width: 28 }, { header: 'Note Number', width: 16 },
        { header: 'Note Date', width: 12 }, { header: 'Note Type', width: 8 }, { header: 'Place Of Supply', width: 20 }, { header: 'Reverse Charge', width: 9 },
        { header: 'Note Supply Type', width: 13 }, money('Note Value'), { header: 'Applicable % of Tax Rate', width: 10 }, rateCol,
        money('Taxable Value'), cess,
      ],
      rows: cdnr,
    },
    {
      name: 'cdnur',
      columns: [
        { header: 'UR Type', width: 9 }, { header: 'Note Number', width: 16 }, { header: 'Note Date', width: 12 }, { header: 'Note Type', width: 8 },
        { header: 'Place Of Supply', width: 20 }, money('Note Value'), { header: 'Applicable % of Tax Rate', width: 10 }, rateCol,
        money('Taxable Value'), cess,
      ],
      rows: cdnur,
    },
    { name: 'hsn(b2b)', columns: hsnColumns, rows: hsnRows(hsn.b2b) },
    { name: 'hsn(b2c)', columns: hsnColumns, rows: hsnRows(hsn.b2c) },
    {
      name: 'docs',
      columns: [{ header: 'Nature of Document', width: 28 }, { header: 'Sr. No. From', width: 16 }, { header: 'Sr. No. To', width: 16 }, { header: 'Total Number', type: 'int', width: 12 }, { header: 'Cancelled', type: 'int', width: 10 }],
      rows: docRows,
    },
  ];
}

module.exports = { buildGstr1, section, gstDate };
