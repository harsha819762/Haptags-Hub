'use strict';

// Leave: anyone on the team can request it; owners and admins approve or reject.
const express = require('express');
const { db } = require('../db');
const L = require('../lib/leave');
const { sendMail } = require('../lib/mailer');
const { nowSql, str, int, isDate, todayIST, addDays } = require('../lib/util');

const router = express.Router();
const isApprover = (u) => ['owner', 'admin'].includes(u.role);

router.get('/', async (req, res) => {
  const today = todayIST();
  const year = Number(today.slice(0, 4));
  const [balances, mine, approvals, off, decided] = await Promise.all([
    L.balances(req.user.id, year),
    db('leave_requests as l').leftJoin('users as d', 'd.id', 'l.decided_by').where('l.user_id', req.user.id).orderBy('l.start_date', 'desc').limit(30).select('l.*', 'd.name as decider'),
    isApprover(req.user) ? L.pendingFor(req.user) : [],
    db('leave_requests as l').join('users as u', 'u.id', 'l.user_id').where('l.status', 'approved').where('l.end_date', '>=', today).where('l.start_date', '<=', addDays(today, 45))
      .orderBy('l.start_date').select('l.*', 'u.name as user_name'),
    isApprover(req.user) ? db('leave_requests as l').join('users as u', 'u.id', 'l.user_id').whereIn('l.status', ['approved', 'rejected']).orderBy('l.decided_at', 'desc').limit(6).select('l.*', 'u.name as user_name') : [],
  ]);
  res.render('team/leave', { title: 'Leave', styles: ['billing'], styles: ['billing'], balances, mine, approvals, off, decided, TYPES: L.TYPES, today, errors: {}, values: { type: 'casual', start_date: today, end_date: today }, approver: isApprover(req.user) });
});

router.post('/', async (req, res) => {
  const today = todayIST();
  const values = {
    type: L.TYPES[req.body.type] ? req.body.type : 'casual', start_date: isDate(req.body.start_date) ? req.body.start_date : '', end_date: isDate(req.body.end_date) ? req.body.end_date : '',
    half_day: Boolean(req.body.half_day), reason: str(req.body.reason, 1000) || '',
  };
  if (values.start_date && !values.end_date) values.end_date = values.start_date;
  const errors = {};
  if (!values.start_date) errors.start_date = 'Pick the first day.';
  else if (values.end_date < values.start_date) errors.end_date = 'The last day can’t be before the first.';
  let days = 0;
  if (!Object.keys(errors).length) {
    days = await L.workingDays(values.start_date, values.end_date, values.half_day);
    if (days <= 0) errors.start_date = 'Those dates are weekends or holidays, so there’s nothing to take off.';
    const clash = await db('leave_requests').where({ user_id: req.user.id }).whereIn('status', ['pending', 'approved'])
      .where('start_date', '<=', values.end_date).where('end_date', '>=', values.start_date).first();
    if (clash) errors.start_date = 'You already have leave that overlaps these dates.';
    const bal = (await L.balances(req.user.id, Number(values.start_date.slice(0, 4)))).find((b) => b.key === values.type);
    if (!errors.start_date && bal.left !== null && days > bal.left) errors.type = `You only have ${bal.left} day${bal.left === 1 ? '' : 's'} of ${bal.label.toLowerCase()} left. Choose unpaid leave or fewer days.`;
  }
  if (Object.keys(errors).length) {
    const year = Number(today.slice(0, 4));
    const [balances, mine, approvals, off, decided] = await Promise.all([
      L.balances(req.user.id, year),
      db('leave_requests as l').leftJoin('users as d', 'd.id', 'l.decided_by').where('l.user_id', req.user.id).orderBy('l.start_date', 'desc').limit(30).select('l.*', 'd.name as decider'),
      isApprover(req.user) ? L.pendingFor(req.user) : [], [], [],
    ]);
    return res.status(422).render('team/leave', { title: 'Leave', styles: ['billing'], balances, mine, approvals, off, decided, TYPES: L.TYPES, today, errors, values, approver: isApprover(req.user) });
  }
  const owner = req.user.role === 'owner'; // the owner's own leave needs nobody's approval
  const [id] = await db('leave_requests').insert({
    user_id: req.user.id, type: values.type, start_date: values.start_date, end_date: values.end_date, days, half_day: values.half_day, reason: values.reason || null,
    status: owner ? 'approved' : 'pending', decided_by: owner ? req.user.id : null, decided_at: owner ? nowSql() : null, created_at: nowSql(),
  });
  if (!owner) {
    const approvers = await db('users').whereIn('role', req.user.role === 'staff' ? ['owner', 'admin'] : ['owner']).where({ is_active: true }).select('email');
    for (const a of approvers) {
      await sendMail({ to: a.email, subject: `Leave request from ${req.user.name}`, heading: 'Leave request', lines: [`${req.user.name} asked for ${days} day${days === 1 ? '' : 's'} of ${L.TYPES[values.type].label.toLowerCase()} (${values.start_date} to ${values.end_date}).`, ...(values.reason ? [values.reason] : [])], button: { label: 'Review request', url: `${require('../config').baseUrl}/team/leave` } }).catch(() => false);
    }
  }
  req.flash('success', owner ? 'Leave added to your record.' : `Request sent for ${days} day${days === 1 ? '' : 's'}. You’ll see the decision here.`);
  res.redirect('/team/leave');
});

router.post('/:id/cancel', async (req, res) => {
  const r = await db('leave_requests').where({ id: int(req.params.id, 0), user_id: req.user.id }).whereIn('status', ['pending', 'approved']).first();
  if (r && r.end_date >= todayIST()) {
    await db('leave_requests').where({ id: r.id }).update({ status: 'cancelled' });
    req.flash('success', 'Leave cancelled.');
  }
  res.redirect('/team/leave');
});

router.post('/:id/decide', async (req, res, next) => {
  const r = await db('leave_requests as l').join('users as u', 'u.id', 'l.user_id').where({ 'l.id': int(req.params.id, 0), 'l.status': 'pending' })
    .select('l.*', 'u.name as user_name', 'u.email as user_email', 'u.role as user_role').first();
  if (!r) return next();
  if (!L.canDecide(req.user, r.user_role, r.user_id)) {
    req.flash('error', 'You can’t decide this request.');
    return res.redirect('/team/leave');
  }
  const approve = req.body.action === 'approve';
  const note = str(req.body.note, 500) || null;
  await db('leave_requests').where({ id: r.id }).update({ status: approve ? 'approved' : 'rejected', decided_by: req.user.id, decided_at: nowSql(), decision_note: note });
  await sendMail({
    to: r.user_email, subject: `Your leave was ${approve ? 'approved' : 'not approved'}`, heading: approve ? 'Leave approved' : 'Leave not approved',
    lines: [`${req.user.name} ${approve ? 'approved' : 'did not approve'} your ${L.TYPES[r.type].label.toLowerCase()} from ${r.start_date} to ${r.end_date}.`, ...(note ? [`Note: ${note}`] : [])],
  }).catch(() => false);
  req.flash('success', `${approve ? 'Approved' : 'Rejected'} ${r.user_name}’s request.`);
  res.redirect('/team/leave');
});

module.exports = router;
