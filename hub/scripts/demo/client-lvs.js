'use strict';

// Demo client: Paru at LVS. She is invited for ONE project (LVS Website); LVS also has a second project she can't see.
// Safe to re-run. Sign in as paru@lvs.test / demo-password-123.
const crypto = require('crypto');
const { db, migrate } = require('../../src/db');
const { hashPassword } = require('../../src/lib/auth');
const { inviteUser, setProjectAccess } = require('../../src/lib/invites');
const { ensureClientGroup } = require('../../src/lib/clientchat');
const chat = require('../../src/lib/chat');
const M = require('../../src/lib/meetings');
const { nowSql, addDays, todayIST, istToUtc } = require('../../src/lib/util');

(async () => {
  await migrate();
  const owner = await db('users').where({ role: 'owner' }).first();
  const staff = await db('users').where({ email: 'staff@haptags.local' }).first();
  if (!owner || !staff) throw new Error('Run npm run seed-demo first.');
  const today = todayIST();

  let client = await db('clients').where({ name: 'LVS' }).first();
  if (client && await db('users').where({ email: 'paru@lvs.test' }).first()) { console.log('LVS demo already exists.'); await db.destroy(); return; }
  if (!client) {
    const [cid] = await db('clients').insert({
      name: 'LVS', contact_name: 'Paru', email: 'paru@lvs.test', phone: '+91 98450 11223', city: 'Bengaluru', state: 'Karnataka', pincode: '560001',
      address: '12, MG Road', status: 'active', created_at: nowSql(), updated_at: nowSql(),
    });
    client = { id: Array.isArray(cid) ? cid[0] : cid };
  }
  const clientId = client.id;
  for (const u of [owner, staff]) if (!(await db('client_contacts').where({ client_id: clientId, user_id: u.id }).first())) await db('client_contacts').insert({ client_id: clientId, user_id: u.id, created_at: nowSql() });

  const mk = async (p) => { const [id] = await db('projects').insert({ client_id: clientId, budget: 0, progress: 0, created_at: nowSql(), updated_at: nowSql(), ...p }); return Array.isArray(id) ? id[0] : id; };
  const web = await mk({ name: 'LVS Website', service: 'website-development', status: 'in_progress', description: 'New marketing website for LVS.', start_date: addDays(today, -21), due_date: addDays(today, 18), assignee: 'Arjun Shetty' });
  const app = await mk({ name: 'LVS Mobile App', service: 'mobile-app-development', status: 'planning', start_date: addDays(today, 7), due_date: addDays(today, 90), assignee: 'Divya Nair' });

  const tasks = [
    ['Sitemap & page structure', 'done', 'normal', -14, 'Arjun Shetty'], ['Brand colours & typography', 'done', 'normal', -10, 'Divya Nair'],
    ['Homepage design', 'review', 'high', 1, 'Divya Nair', 'First draft of the homepage is ready on staging. Please review the hero and the services section.'],
    ['Services pages', 'doing', 'normal', 6, 'Arjun Shetty'], ['Contact form & map', 'doing', 'normal', 8, 'Karthik Menon'],
    ['Blog setup', 'todo', 'low', 12, null], ['SEO & analytics', 'todo', 'normal', 15, 'Ananya Rao'], ['Launch checklist', 'todo', 'high', 17, 'Arjun Shetty'],
  ];
  const ids = {};
  for (const [title, status, priority, due, who, description] of tasks) {
    const [tid] = await db('project_tasks').insert({ project_id: web, title, status, priority, due_date: addDays(today, due), assignee: who, description: description || null, created_at: nowSql(), updated_at: nowSql() });
    ids[title] = Array.isArray(tid) ? tid[0] : tid;
  }
  const done = tasks.filter((t) => t[1] === 'done').length;
  await db('projects').where({ id: web }).update({ progress: Math.round((done / tasks.length) * 100) });
  await db('task_comments').insert([
    { task_id: ids['Homepage design'], user_id: staff.id, body: 'Draft is live on staging — could you check the hero text and approve if it looks right?', internal: false, created_at: nowSql() },
    { task_id: ids['Homepage design'], user_id: staff.id, body: 'Internal: client wants a darker blue — confirm with Divya before the next round.', internal: true, created_at: nowSql() },
  ]);
  await db('project_updates').insert({ project_id: web, user_id: staff.id, body: 'We’ve started building the services pages. The homepage draft is on staging — please review it when you can.', client_visible: true, created_at: nowSql() });
  await db('project_files').insert([
    { project_id: web, label: 'Staging site', url: 'https://example.com/lvs/staging', uploaded_by: staff.id, created_at: nowSql() },
    { project_id: web, label: 'Brand guidelines (PDF)', url: 'https://example.com/lvs/brand.pdf', uploaded_by: staff.id, created_at: nowSql() },
  ]);

  // Invoices for the website project (one paid, one due soon) and one for the app she can't see.
  const inv = async (number, title, projectId, status, total, issued, due, paid) => db('invoices').insert({
    number, client_id: clientId, project_id: projectId, title, issue_date: addDays(today, issued), due_date: addDays(today, due), status, tax_mode: 'intra', gst_rate: 18,
    subtotal: Math.round(total / 1.18), cgst: Math.round((total - Math.round(total / 1.18)) / 2), sgst: Math.round((total - Math.round(total / 1.18)) / 2), total, amount_paid: paid,
    public_token: crypto.randomBytes(24).toString('hex'), paid_at: paid ? nowSql() : null, created_at: nowSql(), updated_at: nowSql(),
  });
  const nextNo = async () => `HT/26-27/${String(1 + (await db('invoices').where('number', 'like', 'HT/26-27/%').count({ n: '*' }).first().then((r) => Number(r.n)))).padStart(4, '0')}`;
  await inv(await nextNo(), 'Website — advance (50%)', web, 'paid', 5900000, -20, -13, 5900000);
  await inv(await nextNo(), 'Website — milestone 2', web, 'sent', 3540000, -2, 5, 0);
  await inv(await nextNo(), 'Mobile app — kick-off', app, 'sent', 7080000, -1, 7, 0);

  // Paru: invited for the website only, with a password so she can also sign in normally.
  const invited = await inviteUser({ name: 'Paru', email: 'paru@lvs.test', role: 'client', clientId, invitedBy: owner, send: false, allProjects: false, projectIds: [web] });
  await db('users').where({ id: invited.id }).update({ password_hash: await hashPassword('demo-password-123'), invite_token_hash: null, invite_expires_at: null, last_login_at: nowSql(), phone: '+91 98450 11223', job_title: 'Operations Head' });

  // The one group chat.
  const gid = await ensureClientGroup(clientId);
  const say = (userId, body) => chat.postMessage({ channelId: gid, userId, body });
  await say(staff.id, 'Hi Paru! 👋 Welcome to your Haptags portal. This is your project chat with our team.');
  await say(invited.id, 'Thanks Arjun, great to be here. Is the homepage draft ready?');
  await say(staff.id, 'Yes — it’s on staging and waiting for your approval under Projects → LVS Website → Homepage design.');
  await say(invited.id, 'Perfect, I’ll look at it this afternoon.');
  await say(owner.id, 'Let us know if you’d like a quick call to walk through it.');

  // A meeting she is invited to.
  const tomorrow = addDays(today, 1);
  await M.createMeeting({ title: 'LVS website review', agenda: 'Walk through the homepage draft and agree changes.', startsAt: istToUtc(tomorrow, '15:00'), duration: 30, allowGuests: false, createdBy: staff.id, userIds: [invited.id] });

  console.log('Demo client ready: Paru at LVS (sees "LVS Website" only; "LVS Mobile App" is hidden from her).');
  await db.destroy();
})();
