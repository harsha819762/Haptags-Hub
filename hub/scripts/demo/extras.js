'use strict';

// Fills in task details, comments and a few links so the new task/files features have something to show. Safe to re-run.
const { db, migrate } = require('../../src/db');
const { nowSql, addDays, todayIST } = require('../../src/lib/util');

(async () => {
  await migrate();
  const client = await db('users').where({ email: 'client@haptags.local' }).first();
  const staff = await db('users').where({ email: 'staff@haptags.local' }).first();
  if (!client || !staff) throw new Error('Run npm run seed-demo first.');
  const today = todayIST();

  const task = (title) => db('project_tasks').where({ title }).first();
  const set = async (title, patch) => { const t = await task(title); if (t) await db('project_tasks').where({ id: t.id }).update(patch); return t; };

  await set('Product catalogue pages', { priority: 'high', due_date: addDays(today, 2), description: 'Category pages with filters, product cards and a quick-view.' });
  await set('Contact & enquiry form', { priority: 'normal', due_date: addDays(today, 6) });
  await set('Cart & checkout', { priority: 'high', due_date: addDays(today, 1), description: 'Cart, address step and UPI / card payment. Ready for your review on staging.' });
  await set('Payment gateway', { priority: 'high', due_date: addDays(today, -1), description: 'Connect Razorpay and test refunds.' });
  await set('Admin dashboard', { priority: 'low', due_date: addDays(today, 12) });

  const review = await task('Cart & checkout');
  if (review && !(await db('task_comments').where({ task_id: review.id }).first())) {
    await db('task_comments').insert([
      { task_id: review.id, user_id: staff.id, body: 'Checkout is live on staging — could you try a test order and approve if it looks right?', created_at: nowSql() },
      { task_id: review.id, user_id: client.id, body: 'Will do this afternoon, thanks!', created_at: nowSql() },
    ]);
    await db('project_files').insert({ project_id: review.project_id, task_id: review.id, label: 'Staging checkout', url: 'https://example.com/staging/checkout', uploaded_by: staff.id, created_at: nowSql() });
  }

  const lotus = await db('projects').where({ name: 'Lotus Boutique Website' }).first();
  if (lotus && !(await db('project_files').where({ project_id: lotus.id }).first())) {
    await db('project_files').insert([
      { project_id: lotus.id, label: 'Brand guidelines (Figma)', url: 'https://example.com/figma/lotus-brand', uploaded_by: staff.id, created_at: nowSql() },
      { project_id: lotus.id, label: 'Signed proposal (Drive)', url: 'https://example.com/drive/lotus-proposal', uploaded_by: client.id, created_at: nowSql() },
    ]);
  }
  console.log('Demo extras ready.');
  await db.destroy();
})();
