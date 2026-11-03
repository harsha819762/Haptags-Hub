'use strict';

// Team calendar (/team/calendar): a month in India time with festivals and holidays highlighted, plus
// meetings, project target dates, task due dates and who is on leave. Owners and admins add company holidays.

const express = require('express');
const { db } = require('../db');
const M = require('../lib/meetings');
const H = require('../lib/holidays');
const { requireAdmin } = require('../lib/auth');
const { todayIST, istToUtc, utcToIst, addDays, addMonths, parseDate, str, int, isDate, nowSql } = require('../lib/util');

const router = express.Router();
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const day = (v) => String(v).slice(0, 10);

router.get('/', async (req, res) => {
  const today = todayIST();
  const month = /^\d{4}-\d{2}$/.test(req.query.month || '') ? req.query.month : today.slice(0, 7);
  const first = `${month}-01`;
  const lead = (parseDate(first).getUTCDay() + 6) % 7; // weeks start on Monday
  const gridStart = addDays(first, -lead);
  const nextMonth = addMonths(first, 1);
  const weeks = Math.ceil((lead + (parseDate(nextMonth) - parseDate(first)) / 86400000) / 7);
  const gridEnd = addDays(gridStart, weeks * 7 - 1);
  const mine = req.query.scope === 'mine';
  const festivals = req.query.festivals !== '0'; // festivals and observances are shown unless switched off

  // Indian holidays: the first visit fetches them; after that they refresh once a day in the background.
  if (!(await db('holidays').first())) await H.syncIfStale();
  else H.syncIfStale();

  const from = istToUtc(gridStart, '00:00');
  const to = istToUtc(addDays(gridEnd, 1), '00:00');
  const [meetings, projects, tasks, leave, holidays] = await Promise.all([
    mine ? M.meetingsFor(req.user.id, { from, to })
      : db('meetings as m').where('m.status', 'scheduled').where('m.starts_at', '>=', from).where('m.starts_at', '<', to).orderBy('m.starts_at').select('m.*'),
    db('projects as p').join('clients as c', 'c.id', 'p.client_id').whereIn('p.status', ['planning', 'in_progress', 'review', 'on_hold'])
      .whereBetween('p.due_date', [gridStart, gridEnd])
      .modify((q) => { if (mine) q.where('p.assigned_to', req.user.id); })
      .select('p.id', 'p.name', 'p.due_date', 'c.name as client_name'),
    db('project_tasks as t').join('projects as p', 'p.id', 't.project_id').whereNot('t.status', 'done').whereNotIn('p.status', ['completed', 'cancelled'])
      .whereBetween('t.due_date', [gridStart, gridEnd])
      .modify((q) => { if (mine) q.where('t.assigned_to', req.user.id); })
      .select('t.id', 't.title', 't.due_date', 'p.name as project_name'),
    db('leave_requests as l').join('users as u', 'u.id', 'l.user_id').where('l.status', 'approved')
      .where('l.start_date', '<=', gridEnd).where('l.end_date', '>=', gridStart)
      .modify((q) => { if (mine) q.where('l.user_id', req.user.id); })
      .select('l.start_date', 'l.end_date', 'l.half_day', 'u.name'),
    H.between(gridStart, gridEnd, { observances: festivals }),
  ]);

  const days = {};
  const add = (date, item) => { (days[date] = days[date] || []).push(item); };
  for (const m of meetings) {
    const t = utcToIst(m.starts_at);
    add(t.date, { kind: 'meeting', time: t.time, title: m.title, href: `/team/chat/meetings/${m.id}` });
  }
  for (const p of projects) add(day(p.due_date), { kind: 'project', title: `${p.name} due`, sub: p.client_name, href: `/team/projects/${p.id}` });
  for (const t of tasks) add(day(t.due_date), { kind: 'task', title: t.title, sub: t.project_name, href: `/team/tasks/${t.id}` });
  for (const l of leave) {
    for (let d = day(l.start_date) < gridStart ? gridStart : day(l.start_date); d <= day(l.end_date) && d <= gridEnd; d = addDays(d, 1)) {
      add(d, { kind: 'leave', title: `${l.name} on leave${l.half_day ? ' (half day)' : ''}`, href: '/team/leave' });
    }
  }
  const order = { meeting: 0, task: 1, project: 2, leave: 3 };
  for (const list of Object.values(days)) list.sort((a, b) => (order[a.kind] - order[b.kind]) || (a.time || '').localeCompare(b.time || ''));

  const byDay = {};
  for (const hd of holidays) (byDay[day(hd.date)] = byDay[day(hd.date)] || []).push(hd);
  const grid = [];
  for (let i = 0; i < weeks * 7; i += 1) {
    const date = addDays(gridStart, i);
    const hs = byDay[date] || [];
    const weekday = i % 7;
    grid.push({
      date, day: Number(date.slice(8)), inMonth: date.slice(0, 7) === month, today: date === today, weekend: weekday >= 5,
      items: days[date] || [], holidays: hs,
      // A day off (public or company holiday) is highlighted strongly; a festival day more lightly.
      tone: hs.some((x) => x.kind !== 'observance') ? 'holiday' : hs.length ? 'festival' : '',
    });
  }
  const [y, mm] = month.split('-').map(Number);
  const monthHolidays = holidays.filter((x) => day(x.date).slice(0, 7) === month);
  const upcoming = await H.between(today, addDays(today, 60), { observances: true }).limit(6);
  res.render('team/calendar', {
    title: 'Calendar', styles: ['calendar'], grid, month, today, mine, festivals, monthHolidays, upcoming,
    label: `${MONTHS[mm - 1]} ${y}`, prev: addMonths(first, -1).slice(0, 7), next: nextMonth.slice(0, 7),
    canManage: ['owner', 'admin'].includes(req.user.role), syncedAt: res.locals.settings.holidays_synced_at, feedOn: Boolean(H.feedUrl()),
  });
});

const back = (req, date) => `/team/calendar?month=${(date || req.body.month || todayIST()).slice(0, 7)}#holidays`;

router.post('/holidays', requireAdmin, async (req, res) => {
  const name = str(req.body.name, 190);
  const date = isDate(req.body.date) ? req.body.date : null;
  if (!name || !date) {
    req.flash('error', 'Give the company holiday a date and a name.');
    return res.redirect(back(req));
  }
  if (await db('holidays').where({ date, name, source: 'company' }).first()) {
    req.flash('error', 'That holiday is already on the calendar.');
    return res.redirect(back(req, date));
  }
  await db('holidays').insert({ date, name, kind: 'company', source: 'company', note: str(req.body.note, 255), created_by: req.user.id, created_at: nowSql() });
  req.flash('success', `${name} added as a company holiday.`);
  res.redirect(back(req, date));
});

router.post('/holidays/:id/delete', requireAdmin, async (req, res) => {
  const hd = await db('holidays').where({ id: int(req.params.id, 0), source: 'company' }).first();
  if (hd) {
    await db('holidays').where({ id: hd.id }).del();
    req.flash('success', `${hd.name} removed.`);
  }
  res.redirect(back(req, hd && day(hd.date)));
});

router.post('/holidays/sync', requireAdmin, async (req, res) => {
  try {
    const n = await H.syncHolidays();
    req.flash('success', `Festivals and holidays updated (${n} dates).`);
  } catch (err) {
    req.flash('error', `Couldn’t update the festival list: ${err.message}`);
  }
  res.redirect(back(req));
});

module.exports = router;
