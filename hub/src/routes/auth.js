'use strict';

const express = require('express');
const rateLimit = require('express-rate-limit');
const { db } = require('../db');
const {
  verifyPassword, hashPassword, passwordProblem, signIn, homeFor, createPasswordLink, findByPasswordToken,
} = require('../lib/auth');
const { sendMail } = require('../lib/mailer');
const google = require('../lib/google');
const { nowSql, str, randomToken, safeEqual } = require('../lib/util');

const router = express.Router();

// Only failed sign-ins count, so a team or college lab behind one IP isn't locked out by normal use.
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 12, skipSuccessfulRequests: true, standardHeaders: 'draft-7', legacyHeaders: false });

const safeNext = (n) => (typeof n === 'string' && n.startsWith('/') && !n.startsWith('//') ? n : null);

router.get('/login', (req, res) => {
  if (req.user) return res.redirect(homeFor(req.user));
  res.render('auth/login', { title: 'Sign in', email: '', next: safeNext(req.query.next) || '', error: null });
});

router.post('/login', loginLimiter, async (req, res) => {
  const email = (str(req.body.email, 190) || '').toLowerCase();
  const user = email ? await db('users').where({ email }).first() : null;
  const ok = user && user.is_active && await verifyPassword(req.body.password || '', user.password_hash);
  if (!ok) {
    return res.status(401).render('auth/login', {
      title: 'Sign in', email, next: safeNext(req.body.next) || '', error: 'That email and password don’t match an active account.',
    });
  }
  await finishSignIn(req, res, user, req.body.next);
});

/** Signs the user in and sends them where they were going, if that page is theirs to see. */
async function finishSignIn(req, res, user, next) {
  await db('users').where({ id: user.id }).update({ last_login_at: nowSql() });
  signIn(req, user);
  const target = safeNext(next);
  const allowed = target && (user.role === 'client' ? target.startsWith('/portal') || target.startsWith('/i/') || target.startsWith('/q/') : true);
  res.redirect(allowed ? target : homeFor(user));
}

// ---- Sign in with Google (only for people who already have an account) ----

const googleFailed = (req, res, error, status = 401) => res.status(status).render('auth/login', { title: 'Sign in', email: '', next: '', error });

router.get('/auth/google', (req, res, next) => {
  if (!google.enabled()) return next();
  if (req.user) return res.redirect(homeFor(req.user));
  const state = randomToken(16);
  const nonce = randomToken(16);
  req.session.google = { state, nonce, next: safeNext(req.query.next) || '', at: Date.now() };
  res.redirect(google.authUrl({ state, nonce }));
});

router.get('/auth/google/callback', loginLimiter, async (req, res, next) => {
  if (!google.enabled()) return next();
  const pending = req.session.google;
  delete req.session.google;
  if (req.query.error) return googleFailed(req, res, 'Google sign-in was cancelled.', 400);
  const fresh = pending && Date.now() - pending.at < 10 * 60 * 1000;
  if (!fresh || typeof req.query.state !== 'string' || !safeEqual(req.query.state, pending.state) || typeof req.query.code !== 'string') {
    return googleFailed(req, res, 'That Google sign-in link has expired. Please try again.', 400);
  }
  let who;
  try {
    who = await google.verifiedIdentity(req.query.code, pending.nonce);
  } catch (err) {
    if (err instanceof google.GoogleError) return googleFailed(req, res, err.message);
    throw err;
  }
  const user = await db('users').where({ email: who.email }).first();
  if (!user || !user.is_active) {
    return googleFailed(req, res, `No active account uses ${who.email}. Sign in with the email your Haptags contact invited, or ask them for an invite.`);
  }
  await finishSignIn(req, res, user, pending.next);
});

router.post('/logout', (req, res) => {
  req.session = null;
  res.redirect('/login');
});

router.get('/forgot', (req, res) => {
  res.render('auth/forgot', { title: 'Reset password', sent: false });
});

router.post('/forgot', loginLimiter, async (req, res) => {
  const email = (str(req.body.email, 190) || '').toLowerCase();
  const user = email ? await db('users').where({ email, is_active: true }).first() : null;
  if (user) {
    const link = await createPasswordLink(user.id);
    await sendMail({
      to: user.email,
      subject: 'Reset your Haptags Portal password',
      related: ['user', user.id],
      heading: 'Reset your password',
      lines: [`Hi ${user.name},`, 'Use the button below to choose a new password. The link works for 7 days.', 'If you didn’t ask for this, you can ignore this email.'],
      button: { label: 'Choose a new password', url: link },
    });
  }
  res.render('auth/forgot', { title: 'Reset password', sent: true });
});

router.get('/set-password/:token', async (req, res) => {
  const user = await findByPasswordToken(req.params.token);
  if (!user) {
    return res.status(410).render('public/message', {
      title: 'Link expired', heading: 'This link has expired',
      body: 'Set-password links work for 7 days and only once. Request a new one below.', link: { href: '/forgot', label: 'Send a new link' },
    });
  }
  res.render('auth/set-password', { title: 'Choose a password', user, token: req.params.token, error: null });
});

router.post('/set-password/:token', loginLimiter, async (req, res) => {
  const user = await findByPasswordToken(req.params.token);
  if (!user) return res.redirect(`/set-password/${encodeURIComponent(req.params.token)}`);
  const pw = req.body.password || '';
  const problem = passwordProblem(pw) || (pw !== req.body.confirm ? 'The two passwords don’t match.' : null);
  if (problem) return res.status(422).render('auth/set-password', { title: 'Choose a password', user, token: req.params.token, error: problem });
  await db('users').where({ id: user.id }).update({
    password_hash: await hashPassword(pw),
    invite_token_hash: null,
    invite_expires_at: null,
    token_version: user.token_version + 1,
    last_login_at: nowSql(),
    updated_at: nowSql(),
  });
  signIn(req, { ...user, token_version: user.token_version + 1 });
  req.flash('success', 'Your password is set. Welcome!');
  res.redirect(homeFor(user));
});

module.exports = router;
