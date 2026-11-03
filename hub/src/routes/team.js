'use strict';

// The Haptags company view: everything across all clients, in the portal's look.
// (The old back office is switched off; this covers clients, projects and tasks, billing, chat and meetings.)
const express = require('express');
const { db } = require('../db');
const chatRouter = require('./portal-chat');
const { requireAdmin } = require('../lib/auth');
const L = require('../lib/leave');
const M = require('../lib/meetings');
const money = require('../lib/money');
const { nowSql, str, int, todayIST, addDays, addMinutesSql } = require('../lib/util');

const router = express.Router();

const TASK_STATUS = ['todo', 'doing', 'review', 'done'];
const TASK_LABEL = { todo: 'To do', doing: 'In progress', review: 'Under review', done: 'Done' };
const DOC_LABEL = { quotation: 'Quotation', invoice: 'Invoice', receipt: 'Receipt' };
const OPEN_PROJECT = ['planning', 'in_progress', 'review', 'on_hold'];
const cleanName = (v) => (str(v, 80) || '').replace(/\s+/g, ' ').trim() || null;

router.use(async (req, res, next) => {
  res.locals.isTeam = true;
  res.locals.chatBase = '/team/chat';
  res.locals.brandSub = 'Company';
  const admin = ['owner', 'admin'].includes(req.user.role);
  res.locals.showMoney = admin;
  res.locals.isApprover = admin;
  const chatUnread = await require('../lib/chat').unreadTotal(req.user.id);
  const leaveWaiting = admin ? (await L.pendingFor(req.user)).length : 0;
  const openTickets = Number((await db('tickets').where({ status: 'open' }).count({ n: '*' }).first()).n);
  res.locals.chatUnread = chatUnread;
  res.locals.navItems = [
    ['/team', 'home', 'Overview', true],
    ['/team/clients', 'clients', 'Clients'],
    ['/team/projects', 'projects', 'Projects'],
    ...(admin ? [['/team/billing', 'payments', 'Billing'], ['/team/gst', 'gst', 'GST Invoices'], ['/team/education', 'education', 'Education'], ['/team/finance', 'finance', 'Income & expenses']] : []),
    ['/team/sales', 'trophy', 'Sales'],
    ['/team/support', 'tickets', 'Support', false, openTickets],
    ['/team/chat', 'chat', 'Chat & Calls', false, chatUnread],
    ['/team/calendar', 'calendar', 'Calendar'],
    ['/team/chat/meetings', 'video', 'Meetings'],
    ['/team/leave', 'clock', 'Leave', false, leaveWaiting],
    ['/team/people', 'team', 'Team'],
  ];
  next();
});

/** Progress follows the tasks (same rule the client sees). */
async function syncProgress(projectId) {
  const rows = await db('project_tasks').where({ project_id: projectId }).select('status');
  if (!rows.length) return;
  const progress = Math.round((rows.filter((r) => r.status === 'done').length / rows.length) * 100);
  const project = await db('projects').where({ id: projectId }).first();
  const patch = { progress, updated_at: nowSql() };
  if (progress === 100) patch.status = 'completed';
  else if (project.status === 'completed') patch.status = 'in_progress';
  else if (project.status === 'planning' && rows.some((r) => r.status !== 'todo')) patch.status = 'in_progress';
  await db('projects').where({ id: projectId }).update(patch);
}

// ---- Overview ----
router.get('/', async (req, res) => {
  const today = todayIST();
  const [clients, projects, tasks, invoices, docs, comments, meetings] = await Promise.all([
    db('clients').where({ status: 'active', segment: 'business' }).count({ n: '*' }).first(),
    db('projects as p').join('clients as c', 'c.id', 'p.client_id').whereIn('p.status', OPEN_PROJECT).select('p.*', 'c.name as client_name'),
    db('project_tasks as t').join('projects as p', 'p.id', 't.project_id').join('clients as c', 'c.id', 'p.client_id').whereNot('t.status', 'done')
      .select('t.*', 'p.name as project_name', 'c.name as client_name'),
    db('invoices as i').join('clients as c', 'c.id', 'i.client_id').whereIn('i.status', ['sent', 'partially_paid', 'overdue']).select('i.*', 'c.name as client_name'),
    db('billing_docs as d').join('clients as c', 'c.id', 'd.client_id').where({ 'd.type': 'invoice', 'd.status': 'open' }).select('d.*', 'c.name as client_name'),
    db('task_comments as m').join('project_tasks as t', 't.id', 'm.task_id').join('projects as p', 'p.id', 't.project_id').join('clients as c', 'c.id', 'p.client_id')
      .leftJoin('users as u', 'u.id', 'm.user_id').orderBy('m.id', 'desc').limit(6)
      .select('m.body', 'm.created_at', 'u.name as user_name', 't.id as task_id', 't.title', 'p.id as project_id', 'p.name as project_name', 'c.name as client_name'),
    M.meetingsFor(req.user.id, { from: nowSql(), to: addMinutesSql(nowSql(), 7 * 24 * 60) }).limit(5),
  ]);
  const balance = (i) => Number(i.total) - Number(i.amount_paid);
  const myBalances = await L.balances(req.user.id, Number(today.slice(0, 4)));
  const leave = {
    casualLeft: (myBalances.find((b) => b.key === 'casual') || {}).left || 0,
    waiting: ['owner', 'admin'].includes(req.user.role) ? (await L.pendingFor(req.user)).length : 0,
    pending: await db('leave_requests').where({ user_id: req.user.id, status: 'pending' }).count({ n: '*' }).first().then((r) => Number(r.n)),
    next: await db('leave_requests').where({ user_id: req.user.id, status: 'approved' }).where('end_date', '>=', today).orderBy('start_date').first(),
  };
  const overdue = invoices.filter((i) => i.status === 'overdue' || (i.due_date && String(i.due_date).slice(0, 10) < today));
  const outstanding = invoices.reduce((s, i) => s + balance(i), 0) + docs.reduce((s, d) => s + Number(d.total), 0);
  const review = tasks.filter((t) => t.status === 'review');
  const late = tasks.filter((t) => t.due_date && String(t.due_date).slice(0, 10) < today);
  const tickets = await db('tickets as t').join('clients as c', 'c.id', 't.client_id').where('t.status', 'open').orderBy('t.last_reply_at', 'desc').limit(5).select('t.id', 't.subject', 't.priority', 'c.name as client_name');
  const pendingPayments = ['owner', 'admin'].includes(req.user.role) ? Number((await db('payments').where({ status: 'pending' }).count({ n: '*' }).first()).n) : 0;
  res.render('team/overview', { tickets, pendingPayments,
    title: 'Overview', clients: Number(clients.n), projects, outstanding, overdue, review, late, comments, meetings,
    overdueTotal: overdue.reduce((s, i) => s + balance(i), 0), balance, leave,
  });
});

