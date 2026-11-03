'use strict';

const express = require('express');
const config = require('../config');
const { db } = require('../db');
const { sendMail } = require('../lib/mailer');
const { verifyPassword, hashPassword, passwordProblem, signIn } = require('../lib/auth');
const { nowSql, str, int } = require('../lib/util');
const { SERVICES } = require('../lib/constants');
const { clientScope, inScope, ticketsInScope } = require('../lib/scope');
const { notFound: notFoundPage } = require('../lib/middleware');

const router = express.Router();

/** .modify() helpers: keep a query inside the person's allowed projects. */
const sc = (req, col = 'id') => (q) => inScope(q, req.scope, col);
const tk = (req, projectCol = 'project_id', userCol = 'created_by') => (q) => ticketsInScope(q, req.scope, req.user, projectCol, userCol);

// Every query below is scoped to the signed-in user's client_id, and then to the projects they were invited for.
router.use(async (req, res, next) => {
  req.clientId = req.user.client_id;
  req.scope = await clientScope(req.user);
  req.allProjects = req.scope.all;
  res.locals.allProjects = req.allProjects;
  res.locals.chatUnread = await require('../lib/chat').unreadTotal(req.user.id);
  res.locals.notifCount = await require('../lib/notifications').unreadCount(req.user);
  res.locals.client = await db('clients').where({ id: req.clientId }).first();
  if (!res.locals.client) {
    req.session = null;
    return res.redirect('/login');
  }
  next();
});

router.use('/chat', require('./portal-chat')({ base: '/portal/chat', audience: 'client' }));

// Clients have no Projects section (everything is on the dashboard), no task board and no document builder.
router.get(['/projects', '/projects/new', '/projects/:id'], (req, res) => res.redirect('/portal'));
router.post(['/projects', '/projects/:id/move', '/projects/:id/assign', '/projects/:id/files', '/projects/:id/links', '/projects/:id/tasks', '/files/:id/delete'], (req, res) => notFoundPage(req, res));
router.use('/tasks', (req, res) => notFoundPage(req, res));
router.all('/billing/new', (req, res) => notFoundPage(req, res));
router.post(['/billing', '/billing/:id/paid', '/billing/:id/accept', '/billing/:id/delete'], (req, res) => notFoundPage(req, res));

const visibleInvoices = (clientId, scope) => inScope(db('invoices').where({ client_id: clientId }).whereNotIn('status', ['draft']), scope, 'project_id');
// Quotes aren't tied to a project, so only people with company-wide access see them.
const visibleQuotes = (clientId, scope) => db('quotes').where({ client_id: clientId }).whereNot({ status: 'draft' }).modify((q) => (scope.all ? q : q.whereRaw('1 = 0')));

router.get('/', async (req, res) => {
  const [projects, unpaid, quotes, tickets] = await Promise.all([
    db('projects').where({ client_id: req.clientId }).modify(sc(req)).whereNot({ status: 'cancelled' }).orderBy('due_date'),
    visibleInvoices(req.clientId, req.scope).whereIn('status', ['sent', 'partially_paid', 'overdue']).orderBy('due_date'),
    visibleQuotes(req.clientId, req.scope).where({ status: 'sent' }).orderBy('id', 'desc'),
    db('tickets').where({ client_id: req.clientId }).modify(tk(req)).whereIn('status', ['open', 'awaiting_client']).orderBy('last_reply_at', 'desc').limit(5),
  ]);
  // Everything about each project sits on the dashboard: progress, updates, files and invoices.
  const ids = projects.length ? projects.map((p) => p.id) : [0];
  const [updates, files, links, invoices, tasks] = await Promise.all([
    db('project_updates as u').leftJoin('users as us', 'us.id', 'u.user_id').whereIn('u.project_id', ids).where('u.client_visible', true).orderBy('u.id', 'desc').select('u.*', 'us.name as user_name'),
    db('project_files').whereIn('project_id', ids).whereNull('task_id').orderBy('id', 'desc'),
    db('project_links').whereIn('project_id', ids).where({ client_visible: true }).orderBy('id', 'desc'),
    visibleInvoices(req.clientId, req.scope).whereIn('project_id', ids).orderBy('id', 'desc'),
    db('project_tasks').whereIn('project_id', ids).select('project_id', 'status'),
  ]);
  const rank = { in_progress: 0, review: 0, planning: 1, on_hold: 2, completed: 3 };
  const cards = [...projects].sort((x, y) => (rank[x.status] ?? 1) - (rank[y.status] ?? 1)).map((p) => {
    const mine = tasks.filter((t) => t.project_id === p.id);
    return {
      project: p, updates: updates.filter((u) => u.project_id === p.id).slice(0, 3), files: files.filter((f) => f.project_id === p.id).slice(0, 8),
      links: links.filter((l) => l.project_id === p.id), invoices: invoices.filter((i) => i.project_id === p.id).slice(0, 5),
      steps: { total: mine.length, done: mine.filter((t) => t.status === 'done').length },
    };
  });
  const balance = unpaid.reduce((sum, i) => sum + Number(i.total) - Number(i.amount_paid), 0);
  res.render('portal/home', { title: 'Overview', cards, unpaid, quotes, tickets, balance });
});

const BOARD_STATUS = { todo: 'planning', doing: 'in_progress', review: 'review', done: 'completed' };
const BOARD_LABEL = { todo: 'To do', doing: 'In progress', review: 'Under review', done: 'Completed' };
const cleanName = (v) => (str(v, 80) || '').replace(/\s+/g, ' ').trim() || null;

/** Names already used on this client's projects and tasks, offered as suggestions in the "Assigned to" box. */
async function assigneeSuggestions(req) {
  const clientId = req.clientId;
  const [a, b] = await Promise.all([
    db('projects').where({ client_id: clientId }).modify(sc(req)).whereNotNull('assignee').distinct('assignee'),
    db('project_tasks as t').join('projects as p', 'p.id', 't.project_id').where('p.client_id', clientId).modify(sc(req, 'p.id')).whereNotNull('t.assignee').distinct('t.assignee'),
  ]);
  return [...new Set([...a, ...b].map((r) => r.assignee))].sort();
}

