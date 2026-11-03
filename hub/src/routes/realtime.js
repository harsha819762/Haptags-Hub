'use strict';

const express = require('express');
const rt = require('../lib/realtime');
const { int } = require('../lib/util');

const router = express.Router();

// A signed-in user's tab (team member or client) subscribes to their notifications. (Meeting guests get their
// credentials from /meet/:token/join instead.)
router.post('/connect', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Sign in again.' });
  res.json(rt.connect({ userId: req.user.id, name: req.user.name }));
});

router.post('/poll', (req, res) => {
  const body = req.body || {};
  const c = rt.auth(body.cid, body.key);
  if (!c) return res.status(401).json({ error: 'Unknown connection', reconnect: true });
  if (c.userId && (!req.user || req.user.id !== c.userId)) return res.status(401).json({ error: 'Signed out', reconnect: true });
  rt.poll(c, int(body.after, NaN), res);
});

module.exports = router;
