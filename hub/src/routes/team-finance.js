'use strict';

// A simple income / expenses / profit page, fed from bank statements and manual entries. Owners and admins only.
const crypto = require('crypto');
const express = require('express');
const { db } = require('../db');
const F = require('../lib/finance');
const money = require('../lib/money');
const { periodFrom, monthsBetween, monthLabel, PRESETS } = require('../lib/period');
const { nowSql, str, int, isDate, todayIST } = require('../lib/util');

const router = express.Router();
const MAX_CSV = 5 * 1024 * 1024;
const decode = (v) => {
  try { return decodeURIComponent(v || ''); } catch { return ''; }
};

/** Bank CSVs are usually UTF-8, but some banks still export Windows-1252. */
function bufferToText(buf) {
  const utf8 = buf.toString('utf8');
  return utf8.includes('�') ? buf.toString('latin1') : utf8;
}

router.get('/', async (req, res) => {
  const range = await F.dataRange();
  const period = periodFrom(req.query, { earliest: range ? range.from : null, latest: range ? range.to : null, fallback: 'all' });
  const a = await F.analyse(period.from, period.to);
  const byMonth = Object.fromEntries(a.months.map((m) => [m.key, m]));
  const keys = monthsBetween(period.from, period.to).slice(-24);
  const multiYear = keys.length > 12;
  const months = keys.map((k) => ({ key: k, label: monthLabel(k, multiYear), income: Math.max(0, (byMonth[k] || {}).income || 0), expense: Math.max(0, (byMonth[k] || {}).expense || 0) }));
  const peak = Math.max(1, ...months.map((m) => Math.max(m.income, m.expense)));
  const limit = req.query.all ? 500 : 25;
  const [txns, imports, accounts] = await Promise.all([
    db('bank_txns').whereBetween('txn_date', [period.from, period.to]).orderBy('txn_date', 'desc').orderBy('id', 'desc').limit(limit),
    db('bank_imports').orderBy('id', 'desc').limit(5),
    db('bank_txns').distinct('account').orderBy('account').pluck('account'),
  ]);
  res.render('team/finance', {
    title: 'Income & expenses', styles: ['billing', 'board'], a, period, presets: PRESETS, months, peak, txns, imports, accounts, range, CATEGORIES: F.CATEGORIES, CAT: F.CAT, showAll: Boolean(req.query.all),
  });
});

// A bank statement CSV, sent straight from the browser. Re-uploading overlapping statements is safe.
router.post('/import', express.raw({ type: ['text/*', 'application/octet-stream', 'application/vnd.ms-excel'], limit: MAX_CSV }), async (req, res) => {
  const text = Buffer.isBuffer(req.body) ? bufferToText(req.body) : '';
  const account = str(decode(req.get('x-account')), 80) || 'Main account';
  const filename = str(decode(req.get('x-file-name')), 255);
  if (/\.(xlsx?|pdf)$/i.test(filename || '')) {
    return res.status(422).json({ error: 'That’s an Excel or PDF file. Open it in Excel or Google Sheets and download it as CSV, then upload the CSV.' });
  }
  try {
    const r = await F.importStatement({ text, account, filename, userId: req.user.id });
    const message = `Imported ${r.added} new transaction${r.added === 1 ? '' : 's'} from ${account}${r.duplicates ? ` (${r.duplicates} already imported, skipped)` : ''}.`;
    res.json({ ok: true, message });
  } catch (err) {
    res.status(422).json({ error: err.message });
  }
});

router.post('/imports/:id/delete', async (req, res) => {
  await db('bank_txns').where({ import_id: int(req.params.id, 0) }).del();
  await db('bank_imports').where({ id: int(req.params.id, 0) }).del();
  req.flash('success', 'That statement and its transactions were removed.');
  res.redirect('/team/finance');
});

// Money that never touched the bank (cash, a client paying you directly...).
router.post('/entry', async (req, res) => {
  const kind = req.body.kind === 'in' ? 'in' : 'out';
  const amount = money.toPaise(req.body.amount);
  const date = isDate(req.body.date) ? req.body.date : todayIST();
  const category = F.CAT[req.body.category] ? req.body.category : (kind === 'in' ? 'other_income' : 'other_expense');
  if (amount <= 0) {
    req.flash('error', 'Enter an amount greater than zero.');
    return res.redirect('/team/finance');
  }
  await db('bank_txns').insert({
    account: 'Manual entries', txn_date: date, description: str(req.body.description, 500) || (kind === 'in' ? 'Income' : 'Expense'),
    debit: kind === 'out' ? amount : 0, credit: kind === 'in' ? amount : 0, has_balance: false, seq: 0, category, categorized_by: 'user',
    hash: crypto.randomBytes(24).toString('hex'), created_at: nowSql(),
  });
  req.flash('success', `${kind === 'in' ? 'Income' : 'Expense'} of ${money.formatINR(amount)} added.`);
  res.redirect('/team/finance');
});

router.post('/txn/:id', async (req, res) => {
  const t = await db('bank_txns').where({ id: int(req.params.id, 0) }).first();
  if (t && F.CAT[req.body.category]) await db('bank_txns').where({ id: t.id }).update({ category: req.body.category, categorized_by: 'user' });
  res.redirect(req.body.back || '/team/finance');
});

module.exports = router;
