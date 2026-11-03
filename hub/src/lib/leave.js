'use strict';

// Leave rules: yearly allowances, working-day counting (Mon–Fri, minus public and company holidays), balances
// and who may approve whose request.
const { db } = require('../db');
const { addDays } = require('./util');

const TYPES = {
  casual: { label: 'Casual leave', allowance: 12, tone: 'blue' },
  sick: { label: 'Sick leave', allowance: 6, tone: 'amber' },
  earned: { label: 'Earned leave', allowance: 15, tone: 'green' },
  unpaid: { label: 'Unpaid leave', allowance: null, tone: 'grey' },
};

const dow = (ymd) => new Date(`${ymd}T00:00:00Z`).getUTCDay();

/** Working days between two dates, inclusive. A single half-day counts 0.5. */
async function workingDays(start, end, half) {
  const holidays = new Set((await db('holidays').whereBetween('date', [start, end]).whereIn('kind', ['public', 'company']).pluck('date')).map((d) => String(d).slice(0, 10)));
  let n = 0;
  for (let d = start, guard = 0; d <= end && guard < 400; d = addDays(d, 1), guard += 1) {
    const w = dow(d);
    if (w !== 0 && w !== 6 && !holidays.has(d)) n += 1;
  }
  return half && start === end && n === 1 ? 0.5 : n;
}

/** Days used and pending per leave type in a calendar year. */
async function balances(userId, year) {
  const rows = await db('leave_requests').where({ user_id: userId }).whereIn('status', ['approved', 'pending'])
    .whereBetween('start_date', [`${year}-01-01`, `${year}-12-31`]).select('type', 'status', 'days');
  return Object.entries(TYPES).map(([key, t]) => {
    const used = rows.filter((r) => r.type === key && r.status === 'approved').reduce((s, r) => s + Number(r.days), 0);
    const pending = rows.filter((r) => r.type === key && r.status === 'pending').reduce((s, r) => s + Number(r.days), 0);
    return { key, ...t, used, pending, left: t.allowance === null ? null : Math.max(0, t.allowance - used - pending) };
  });
}

/** Owners decide anyone's request. Admins decide staff requests. Nobody decides their own. */
function canDecide(approver, requesterRole, requesterId) {
  if (approver.id === requesterId) return false;
  if (approver.role === 'owner') return true;
  return approver.role === 'admin' && requesterRole === 'staff';
}

async function pendingFor(approver) {
  const rows = await db('leave_requests as l').join('users as u', 'u.id', 'l.user_id').where('l.status', 'pending')
    .orderBy('l.start_date').select('l.*', 'u.name as user_name', 'u.role as user_role', 'u.job_title');
  return rows.filter((r) => canDecide(approver, r.user_role, r.user_id));
}

module.exports = { TYPES, workingDays, balances, canDecide, pendingFor };
