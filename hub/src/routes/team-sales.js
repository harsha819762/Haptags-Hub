'use strict';

// Sales: teammates log what they sold; owners and admins see everyone's and who is contributing what.
// A teammate only ever sees their own entries.
const express = require('express');
const { db } = require('../db');
const { toPaise } = require('../lib/money');
const { nowSql, str, int, isDate, todayIST } = require('../lib/util');

const router = express.Router();
const STATUS = { won: 'Closed', pipeline: 'In talks' };
const MAX_PAISE = 100000000000; // ₹100 crore: catches a mistyped extra zero
const isApprover = (u) => ['owner', 'admin'].includes(u.role);
const ORG = ['owner', 'admin', 'staff'];

const monthOf = (v) => (/^\d{4}-(0[1-9]|1[0-2])$/.test(v || '') ? v : null);
const monthLabel = (m) => new Date(`${m}-01T00:00:00Z`).toLocaleDateString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const shiftMonth = (m, by) => { const [y, mo] = m.split('-').map(Number); const d = new Date(Date.UTC(y, mo - 1 + by, 1)); return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`; };

const day = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v || '').slice(0, 10));
const sum = (rows) => rows.reduce((s, r) => s + Number(r.amount), 0);

async function people() {
  return db('users').whereIn('role', ORG).where({ is_active: true }).orderBy('name').select('id', 'name', 'role');
}

async function clientOptions() {
  return db('clients').where({ status: 'active' }).orderBy('name').select('id', 'name');
}

/** Read and check the form; returns { values, errors, row }. */
async function readForm(req) {
  const b = req.body;
  const values = {
    customer: str(b.customer, 190) || '', title: str(b.title, 190) || '', amount: str(b.amount, 30) || '',
    sale_date: isDate(b.sale_date) ? b.sale_date : '', status: STATUS[b.status] ? b.status : 'won', notes: str(b.notes, 2000) || '',
    client_id: int(b.client_id, 0) || '', user_id: int(b.user_id, 0) || '',
  };
  const errors = {};
  const paise = toPaise(values.amount);
  if (!values.customer) errors.customer = 'Who did you sell to?';
  if (!values.title) errors.title = 'What did you sell?';
  if (!(paise > 0)) errors.amount = 'Enter the amount in rupees.';
  else if (paise > MAX_PAISE) errors.amount = 'That amount looks too large. Check the zeros.';
  if (!values.sale_date) errors.sale_date = 'Pick the date.';
  let client = null;
  if (values.client_id) client = await db('clients').where({ id: values.client_id }).first();
  return { values, errors, paise, client };
}

router.get('/', async (req, res) => {
  const approver = isApprover(req.user);
  const today = todayIST();
  const rawMonth = req.query.month === 'all' ? 'all' : monthOf(req.query.month);
  const month = rawMonth || today.slice(0, 7);
  const staff = await people();
  const who = approver ? int(req.query.who, 0) || null : req.user.id;

  const query = db('sales as s').join('users as u', 'u.id', 's.user_id').leftJoin('clients as c', 'c.id', 's.client_id')
    .orderBy('s.sale_date', 'desc').orderBy('s.id', 'desc').select('s.*', 'u.name as user_name', 'c.name as client_name');
  if (month !== 'all') query.whereRaw('substr(s.sale_date, 1, 7) = ?', [month]);
  if (who) query.where('s.user_id', who);
  const rows = (await query).map((r) => ({ ...r, sale_date: day(r.sale_date) }));

  const won = rows.filter((r) => r.status === 'won');
  const pipeline = rows.filter((r) => r.status === 'pipeline');
  const board = [];
  if (approver) {
    const by = new Map();
    won.forEach((r) => { const e = by.get(r.user_id) || { id: r.user_id, name: r.user_name, total: 0, count: 0 }; e.total += Number(r.amount); e.count += 1; by.set(r.user_id, e); });
    board.push(...[...by.values()].sort((a, b) => b.total - a.total));
  }
  const best = board[0] || null;

  res.render('team/sales', {
    title: 'Sales', rows, month, monthName: month === 'all' ? 'All time' : monthLabel(month), prev: month === 'all' ? null : shiftMonth(month, -1), next: month === 'all' ? null : shiftMonth(month, 1),
    isCurrent: month === today.slice(0, 7), approver, who, staff, board, best, STATUS,
    totals: { won: sum(won), wonCount: won.length, pipeline: sum(pipeline), pipelineCount: pipeline.length, average: won.length ? Math.round(sum(won) / won.length) : 0 },
    clients: await clientOptions(), errors: {}, values: { sale_date: today, status: 'won', user_id: req.user.id }, canCredit: approver, me: req.user.id,
  });
});

router.post('/', async (req, res) => {
  const approver = isApprover(req.user);
  const { values, errors, paise, client } = await readForm(req);
  let owner = req.user.id;
  if (approver && values.user_id) {
    const target = await db('users').where({ id: values.user_id, is_active: true }).whereIn('role', ORG).first();
    if (target) owner = target.id;
  }
  if (Object.keys(errors).length) {
    req.flash('error', Object.values(errors)[0]);
    return res.redirect('/team/sales');
  }
  await db('sales').insert({
    user_id: owner, client_id: client ? client.id : null, customer: values.customer, title: values.title, amount: paise, sale_date: values.sale_date,
    status: values.status, notes: values.notes || null, created_by: req.user.id, created_at: nowSql(), updated_at: nowSql(),
  });
  req.flash('success', `Sale saved: ${values.title} for ${values.customer}.`);
  res.redirect(`/team/sales?month=${values.sale_date.slice(0, 7)}`);
});

/** One entry, if this person may see it: their own, or anyone's for an owner or admin. */
async function loadSale(req, res, next) {
  const sale = await db('sales as s').join('users as u', 'u.id', 's.user_id').where('s.id', int(req.params.id, 0)).select('s.*', 'u.name as user_name').first();
  if (!sale || (sale.user_id !== req.user.id && !isApprover(req.user))) return next('route');
  req.sale = { ...sale, sale_date: day(sale.sale_date) };
  next();
}

router.get('/:id', loadSale, async (req, res) => {
  res.render('team/sale', { title: 'Edit sale', sale: req.sale, clients: await clientOptions(), STATUS, errors: {}, values: null });
});

router.post('/:id', loadSale, async (req, res) => {
  const { values, errors, paise, client } = await readForm(req);
  if (Object.keys(errors).length) {
    return res.status(422).render('team/sale', { title: 'Edit sale', sale: req.sale, clients: await clientOptions(), STATUS, errors, values });
  }
  await db('sales').where({ id: req.sale.id }).update({
    client_id: client ? client.id : null, customer: values.customer, title: values.title, amount: paise, sale_date: values.sale_date,
    status: values.status, notes: values.notes || null, updated_at: nowSql(),
  });
  req.flash('success', 'Sale updated.');
  res.redirect(`/team/sales?month=${values.sale_date.slice(0, 7)}`);
});

router.post('/:id/delete', loadSale, async (req, res) => {
  await db('sales').where({ id: req.sale.id }).del();
  req.flash('success', 'Sale deleted.');
  res.redirect('/team/sales');
});

module.exports = router;