router.get('/projects', async (req, res) => {
  const [projects, team] = await Promise.all([
    db('projects').where({ client_id: req.clientId }).modify(sc(req)).whereNot({ status: 'cancelled' }).orderBy('id', 'desc'),
    assigneeSuggestions(req),
  ]);
  res.render('portal/projects', { title: 'Projects', styles: ['board'], projects, suggestions: team });
});

router.get('/projects/new', async (req, res) => {
  res.render('portal/project-new', { title: 'New project', values: {}, errors: {}, services: SERVICES });
});

// Adds a project in the "To do" column (status planning).
router.post('/projects', async (req, res) => {
  const values = {
    name: str(req.body.name, 190), service: str(req.body.service, 80), description: str(req.body.description, 2000),
    due_date: str(req.body.due_date, 10),
  };
  const errors = {};
  if (!values.name) errors.name = 'Give the project a name.';
  if (values.due_date && !/^\d{4}-\d{2}-\d{2}$/.test(values.due_date)) errors.due_date = 'Pick a valid date.';
  if (Object.keys(errors).length) {
    return res.status(422).render('portal/project-new', { title: 'New project', values, errors, services: SERVICES });
  }
  const [newId] = await db('projects').insert({
    client_id: req.clientId, name: values.name, service: values.service || null, description: values.description || null,
    status: 'planning', progress: 0, due_date: values.due_date || null,
    budget: 0, created_at: nowSql(), updated_at: nowSql(),
  });
  if (!req.allProjects) await db('project_members').insert({ project_id: Array.isArray(newId) ? newId[0] : newId, user_id: req.user.id, created_at: nowSql() });
  req.flash('success', `“${values.name}” added to To do.`);
  res.redirect('/portal/projects');
});

// Drag-and-drop on the board: moves a project to another column.
router.post('/projects/:id/move', async (req, res) => {
  const status = BOARD_STATUS[req.body.column];
  const project = await db('projects').where({ id: int(req.params.id, 0), client_id: req.clientId }).modify(sc(req)).first();
  if (!status || !project) return res.status(404).json({ ok: false });
  if (project.status !== status) {
    const patch = { status, updated_at: nowSql() };
    if (status === 'completed') patch.progress = 100;
    await db('projects').where({ id: project.id }).update(patch);
    await db('project_updates').insert({
      project_id: project.id, user_id: req.user.id, client_visible: true, created_at: nowSql(),
      body: `${req.user.name} moved this project to “${BOARD_LABEL[req.body.column]}”.`,
    });
  }
  res.json({ ok: true });
});

// Set who a project is assigned to: any name, or empty to clear it.
router.post('/projects/:id/assign', async (req, res) => {
  const project = await db('projects').where({ id: int(req.params.id, 0), client_id: req.clientId }).modify(sc(req)).first();
  if (!project) return res.status(404).json({ ok: false });
  const name = cleanName(req.body.name);
  await db('projects').where({ id: project.id }).update({ assignee: name, updated_at: nowSql() });
  res.json({ ok: true, name });
});

router.get('/projects/:id', async (req, res, next) => {
  const project = await db('projects').where({ id: int(req.params.id, 0), client_id: req.clientId }).modify(sc(req)).first();
  if (!project) return next();
  const [milestones, updates, links, invoices, tasks, team, files] = await Promise.all([
    db('milestones').where({ project_id: project.id, client_visible: true }).orderByRaw('CASE WHEN due_date IS NULL THEN 1 ELSE 0 END').orderBy('due_date').orderBy('id'),
    db('project_updates as u').leftJoin('users as us', 'us.id', 'u.user_id').where({ 'u.project_id': project.id, 'u.client_visible': true })
      .orderBy('u.id', 'desc').select('u.*', 'us.name as user_name'),
    db('project_links').where({ project_id: project.id, client_visible: true }).orderBy('id', 'desc'),
    visibleInvoices(req.clientId, req.scope).where({ project_id: project.id }).orderBy('id', 'desc'),
    db('project_tasks').where({ project_id: project.id }).select('id', 'title', 'status', 'description'),
    assigneeSuggestions(req),
    db('project_files as f').leftJoin('users as u', 'u.id', 'f.uploaded_by').where('f.project_id', project.id).whereNull('f.task_id').orderBy('f.id', 'desc').select('f.*', 'u.name as by_name'),
  ]);
  const reviews = tasks.filter((t) => t.status === 'review');
  const steps = { total: tasks.length, done: tasks.filter((t) => t.status === 'done').length };
  res.render('portal/project', { title: project.name, styles: ['board'], project, milestones, updates, links, invoices, reviews, steps, files });
});

// ---- Tasks inside a project (the project page's board) ----
const TASK_COLUMNS = ['todo', 'doing', 'review', 'done'];
const TASK_LABEL = { todo: 'To do', doing: 'In progress', review: 'Under review', done: 'Completed' };

const ownProject = (req) => db('projects').where({ id: int(req.params.id, 0), client_id: req.clientId }).modify(sc(req)).first();
const ownTask = (req) => db('project_tasks as t').join('projects as p', 'p.id', 't.project_id')
  .where({ 't.id': int(req.params.id, 0), 'p.client_id': req.clientId }).modify(sc(req, 'p.id')).select('t.*').first();

/** Progress follows the tasks: share of tasks completed. Projects with no tasks keep their manual value. */
async function syncProgress(projectId) {
  const rows = await db('project_tasks').where({ project_id: projectId }).select('status');
  if (!rows.length) return null;
  const progress = Math.round((rows.filter((r) => r.status === 'done').length / rows.length) * 100);
  const patch = { progress, updated_at: nowSql() };
  const project = await db('projects').where({ id: projectId }).first();
  if (progress === 100) patch.status = 'completed';
  else if (project.status === 'completed') patch.status = 'in_progress';
  else if (project.status === 'planning' && rows.some((r) => r.status !== 'todo')) patch.status = 'in_progress';
  await db('projects').where({ id: projectId }).update(patch);
  return progress;
}

// Clients don't manage tasks. They only review what the team sends for approval (see /tasks/:id below).
router.post('/projects/:id/tasks', (req, res) => notFoundPage(req, res));
router.post('/tasks/:id/move', (req, res) => notFoundPage(req, res));
router.post('/tasks/:id/assign', (req, res) => notFoundPage(req, res));
router.post('/tasks/:id/delete', (req, res) => notFoundPage(req, res));
router.post('/tasks/:id', (req, res) => notFoundPage(req, res));