// ---- Clients ----
router.get('/clients', async (req, res) => {
  const q = (str(req.query.q, 80) || '').trim();
  const archived = req.query.show === 'archived';
  const query = db('clients as c').where('c.segment', 'business').where('c.status', archived ? 'archived' : 'active').orderBy('c.name').select('c.*',
    db.raw("(select count(*) from projects p where p.client_id = c.id and p.status not in ('completed','cancelled')) as active_projects"),
    db.raw('(select count(*) from projects p where p.client_id = c.id) as total_projects'),
    db.raw("(select coalesce(sum(i.total - i.amount_paid), 0) from invoices i where i.client_id = c.id and i.status in ('sent','partially_paid','overdue')) as owed"));
  if (q) query.where((w) => w.where('c.name', 'like', `%${q}%`).orWhere('c.contact_name', 'like', `%${q}%`).orWhere('c.email', 'like', `%${q}%`));
  const archivedCount = Number((await db('clients').where({ status: 'archived', segment: 'business' }).count({ n: '*' }).first()).n);
  res.render('team/clients', { title: 'Clients', clients: await query, q, archived, archivedCount, manage: ['owner', 'admin'].includes(req.user.role) });
});

// ---- Add a client and invite their people (owners and admins) ----
const { inviteUser, resendInvite, setProjectAccess } = require('../lib/invites');
const { ensureClientGroup, syncMembers, groupIdFor } = require('../lib/clientchat');
const idList = (v) => [].concat(v || []).map((x) => int(x, 0)).filter(Boolean);
const isEmailLike = (e) => /^\S+@\S+\.\S+$/.test(e || '');
const takeInvite = (req) => { const v = req.session.inviteLink || null; delete req.session.inviteLink; return v; };

router.get('/clients/new', requireAdmin, (req, res) => res.render('team/client-new', { title: 'Add a client', values: {}, errors: {} }));

router.post('/clients', requireAdmin, async (req, res) => {
  const values = {
    name: str(req.body.name, 190), gstin: (str(req.body.gstin, 20) || '').toUpperCase(), phone: str(req.body.phone, 40), address: str(req.body.address, 500),
    city: str(req.body.city, 100), state: str(req.body.state, 100), pincode: str(req.body.pincode, 12),
    first_project: str(req.body.first_project, 190), contact_name: str(req.body.contact_name, 190), contact_email: (str(req.body.contact_email, 190) || '').toLowerCase(), send_invite: Boolean(req.body.send_invite),
  };
  const errors = {};
  if (!values.name) errors.name = 'What is the company called?';
  if (values.contact_name || values.contact_email) {
    if (!values.contact_name) errors.contact_name = 'Add the person’s name.';
    if (!isEmailLike(values.contact_email)) errors.contact_email = 'Enter a valid email address.';
    else if (await db('users').where({ email: values.contact_email }).first()) errors.contact_email = 'That email already has an account.';
    if (!values.first_project) errors.first_project = 'Which project are they being invited for?';
  }
  if (Object.keys(errors).length) return res.status(422).render('team/client-new', { title: 'Add a client', values, errors });
  const [cid] = await db('clients').insert({
    name: values.name, contact_name: values.contact_name || null, email: values.contact_email || null, phone: values.phone || null, gstin: values.gstin || null,
    address: values.address || null, city: values.city || null, state: values.state || null, pincode: values.pincode || null, status: 'active', created_at: nowSql(), updated_at: nowSql(),
  });
  const clientId = Array.isArray(cid) ? cid[0] : cid;
  await db('client_contacts').insert({ client_id: clientId, user_id: req.user.id, created_at: nowSql() });
  let firstProjectId = null;
  if (values.first_project) {
    const [pid] = await db('projects').insert({ client_id: clientId, name: values.first_project, status: 'planning', progress: 0, budget: 0, created_at: nowSql(), updated_at: nowSql() });
    firstProjectId = Array.isArray(pid) ? pid[0] : pid;
  }
  await ensureClientGroup(clientId);
  if (values.contact_name) {
    const inv = await inviteUser({ name: values.contact_name, email: values.contact_email, role: 'client', clientId, invitedBy: req.user, send: values.send_invite, allProjects: false, projectIds: [firstProjectId] });
    req.session.inviteLink = { name: values.contact_name, link: inv.link, sent: inv.sent };
  }
  req.flash('success', `${values.name} was added${values.contact_name ? `, and ${values.contact_name} was invited` : ''}.`);
  res.redirect(`/team/clients/${clientId}`);
});

// Archive a client: hidden from the list and its people can no longer sign in. Nothing is deleted, so it can be restored.
router.post('/clients/:id/archive', requireAdmin, async (req, res, next) => {
  const client = await db('clients').where({ id: int(req.params.id, 0), segment: 'business' }).first();
  if (!client) return next();
  await db('clients').where({ id: client.id }).update({ status: 'archived', updated_at: nowSql() });
  const people = await db('users').where({ client_id: client.id, role: 'client' });
  for (const p of people) await db('users').where({ id: p.id }).update({ is_active: false, token_version: p.token_version + 1, updated_at: nowSql() });
  req.flash('success', `${client.name} was archived. You can restore it any time from the Archived list.`);
  res.redirect('/team/clients');
});

router.post('/clients/:id/restore', requireAdmin, async (req, res, next) => {
  const client = await db('clients').where({ id: int(req.params.id, 0), segment: 'business' }).first();
  if (!client) return next();
  await db('clients').where({ id: client.id }).update({ status: 'active', updated_at: nowSql() });
  await db('users').where({ client_id: client.id, role: 'client' }).update({ is_active: true, updated_at: nowSql() });
  const gid = await groupIdFor(client.id);
  if (gid) await syncMembers(client.id, gid);
  req.flash('success', `${client.name} is back, and its people can sign in again.`);
  res.redirect(`/team/clients/${client.id}`);
});

// Delete for good: only an archived client that has never been billed (billing records must be kept).
router.post('/clients/:id/delete', requireAdmin, async (req, res, next) => {
  const client = await db('clients').where({ id: int(req.params.id, 0), segment: 'business' }).first();
  if (!client) return next();
  if (client.status !== 'archived') {
    req.flash('error', 'Archive the client first.');
    return res.redirect(`/team/clients/${client.id}`);
  }
  const billed = await Promise.all(['invoices', 'billing_docs', 'quotes', 'payments'].map(async (t) => Number((await db(t).where({ client_id: client.id }).count({ n: '*' }).first()).n)));
  const gst = Number((await db('gst_clients').where({ hub_client_id: client.id }).count({ n: '*' }).first()).n);
  if (billed.some(Boolean) || gst) {
    req.flash('error', `${client.name} has billing records, so it can only be archived, not deleted.`);
    return res.redirect(`/team/clients/${client.id}`);
  }
  await db.transaction(async (trx) => {
    await trx('channels').where({ client_id: client.id }).del();
    await trx('users').where({ client_id: client.id, role: 'client' }).del();
    await trx('clients').where({ id: client.id }).del();
  });
  req.flash('success', `${client.name} was deleted.`);
  res.redirect('/team/clients?show=archived');
});

