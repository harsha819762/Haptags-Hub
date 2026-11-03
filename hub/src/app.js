'use strict';

const path = require('path');
const express = require('express');
const helmet = require('helmet');
const cookieSession = require('cookie-session');
const config = require('./config');
const { getSettings } = require('./lib/settings');
const { loadUser, requireStaff, requireAdmin, requireClient, homeFor } = require('./lib/auth');
const { csrf, flash, notFound } = require('./lib/middleware');
const viewHelpers = require('./lib/view-helpers');

const app = express();

app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'ejs');
app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      // 'wasm-unsafe-eval' lets the meeting room run its background-blur model (WebAssembly).
      scriptSrc: ["'self'", "'wasm-unsafe-eval'", 'https://checkout.razorpay.com', 'https://*.razorpay.com'],
      workerSrc: ["'self'"],
      mediaSrc: ["'self'", 'blob:'],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
      imgSrc: ["'self'", 'data:', 'blob:', 'https:'],
      connectSrc: ["'self'", 'https://*.razorpay.com'],
      frameSrc: ['https://*.razorpay.com'],
      formAction: ["'self'"],
      frameAncestors: ["'none'"],
      upgradeInsecureRequests: config.isProd ? [] : null,
    },
  },
  crossOriginEmbedderPolicy: false,
}));

app.use('/static', express.static(path.join(__dirname, '..', 'public'), { maxAge: config.isProd ? '7d' : 0 }));
// MediaPipe's segmentation runtime for meeting background effects, served from the pinned npm package.
app.use('/static/vendor/mediapipe', express.static(path.join(__dirname, '..', 'node_modules', '@mediapipe', 'tasks-vision'), {
  maxAge: config.isProd ? '30d' : 0, index: false,
}));
app.get('/favicon.ico', (req, res) => res.redirect(301, '/static/img/haptags-mark.png'));
app.get('/healthz', async (req, res) => {
  try {
    await require('./db').db.raw('select 1');
    res.json({ ok: true, db: true });
  } catch {
    res.status(503).json({ ok: false, db: false });
  }
});

// Webhooks need the raw body for signature checks, so they mount before the body parsers.
app.use('/webhooks', require('./routes/webhooks'));

app.use(express.urlencoded({ extended: false, limit: '300kb' }));
app.use(express.json({ limit: '100kb' }));
app.use(cookieSession({
  name: 'hub_session',
  keys: [config.sessionSecret],
  maxAge: 14 * 24 * 60 * 60 * 1000,
  httpOnly: true,
  sameSite: 'lax',
  secure: config.isProd,
}));

// Wrap views in a layout chosen by folder: admin/*, portal/*, everything else public.
app.use((req, res, next) => {
  const render = res.render.bind(res);
  res.render = (view, locals = {}) => {
    render(view, locals, (err, html) => {
      if (err) return next(err);
      const layout = locals.layout !== undefined ? locals.layout
        : view.startsWith('admin/') ? 'admin' : view.startsWith('portal/') || view.startsWith('team/') ? 'portal' : 'public';
      if (!layout) return res.send(html);
      render(`layouts/${layout}`, { ...locals, body: html }, (err2, page) => (err2 ? next(err2) : res.send(page)));
    });
  };
  next();
});

app.use(async (req, res, next) => {
  res.locals.settings = await getSettings();
  res.locals.h = viewHelpers;
  res.locals.fullPath = req.path;
  res.locals.searchQuery = req.path === '/admin/search' ? String(req.query.q || '') : '';
  res.locals.baseUrl = config.baseUrl;
  res.locals.adminOn = process.env.ENABLE_ADMIN === '1'; // the legacy back office at /admin
  res.locals.googleSignIn = require('./lib/google').enabled();
  res.locals.title = '';
  next();
});

app.use(loadUser);
app.use(flash);
app.use(csrf);

// Company view for the Haptags team at /team, and the client portal at /portal. The old back office (/admin) is switched off.
app.use('/api/rt', require('./routes/realtime'));
app.use(require('./routes/meet'));
// The lms.haptags.com API (doubt sessions, tax invoices for LMS payments) is called by the LMS server, so it is always on.
app.use(require('./routes/lms'));
// The old back office (leads, finance, education, GST screens...) is off unless ENABLE_ADMIN=1. The tests turn it on.
if (process.env.ENABLE_ADMIN === '1') {
  app.use('/admin', requireStaff, require('./routes/admin'));
} else {
  app.use(['/start', '/api/v1/leads'], notFound); // the public enquiry form feeds that back office, so it is off too
}
app.use('/invoices', requireStaff, (req, res) => res.redirect(`/team/gst${req.url === '/' ? '' : req.url}`)); // GST Invoices moved into the company view
app.get('/', (req, res) => res.redirect(homeFor(req.user)));
app.use(require('./routes/public'));
app.use(require('./routes/auth'));
app.use('/team', requireStaff, require('./routes/team'));
app.use('/portal', requireClient, require('./routes/portal'));

app.use(notFound);

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(`[error] ${req.method} ${req.originalUrl}`, err);
  if (res.headersSent) return;
  const status = err.status || err.statusCode || 500;
  if (req.path.startsWith('/api/') || req.accepts(['html', 'json']) === 'json') {
    return res.status(status).json({ success: false, error: status === 500 ? 'Server error' : err.message });
  }
  res.status(status).render('public/message', {
    title: 'Something went wrong', heading: 'Something went wrong',
    body: config.isProd ? 'The error has been logged. Please try again.' : err.message,
    link: { href: '/', label: 'Go home' },
  });
});

module.exports = app;
