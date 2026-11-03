'use strict';

const { int } = require('../../lib/util');

const idParam = (req, key = 'id') => int(req.params[key], 0);

/** Back to the page the request came from, if it was in this module. */
function back(req, fallback) {
  const ref = req.get('referer');
  if (ref) {
    try {
      const u = new URL(ref);
      if (u.pathname === '/team/gst' || u.pathname.startsWith('/team/gst/')) return u.pathname + u.search;
    } catch { /* ignore */ }
  }
  return fallback;
}

/** Sends a report file and records who exported it. */
function sendFile(res, { name, type, body }) {
  const types = {
    csv: 'text/csv; charset=utf-8',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    json: 'application/json; charset=utf-8',
    gz: 'application/gzip',
  };
  res.set({ 'Content-Type': types[type], 'Content-Disposition': `attachment; filename="${name}"`, 'Cache-Control': 'private, no-store' });
  res.send(body);
}

module.exports = { idParam, back, sendFile };