// Another person at an existing client.
router.post('/clients/:id/people', requireAdmin, async (req, res, next) => {
  const client = await db('clients').where({ id: int(req.params.id, 0) }).first();
  if (!client) return next();
  const name = str(req.body.name, 190);
  const email = (str(req.body.email, 190) || '').toLowerCase();
  if (!name || !isEmailLike(email)) {
    req.flash('error', 'Enter their name and a valid email.');
    return res.redirect(`/team/clients/${client.id}`);
  }
  if (await db('users').where({ email }).first()) {
    req.flash('error', 'That email already has an account.');
    return res.redirect(`/team/clients/${client.id}`);
  }
  const all = Boolean(req.body.all_projects);
  const projectIds = idList(req.body.project_ids);
  if (!all && !projectIds.length) {
    req.flash('error', 'Choose which project they’re being invited for, or give them all projects.');
    return res.redirect(`/team/clients/${client.id}`);
  }
  const inv = await inviteUser({ name, email, role: 'client', clientId: client.id, invitedBy: req.user, send: req.body.send_invite !== '0', allProjects: all, projectIds });
  req.session.inviteLink = { name, link: inv.link, sent: inv.sent };
  req.flash('success', `${name} was invited to ${client.name}’s portal.`);
  res.redirect(`/team/clients/${client.id}`);
});

router.post('/clients/:id/people/:uid', requireAdmin, async (req, res, next) => {
  const user = await db('users').where({ id: int(req.params.uid, 0), client_id: int(req.params.id, 0), role: 'client' }).first();
  if (!user) return next();
  if (req.body.action === 'resend') {
    const r = await resendInvite(user, req.user);
    req.session.inviteLink = { name: user.name, link: r.link, sent: r.sent };
    req.flash('success', `A new invite link was made for ${user.name}.`);
  } else if (req.body.action === 'toggle') {
    await db('users').where({ id: user.id }).update({ is_active: !user.is_active, token_version: user.token_version + 1, updated_at: nowSql() });
    const gid = await groupIdFor(user.client_id);
    if (gid && user.is_active) await db('channel_members').where({ channel_id: gid, user_id: user.id }).del();
    else if (gid) await syncMembers(user.client_id, gid);
    req.flash('success', user.is_active ? `${user.name}’s access was removed.` : `${user.name}’s access was restored.`);
  } else if (req.body.action === 'access') {
    const all = Boolean(req.body.all_projects);
    const ids = idList(req.body.project_ids);
    if (!all && !ids.length) req.flash('error', 'Pick at least one project, or give them all projects.');
    else {
      await setProjectAccess(user.id, user.client_id, { all, projectIds: ids });
      req.flash('success', `${user.name} can now see ${all ? 'all of the company’s projects' : `${ids.length} project${ids.length === 1 ? '' : 's'}`}.`);
    }
  }
  res.redirect(`/team/clients/${user.client_id}`);
});

router.post('/clients/:id/projects', requireAdmin, async (req, res, next) => {
  const client = await db('clients').where({ id: int(req.params.id, 0) }).first();
  if (!client) return next();
  const name = str(req.body.name, 190);
  if (!name) {
    req.flash('error', 'Give the project a name.');
    return res.redirect(`/team/clients/${client.id}`);
  }
  const due = /^\d{4}-\d{2}-\d{2}$/.test(req.body.due_date || '') ? req.body.due_date : null;
  await db('projects').insert({ client_id: client.id, name, status: 'planning', progress: 0, due_date: due, budget: 0, created_at: nowSql(), updated_at: nowSql() });
  req.flash('success', `“${name}” added to ${client.name}. Invite people to it from the People box.`);
  res.redirect(`/team/clients/${client.id}`);
});

// Which Haptags people this client can see and message.
router.post('/clients/:id/contacts', requireAdmin, async (req, res, next) => {
  const client = await db('clients').where({ id: int(req.params.id, 0) }).first();
  const user = await db('users').where({ id: int(req.body.user_id, 0), is_active: true }).whereIn('role', ['owner', 'admin', 'staff']).first();
  if (!client) return next();
  if (user && !(await db('client_contacts').where({ client_id: client.id, user_id: user.id }).first())) {
    await db('client_contacts').insert({ client_id: client.id, user_id: user.id, created_at: nowSql() });
    await ensureClientGroup(client.id);
    req.flash('success', `${user.name} is now one of ${client.name}’s Haptags contacts.`);
  }
  res.redirect(`/team/clients/${client.id}`);
});

router.post('/clients/:id/contacts/:uid/remove', requireAdmin, async (req, res) => {
  await db('client_contacts').where({ client_id: int(req.params.id, 0), user_id: int(req.params.uid, 0) }).del();
  const gid = await groupIdFor(int(req.params.id, 0));
  if (gid) await db('channel_members').where({ channel_id: gid, user_id: int(req.params.uid, 0) }).del();
  req.flash('success', 'Removed. They’ll no longer appear in the client’s chat list.');
  res.redirect(`/team/clients/${int(req.params.id, 0)}`);
});

router.get('/clients/:id', async (req, res, next) => {
  const client = await db('clients').where({ id: int(req.params.id, 0) }).first();
  if (!client) return next();
  const [projects, invoices, docs, people, contacts, staffOptions] = await Promise.all([
    db('projects').where({ client_id: client.id }).orderBy('id', 'desc'),
    db('invoices').where({ client_id: client.id }).whereNot('status', 'draft').orderBy('id', 'desc').limit(10),
    db('billing_docs').where({ client_id: client.id }).orderBy('id', 'desc').limit(10),
    db('users').where({ client_id: client.id, role: 'client' }).orderBy('id'),
    db('client_contacts as cc').join('users as u', 'u.id', 'cc.user_id').where('cc.client_id', client.id).orderBy('u.name').select('u.id', 'u.name', 'u.role'),
    db('users').whereIn('role', ['owner', 'admin', 'staff']).where({ is_active: true }).orderBy('name').select('id', 'name', 'role'),
  ]);
  const members = people.length ? await db('project_members as pm').join('projects as pr', 'pr.id', 'pm.project_id').whereIn('pm.user_id', people.map((p) => p.id)).select('pm.user_id', 'pr.id', 'pr.name') : [];
  const access = {};
  members.forEach((m) => { (access[m.user_id] = access[m.user_id] || []).push({ id: m.id, name: m.name }); });
  const groupId = await ensureClientGroup(client.id);
  res.render('team/client', { access, groupId, canOpenChat: ['owner', 'admin'].includes(req.user.role) || contacts.some((c) => c.id === req.user.id), title: client.name, client, projects, invoices, docs, people, contacts, staffOptions, DOC_LABEL, inviteLink: takeInvite(req), manage: ['owner', 'admin'].includes(req.user.role) });
});

// ---- Projects ----
// The Projects page opens as the list; each project opens its own task board. ?view=board shows every project as a card by phase.
const PROJECT_COLUMN = { planning: 'todo', in_progress: 'doing', on_hold: 'doing', review: 'review', completed: 'done' };
const COLUMN_STATUS = { todo: 'planning', doing: 'in_progress', review: 'review', done: 'completed' };

