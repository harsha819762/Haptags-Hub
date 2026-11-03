'use strict';

// Section access for the team. Owners and admins can use everything. Staff see projects, tasks, support,
// chat, sales, leave and the calendar, plus any section an owner or admin opens to them on the Team page.

const PERMISSIONS = [
  ['billing', 'Billing', 'Quotations, invoices, receipts and confirming payments'],
  ['gst', 'GST Invoices', 'Tax invoices, credit and debit notes, GSTR reports'],
  ['education', 'Education', 'Students, fees, certificates and offer letters'],
  ['finance', 'Income & expenses', 'Bank statements, costs and the CEO view'],
  ['clients', 'Manage clients', 'Add, archive and delete clients, and invite their people'],
  ['projects', 'Manage projects', 'Create, edit and delete projects'],
];
const KEYS = PERMISSIONS.map((p) => p[0]);
const FULL_ACCESS = ['owner', 'admin'];

/** The keys stored on a user (staff only; anything unknown is ignored). */
function grantsOf(user) {
  if (!user || !user.permissions) return [];
  try {
    const list = JSON.parse(user.permissions);
    return Array.isArray(list) ? list.filter((k) => KEYS.includes(k)) : [];
  } catch {
    return [];
  }
}

/** Can this person use a section? Owners and admins always; staff when it was opened to them; clients never. */
function can(user, key) {
  if (!user) return false;
  if (FULL_ACCESS.includes(user.role)) return true;
  return user.role === 'staff' && grantsOf(user).includes(key);
}

/** The value to store for a set of ticked boxes. */
const serialise = (keys) => {
  const list = [...new Set([].concat(keys || []))].filter((k) => KEYS.includes(k));
  return list.length ? JSON.stringify(list) : null;
};

/** Route guard: sign-in first, then the section must be open to them. */
function requireAccess(key) {
  return (req, res, next) => {
    if (!req.user) return res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
    if (can(req.user, key)) return next();
    if (req.user.role === 'client') return require('./middleware').notFound(req, res);
    const label = (PERMISSIONS.find((p) => p[0] === key) || [])[1] || 'this section';
    return res.status(403).render('public/message', {
      title: 'Not allowed', heading: `You don’t have access to ${label}`, body: 'Ask an owner or admin to open it to you on the Team page.',
      link: { href: '/team', label: 'Go to my dashboard' },
    });
  };
}

module.exports = { PERMISSIONS, KEYS, grantsOf, can, serialise, requireAccess };