router.post('/projects/:id/tasks', async (req, res) => {
  const project = await ownProject(req);
  if (!project) return res.status(404).render('public/message', { title: 'Not found', heading: 'Project not found', link: { href: '/portal/projects', label: 'Back to projects' } });
  const title = str(req.body.title, 255);
  if (!title) {
    req.flash('error', 'Type a task first.');
    return res.redirect(`/portal/projects/${project.id}`);
  }
  await db('project_tasks').insert({ project_id: project.id, title, status: 'todo', created_at: nowSql(), updated_at: nowSql() });
  await syncProgress(project.id);
  req.flash('success', `Task added to To do.`);
  res.redirect(`/portal/projects/${project.id}#tasks`);
});

router.post('/tasks/:id/move', async (req, res) => {
  const task = await ownTask(req);
  if (!task || !TASK_COLUMNS.includes(req.body.column)) return res.status(404).json({ ok: false });
  await db('project_tasks').where({ id: task.id }).update({ status: req.body.column, updated_at: nowSql() });
  const progress = await syncProgress(task.project_id);
  res.json({ ok: true, progress });
});

router.post('/tasks/:id/assign', async (req, res) => {
  const task = await ownTask(req);
  if (!task) return res.status(404).json({ ok: false });
  const name = cleanName(req.body.name);
  await db('project_tasks').where({ id: task.id }).update({ assignee: name, updated_at: nowSql() });
  res.json({ ok: true, name });
});

router.post('/tasks/:id/delete', async (req, res) => {
  const task = await ownTask(req);
  if (!task) return res.redirect('/portal/projects');
  await db('project_tasks').where({ id: task.id }).del();
  await syncProgress(task.project_id);
  req.flash('success', 'Task removed.');
  res.redirect(`/portal/projects/${task.project_id}#tasks`);
});

// ---- Billing: a simple builder for quotations, invoices and receipts ----
const money = require('../lib/money');
const { financialYear, todayIST, addDays } = require('../lib/util');

const DOC_TYPES = {
  quotation: { label: 'Quotation', prefix: 'QT' },
  invoice: { label: 'Invoice', prefix: 'INV' },
  receipt: { label: 'Receipt', prefix: 'RC' },
};
const PAY_METHODS = ['UPI', 'Bank transfer', 'Cash', 'Card', 'Cheque'];
const ymdOk = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(v || '') ? v : null);
const asList = (v) => (Array.isArray(v) ? v : v === undefined ? [] : [v]);

/** Next number for a document type, e.g. INV/26-27/0003. */
async function nextDocNumber(type, issueDate) {
  const base = `${DOC_TYPES[type].prefix}/${financialYear(issueDate)}/`;
  const last = await db('billing_docs').where({ type }).where('number', 'like', `${base}%`).orderBy('id', 'desc').first();
  const seq = last ? Number(last.number.slice(base.length)) + 1 : 1;
  return `${base}${String(seq).padStart(4, '0')}`;
}

/** Stored row -> everything the document view needs, with totals recomputed from the lines. */
function presentDoc(row) {
  const items = JSON.parse(row.items);
  const totals = money.computeTotals(items.map((i) => ({ description: i.description, quantity: i.quantity, rate: i.rate })), {
    taxMode: Number(row.gst_rate) === 0 ? 'none' : row.igst ? 'inter' : 'intra', gstRate: Number(row.gst_rate), discount: row.discount,
  });
  return { ...row, totals };
}

/** The document shown in the builder's preview before anything is saved. */
function previewDoc(values, number) {
  const gst = Number(values.gst_rate) || 0;
  const totals = money.computeTotals(values.items, { taxMode: gst === 0 ? 'none' : values.igst ? 'inter' : 'intra', gstRate: gst, discount: values.discount });
  return { ...values, number, gst_rate: gst, totals };
}

/** Everything billing-related for a client, in one list: invoices and quotes from the team, plus documents made in the builder. */
async function billingFeed(clientId, scope) {
  const [invoices, quotes, docs] = await Promise.all([
    visibleInvoices(clientId, scope), visibleQuotes(clientId, scope), scope.all ? db('billing_docs').where({ client_id: clientId }) : Promise.resolve([]),
  ]);
  const rows = [
    ...invoices.map((i) => ({
      kind: 'invoice', origin: 'team', number: i.number, title: i.title, date: i.issue_date, due: i.due_date, total: Number(i.total),
      balance: i.status === 'void' ? 0 : Math.max(0, Number(i.total) - Number(i.amount_paid)), status: i.status, href: `/i/${i.public_token}`, payHref: `/i/${i.public_token}#pay`, id: `i${i.id}`,
    })),
    ...quotes.map((q) => ({
      kind: 'quotation', origin: 'team', number: q.number, title: q.title, date: q.issue_date, due: q.valid_until || null, total: Number(q.total), balance: 0,
      status: q.status, href: `/q/${q.public_token}`, reviewHref: q.status === 'sent' ? `/q/${q.public_token}#respond` : null, id: `q${q.id}`,
    })),
    ...docs.map((d) => ({
      kind: d.type, origin: 'team', number: d.number, title: d.bill_name, date: d.issue_date, due: d.due_date, total: Number(d.total),
      balance: d.type === 'invoice' && d.status === 'open' ? Number(d.total) : 0, status: d.type === 'receipt' ? 'paid' : d.status === 'open' ? (d.type === 'invoice' ? 'sent' : 'sent') : d.status,
      href: `/portal/billing/${d.id}`, id: `d${d.id}`, docId: d.id,
    })),
  ];
  return rows.sort((a, b) => String(b.date).localeCompare(String(a.date)) || String(b.number).localeCompare(String(a.number)));
}

// People limited to some projects don't see company-wide documents made in the builder.
router.use('/billing', (req, res, next) => (req.allProjects || req.path === '/' ? next() : notFoundPage(req, res)));