router.get('/projects', async (req, res) => {
  const view = req.query.view === 'board' ? 'board' : 'list';
  const status = ['active', 'completed', 'on_hold'].includes(req.query.status) ? req.query.status : 'all';
  const q = (str(req.query.q, 80) || '').trim();
  const query = db('projects as p').join('clients as c', 'c.id', 'p.client_id').whereNot('p.status', 'cancelled').orderBy('p.id', 'desc').select('p.*', 'c.name as client_name',
    db.raw("(select count(*) from project_tasks t where t.project_id = p.id and t.status = 'review') as in_review"),
    db.raw('(select count(*) from project_tasks t where t.project_id = p.id) as task_count'),
    db.raw("(select count(*) from project_tasks t where t.project_id = p.id and t.status = 'done') as tasks_done"));
  if (view === 'list' && status === 'active') query.whereIn('p.status', ['planning', 'in_progress', 'review']);
  if (view === 'list' && status === 'completed') query.where('p.status', 'completed');
  if (view === 'list' && status === 'on_hold') query.where('p.status', 'on_hold');
  if (q) query.where((w) => w.where('p.name', 'like', `%${q}%`).orWhere('c.name', 'like', `%${q}%`));
  const canCreate = ['owner', 'admin'].includes(req.user.role);
  const clients = canCreate ? await db('clients').where({ status: 'active', segment: 'business' }).orderBy('name').select('id', 'name') : [];
  res.render('team/projects', {
    title: 'Projects', styles: ['board'], scripts: ['projects'], projects: await query, status, q, view, canCreate, clients, TASK_LABEL, PROJECT_COLUMN,
    team: await db('users').whereIn('role', ['owner', 'admin', 'staff']).where({ is_active: true }).orderBy('name').select('id', 'name'),
    openNew: canCreate && req.query.new === '1', preselect: int(req.query.client, 0),
  });
});

// Drag a project card to another phase: { column } in.
router.post('/projects/:id/move', async (req, res) => {
  const project = await db('projects').where({ id: int(req.params.id, 0) }).first();
  if (!project) return res.status(404).json({ ok: false });
  const status = COLUMN_STATUS[req.body.column];
  if (!status) return res.status(422).json({ ok: false, error: 'Unknown column.' });
  const keep = status === 'in_progress' && project.status === 'on_hold'; // dropping an on-hold project back in its own column changes nothing
  if (!keep && status !== project.status) {
    await db('projects').where({ id: project.id }).update({ status, ...(status === 'completed' ? { progress: 100 } : {}), updated_at: nowSql() });
  }
  const after = await db('projects').where({ id: project.id }).first();
  res.json({ ok: true, status: after.status, progress: after.progress });
});

// "Assign to" on a project card: the teammate who owns the project.
router.post('/projects/:id/assign', async (req, res) => {
  const project = await db('projects as p').join('clients as c', 'c.id', 'p.client_id').where('p.id', int(req.params.id, 0)).select('p.*', 'c.name as client_name').first();
  if (!project) return res.status(404).json({ ok: false });
  const who = await assigneeFrom(req.body);
  await db('projects').where({ id: project.id }).update({ ...who, updated_at: nowSql() });
  if (who.assigned_to && who.assigned_to !== req.user.id && who.assigned_to !== project.assigned_to) {
    require('../lib/realtime').publish({ users: [who.assigned_to] }, 'task.assigned', {
      id: `p${project.id}`, title: project.name, project: project.client_name, by: req.user.name, url: `/team/projects/${project.id}`, kind: 'project',
    });
  }
  res.json({ ok: true, name: who.assignee, userId: who.assigned_to });
});

// ---- New project from the Projects page (owners and admins): pick or type the client, optional first tasks ----
router.post('/projects', requireAdmin, async (req, res) => {
  const name = str(req.body.name, 190);
  const isNew = req.body.client_id === 'new';
  const newClient = str(req.body.new_client, 190);
  const due = /^\d{4}-\d{2}-\d{2}$/.test(req.body.due_date || '') ? req.body.due_date : null;
  const firstTasks = String(req.body.tasks || '').split(/\r?\n/).map((t) => t.replace(/\s+/g, ' ').trim().slice(0, 255)).filter(Boolean).slice(0, 30);
  const client = isNew ? null : await db('clients').where({ id: int(req.body.client_id, 0), status: 'active', segment: 'business' }).first();
  const problem = !name ? 'Give the project a name.' : isNew && !newClient ? 'Type the new client’s name.' : !isNew && !client ? 'Pick which client this project is for.' : null;
  if (problem) {
    req.flash('error', problem);
    return res.redirect('/team/projects?new=1');
  }
  let clientId = client && client.id;
  if (isNew) {
    const [cid] = await db('clients').insert({ name: newClient, status: 'active', created_at: nowSql(), updated_at: nowSql() });
    clientId = Array.isArray(cid) ? cid[0] : cid;
    await db('client_contacts').insert({ client_id: clientId, user_id: req.user.id, created_at: nowSql() });
    await ensureClientGroup(clientId);
  }
  const status = COLUMN_STATUS[req.body.phase] || 'planning';
  const [pid] = await db('projects').insert({ client_id: clientId, name, status, progress: status === 'completed' ? 100 : 0, due_date: due, budget: 0, created_at: nowSql(), updated_at: nowSql() });
  const projectId = Array.isArray(pid) ? pid[0] : pid;
  for (const title of firstTasks) {
    await db('project_tasks').insert({ project_id: projectId, title, status: 'todo', priority: 'normal', created_at: nowSql(), updated_at: nowSql() });
  }
  req.flash('success', `Project “${name}” created${isNew ? ` with the new client ${newClient}` : ''}. Add tasks and drag them across the board as work moves.`);
  res.redirect(`/team/projects/${projectId}`);
});

router.get('/projects/:id', async (req, res, next) => {
  const project = await db('projects as p').join('clients as c', 'c.id', 'p.client_id').where('p.id', int(req.params.id, 0)).select('p.*', 'c.name as client_name', 'c.id as client_id').first();
  if (!project) return next();
  const [tasks, updates, files, invoices] = await Promise.all([
    db('project_tasks as t').where('t.project_id', project.id).orderBy('t.id').select('t.*', db.raw('(select count(*) from task_comments c where c.task_id = t.id) as comments')),
    db('project_updates as u').leftJoin('users as us', 'us.id', 'u.user_id').where('u.project_id', project.id).orderBy('u.id', 'desc').limit(8).select('u.*', 'us.name as user_name'),
    db('project_files').where({ project_id: project.id }).whereNull('task_id').orderBy('id', 'desc'),
    db('invoices').where({ project_id: project.id }).whereNot('status', 'draft').orderBy('id', 'desc'),
  ]);
  const team = await db('users').whereIn('role', ['owner', 'admin', 'staff']).where({ is_active: true }).orderBy('name').select('id', 'name');
  const canManage = ['owner', 'admin'].includes(req.user.role);
  const clients = canManage ? await db('clients').where({ segment: 'business' }).where((w) => w.where({ status: 'active' }).orWhere({ id: project.client_id })).orderBy('name').select('id', 'name') : [];
  res.render('team/project', {
    title: project.name, styles: ['board'], scripts: ['projects'], project, tasks, updates, files, invoices, team, TASK_LABEL, TASK_STATUS,
    canManage, clients, SERVICES: require('../lib/constants').SERVICES, openEdit: canManage && req.query.edit === '1',
  });
});

