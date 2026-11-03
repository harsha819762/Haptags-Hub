'use strict';

// Adds demo projects (website, app, AI automation and a few more) with tasks for the demo client.
// "Assigned to" is just a name. Safe to re-run: projects that already exist are skipped.
const { db, migrate } = require('../../src/db');
const { nowSql, addDays, todayIST } = require('../../src/lib/util');

const PEOPLE = ['Ananya Rao', 'Karthik Menon', 'Divya Nair', 'Rohan Shetty', 'Meera Iyer'];

const DEMOS = [
  {
    name: 'Lotus Boutique Website', service: 'website-development', status: 'in_progress', dueIn: 24, who: 'Ananya Rao',
    tasks: [['Brand & moodboard', 'done'], ['Homepage design', 'done'], ['Product catalogue pages', 'doing'], ['Contact & enquiry form', 'todo'], ['SEO setup', 'todo']],
  },
  {
    name: 'FreshCart Grocery App', service: 'mobile-app-development', status: 'review', dueIn: 40, who: 'Karthik Menon',
    tasks: [['User flows & wireframes', 'done'], ['Onboarding screens', 'done'], ['Cart & checkout', 'review'], ['Push notifications', 'doing'], ['Play Store listing', 'todo']],
  },
  {
    name: 'SmartDesk AI Support Bot', service: 'ai-automation', status: 'planning', dueIn: 60, who: 'Divya Nair',
    tasks: [['Collect FAQs & past tickets', 'todo'], ['Choose WhatsApp flow', 'todo'], ['Train & test answers', 'todo']],
  },
  {
    name: 'Urban Nest Booking Portal', service: 'web-application-development', status: 'in_progress', dueIn: 35, who: 'Rohan Shetty',
    tasks: [['Room & rate model', 'done'], ['Booking calendar', 'doing'], ['Payment gateway', 'todo'], ['Admin dashboard', 'todo']],
  },
  {
    name: 'Zenith Fitness CRM', service: 'crm-development', status: 'completed', dueIn: -10, who: 'Meera Iyer',
    tasks: [['Member import', 'done'], ['Renewal reminders', 'done'], ['Reports', 'done']],
  },
  {
    name: 'Spice Route Online Store', service: 'ecommerce-development', status: 'on_hold', dueIn: 75, who: 'Ananya Rao',
    tasks: [['Product photography brief', 'todo'], ['Shipping rules', 'todo']],
  },
];

(async () => {
  await migrate();
  const client = await db('users').where({ email: 'client@haptags.local' }).first();
  if (!client) throw new Error('Run npm run seed-demo first.');

  // Leftovers from manual testing.
  await db('projects').where({ client_id: client.client_id, name: 'Mobile app for orders' }).del();
  await db('project_tasks').whereIn('title', ['Curl task', 'Design homepage hero']).del();

  const today = todayIST();
  let added = 0;
  for (const d of DEMOS) {
    const existing = await db('projects').where({ client_id: client.client_id, name: d.name }).first();
    if (existing) {
      await db('projects').where({ id: existing.id }).update({ assignee: d.who });
      await db('project_tasks').where({ project_id: existing.id }).whereNotNull('assigned_to').update({ assignee: d.who });
      continue;
    }
    const done = d.tasks.filter((t) => t[1] === 'done').length;
    const [id] = await db('projects').insert({
      client_id: client.client_id, name: d.name, service: d.service, status: d.status, assignee: d.who,
      progress: Math.round((done / d.tasks.length) * 100), start_date: addDays(today, -14), due_date: addDays(today, d.dueIn),
      budget: 0, created_at: nowSql(), updated_at: nowSql(),
    });
    for (const [i, [title, status]] of d.tasks.entries()) {
      await db('project_tasks').insert({
        project_id: id, title, status, assignee: status === 'todo' && i % 2 ? null : PEOPLE[(added + i) % PEOPLE.length],
        created_at: nowSql(), updated_at: nowSql(),
      });
    }
    added += 1;
  }
  // The original seeded project gets a name too.
  await db('projects').where({ client_id: client.client_id, name: 'Website redesign' }).update({ assignee: 'Ananya Rao' });
  console.log(`Added ${added} demo project(s).`);
  await db.destroy();
})();
