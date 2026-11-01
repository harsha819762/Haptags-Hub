'use strict';

// Dashboard figures and the CA's registers. Every total is in INR (paise): documents in a
// foreign currency carry inr_* columns, and payments carry what reached the bank.

const { db } = require('../../db');
const { todayIST, daysBetween, addMonths, financialYear } = require('../util');
const { monthsBetween, monthLabel } = require('../period');
const { displayStatus } = require('./format');
const C = require('./constants');
const { hubIds } = require('./clients');

const OPEN = ['unpaid', 'partially_paid'];
const toInr = (doc, minor) => (doc.currency === 'INR' ? Number(minor) : Math.round(Number(minor) * Number(doc.exchange_rate)));

/** Restricts a query on gst_documents (aliased `d` when joined) to a displayed status. */
function whereStatus(q, status, today, col = (c) => c) {
  if (status === 'overdue') q.whereIn(col('status'), OPEN).where(col('due_date'), '<', today);
  else if (OPEN.includes(status)) q.where(col('status'), status).where((w) => w.whereNull(col('due_date')).orWhere(col('due_date'), '>=', today));
  else if (C.STATUS[status]) q.where(col('status'), status);
  else q.whereNot(col('status'), 'cancelled');
  return q;
}

function invoices({ clientId } = {}) {
  const q = db('gst_documents').where({ kind: 'invoice' }).whereNotNull('number');
  if (clientId) q.where('client_id', clientId);
  return q;
}