router.post('/projects/:id/tasks', async (req, res, next) => {
  const project = await db('projects').where({ id: int(req.params.id, 0) }).first();
  if (!project) return next();
  const title = str(req.body.title, 255);
  if (!title) {
    req.flash('error', 'Give the task a title.');
    return res.redirect(`/team/projects/${project.id}`);
  }
  await db('project_tasks').insert({
    project_id: project.id, title, status: TASK_STATUS.includes(req.body.status) ? req.body.status : 'todo', priority: ['low', 'normal', 'high'].includes(req.body.priority) ? req.body.priority : 'normal',
    due_date: /^\d{4}-\d{2}-\d{2}$/.test(req.body.due_date || '') ? req.body.due_date : null, ...(await assigneeFrom(req.body)), created_at: nowSql(), updated_at: nowSql(),
  });
  await syncProgress(project.id);
  req.flash('success', `Task added to ${TASK_LABEL[TASK_STATUS.includes(req.body.status) ? req.body.status : 'todo']}.`);
  res.redirect(`/team/projects/${project.id}#board-title`);
});

// ---- Edit or delete a project (owners and admins) ----
const { SERVICES } = require('../lib/constants');
const PROJECT_STATUSES_ALL = ['planning', 'in_progress', 'review', 'on_hold', 'completed', 'cancelled'];
const isoDate = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(v || '') ? v : null);

router.post('/projects/:id/edit', requireAdmin, async (req, res, next) => {
  const project = await db('projects').where({ id: int(req.params.id, 0) }).first();
  if (!project) return next();
  const name = str(req.body.name, 190);
  const client = await db('clients').where({ id: int(req.body.client_id, project.client_id), segment: 'business' }).first();
  const start = isoDate(req.body.start_date);
  const due = isoDate(req.body.due_date);
  const problem = !name ? 'Give the project a name.' : !client ? 'Pick which client this project is for.'
    : start && due && due < start ? 'The target date can’t be before the start date.' : null;
  if (problem) {
    req.flash('error', problem);
    return res.redirect(`/team/projects/${project.id}?edit=1`);
  }
  const status = PROJECT_STATUSES_ALL.includes(req.body.status) ? req.body.status : project.status;
  const service = SERVICES.some((s) => s[0] === req.body.service) ? req.body.service : null;
  const moved = client.id !== project.client_id;
  await db.transaction(async (trx) => {
    await trx('projects').where({ id: project.id }).update({
      name, client_id: client.id, service, description: str(req.body.description, 5000) || null, start_date: start, due_date: due, status,
      ...(status === 'completed' ? { progress: 100 } : {}), updated_at: nowSql(),
    });
    // People at the old client lose access to a project that now belongs to someone else.
    if (moved) {
      const outsiders = await trx('users').where({ role: 'client' }).whereNot({ client_id: client.id }).pluck('id');
      if (outsiders.length) await trx('project_members').where({ project_id: project.id }).whereIn('user_id', outsiders).del();
    }
  });
  req.flash('success', `Project details saved${moved ? `. It now belongs to ${client.name}` : ''}.`);
  res.redirect(`/team/projects/${project.id}`);
});

router.post('/projects/:id/delete', requireAdmin, async (req, res, next) => {
  const project = await db('projects').where({ id: int(req.params.id, 0) }).first();
  if (!project) return next();
  const typed = (str(req.body.confirm_name, 190) || '').trim().toLowerCase();
  if (typed !== project.name.trim().toLowerCase()) {
    req.flash('error', 'Type the project’s name exactly to delete it.');
    return res.redirect(`/team/projects/${project.id}?edit=1`);
  }
  // Invoices are tax records: a project that has issued any is cancelled, never deleted.
  const billed = await db('invoices').where({ project_id: project.id }).whereNot('status', 'draft').first();
  if (billed) {
    req.flash('error', `“${project.name}” has invoices (${billed.number || 'issued'}), so it can’t be deleted. Set its status to Cancelled instead.`);
    return res.redirect(`/team/projects/${project.id}`);
  }
  await db.transaction(async (trx) => {
    const taskIds = await trx('project_tasks').where({ project_id: project.id }).pluck('id');
    if (taskIds.length) await trx('task_comments').whereIn('task_id', taskIds).del();
    const fileIds = (await trx('project_files').where({ project_id: project.id }).whereNotNull('file_id').pluck('file_id')).filter(Boolean);
    await trx('project_files').where({ project_id: project.id }).del();
    if (fileIds.length) await trx('files').whereIn('id', fileIds).del();
    for (const table of ['project_tasks', 'milestones', 'project_updates', 'project_links', 'project_members']) {
      await trx(table).where({ project_id: project.id }).del();
    }
    for (const table of ['invoices', 'retainers', 'tickets']) await trx(table).where({ project_id: project.id }).update({ project_id: null });
    await trx('projects').where({ id: project.id }).del();
  });
  req.flash('success', `Project “${project.name}” and its tasks, files and updates were deleted.`);
  res.redirect('/team/projects');
});

router.post('/projects/:id/status', async (req, res, next) => {
  const project = await db('projects').where({ id: int(req.params.id, 0) }).first();
  if (!project) return next();
  const status = ['planning', 'in_progress', 'review', 'on_hold', 'completed', 'cancelled'].includes(req.body.status) ? req.body.status : project.status;
  await db('projects').where({ id: project.id }).update({ status, ...(status === 'completed' ? { progress: 100 } : {}), updated_at: nowSql() });
  req.flash('success', 'Project status updated.');
  res.redirect(`/team/projects/${project.id}`);
});

// A client-visible note on the project.
router.post('/projects/:id/updates', async (req, res, next) => {
  const project = await db('projects').where({ id: int(req.params.id, 0) }).first();
  if (!project) return next();
  const body = str(req.body.body, 3000);
  if (body) await db('project_updates').insert({ project_id: project.id, user_id: req.user.id, body, client_visible: req.body.internal ? false : true, created_at: nowSql() });
  req.flash('success', !body ? 'Write an update first.' : req.body.internal ? 'Saved as an internal note. The client can’t see it.' : 'Update posted. The client can see it.');
  res.redirect(`/team/projects/${project.id}`);
});

// ---- Tasks ----
async function loadTask(req, res, next) {
  const task = await db('project_tasks as t').join('projects as p', 'p.id', 't.project_id').join('clients as c', 'c.id', 'p.client_id')
    .where('t.id', int(req.params.id, 0)).select('t.*', 'p.name as project_name', 'p.id as project_id', 'c.name as client_name').first();
  if (!task) return next();
  req.task = task;
  next();
}

