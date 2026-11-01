'use strict';

const express = require('express');
const { salesRegister, outstanding, outstandingSheet } = require('../../lib/gst/reports');
const { buildGstr1 } = require('../../lib/gst/gstr1');
const { buildXlsx, buildCsv } = require('../../lib/gst/xlsx');
const { actor, audit } = require('../../lib/gst/audit');
const { fyStart } = require('../../lib/period');
const { todayIST, isDate, addMonths, addDays, int } = require('../../lib/util');
const { GstError } = require('../../lib/gst/numbering');
const { sendFile } = require('./_helpers');

const router = express.Router();

/** Handy ranges for the report forms: months, quarters and financial years. */
function ranges(today) {
  const month = `${today.slice(0, 7)}-01`;
  const fy = fyStart(today);
  const out = [
    ['This month', month, today],
    ['Last month', addMonths(month, -1), addDays(month, -1)],
  ];
  for (let q = 0; q < 4; q += 1) {
    const from = addMonths(fy, q * 3);
    if (from > today) break;
    out.push([`Q${q + 1} (${['Apr–Jun', 'Jul–Sep', 'Oct–Dec', 'Jan–Mar'][q]})`, from, addDays(addMonths(from, 3), -1)]);
  }
  out.push(['This financial year', fy, addDays(addMonths(fy, 12), -1)], ['Last financial year', addMonths(fy, -12), addDays(fy, -1)]);
  return out;
}

function range(query) {
  const from = isDate(query.from) ? query.from : null;
  const to = isDate(query.to) ? query.to : null;
  if (!from || !to || from > to) throw new GstError('Choose a valid date range.');
  return { from, to };
}

router.get('/', async (req, res) => {
  const today = todayIST();
  res.render('gst/reports/index', { title: 'Reports · GST Invoices', ranges: ranges(today), today, month: `${today.slice(0, 7)}-01` });
});

router.get('/sales-register.:ext', async (req, res, next) => {
  if (!['csv', 'xlsx'].includes(req.params.ext)) return next();
  const { from, to } = range(req.query);
  const reg = await salesRegister({ from, to });
  await audit(actor(req), { entity: 'report', action: 'exported', summary: `Sales register ${from} to ${to} exported (${req.params.ext}, ${reg.count} documents)` });
  const name = `sales-register-${from}-to-${to}.${req.params.ext}`;
  if (req.params.ext === 'csv') return sendFile(res, { name, type: 'csv', body: buildCsv(reg) });
  return sendFile(res, { name, type: 'xlsx', body: buildXlsx([{ name: 'Sales register', ...reg }]) });
});

router.get('/gstr1.xlsx', async (req, res) => {
  const { from, to } = range(req.query);
  const sheets = await buildGstr1({ from, to });
  await audit(actor(req), { entity: 'report', action: 'exported', summary: `GSTR-1 workbook ${from} to ${to} exported` });
  sendFile(res, { name: `gstr1-${from}-to-${to}.xlsx`, type: 'xlsx', body: buildXlsx(sheets) });
});

router.get('/outstanding', async (req, res) => {
  const report = await outstanding({ clientId: int(req.query.client, 0) || null });
  res.render('gst/reports/outstanding', { title: 'Outstanding receivables · GST Invoices', report });
});

router.get('/outstanding.:ext', async (req, res, next) => {
  if (!['csv', 'xlsx'].includes(req.params.ext)) return next();
  const report = await outstanding({ clientId: int(req.query.client, 0) || null });
  const sheet = outstandingSheet(report);
  await audit(actor(req), { entity: 'report', action: 'exported', summary: `Outstanding receivables exported (${req.params.ext}, ${report.items.length} invoices)` });
  const name = `outstanding-${report.today}.${req.params.ext}`;
  if (req.params.ext === 'csv') return sendFile(res, { name, type: 'csv', body: buildCsv(sheet) });
  return sendFile(res, { name, type: 'xlsx', body: buildXlsx([sheet]) });
});

module.exports = router;
