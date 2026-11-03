'use strict';

// Everyone in the Haptags organisation, with their role. Owners and admins can invite people and change roles.
const express = require('express');
const { db } = require('../db');
const rt = require('../lib/realtime');
const { createPasswordLink, INVITE_DAYS, hashPassword, passwordProblem } = require('../lib/auth');
const { sendMail } = require('../lib/mailer');
const { nowSql, str, int, isEmail, todayIST } = require('../lib/util');
const P = require('../lib/permissions');

const router = express.Router();
const ORG_ROLES = ['owner', 'admin', 'staff'];
const canManage = (user) => ['owner', 'admin'].includes(user.role);

router.get('/', async (req, res) => {
  const people = await db('users').whereIn('role', ORG_ROLES).orderByRaw("CASE role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END").orderBy('name');
  const online = new Set(rt.onlineUsers());
  const inviteLink = req.session.inviteLink || null;
  req.session.inviteLink = null;
  const count = (role) => people.filter((p) => p.role === role && p.is_active).length;
  const month = todayIST().slice(0, 7);
  const sales = {};
  if (canManage(req.user)) {
    const rows = await db('sales').where({ status: 'won' }).whereRaw('substr(sale_date, 1, 7) = ?', [month]).select('user_id').sum({ total: 'amount' }).count({ n: '*' }).groupBy('user_id');
    rows.forEach((r) => { sales[r.user_id] = { total: Number(r.total), n: Number(r.n) }; });
  }
  res.render('team/people', {
    title: 'Team', people, online, inviteLink, manage: canManage(req.user), sales, isOwner: req.user.role === 'owner', PERMISSIONS: P.PERMISSIONS, grantsOf: P.grantsOf,
    counts: { total: people.filter((p) => p.is_active).length, owner: count('owner'), admin: count('admin'), staff: count('staff'), online: people.filter((p) => online.has(p.id)).length },
  });
});

router.post('/', async (req, res) => {
  if (!canManage(req.user)) return res.status(403).render('public/message', { title: 'Not allowed', heading: 'Only owners and admins can add people', link: { href: '/team/people', label: 'Back to team' } });
  const name = str(req.body.name, 190);
  const email = (str(req.body.email, 190) || '').toLowerCase();
  const role = ['admin', 'staff'].includes(req.body.role) || (req.body.role === 'owner' && req.user.role === 'owner') ? req.body.role : 'staff';
  const permissions = role === 'staff' ? P.serialise(req.body.perms) : null;
  if (!name || !isEmail(email)) {
    req.flash('error', 'Enter a name and a valid email.');
    return res.redirect('/team/people');
  }
  if (await db('users').where({ email }).first()) {
    req.flash('error', 'That email already has an account.');
    return res.redirect('/team/people');
  }
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  if (password) {
    const problem = passwordProblem(password);
    if (problem) {
      req.flash('error', problem);
      return res.redirect('/team/people');
    }
    await db('users').insert({ name, email, role, permissions, job_title: str(req.body.job_title, 120) || null, password_hash: await hashPassword(password), is_active: true, token_version: 1, created_at: nowSql(), updated_at: nowSql() });
    req.flash('success', `${name} can sign in now with ${email} and the password you set. Ask them to change it from My account.`);
    return res.redirect('/team/people');
  }
  const [uid] = await db('users').insert({ name, email, role, permissions, job_title: str(req.body.job_title, 120) || null, is_active: true, token_version: 1, created_at: nowSql(), updated_at: nowSql() });
  const link = await createPasswordLink(Array.isArray(uid) ? uid[0] : uid);
  const sent = await sendMail({
    to: email, subject: 'You’ve been added to Haptags', heading: 'Welcome to Haptags',
    lines: [`Hi ${name},`, `${req.user.name} added you to the Haptags portal as ${role}. Set your password to get started (the link works for ${INVITE_DAYS} days).`],
    button: { label: 'Set my password', url: link },
  }).catch(() => false);
  req.session.inviteLink = { name, link, sent };
  res.redirect('/team/people');
});

router.post('/:id', async (req, res, next) => {
  if (!canManage(req.user)) return res.redirect('/team/people');
  const user = await db('users').where({ id: int(req.params.id, 0) }).whereIn('role', ORG_ROLES).first();
  if (!user) return next();
  // Nobody changes their own access here. Only an owner can change another owner (or make someone an owner).
  if (user.id === req.user.id || (user.role === 'owner' && req.user.role !== 'owner')) {
    req.flash('error', user.id === req.user.id ? 'You can’t change your own access here.' : 'Only an owner can change another owner’s access.');
    return res.redirect('/team/people');
  }
  if (req.body.action === 'toggle') {
    await db('users').where({ id: user.id }).update({ is_active: !user.is_active, token_version: user.token_version + 1, updated_at: nowSql() });
  } else if (req.body.action === 'role' && (['admin', 'staff'].includes(req.body.role) || (req.body.role === 'owner' && req.user.role === 'owner'))) {
    if (req.body.role !== user.role) {
      await db('users').where({ id: user.id }).update({ role: req.body.role, updated_at: nowSql() });
      const label = { owner: 'an owner, with full access', admin: 'an admin, with full access', staff: 'staff' }[req.body.role];
      req.flash('success', `${user.name} is now ${label}.`);
    }
  } else if (req.body.action === 'access') {
    if (user.role !== 'staff') req.flash('error', `${user.name} is ${user.role === 'owner' ? 'an owner' : 'an admin'}, so they already have access to everything.`);
    else {
      const permissions = P.serialise(req.body.perms);
      await db('users').where({ id: user.id }).update({ permissions, updated_at: nowSql() });
      const names = P.grantsOf({ permissions }).map((k) => P.PERMISSIONS.find((x) => x[0] === k)[1]);
      req.flash('success', names.length ? `${user.name} can now use ${names.join(', ')}.` : `${user.name} now has the standard staff access.`);
    }
  } else if (req.body.action === 'details') {
    const name = str(req.body.name, 190);
    if (!name) req.flash('error', 'A name is required.');
    else {
      await db('users').where({ id: user.id }).update({ name, job_title: str(req.body.job_title, 120) || null, updated_at: nowSql() });
      req.flash('success', 'Saved.');
    }
  } else if (req.body.action === 'password') {
    const password = typeof req.body.password === 'string' ? req.body.password : '';
    const problem = passwordProblem(password);
    if (problem) req.flash('error', problem);
    else {
      await db('users').where({ id: user.id }).update({ password_hash: await hashPassword(password), invite_token_hash: null, token_version: user.token_version + 1, updated_at: nowSql() });
      req.flash('success', `New password set for ${user.name}. They were signed out everywhere.`);
    }
  } else if (req.body.action === 'resend') {
    const link = await createPasswordLink(user.id);
    const sent = await sendMail({
      to: user.email, subject: 'Set your Haptags password', heading: 'Set your password',
      lines: [`Hi ${user.name},`, `Use this link to set your password (works for ${INVITE_DAYS} days).`], button: { label: 'Set my password', url: link },
    }).catch(() => false);
    req.session.inviteLink = { name: user.name, link, sent };
  }
  res.redirect('/team/people');
});

module.exports = router;