router.get('/tasks/:id', loadTask, async (req, res) => {
  const [comments, files] = await Promise.all([
    db('task_comments as c').leftJoin('users as u', 'u.id', 'c.user_id').where('c.task_id', req.task.id).orderBy('c.id').select('c.*', 'u.name as user_name', 'u.role as user_role'),
    db('project_files').where({ task_id: req.task.id }).orderBy('id', 'desc'),
  ]);
  res.render('team/task', { title: req.task.title, task: req.task, comments, files, TASK_LABEL });
});

router.post('/tasks/:id/status', loadTask, async (req, res) => {
  const t = req.task;
  if (TASK_STATUS.includes(req.body.status) && req.body.status !== t.status) {
    await db('project_tasks').where({ id: t.id }).update({ status: req.body.status, updated_at: nowSql() });
    await syncProgress(t.project_id);
  }
  res.redirect(req.body.back === 'project' ? `/team/projects/${t.project_id}` : `/team/tasks/${t.id}`);
});

// Edit a task's title, due date and priority (the pencil on a board card).
router.post('/tasks/:id/edit', loadTask, async (req, res) => {
  const t = req.task;
  const title = str(req.body.title, 255);
  if (!title) {
    req.flash('error', 'A task needs a title.');
    return res.redirect(`/team/projects/${t.project_id}#board-title`);
  }
  await db('project_tasks').where({ id: t.id }).update({
    title,
    due_date: /^\d{4}-\d{2}-\d{2}$/.test(req.body.due_date || '') ? req.body.due_date : null,
    priority: ['low', 'normal', 'high'].includes(req.body.priority) ? req.body.priority : t.priority,
    updated_at: nowSql(),
  });
  req.flash('success', 'Task updated.');
  res.redirect(req.body.back === 'task' ? `/team/tasks/${t.id}` : `/team/projects/${t.project_id}#board-title`);
});

// Delete a task, with its comments and attachments. Project progress follows.
router.post('/tasks/:id/delete', loadTask, async (req, res) => {
  const t = req.task;
  await db.transaction(async (trx) => {
    await trx('task_comments').where({ task_id: t.id }).del();
    await trx('project_files').where({ task_id: t.id }).del();
    await trx('project_tasks').where({ id: t.id }).del();
  });
  await syncProgress(t.project_id);
  req.flash('success', `Task “${t.title}” deleted.`);
  res.redirect(`/team/projects/${t.project_id}#board-title`);
});

// Drag and drop on the project board: { column } in, the project's new progress out.
router.post('/tasks/:id/move', loadTask, async (req, res) => {
  const t = req.task;
  if (!TASK_STATUS.includes(req.body.column)) return res.status(422).json({ ok: false, error: 'Unknown column.' });
  if (req.body.column !== t.status) {
    await db('project_tasks').where({ id: t.id }).update({ status: req.body.column, updated_at: nowSql() });
    await syncProgress(t.project_id);
  }
  const project = await db('projects').where({ id: t.project_id }).first();
  res.json({ ok: true, status: req.body.column, progress: project.progress, projectStatus: project.status });
});

/** "Assign to": a team member by id (from the board), or a typed name (task page). Empty clears it. */
async function assigneeFrom(body) {
  if (body.user_id !== undefined && body.user_id !== '') {
    const u = await db('users').where({ id: int(body.user_id, 0), is_active: true }).whereIn('role', ['owner', 'admin', 'staff']).first();
    if (u) return { assigned_to: u.id, assignee: u.name.slice(0, 80) };
  }
  if (body.user_id === '') return { assigned_to: null, assignee: null };
  const name = cleanName(body.assignee);
  const match = name ? await db('users').whereIn('role', ['owner', 'admin', 'staff']).where({ is_active: true }).whereRaw('LOWER(name) = ?', [name.toLowerCase()]).first() : null;
  return { assigned_to: match ? match.id : null, assignee: name };
}

router.post('/tasks/:id/assign', loadTask, async (req, res) => {
  const t = req.task;
  const who = await assigneeFrom(req.body);
  await db('project_tasks').where({ id: t.id }).update({ ...who, updated_at: nowSql() });
  if (who.assigned_to && who.assigned_to !== req.user.id && who.assigned_to !== t.assigned_to) {
    require('../lib/realtime').publish({ users: [who.assigned_to] }, 'task.assigned', {
      id: t.id, title: t.title, project: t.project_name, by: req.user.name, url: `/team/tasks/${t.id}`,
    });
  }
  if (req.is('application/json')) return res.json({ ok: true, name: who.assignee, userId: who.assigned_to });
  res.redirect(req.body.back === 'project' ? `/team/projects/${t.project_id}` : `/team/tasks/${t.id}`);
});

router.post('/tasks/:id/comment', loadTask, async (req, res) => {
  const body = str(req.body.body, 3000);
  if (body) await db('task_comments').insert({ task_id: req.task.id, user_id: req.user.id, body, internal: Boolean(req.body.internal), created_at: nowSql() });
  res.redirect(`/team/tasks/${req.task.id}#comments`);
});

router.get('/files/:id', async (req, res, next) => {
  const row = await db('project_files').where({ id: int(req.params.id, 0) }).first();
  const file = row && row.file_id ? await db('files').where({ id: row.file_id }).first() : null;
  if (!file) return next();
  const inline = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(file.mime) && !req.query.download;
  res.set({
    'Content-Type': file.mime, 'Content-Length': file.size,
    'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="${file.name.replace(/[^ -~]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(file.name)}`,
    'Cache-Control': 'private, max-age=3600', 'Content-Security-Policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
  });
  res.end(Buffer.from(file.data));
});

// ---- Support: client requests, answered from here ----
const { refreshInvoice, recordPayment } = require('../lib/billing');
const { logActivity } = require('../lib/activity');
const { formatINR, toPaise } = require('../lib/money');
const { sendMail } = require('../lib/mailer');
const config = require('../config');

const TICKET_FILTER = { open: ['open'], waiting: ['awaiting_client'], closed: ['closed', 'resolved'] };

router.get('/support', async (req, res) => {
  const tab = ['open', 'waiting', 'closed', 'all'].includes(req.query.tab) ? req.query.tab : 'open';
  const query = db('tickets as t').join('clients as c', 'c.id', 't.client_id').leftJoin('projects as p', 'p.id', 't.project_id').leftJoin('users as u', 'u.id', 't.created_by')
    .orderByRaw("CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 ELSE 2 END").orderBy('t.last_reply_at', 'desc')
    .select('t.*', 'c.name as client_name', 'p.name as project_name', 'u.name as opened_by');
  if (tab !== 'all') query.whereIn('t.status', TICKET_FILTER[tab]);
  const [tickets, counts] = await Promise.all([query.limit(200), db('tickets').select('status').count({ n: '*' }).groupBy('status')]);
  const n = (...s) => counts.filter((c) => s.includes(c.status)).reduce((sum, c) => sum + Number(c.n), 0);
  res.render('team/support', { title: 'Support', tickets, tab, counts: { open: n('open'), waiting: n('awaiting_client'), closed: n('closed', 'resolved'), all: n('open', 'awaiting_client', 'closed', 'resolved') } });
});