async function dashboard({ from, to, clientId = null, status = '' }) {
  const today = todayIST();
  const monthStart = `${today.slice(0, 7)}-01`;
  const prevStart = addMonths(monthStart, -1);
  const prevSameDay = `${prevStart.slice(0, 8)}${today.slice(8, 10)}`;

  const set = await whereStatus(invoices({ clientId }).whereBetween('issue_date', [from, to]), status, today);
  const live = set.filter((d) => d.status !== 'cancelled');
  const sum = (rows, key) => rows.reduce((s, r) => s + Number(r[key] || 0), 0);

  const thisMonth = await invoices({ clientId }).whereNot('status', 'cancelled').where('issue_date', '>=', monthStart).where('issue_date', '<=', today);
  const lastMonth = await invoices({ clientId }).whereNot('status', 'cancelled').where('issue_date', '>=', prevStart).where('issue_date', '<=', prevSameDay);

  const notesQ = db('gst_documents').whereIn('kind', C.NOTE_KINDS).where('status', 'issued').whereBetween('issue_date', [from, to]);
  if (clientId) notesQ.where('client_id', clientId);
  const notes = await notesQ;
  const sign = (n) => (n.kind === 'credit_note' ? -1 : 1);
  const gst = {
    cgst: sum(live, 'inr_cgst') + notes.reduce((s, n) => s + sign(n) * Number(n.inr_cgst), 0),
    sgst: sum(live, 'inr_sgst') + notes.reduce((s, n) => s + sign(n) * Number(n.inr_sgst), 0),
    igst: sum(live, 'inr_igst') + notes.reduce((s, n) => s + sign(n) * Number(n.inr_igst), 0),
  };
  gst.total = gst.cgst + gst.sgst + gst.igst;

  const payQ = db('gst_payments as p').join('gst_documents as d', 'd.id', 'p.document_id').where('p.status', 'active')
    .whereBetween('p.paid_on', [from, to]).select('p.paid_on', 'p.inr_amount', 'p.tds', 'd.currency', 'd.exchange_rate');
  if (clientId) payQ.where('d.client_id', clientId);
  const pays = await payQ;
  const collected = sum(pays, 'inr_amount');
  const tds = pays.reduce((s, p) => s + toInr(p, p.tds), 0);

  const open = live.filter((d) => OPEN.includes(d.status));
  const outstanding = open.reduce((s, d) => s + toInr(d, d.balance), 0);
  const overdueRows = open.filter((d) => displayStatus(d, today) === 'overdue');
  const overdue = overdueRows.reduce((s, d) => s + toInr(d, d.balance), 0);

  // Invoiced vs collected per month (at most the last 24 months of the range).
  let months = monthsBetween(from, to);
  if (months.length > 24) months = months.slice(-24);
  const byMonth = Object.fromEntries(months.map((m) => [m, { invoiced: 0, collected: 0, revenue: 0 }]));
  for (const d of live) if (byMonth[d.issue_date.slice(0, 7)]) { byMonth[d.issue_date.slice(0, 7)].invoiced += Number(d.inr_total); byMonth[d.issue_date.slice(0, 7)].revenue += Number(d.inr_taxable); }
  for (const n of notes) if (byMonth[n.issue_date.slice(0, 7)]) byMonth[n.issue_date.slice(0, 7)].revenue += sign(n) * Number(n.inr_taxable);
  for (const p of pays) if (byMonth[p.paid_on.slice(0, 7)]) byMonth[p.paid_on.slice(0, 7)].collected += Number(p.inr_amount) + toInr(p, p.tds);
  const withYear = months.length > 12 || months[0].slice(0, 4) !== months[months.length - 1].slice(0, 4);
  const series = months.map((m) => ({
    key: m, label: monthLabel(m, withYear), tip: monthLabel(m, true), a: byMonth[m].invoiced, b: byMonth[m].collected, revenue: byMonth[m].revenue,
  }));

  const clients = new Map();
  for (const d of live) {
    const c = clients.get(d.client_id) || { id: d.client_id, name: d.bill_name, revenue: 0, invoiced: 0, outstanding: 0, count: 0 };
    c.revenue += Number(d.inr_taxable);
    c.invoiced += Number(d.inr_total);
    if (OPEN.includes(d.status)) c.outstanding += toInr(d, d.balance);
    c.count += 1;
    clients.set(d.client_id, c);
  }
  const topClients = [...clients.values()].sort((a, b) => b.revenue - a.revenue).slice(0, 6);
  const hubs = await hubIds(topClients.map((c) => c.id));
  for (const c of topClients) c.hub = hubs[c.id];

  const overdueAll = (await whereStatus(invoices({ clientId }), 'overdue', today).orderBy('due_date').limit(10))
    .map((d) => ({ ...d, days: daysBetween(d.due_date, today), inrBalance: toInr(d, d.balance) }));

  return {
    today,
    cards: {
      monthInvoiced: sum(thisMonth, 'inr_total'),
      monthCount: thisMonth.length,
      lastMonthToDate: sum(lastMonth, 'inr_total'),
      invoiced: sum(live, 'inr_total'),
      revenue: sum(live, 'inr_taxable') + notes.reduce((s, n) => s + sign(n) * Number(n.inr_taxable), 0),
      count: live.length,
      collected,
      tds,
      outstanding,
      openCount: open.length,
      overdue,
      overdueCount: overdueRows.length,
      gst,
    },
    series,
    topClients,
    overdueAll,
  };
}

const SIGNED = { invoice: 1, debit_note: 1, credit_note: -1 };