router.get('/billing', async (req, res) => {
  const tab = ['invoices', 'quotations', 'receipts'].includes(req.query.tab) ? req.query.tab : 'all';
  const all = await billingFeed(req.clientId, req.scope);
  const kindOf = { invoices: 'invoice', quotations: 'quotation', receipts: 'receipt' };
  const rows = tab === 'all' ? all : all.filter((r) => r.kind === kindOf[tab]);
  const counts = { all: all.length, invoices: all.filter((r) => r.kind === 'invoice').length, quotations: all.filter((r) => r.kind === 'quotation').length, receipts: all.filter((r) => r.kind === 'receipt').length };
  const outstanding = all.filter((r) => r.kind === 'invoice').reduce((s, r) => s + r.balance, 0);
  const paid = all.filter((r) => r.kind === 'receipt').reduce((s, r) => s + r.total, 0)
    + all.filter((r) => r.kind === 'invoice' && r.origin === 'team' && r.status === 'paid').reduce((s, r) => s + r.total, 0);
  const awaiting = all.filter((r) => r.kind === 'quotation' && r.status === 'sent').length;
  res.render('portal/billing', { title: 'Billing', styles: ['billing'], rows, tab, counts, outstanding, paid, awaiting, DOC_TYPES });
});

router.get('/invoices', (req, res) => res.redirect('/portal/billing?tab=invoices'));
router.get('/quotes', (req, res) => res.redirect('/portal/billing?tab=quotations'));

// Mark one of your own invoices as paid: it is closed and a matching receipt is made for you.
router.post('/billing/:id/paid', async (req, res, next) => {
  const row = await db('billing_docs').where({ id: int(req.params.id, 0), client_id: req.clientId, type: 'invoice', status: 'open' }).first();
  if (!row) return next();
  const today = todayIST();
  const number = await nextDocNumber('receipt', today);
  const [rid] = await db('billing_docs').insert({
    client_id: req.clientId, type: 'receipt', number, issue_date: today, bill_name: row.bill_name, bill_email: row.bill_email, bill_phone: row.bill_phone,
    bill_address: row.bill_address, bill_gstin: row.bill_gstin, items: row.items, gst_rate: row.gst_rate, igst: row.igst, discount: row.discount, total: row.total,
    pay_method: str(req.body.pay_method, 40) || 'UPI', pay_ref: str(req.body.pay_ref, 120), notes: `Receipt for invoice ${row.number}`, status: 'paid', source_id: row.id, created_at: nowSql(),
  });
  await db('billing_docs').where({ id: row.id }).update({ status: 'paid' });
  req.flash('success', `Invoice ${row.number} marked as paid. Receipt ${number} created.`);
  res.redirect(`/portal/billing/${Array.isArray(rid) ? rid[0] : rid}`);
});

router.post('/billing/:id/accept', async (req, res, next) => {
  const row = await db('billing_docs').where({ id: int(req.params.id, 0), client_id: req.clientId, type: 'quotation', status: 'open' }).first();
  if (!row) return next();
  await db('billing_docs').where({ id: row.id }).update({ status: 'accepted' });
  req.flash('success', `Quotation ${row.number} marked as accepted.`);
  res.redirect(`/portal/billing/${row.id}`);
});

router.get('/billing/new', async (req, res) => {
  const type = DOC_TYPES[req.query.type] ? req.query.type : 'invoice';
  const from = req.query.from ? await db('billing_docs').where({ id: int(req.query.from, 0), client_id: req.clientId }).first() : null;
  const today = todayIST();
  const values = from
    ? { ...from, type, issue_date: today, due_date: addDays(today, 7), items: JSON.parse(from.items) }
    : { type, issue_date: today, due_date: addDays(today, 7), gst_rate: 18, igst: false, discount: 0, items: [{ description: '', quantity: 1, rate: 0 }], pay_method: 'UPI' };
  const nextNumber = await nextDocNumber(type, today);
  res.render('portal/billing-new', { title: 'New document', styles: ['billing'], values, doc: previewDoc(values, nextNumber), errors: {}, DOC_TYPES, PAY_METHODS });
});

router.post('/billing', async (req, res) => {
  const type = DOC_TYPES[req.body.type] ? req.body.type : 'invoice';
  const descs = asList(req.body.item_desc);
  const qtys = asList(req.body.item_qty);
  const rates = asList(req.body.item_rate);
  const items = descs.map((d, i) => ({ description: str(d, 255) || '', quantity: Math.max(0, Number(qtys[i]) || 0), rate: money.toPaise(rates[i]) }))
    .filter((i) => i.description && i.quantity > 0);
  const gstRate = [0, 5, 12, 18, 28].includes(Number(req.body.gst_rate)) ? Number(req.body.gst_rate) : 0;
  const values = {
    type, issue_date: ymdOk(req.body.issue_date) || todayIST(), due_date: ymdOk(req.body.due_date),
    bill_name: str(req.body.bill_name, 190), bill_email: str(req.body.bill_email, 190), bill_phone: str(req.body.bill_phone, 40),
    bill_address: str(req.body.bill_address, 500), bill_gstin: (str(req.body.bill_gstin, 20) || '').toUpperCase(),
    gst_rate: gstRate, igst: Boolean(req.body.igst), discount: money.toPaise(req.body.discount),
    pay_method: str(req.body.pay_method, 40), pay_ref: str(req.body.pay_ref, 120), notes: str(req.body.notes, 1500),
  };
  const errors = {};
  if (!values.bill_name) errors.bill_name = 'Who is this for?';
  if (!items.length) errors.items = 'Add at least one item with a quantity.';
  if (Object.keys(errors).length) {
    const shown = { ...values, items: items.length ? items : [{ description: '', quantity: 1, rate: 0 }] };
    return res.status(422).render('portal/billing-new', {
      title: 'New document', styles: ['billing'], values: shown, doc: previewDoc(shown, await nextDocNumber(type, values.issue_date)), errors, DOC_TYPES, PAY_METHODS,
    });
  }
  const totals = money.computeTotals(items, { taxMode: gstRate === 0 ? 'none' : values.igst ? 'inter' : 'intra', gstRate, discount: values.discount });
  const number = await nextDocNumber(type, values.issue_date);
  const [id] = await db('billing_docs').insert({
    ...values, client_id: req.clientId, number, items: JSON.stringify(items), discount: totals.discount, total: totals.total, created_at: nowSql(),
  });
  req.flash('success', `${DOC_TYPES[type].label} ${number} created.`);
  res.redirect(`/portal/billing/${Array.isArray(id) ? id[0] : id}`);
});

router.get('/billing/:id', async (req, res, next) => {
  const row = await db('billing_docs').where({ id: int(req.params.id, 0), client_id: req.clientId }).first();
  if (!row) return next();
  res.render('portal/billing-show', { title: `${DOC_TYPES[row.type].label} ${row.number}`, styles: ['billing'], doc: presentDoc(row), DOC_TYPES });
});