async function loadTicket(req, res, next) {
  const t = await db('tickets as t').join('clients as c', 'c.id', 't.client_id').leftJoin('projects as p', 'p.id', 't.project_id').leftJoin('users as u', 'u.id', 't.created_by')
    .where('t.id', int(req.params.id, 0)).select('t.*', 'c.name as client_name', 'p.name as project_name', 'u.name as opened_by', 'u.email as opened_by_email').first();
  if (!t) return next();
  req.ticket = t;
  next();
}

router.get('/support/:id', loadTicket, async (req, res) => {
  const messages = await db('ticket_messages as m').leftJoin('users as u', 'u.id', 'm.user_id').where('m.ticket_id', req.ticket.id).orderBy('m.id').select('m.*', 'u.name as user_name', 'u.role as user_role');
  res.render('team/ticket', { title: req.ticket.subject, ticket: req.ticket, messages });
});

router.post('/support/:id/reply', loadTicket, async (req, res) => {
  const t = req.ticket;
  const body = str(req.body.body, 10000);
  if (!body) {
    req.flash('error', 'Write a reply first.');
    return res.redirect(`/team/support/${t.id}`);
  }
  const internal = Boolean(req.body.internal);
  await db('ticket_messages').insert({ ticket_id: t.id, user_id: req.user.id, body, internal, created_at: nowSql() });
  if (!internal) {
    await db('tickets').where({ id: t.id }).update({ status: req.body.close ? 'closed' : 'awaiting_client', last_reply_at: nowSql(), last_reply_by: 'staff', updated_at: nowSql() });
    if (t.opened_by_email) {
      await sendMail({
        to: t.opened_by_email, subject: `Re: ${t.subject}`, related: ['ticket', t.id], heading: 'The Haptags team replied',
        lines: [`${req.user.name} wrote:`, ...body.split(/\n+/)], button: { label: 'Open your request', url: `${config.baseUrl}/portal/tickets/${t.id}` },
      }).catch(() => false);
    }
  } else if (req.body.close) await db('tickets').where({ id: t.id }).update({ status: 'closed', updated_at: nowSql() });
  req.flash('success', internal ? 'Internal note saved. The client can’t see it.' : 'Reply sent.');
  res.redirect(`/team/support/${t.id}`);
});

router.post('/support/:id/status', loadTicket, async (req, res) => {
  const status = ['open', 'closed'].includes(req.body.status) ? req.body.status : req.ticket.status;
  await db('tickets').where({ id: req.ticket.id }).update({ status, updated_at: nowSql() });
  res.redirect(`/team/support/${req.ticket.id}`);
});

// ---- Payments: confirm what clients report, or record money you received (owners and admins) ----
router.post('/payments/:id/status', requireAdmin, async (req, res, next) => {
  const p = await db('payments').where({ id: int(req.params.id, 0) }).first();
  if (!p) return next();
  const to = ['confirmed', 'rejected'].includes(req.body.status) ? req.body.status : null;
  if (!to || to === p.status) return res.redirect('/team/billing');
  await db.transaction(async (trx) => {
    await trx('payments').where({ id: p.id }).update({ status: to, recorded_by: req.user.id });
    await refreshInvoice(trx, p.invoice_id);
    await logActivity('invoice', p.invoice_id, req.user.id, 'system', `Payment of ${formatINR(p.amount)} ${to}`, trx);
  });
  if (to === 'confirmed') {
    const inv = await db('invoices').where({ id: p.invoice_id }).first();
    const client = await db('clients').where({ id: p.client_id }).first();
    if (client.email) {
      await sendMail({
        to: client.email, subject: `Payment received — ${formatINR(p.amount)} for invoice ${inv.number}`, related: ['invoice', inv.id], heading: 'Payment confirmed. Thank you!',
        lines: [`We’ve confirmed your payment of ${formatINR(p.amount)} for invoice ${inv.number}.`],
        rows: [['Reference', p.reference || '—'], ['Balance due', formatINR(Math.max(0, Number(inv.total) - Number(inv.amount_paid)))]],
      }).catch(() => false);
    }
  }
  req.flash('success', to === 'confirmed' ? 'Payment confirmed, and the client was emailed a receipt.' : 'Payment rejected.');
  res.redirect('/team/billing');
});

router.post('/billing/invoices/:id/payment', requireAdmin, async (req, res, next) => {
  const inv = await db('invoices').where({ id: int(req.params.id, 0) }).whereNotIn('status', ['draft', 'void']).first();
  if (!inv) return next();
  const amount = toPaise(req.body.amount);
  const balance = Number(inv.total) - Number(inv.amount_paid);
  const date = /^\d{4}-\d{2}-\d{2}$/.test(req.body.paid_on || '') ? req.body.paid_on : todayIST();
  if (amount <= 0) req.flash('error', 'Enter the amount you received.');
  else if (amount + toPaise(req.body.tds) > balance) req.flash('error', `That is more than the ${formatINR(balance)} still due on ${inv.number}.`);
  else {
    await recordPayment({
      invoice_id: inv.id, amount, tds: toPaise(req.body.tds), method: ['upi', 'bank_transfer', 'cash', 'cheque', 'other'].includes(req.body.method) ? req.body.method : 'bank_transfer',
      reference: str(req.body.reference, 190), status: 'confirmed', paid_on: date, notes: 'Recorded by the team', recorded_by: req.user.id,
    });
    req.flash('success', `Payment of ${formatINR(amount)} recorded for ${inv.number}.`);
  }
  res.redirect('/team/billing');
});