/** Every tax invoice and credit/debit note in a date range, as register rows. */
async function salesRegister({ from, to }) {
  const rank = { invoice: 0, credit_note: 1, debit_note: 2 };
  const docs = (await db('gst_documents').whereIn('kind', ['invoice', 'credit_note', 'debit_note']).whereNotNull('number')
    .whereBetween('issue_date', [from, to]))
    .sort((a, b) => a.issue_date.localeCompare(b.issue_date) || rank[a.kind] - rank[b.kind] || a.fy.localeCompare(b.fy) || a.seq - b.seq);
  const lines = docs.length ? await db('gst_document_lines').whereIn('document_id', docs.map((d) => d.id)).select('document_id', 'sac') : [];
  const originals = Object.fromEntries((await db('gst_documents').whereIn('id', docs.map((d) => d.original_id).filter(Boolean)).select('id', 'number', 'issue_date'))
    .map((o) => [o.id, o]));
  const sacs = {};
  for (const l of lines) (sacs[l.document_id] = sacs[l.document_id] || new Set()).add(l.sac);

  const columns = [
    { header: 'Date', width: 12 }, { header: 'Document', width: 13 }, { header: 'Number', width: 16 }, { header: 'Status', width: 13 },
    { header: 'Client', width: 30 }, { header: 'Client GSTIN', width: 18 }, { header: 'Client type', width: 12 }, { header: 'Place of supply', width: 22 },
    { header: 'Supply', width: 10 }, { header: 'Against invoice', width: 16 }, { header: 'SAC', width: 16 },
    { header: 'Taxable value', type: 'money', width: 15 }, { header: 'CGST', type: 'money', width: 13 }, { header: 'SGST', type: 'money', width: 13 },
    { header: 'IGST', type: 'money', width: 13 }, { header: 'Round off', type: 'money', width: 11 }, { header: 'Total (INR)', type: 'money', width: 15 },
    { header: 'Currency', width: 9 }, { header: 'Exchange rate', type: 'rate', width: 12 }, { header: 'Total (currency)', type: 'money', width: 15 },
    { header: 'Received (INR)', type: 'money', width: 15 }, { header: 'TDS', type: 'money', width: 12 }, { header: 'Balance', type: 'money', width: 14 },
    { header: 'Remarks', width: 36 },
  ];
  const totals = { taxable: 0, cgst: 0, sgst: 0, igst: 0, round: 0, total: 0 };
  const rows = docs.map((d) => {
    const cancelled = d.status === 'cancelled';
    const k = cancelled ? 0 : SIGNED[d.kind];
    const v = (minor) => k * Number(minor);
    const inv = d.kind === 'invoice';
    const roundInr = d.currency === 'INR' ? v(d.round_off) : 0;
    totals.taxable += v(d.inr_taxable); totals.cgst += v(d.inr_cgst); totals.sgst += v(d.inr_sgst); totals.igst += v(d.inr_igst);
    totals.round += roundInr; totals.total += v(d.inr_total);
    const orig = originals[d.original_id];
    return [
      d.issue_date, C.KINDS[d.kind].short, d.number, C.STATUS[displayStatus(d)][0], d.bill_name, d.bill_gstin || '',
      d.client_type.toUpperCase(), `${d.pos_code}-${d.pos_name}`, d.supply_type, orig ? `${orig.number} (${orig.issue_date})` : '',
      [...(sacs[d.id] || [])].filter(Boolean).join(', '),
      v(d.inr_taxable), v(d.inr_cgst), v(d.inr_sgst), v(d.inr_igst), roundInr, v(d.inr_total),
      d.currency, d.currency === 'INR' ? '' : Number(d.exchange_rate), d.currency === 'INR' ? '' : v(d.total),
      inv && !cancelled ? toInr(d, d.paid) : '', inv && !cancelled ? toInr(d, d.tds) : '', inv && !cancelled ? toInr(d, d.balance) : '',
      cancelled ? `Cancelled: ${d.cancel_reason || ''}` : d.note_reason || '',
    ];
  });
  rows.push(['', '', '', '', { v: `Total (${docs.length} documents)`, bold: true }, '', '', '', '', '', '',
    { v: totals.taxable, bold: true }, { v: totals.cgst, bold: true }, { v: totals.sgst, bold: true }, { v: totals.igst, bold: true },
    { v: totals.round, bold: true }, { v: totals.total, bold: true }, '', '', '', '', '', '', '']);
  return { columns, rows, count: docs.length, totals };
}

const BUCKETS = [['current', 'Not yet due'], ['1-30', '1–30 days'], ['31-60', '31–60 days'], ['61-90', '61–90 days'], ['90+', 'Over 90 days']];
function bucket(days) {
  if (days <= 0) return 'current';
  if (days <= 30) return '1-30';
  if (days <= 60) return '31-60';
  if (days <= 90) return '61-90';
  return '90+';
}

