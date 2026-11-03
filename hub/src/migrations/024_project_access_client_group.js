'use strict';

/**
 * 1. A client person can be limited to certain projects (project_members). Existing people keep access to
 *    all of their company's projects (users.all_projects defaults to true); new invitations choose.
 * 2. Each client company gets exactly one group chat with its Haptags contacts (channels.client_id). Any older
 *    chats between that client's people and the team are folded into that group, so nothing is lost.
 */
exports.up = async function up(knex) {
  await knex.schema.createTable('project_members', (t) => {
    t.increments('id');
    t.integer('project_id').unsigned().notNullable().references('id').inTable('projects').onDelete('CASCADE');
    t.integer('user_id').unsigned().notNullable().references('id').inTable('users').onDelete('CASCADE');
    t.datetime('created_at');
    t.unique(['project_id', 'user_id']);
  });
  await knex.schema.alterTable('users', (t) => { t.boolean('all_projects').notNullable().defaultTo(true); });
  await knex.schema.alterTable('channels', (t) => { t.integer('client_id').unsigned(); });

  const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
  const clients = await knex('clients').select('id', 'name');
  for (const c of clients) {
    const clientUsers = await knex('users').where({ client_id: c.id, role: 'client' }).pluck('id');
    if (!clientUsers.length) continue;
    const contacts = await knex('client_contacts').where({ client_id: c.id }).pluck('user_id');

    const [gid] = await knex('channels').insert({ kind: 'group', name: `${c.name} × Haptags`, is_private: true, client_id: c.id, created_at: now, last_message_at: now });
    const groupId = Array.isArray(gid) ? gid[0] : gid;

    // Fold every other conversation these people were in (DMs and groups) into the one group.
    const old = await knex('channel_members').whereIn('user_id', clientUsers).whereNot('channel_id', groupId).distinct('channel_id').pluck('channel_id');
    const oldChannels = old.length ? await knex('channels').whereIn('id', old).whereIn('kind', ['dm', 'group']).whereNull('client_id') : [];
    const team = new Set(contacts);
    for (const ch of oldChannels) {
      (await knex('channel_members').where({ channel_id: ch.id }).pluck('user_id')).forEach((u) => { if (!clientUsers.includes(u)) team.add(u); });
      await knex('messages').where({ channel_id: ch.id }).update({ channel_id: groupId });
      await knex('channel_members').where({ channel_id: ch.id }).del();
      await knex('channels').where({ id: ch.id }).del();
    }

    const last = await knex('messages').where({ channel_id: groupId }).max({ m: 'id' }).first();
    const lastId = Number(last.m || 0);
    for (const uid of new Set([...clientUsers, ...team])) {
      await knex('channel_members').insert({ channel_id: groupId, user_id: uid, last_read_id: lastId, joined_at: now });
    }
    // Contacts are who the client can reach, so keep that list in step with the group.
    for (const uid of team) {
      if (!contacts.includes(uid)) await knex('client_contacts').insert({ client_id: c.id, user_id: uid, created_at: now }).catch(() => {});
    }
    const newest = await knex('messages').where({ channel_id: groupId }).max({ at: 'created_at' }).first();
    if (newest.at) await knex('channels').where({ id: groupId }).update({ last_message_at: newest.at });
  }
};

exports.down = async function down(knex) {
  await knex.schema.alterTable('channels', (t) => { t.dropColumn('client_id'); });
  await knex.schema.alterTable('users', (t) => { t.dropColumn('all_projects'); });
  await knex.schema.dropTableIfExists('project_members');
};