// ---- Billing across all clients (owners and admins only) ----
router.use('/billing', requireAdmin);
router.get('/billing', async (req, res) => {
  const tab = ['invoices', 'quotations', 'receipts', 'overdue'].includes(req.query.tab) ? req.query.tab : 'all';
  const today = todayIST();
  const [invoices, quotes, docs] = await Promise.all([
    db('invoices as i').join('clients as c', 'c.id', 'i.client_id').whereNot('i.status', 'draft').select('i.*', 'c.name as client_name'),
    db('quotes as q').join('clients as c', 'c.id', 'q.client_id').whereNot('q.status', 'draft').select('q.*', 'c.name as client_name'),
    db('billing_docs as d').join('clients as c', 'c.id', 'd.client_id').select('d.*', 'c.name as client_name'),
  ]);
  const all = [
    ...invoices.map((i) => ({ kind: 'invoice', client: i.client_name, number: i.number, date: i.issue_date, due: i.due_date, total: Number(i.total), balance: i.status === 'void' ? 0 : Math.max(0, Number(i.total) - Number(i.amount_paid)), status: i.status, href: `/i/${i.public_token}`, clientId: i.client_id, invoiceId: i.id })),
    ...quotes.map((x) => ({ kind: 'quotation', client: x.client_name, number: x.number, date: x.issue_date, due: x.valid_until, total: Number(x.total), balance: 0, status: x.status, href: `/q/${x.public_token}`, clientId: x.client_id })),
    ...docs.map((d) => ({ kind: d.type, client: d.client_name, number: d.number, date: d.issue_date, due: d.due_date, total: Number(d.total), balance: d.type === 'invoice' && d.status === 'open' ? Number(d.total) : 0, status: d.type === 'receipt' ? 'paid' : d.status === 'open' ? 'sent' : d.status, href: `/team/billing/${d.id}`, clientId: d.client_id })),
  ].sort((a, b) => String(b.date).localeCompare(String(a.date)) || String(b.number).localeCompare(String(a.number)));
  const isLate = (r) => r.kind === 'invoice' && r.balance > 0 && (r.status === 'overdue' || (r.due && String(r.due).slice(0, 10) < today));
  const kindOf = { invoices: 'invoice', quotations: 'quotation', receipts: 'receipt' };
  const rows = tab === 'all' ? all : tab === 'overdue' ? all.filter(isLate) : all.filter((r) => r.kind === kindOf[tab]);
  const counts = { all: all.length, invoices: all.filter((r) => r.kind === 'invoice').length, quotations: all.filter((r) => r.kind === 'quotation').length, receipts: all.filter((r) => r.kind === 'receipt').length, overdue: all.filter(isLate).length };
  const outstanding = all.filter((r) => r.kind === 'invoice').reduce((s, r) => s + r.balance, 0);
  const overdueTotal = all.filter(isLate).reduce((s, r) => s + r.balance, 0);
  const collected = all.filter((r) => r.kind === 'invoice' && r.status === 'paid').reduce((s, r) => s + r.total, 0) + all.filter((r) => r.kind === 'receipt').reduce((s, r) => s + r.total, 0);
  const pending = await db('payments as p').join('invoices as i', 'i.id', 'p.invoice_id').join('clients as c', 'c.id', 'p.client_id').where('p.status', 'pending')
    .orderBy('p.id', 'desc').select('p.*', 'i.number as invoice_number', 'i.public_token', 'c.name as client_name');
  res.render('team/billing', { title: 'Billing', rows, tab, counts, outstanding, overdueTotal, collected, isLate, pending });
});

// ---- Create quotations, invoices and receipts for any client ----
const B = require('../lib/billdocs');

const clientPrefill = (c) => ({
  bill_name: c.name, bill_email: c.email || '', bill_phone: c.phone || '', bill_gstin: c.gstin || '',
  bill_address: [c.address, c.city, c.state, c.pincode].filter(Boolean).join(', '),
  igst: Boolean(c.state) && c.state.toLowerCase() !== 'karnataka',
});

router.get('/billing/new', async (req, res) => {
  const type = B.DOC_TYPES[req.query.type] ? req.query.type : 'invoice';
  const today = todayIST();
  const clients = await db('clients').where({ status: 'active' }).orderBy('name').select('id', 'name', 'email', 'phone', 'gstin', 'address', 'city', 'state', 'pincode');
  const from = req.query.from ? await db('billing_docs').where({ id: int(req.query.from, 0) }).first() : null;
  const client = clients.find((c) => c.id === int(req.query.client, from ? from.client_id : 0)) || null;
  const base = { type, issue_date: today, due_date: addDays(today, 7), gst_rate: 18, igst: false, discount: 0, pay_method: 'UPI', items: [{ description: '', quantity: 1, rate: 0 }] };
  const values = from ? { ...from, type, issue_date: today, due_date: addDays(today, 7), items: JSON.parse(from.items) } : { ...base, ...(client ? clientPrefill(client) : {}) };
  res.render('portal/billing-new', {
    title: 'New document', styles: ['billing'], values, doc: B.previewDoc(values, await B.nextDocNumber(type, today)), errors: {}, DOC_TYPES: B.DOC_TYPES,
    PAY_METHODS: B.PAY_METHODS, billBase: '/team/billing', clients, clientId: client ? client.id : 0,
  });
});

router.post('/billing', async (req, res) => {
  const parsed = B.parseDocForm(req.body, todayIST());
  const client = await db('clients').where({ id: int(req.body.client_id, 0) }).first();
  const errors = { ...parsed.errors };
  if (!client) errors.client = 'Pick which client this is for.';
  if (Object.keys(errors).length) {
    const clients = await db('clients').where({ status: 'active' }).orderBy('name').select('id', 'name', 'email', 'phone', 'gstin', 'address', 'city', 'state', 'pincode');
    const shown = { ...parsed.values, items: parsed.items.length ? parsed.items : [{ description: '', quantity: 1, rate: 0 }] };
    return res.status(422).render('portal/billing-new', {
      title: 'New document', styles: ['billing'], values: shown, doc: B.previewDoc(shown, await B.nextDocNumber(parsed.type, parsed.values.issue_date)), errors,
      DOC_TYPES: B.DOC_TYPES, PAY_METHODS: B.PAY_METHODS, billBase: '/team/billing', clients, clientId: client ? client.id : 0,
    });
  }
  const saved = await B.saveDoc(client.id, parsed);
  req.flash('success', `${B.DOC_TYPES[parsed.type].label} ${saved.number} created for ${client.name}.`);
  res.redirect(`/team/billing/${saved.id}`);
});

router.post('/billing/:id/paid', async (req, res, next) => {
  const row = await db('billing_docs').where({ id: int(req.params.id, 0), type: 'invoice', status: 'open' }).first();
  if (!row) return next();
  const r = await B.markInvoicePaid(row, { today: todayIST(), payMethod: req.body.pay_method, payRef: req.body.pay_ref });
  req.flash('success', `Invoice ${row.number} marked as paid. Receipt ${r.number} created.`);
  res.redirect(`/team/billing/${r.id}`);
});

router.post('/billing/:id/accept', async (req, res, next) => {
  const row = await db('billing_docs').where({ id: int(req.params.id, 0), type: 'quotation', status: 'open' }).first();
  if (!row) return next();
  await db('billing_docs').where({ id: row.id }).update({ status: 'accepted' });
  req.flash('success', `Quotation ${row.number} marked as accepted.`);
  res.redirect(`/team/billing/${row.id}`);
});

router.post('/billing/:id/delete', async (req, res) => {
  await db('billing_docs').where({ id: int(req.params.id, 0) }).del();
  req.flash('success', 'Document deleted.');
  res.redirect('/team/billing');
});

router.get('/billing/:id', async (req, res, next) => {
  const row = await db('billing_docs as d').join('clients as c', 'c.id', 'd.client_id').where('d.id', int(req.params.id, 0)).select('d.*', 'c.name as client_name').first();
  if (!row) return next();
  res.render('team/billing-doc', { title: `${DOC_LABEL[row.type]} ${row.number}`, styles: ['billing'], doc: B.presentDoc(row), DOC_LABEL });
});

router.use('/people', require('./team-people'));
router.use('/sales', require('./team-sales'));
router.use('/leave', require('./team-leave'));
router.use('/calendar', require('./team-calendar'));
router.use('/finance', requireAdmin, require('./team-finance'));
// GST tax invoices, and students with their fee invoices and internship offer letters (owners and admins: both handle money).
router.use('/gst', requireAdmin, require('./gst'));
router.use('/education', requireAdmin, require('./admin/education'));
router.use('/chat', chatRouter({ base: '/team/chat', audience: 'team' }));

module.exports = router;