router.post('/billing/:id/delete', async (req, res) => {
  await db('billing_docs').where({ id: int(req.params.id, 0), client_id: req.clientId }).del();
  req.flash('success', 'Document deleted.');
  res.redirect('/portal/billing');
});

// ---- Task details, comments and approval ----
const PRIORITIES = ['low', 'normal', 'high'];
const MAX_UPLOAD = 8 * 1024 * 1024;
const SAFE_IMAGES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

async function taskPage(req, res, next) {
  const task = await ownTask(req);
  if (!task || task.status !== 'review') return next(); // clients only open items waiting for their approval
  const [project, comments, files, suggestions] = await Promise.all([
    db('projects').where({ id: task.project_id }).first(),
    db('task_comments as c').leftJoin('users as u', 'u.id', 'c.user_id').where('c.task_id', task.id).where('c.internal', false).orderBy('c.id').select('c.*', 'u.name as user_name', 'u.role as user_role'),
    db('project_files').where({ task_id: task.id }).orderBy('id', 'desc'),
    assigneeSuggestions(req),
  ]);
  res.render('portal/task', { title: task.title, styles: ['board'], task, project, comments, files, suggestions, TASK_LABEL, PRIORITIES, errors: {} });
}
router.get('/tasks/:id', taskPage);

router.post('/tasks/:id', async (req, res, next) => {
  const task = await ownTask(req);
  if (!task) return next();
  const title = str(req.body.title, 255);
  if (!title) {
    req.flash('error', 'A task needs a title.');
    return res.redirect(`/portal/tasks/${task.id}`);
  }
  await db('project_tasks').where({ id: task.id }).update({
    title, description: str(req.body.description, 3000) || null, priority: PRIORITIES.includes(req.body.priority) ? req.body.priority : 'normal',
    due_date: ymdOk(req.body.due_date), assignee: cleanName(req.body.assignee), updated_at: nowSql(),
  });
  req.flash('success', 'Task updated.');
  res.redirect(`/portal/tasks/${task.id}`);
});

router.post('/tasks/:id/comment', async (req, res, next) => {
  const task = await ownTask(req);
  if (!task || task.status !== 'review') return next();
  const body = str(req.body.body, 3000);
  if (body) await db('task_comments').insert({ task_id: task.id, user_id: req.user.id, body, created_at: nowSql() });
  res.redirect(`/portal/tasks/${task.id}#comments`);
});

// "Approve" on a task that is under review: marks it completed and records who signed it off.
router.post('/tasks/:id/approve', async (req, res, next) => {
  const task = await ownTask(req);
  if (!task) return next();
  if (task.status === 'review') {
    await db('project_tasks').where({ id: task.id }).update({ status: 'done', approved_at: nowSql(), updated_at: nowSql() });
    await db('task_comments').insert({ task_id: task.id, user_id: req.user.id, body: '✅ Approved — looks good.', created_at: nowSql() });
    await db('project_updates').insert({ project_id: task.project_id, user_id: req.user.id, client_visible: true, created_at: nowSql(), body: `${req.user.name} approved “${task.title}”.` });
    await syncProgress(task.project_id);
    req.flash('success', 'Approved. Thanks!');
  }
  res.redirect(`/portal/projects/${task.project_id}`);
});

router.post('/tasks/:id/request-changes', async (req, res, next) => {
  const task = await ownTask(req);
  if (!task) return next();
  const body = str(req.body.body, 3000);
  if (task.status === 'review') {
    await db('project_tasks').where({ id: task.id }).update({ status: 'doing', updated_at: nowSql() });
    await db('task_comments').insert({ task_id: task.id, user_id: req.user.id, body: `🔁 Changes requested${body ? `: ${body}` : '.'}`, created_at: nowSql() });
    await syncProgress(task.project_id);
    req.flash('success', 'Sent back to the team with your note.');
  }
  res.redirect(`/portal/projects/${task.project_id}`);
});

// ---- Project files & links (also used for task attachments) ----
const decodeHeader = (v) => {
  try { return decodeURIComponent(v || ''); } catch { return ''; }
};