/** Open invoices with ageing, and a per-client summary. hubClientId narrows it to one Hub client. */
async function outstanding({ hubClientId = null } = {}) {
  const today = todayIST();
  const q = invoices().whereIn('status', OPEN).where('balance', '>', 0).orderBy('due_date').orderBy('seq');
  if (hubClientId) q.whereIn('client_id', db('gst_clients').where({ hub_client_id: hubClientId }).select('id'));
  const docs = await q;
  const items = docs.map((d) => {
    const days = d.due_date ? daysBetween(d.due_date, today) : 0;
    return { ...d, days, bucket: bucket(days), inrBalance: toInr(d, d.balance), status: displayStatus(d, today) };
  });
  const byClient = new Map();
  for (const it of items) {
    const c = byClient.get(it.client_id) || { id: it.client_id, name: it.bill_name, total: 0, count: 0, ...Object.fromEntries(BUCKETS.map((b) => [b[0], 0])) };
    c.total += it.inrBalance;
    c[it.bucket] += it.inrBalance;
    c.count += 1;
    byClient.set(it.client_id, c);
  }
  const clients = [...byClient.values()].sort((a, b) => b.total - a.total);
  const hubs = await hubIds(clients.map((c) => c.id));
  for (const c of clients) c.hub = hubs[c.id];
  const totals = { total: 0, ...Object.fromEntries(BUCKETS.map((b) => [b[0], 0])) };
  for (const c of clients) { totals.total += c.total; for (const [k] of BUCKETS) totals[k] += c[k]; }
  return { today, items, clients, totals, buckets: BUCKETS };
}

function outstandingSheet(report) {
  const columns = [
    { header: 'Invoice', width: 16 }, { header: 'Date', width: 12 }, { header: 'Due', width: 12 }, { header: 'Client', width: 30 },
    { header: 'Client GSTIN', width: 18 }, { header: 'Currency', width: 9 }, { header: 'Invoice total', type: 'money', width: 15 },
    { header: 'Received', type: 'money', width: 14 }, { header: 'TDS', type: 'money', width: 12 }, { header: 'Credit notes', type: 'money', width: 13 },
    { header: 'Debit notes', type: 'money', width: 13 }, { header: 'Balance', type: 'money', width: 14 }, { header: 'Balance (INR)', type: 'money', width: 15 },
    { header: 'Days overdue', type: 'int', width: 12 }, { header: 'Ageing', width: 14 },
  ];
  const label = Object.fromEntries(BUCKETS);
  const rows = report.items.map((d) => [
    d.number, d.issue_date, d.due_date || '', d.bill_name, d.bill_gstin || '', d.currency, Number(d.total), Number(d.paid), Number(d.tds),
    Number(d.credited), Number(d.debited), Number(d.balance), d.inrBalance, Math.max(0, d.days), label[d.bucket],
  ]);
  rows.push(['', '', '', { v: 'Total', bold: true }, '', '', '', '', '', '', '', '', { v: report.totals.total, bold: true }, '', '']);
  return { name: 'Outstanding', columns, rows };
}

/** Financial years that have documents, newest first, always including the current one. */
async function financialYears() {
  const first = await db('gst_documents').min({ d: 'issue_date' }).first();
  const out = [];
  let y = Number(`20${financialYear(todayIST()).slice(0, 2)}`);
  const start = first && first.d ? Number(`20${financialYear(first.d).slice(0, 2)}`) : y;
  for (; y >= start && out.length < 10; y -= 1) out.push(`${String(y).slice(2)}-${String(y + 1).slice(2)}`);
  return out;
}

module.exports = { dashboard, salesRegister, outstanding, outstandingSheet, financialYears, whereStatus, toInr, BUCKETS, OPEN };
