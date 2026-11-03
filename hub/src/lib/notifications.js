'use strict';

// The portal's notification feed is worked out from live data (overdue invoices, tasks waiting for approval,
// unread chat, meetings coming up...), so it is always accurate. Only "read" marks are stored.
const { db } = require('../db');
const chat = require('./chat');
const { clientScope, inScope, ticketsInScope } = require('./scope');
const M = require('./meetings');
const { nowSql, addMinutesSql, todayIST, addDays } = require('./util');
const money = require('./money');

const day = (v) => String(v || '').slice(0, 10);

async function feed(user) {
  const clientId = user.client_id;
  const scope = await clientScope(user);
  const today = todayIST();
  const soon = addDays(today, 3);
  const items = [];
  const add = (key, tone, icon, text, sub, href, at) => items.push({ key, tone, icon, text, sub, href, at: at || nowSql() });

  const [invoices, docs, quotes, tickets, tasks, meetings, convos] = await Promise.all([
    inScope(db('invoices').where({ client_id: clientId }).whereIn('status', ['sent', 'partially_paid', 'overdue']), scope, 'project_id'),
    scope.all ? db('billing_docs').where({ client_id: clientId, type: 'invoice', status: 'open' }) : Promise.resolve([]),
    scope.all ? db('quotes').where({ client_id: clientId, status: 'sent' }) : Promise.resolve([]),
    ticketsInScope(db('tickets').where({ client_id: clientId, status: 'awaiting_client' }), scope, user),
    inScope(db('project_tasks as t').join('projects as p', 'p.id', 't.project_id').where('p.client_id', clientId).whereNot('t.status', 'done'), scope, 'p.id')
      .select('t.*', 'p.name as project_name'),
    M.meetingsFor(user.id, { from: nowSql(), to: addMinutesSql(nowSql(), 24 * 60) }),
    chat.channelList(user.id),
  ]);

  invoices.forEach((i) => {
    const due = day(i.due_date);
    const balance = money.formatINR(Number(i.total) - Number(i.amount_paid));
    if (i.status === 'overdue' || (due && due < today)) add(`inv-overdue-${i.id}`, 'red', 'alert', `Invoice ${i.number} is overdue`, `${balance} was due ${due}`, `/i/${i.public_token}#pay`, i.due_date);
    else if (due && due <= soon) add(`inv-due-${i.id}`, 'amber', 'clock', `Invoice ${i.number} is due soon`, `${balance} due ${due}`, `/i/${i.public_token}#pay`, i.due_date);
  });
  docs.forEach((d) => {
    if (d.due_date && day(d.due_date) < today) add(`doc-overdue-${d.id}`, 'red', 'alert', `Your invoice ${d.number} is overdue`, `For ${d.bill_name}`, `/portal/billing/${d.id}`, d.due_date);
  });
  quotes.forEach((q) => add(`quote-${q.id}`, 'violet', 'quotes', `Quotation ${q.number} is waiting for you`, q.title, `/q/${q.public_token}#respond`, q.created_at));
  tickets.forEach((t) => add(`ticket-${t.id}-${t.last_reply_at}`, 'blue', 'chat', 'The team replied to your request', t.subject, `/portal/tickets/${t.id}`, t.last_reply_at));
  meetings.forEach((m) => add(`meet-${m.id}`, 'green', 'video', `Meeting: ${m.title}`, 'Coming up in the next 24 hours', `/portal/chat/meetings/${m.id}`, m.starts_at));
  convos.direct.filter((c) => c.unread > 0).forEach((c) => add(`chat-${c.id}-${c.last_message_at}`, 'blue', 'chat', `${c.unread} new message${c.unread === 1 ? '' : 's'} in ${c.label}`, 'Chat', `/portal/chat/${c.id}`, c.last_message_at));

  const reads = new Set(await db('notification_reads').where({ user_id: user.id }).pluck('key'));
  items.forEach((i) => { i.read = reads.has(i.key); });
  return items.sort((a, b) => Number(a.read) - Number(b.read) || String(b.at).localeCompare(String(a.at)));
}

const unreadCount = async (user) => (await feed(user)).filter((i) => !i.read).length;

async function markRead(userId, keys) {
  for (const key of keys) {
    const exists = await db('notification_reads').where({ user_id: userId, key }).first();
    if (!exists) await db('notification_reads').insert({ user_id: userId, key, created_at: nowSql() });
  }
}

module.exports = { feed, unreadCount, markRead };
