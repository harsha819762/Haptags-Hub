'use strict';

// Seeds a few conversations and an upcoming meeting so the demo client's Chat & Calls page isn't empty. Safe to re-run.
const { db, migrate } = require('../../src/db');
const chat = require('../../src/lib/chat');
const M = require('../../src/lib/meetings');
const { istToUtc, addDays, todayIST, nowSql } = require('../../src/lib/util');

(async () => {
  await migrate();
  const client = await db('users').where({ email: 'client@haptags.local' }).first();
  const staff = await db('users').where({ email: 'staff@haptags.local' }).first();
  const owner = await db('users').where({ email: 'demo@haptags.local' }).first();
  if (!client || !staff || !owner) throw new Error('Run npm run seed-demo first.');

  const dm = await chat.directChannel(client.id, staff.id);
  if (!(await db('messages').where({ channel_id: dm }).first())) {
    const say = (userId, body) => chat.postMessage({ channelId: dm, userId, body });
    await say(staff.id, 'Hi Priya! 👋 Arjun from Haptags here. I’ll be your point of contact for the website redesign.');
    await say(client.id, 'Hello Arjun, thanks! Could you share the latest homepage draft?');
    await say(staff.id, 'Sure — the staging link is live. Have a look and drop your feedback here, or we can walk through it on a quick call.');
    await say(client.id, 'Great, let’s do a call tomorrow.');
  }

  const groupName = 'Website launch';
  let group = await db('channels').where({ kind: 'group', name: groupName }).first();
  if (!group) {
    const id = await chat.groupChannel(client.id, [staff.id, owner.id], groupName);
    group = { id };
    await chat.postMessage({ channelId: id, userId: owner.id, body: 'Welcome to the launch room. We’ll share progress and approvals here.' });
  }

  if (!(await db('meetings').where({ title: 'Homepage review call' }).first())) {
    const tomorrow = addDays(todayIST(), 1);
    await M.createMeeting({
      title: 'Homepage review call', agenda: 'Walk through the homepage draft and agree the changes.', startsAt: istToUtc(tomorrow, '11:00'),
      duration: 30, allowGuests: false, createdBy: staff.id, userIds: [client.id],
    });
  }
  console.log('Demo chat and meeting ready.', nowSql());
  await db.destroy();
})();