router.post('/projects/:id/files', express.raw({ type: () => true, limit: MAX_UPLOAD }), async (req, res) => {
  const project = await ownProject(req);
  if (!project) return res.status(404).json({ error: 'Not found' });
  const data = req.body;
  if (!Buffer.isBuffer(data) || !data.length) return res.status(422).json({ error: 'The file is empty.' });
  const taskId = int(req.query.task, 0);
  if (taskId && !(await db('project_tasks').where({ id: taskId, project_id: project.id }).first())) return res.status(404).json({ error: 'Not found' });
  const name = decodeHeader(req.get('x-file-name')).replace(/[\\/\r\n"]/g, '_').slice(0, 190) || 'file';
  const mime = /^[\w.+-]+\/[\w.+-]+$/.test(req.get('content-type') || '') ? req.get('content-type').toLowerCase() : 'application/octet-stream';
  const [fileId] = await db('files').insert({ name, mime, size: data.length, data, uploaded_by: req.user.id, created_at: nowSql() });
  await db('project_files').insert({
    project_id: project.id, task_id: taskId || null, file_id: Array.isArray(fileId) ? fileId[0] : fileId, label: name, mime, size: data.length, uploaded_by: req.user.id, created_at: nowSql(),
  });
  res.status(201).json({ ok: true });
});

router.post('/projects/:id/links', async (req, res) => {
  const project = await ownProject(req);
  if (!project) return res.redirect('/portal/projects');
  const url = str(req.body.url, 500);
  const taskId = int(req.body.task_id, 0);
  const back = taskId ? `/portal/tasks/${taskId}` : `/portal/projects/${project.id}#files`;
  if (!/^https?:\/\//i.test(url || '')) {
    req.flash('error', 'Links must start with http:// or https://');
    return res.redirect(back);
  }
  await db('project_files').insert({
    project_id: project.id, task_id: taskId || null, label: str(req.body.label, 190) || url, url, uploaded_by: req.user.id, created_at: nowSql(),
  });
  res.redirect(back);
});

async function ownFile(req) {
  return db('project_files as f').join('projects as p', 'p.id', 'f.project_id')
    .where({ 'f.id': int(req.params.id, 0), 'p.client_id': req.clientId }).modify(sc(req, 'p.id')).select('f.*').first();
}

router.get('/files/:id', async (req, res, next) => {
  const row = await ownFile(req);
  if (!row || !row.file_id) return next();
  const file = await db('files').where({ id: row.file_id }).first();
  if (!file) return next();
  const inline = SAFE_IMAGES.includes(file.mime) && !req.query.download;
  res.set({
    'Content-Type': file.mime, 'Content-Length': file.size,
    'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="${file.name.replace(/[^ -~]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(file.name)}`,
    'Cache-Control': 'private, max-age=3600', 'Content-Security-Policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
  });
  res.end(Buffer.from(file.data));
});

router.post('/files/:id/delete', async (req, res, next) => {
  const row = await ownFile(req);
  if (!row) return next();
  if (row.file_id) await db('files').where({ id: row.file_id }).del();
  await db('project_files').where({ id: row.id }).del();
  res.redirect(row.task_id ? `/portal/tasks/${row.task_id}` : `/portal/projects/${row.project_id}#files`);
});

// ---- Notifications & search ----
const notifications = require('../lib/notifications');
const safeTarget = (to) => (typeof to === 'string' && /^\/(portal|i|q|meet)\//.test(to) ? to : '/portal/notifications');

router.get('/notifications', async (req, res) => {
  res.render('portal/notifications', { title: 'Notifications', items: await notifications.feed(req.user) });
});

// Clicking a notification marks it read, then goes where it points.
router.get('/notifications/open', async (req, res) => {
  if (req.query.key) await notifications.markRead(req.user.id, [String(req.query.key).slice(0, 120)]);
  res.redirect(safeTarget(req.query.to));
});

router.post('/notifications/read-all', async (req, res) => {
  await notifications.markRead(req.user.id, (await notifications.feed(req.user)).filter((i) => !i.read).map((i) => i.key));
  res.redirect('/portal/notifications');
});

router.get('/search', async (req, res) => {
  const q = (str(req.query.q, 80) || '').trim();
  const like = `%${q.replace(/[%_]/g, '')}%`;
  const none = { projects: [], tasks: [], billing: [], tickets: [], messages: [] };
  if (q.length < 2) return res.render('portal/search', { title: 'Search', q, results: none, total: 0 });
  const [projects, tasks, docs, invoices, quotes, tickets, messages] = await Promise.all([
    Promise.resolve([]), // clients have no Projects section
    Promise.resolve([]), // clients don't search tasks
    db('billing_docs').where({ client_id: req.clientId }).modify((q) => (req.allProjects ? q : q.whereRaw('1 = 0'))).where((w) => w.where('number', 'like', like).orWhere('bill_name', 'like', like)).limit(6),
    visibleInvoices(req.clientId, req.scope).where((w) => w.where('number', 'like', like).orWhere('title', 'like', like)).limit(6),
    visibleQuotes(req.clientId, req.scope).where((w) => w.where('number', 'like', like).orWhere('title', 'like', like)).limit(6),
    db('tickets').where({ client_id: req.clientId }).modify(tk(req)).where('subject', 'like', like).limit(6),
    db('messages as m').join('channel_members as cm', 'cm.channel_id', 'm.channel_id').where('cm.user_id', req.user.id)
      .whereNull('m.deleted_at').where('m.kind', 'text').where('m.body', 'like', like).orderBy('m.id', 'desc').limit(6).select('m.id', 'm.channel_id', 'm.body'),
  ]);
  const billing = [
    ...docs.map((d) => ({ title: `${DOC_TYPES[d.type].label} ${d.number}`, sub: d.bill_name, href: `/portal/billing/${d.id}` })),
    ...invoices.map((i) => ({ title: `Invoice ${i.number}`, sub: i.title || '', href: `/i/${i.public_token}` })),
    ...quotes.map((x) => ({ title: `Quotation ${x.number}`, sub: x.title || '', href: `/q/${x.public_token}` })),
  ];
  const results = { projects, tasks, billing, tickets, messages };
  res.render('portal/search', { title: `Search “${q}”`, q, results, total: projects.length + tasks.length + billing.length + tickets.length + messages.length });
});

const { istToUtc, utcToIst, addMinutesSql } = require('../lib/util');
const M = require('../lib/meetings');

// ---- Calendar: meetings, task deadlines, invoice due dates and project targets in one month view ----
// Clients don't get a calendar. The page is switched off (it falls through to a plain 404); invoice due dates are in Billing and meetings are under Chat & Calls.
router.get('/calendar', (req, res, next) => next());
router.get('/calendar-disabled', async (req, res) => {
  const today = todayIST();
  const m = /^\d{4}-\d{2}$/.test(req.query.m || '') ? req.query.m : today.slice(0, 7);
  const [y, mo] = m.split('-').map(Number);
  const first = new Date(Date.UTC(y, mo - 1, 1));
  const gridStart = new Date(first); gridStart.setUTCDate(1 - ((first.getUTCDay() + 6) % 7)); // weeks start on Monday
  const ymd = (d) => d.toISOString().slice(0, 10);
  const days = [];
  for (let i = 0; i < 42; i += 1) { const d = new Date(gridStart); d.setUTCDate(gridStart.getUTCDate() + i); days.push({ date: ymd(d), inMonth: d.getUTCMonth() === mo - 1, today: ymd(d) === today, events: [] }); }
  const from = days[0].date; const to = days[41].date;
  const byDate = Object.fromEntries(days.map((d) => [d.date, d]));
  const put = (date, ev) => { const d = byDate[String(date).slice(0, 10)]; if (d) d.events.push(ev); };

  const [meetings, tasks, invoices, docs, projects] = await Promise.all([
    M.meetingsFor(req.user.id, { from: addMinutesSql(istToUtc(from, '00:00'), 0), to: addMinutesSql(istToUtc(to, '23:59'), 1) }),
    db('project_tasks as t').join('projects as p', 'p.id', 't.project_id').where('p.client_id', req.clientId).modify(sc(req, 'p.id')).whereNot('t.status', 'done').whereBetween('t.due_date', [from, to]).select('t.id', 't.title', 't.due_date', 'p.name as project'),
    db('invoices').where({ client_id: req.clientId }).whereIn('status', ['sent', 'partially_paid', 'overdue']).whereBetween('due_date', [from, to]),
    db('billing_docs').where({ client_id: req.clientId, type: 'invoice', status: 'open' }).whereBetween('due_date', [from, to]),
    db('projects').where({ client_id: req.clientId }).modify(sc(req)).whereNotIn('status', ['completed', 'cancelled']).whereBetween('due_date', [from, to]),
  ]);
  meetings.forEach((mt) => { const t = utcToIst(mt.starts_at); put(t.date, { kind: 'meeting', label: `${t.time} ${mt.title}`, href: `/portal/chat/meetings/${mt.id}` }); });
  tasks.forEach((t) => put(t.due_date, { kind: 'task', label: t.title, href: `/portal/tasks/${t.id}`, sub: t.project }));
  invoices.forEach((i) => put(i.due_date, { kind: 'invoice', label: `${i.number} due`, href: `/i/${i.public_token}` }));
  docs.forEach((d) => put(d.due_date, { kind: 'invoice', label: `${d.number} due`, href: `/portal/billing/${d.id}` }));
  projects.forEach((p) => put(p.due_date, { kind: 'project', label: `${p.name} target`, href: `/portal/projects/${p.id}` }));

  const shift = (n) => { const d = new Date(Date.UTC(y, mo - 1 + n, 1)); return d.toISOString().slice(0, 7); };
  const upcoming = days.filter((d) => d.date >= today && d.events.length).slice(0, 8);
  res.render('portal/calendar', {
    title: 'Calendar', m, monthLabel: first.toLocaleDateString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' }), weeks: [0, 1, 2, 3, 4, 5].map((w) => days.slice(w * 7, w * 7 + 7)),
    prev: shift(-1), next: shift(1), thisMonth: today.slice(0, 7), upcoming,
  });
});

// ---- Support ---------------------------------------------------------------------------
router.get('/tickets', async (req, res) => {
  const tickets = await db('tickets as t').leftJoin('projects as p', 'p.id', 't.project_id').where('t.client_id', req.clientId).modify(tk(req, 't.project_id', 't.created_by'))
    .orderByRaw("CASE WHEN t.status IN ('open','awaiting_client') THEN 0 ELSE 1 END").orderBy('t.last_reply_at', 'desc')
    .select('t.*', 'p.name as project_name');
  res.render('portal/tickets', { title: 'Support', tickets });
});

router.get('/tickets/new', async (req, res) => {
  const projects = await db('projects').where({ client_id: req.clientId }).modify(sc(req)).whereNot({ status: 'cancelled' }).orderBy('name');
  res.render('portal/ticket-new', { title: 'New request', projects, values: { project_id: req.query.project_id || '' }, errors: {} });
});

async function notifyTeam(ticket, body, clientName, userName, isNew) {
  await sendMail({
    to: config.notifyEmail,
    subject: `${isNew ? '🆕 Support request' : '💬 Client reply'} [#${ticket.id}] ${ticket.subject} — ${clientName}`,
    related: ['ticket', ticket.id],
    heading: isNew ? 'New support request' : 'Client replied',
    lines: [`${userName} (${clientName}) wrote:`, ...body.split(/\n+/)],
    rows: [['Priority', ticket.priority]],
    button: { label: 'Open request', url: `${config.baseUrl}${process.env.ENABLE_ADMIN === '1' ? '/admin/tickets/' : '/team/support/'}${ticket.id}` },
  });
}

router.post('/tickets', async (req, res) => {
  const subject = str(req.body.subject, 255);
  const body = str(req.body.body, 10000);
  const projectId = int(req.body.project_id, 0);
  const project = projectId ? await db('projects').where({ id: projectId, client_id: req.clientId }).modify(sc(req)).first() : null;
  const errors = {};
  if (!subject) errors.subject = 'Add a short subject.';
  if (!body) errors.body = 'Tell us what you need.';
  if (Object.keys(errors).length) {
    const projects = await db('projects').where({ client_id: req.clientId }).modify(sc(req)).orderBy('name');
    return res.status(422).render('portal/ticket-new', { title: 'New request', projects, values: req.body, errors });
  }
  const priority = ['low', 'normal', 'high', 'urgent'].includes(req.body.priority) ? req.body.priority : 'normal';
  const [id] = await db('tickets').insert({
    client_id: req.clientId, project_id: project ? project.id : null, subject, priority, status: 'open', created_by: req.user.id,
    last_reply_at: nowSql(), last_reply_by: 'client', created_at: nowSql(), updated_at: nowSql(),
  });
  await db('ticket_messages').insert({ ticket_id: id, user_id: req.user.id, body, internal: false, created_at: nowSql() });
  await notifyTeam({ id, subject, priority }, body, res.locals.client.name, req.user.name, true);
  req.flash('success', 'Request sent. We’ll reply here and by email.');
  res.redirect(`/portal/tickets/${id}`);
});

router.get('/tickets/:id', async (req, res, next) => {
  const ticket = await db('tickets').where({ id: int(req.params.id, 0), client_id: req.clientId }).modify(tk(req)).first();
  if (!ticket) return next();
  const messages = await db('ticket_messages as m').leftJoin('users as u', 'u.id', 'm.user_id')
    .where({ 'm.ticket_id': ticket.id, 'm.internal': false }).orderBy('m.id').select('m.*', 'u.name as user_name', 'u.role as user_role');
  res.render('portal/ticket', { title: ticket.subject, ticket, messages });
});

router.post('/tickets/:id/reply', async (req, res, next) => {
  const ticket = await db('tickets').where({ id: int(req.params.id, 0), client_id: req.clientId }).modify(tk(req)).first();
  if (!ticket) return next();
  const body = str(req.body.body, 10000);
  if (req.body.close) {
    await db('tickets').where({ id: ticket.id }).update({ status: 'closed', updated_at: nowSql() });
    req.flash('success', 'Request closed. Thanks!');
    return res.redirect(`/portal/tickets/${ticket.id}`);
  }
  if (body) {
    await db('ticket_messages').insert({ ticket_id: ticket.id, user_id: req.user.id, body, internal: false, created_at: nowSql() });
    await db('tickets').where({ id: ticket.id }).update({ status: 'open', last_reply_at: nowSql(), last_reply_by: 'client', updated_at: nowSql() });
    await notifyTeam(ticket, body, res.locals.client.name, req.user.name, false);
    req.flash('success', 'Reply sent.');
  }
  res.redirect(`/portal/tickets/${ticket.id}`);
});

// ---- Account ---------------------------------------------------------------------------
// ---- Account: profile, company, people, password ----
const { createPasswordLink } = require('../lib/auth');

async function accountLocals(req, extra = {}) {
  const [client, people] = await Promise.all([
    db('clients').where({ id: req.clientId }).first(),
    db('users').where({ client_id: req.clientId, role: 'client' }).orderBy('id'),
  ]);
  return { title: 'My account', styles: ['board'], error: null, client, people, inviteLink: null, ...extra };
}

const companyOnly = (req, res, next) => (req.allProjects ? next() : notFoundPage(req, res));
router.get('/account', async (req, res) => {
  const inviteLink = req.session.inviteLink || null;
  delete req.session.inviteLink;
  res.render('portal/account', await accountLocals(req, { inviteLink }));
});

router.post('/account', async (req, res) => {
  const ok = await verifyPassword(req.body.current || '', req.user.password_hash);
  const problem = !ok ? 'Your current password is incorrect.' : passwordProblem(req.body.password) || (req.body.password !== req.body.confirm ? 'The new passwords don’t match.' : null);
  if (problem) return res.status(422).render('portal/account', await accountLocals(req, { error: problem }));
  const v = req.user.token_version + 1;
  await db('users').where({ id: req.user.id }).update({ password_hash: await hashPassword(req.body.password), token_version: v, updated_at: nowSql() });
  signIn(req, { ...req.user, token_version: v });
  req.flash('success', 'Password changed.');
  res.redirect('/portal/account');
});

router.post('/account/profile', async (req, res) => {
  const name = str(req.body.name, 190);
  if (!name) {
    req.flash('error', 'Your name can’t be empty.');
    return res.redirect('/portal/account');
  }
  await db('users').where({ id: req.user.id }).update({
    name, job_title: str(req.body.job_title, 120) || null, phone: str(req.body.phone, 40) || null, email_updates: Boolean(req.body.email_updates), updated_at: nowSql(),
  });
  req.flash('success', 'Profile saved.');
  res.redirect('/portal/account');
});

// Profile photo: stored like any other upload, images only.
router.post('/account/avatar', express.raw({ type: () => true, limit: 2 * 1024 * 1024 }), async (req, res) => {
  const data = req.body;
  const mime = String(req.get('content-type') || '').toLowerCase();
  if (!Buffer.isBuffer(data) || !data.length || !SAFE_IMAGES.includes(mime)) return res.status(422).json({ error: 'Choose a PNG, JPG, GIF or WebP image under 2 MB.' });
  const [fid] = await db('files').insert({ name: 'avatar', mime, size: data.length, data, uploaded_by: req.user.id, created_at: nowSql() });
  if (req.user.avatar_file_id) await db('files').where({ id: req.user.avatar_file_id }).del();
  await db('users').where({ id: req.user.id }).update({ avatar_file_id: Array.isArray(fid) ? fid[0] : fid, updated_at: nowSql() });
  res.json({ ok: true });
});

router.post('/account/avatar/remove', async (req, res) => {
  if (req.user.avatar_file_id) await db('files').where({ id: req.user.avatar_file_id }).del();
  await db('users').where({ id: req.user.id }).update({ avatar_file_id: null, updated_at: nowSql() });
  res.redirect('/portal/account');
});

router.get('/avatar/:id', async (req, res, next) => {
  const u = await db('users').where({ id: int(req.params.id, 0) }).first();
  // A photo is only shown to people at the same company, or when it belongs to someone on the Haptags team.
  const visible = u && (u.client_id === req.clientId || ['owner', 'admin', 'staff'].includes(u.role));
  const file = visible && u.avatar_file_id ? await db('files').where({ id: u.avatar_file_id }).first() : null;
  if (!file || !SAFE_IMAGES.includes(file.mime)) return next();
  res.set({ 'Content-Type': file.mime, 'Content-Length': file.size, 'Cache-Control': 'private, max-age=300', 'Content-Security-Policy': "default-src 'none'; img-src 'self'; sandbox" });
  res.end(Buffer.from(file.data));
});

router.post('/account/company', companyOnly, async (req, res) => {
  await db('clients').where({ id: req.clientId }).update({
    name: str(req.body.name, 190) || undefined, phone: str(req.body.phone, 40) || null, address: str(req.body.address, 500) || null,
    city: str(req.body.city, 100) || null, state: str(req.body.state, 100) || null, pincode: str(req.body.pincode, 12) || null,
    gstin: (str(req.body.gstin, 20) || '').toUpperCase() || null, updated_at: nowSql(),
  });
  req.flash('success', 'Company details saved.');
  res.redirect('/portal/account');
});

// Add a colleague from the same company: they get a link to set their password.
router.post('/account/people', companyOnly, async (req, res) => {
  const name = str(req.body.name, 190);
  const email = (str(req.body.email, 190) || '').toLowerCase();
  if (!name || !/^\S+@\S+\.\S+$/.test(email)) {
    req.flash('error', 'Enter your colleague’s name and a valid email.');
    return res.redirect('/portal/account');
  }
  if (await db('users').where({ email }).first()) {
    req.flash('error', 'That email already has an account.');
    return res.redirect('/portal/account');
  }
  const [id] = await db('users').insert({ name, email, role: 'client', client_id: req.clientId, is_active: true, token_version: 1, created_at: nowSql(), updated_at: nowSql() });
  const link = await createPasswordLink(Array.isArray(id) ? id[0] : id);
  await sendMail({ to: email, subject: 'You’ve been added to the Haptags client portal', heading: `Welcome, ${name.split(' ')[0]}`, lines: [`${req.user.name} added you to the Haptags client portal.`, 'Set your password to get started.'], button: { label: 'Set my password', url: link } }).catch(() => {});
  req.session.inviteLink = link;
  req.flash('success', `${name} was added. Share the link below if the email doesn’t arrive.`);
  res.redirect('/portal/account');
});

router.post('/account/people/:id/remove', companyOnly, async (req, res) => {
  const id = int(req.params.id, 0);
  if (id !== req.user.id) await db('users').where({ id, client_id: req.clientId, role: 'client' }).update({ is_active: false, token_version: db.raw('token_version + 1'), updated_at: nowSql() });
  req.flash('success', 'Access removed.');
  res.redirect('/portal/account');
});


module.exports = router;
