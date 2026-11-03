'use strict';

/**
 * Which Haptags people a client can see and message (their "account team"), and internal task notes that
 * only the team can read. Existing clients start with the owner plus anyone the team has already chatted with them.
 */
exports.up = async function up(knex) {
  await knex.schema.createTable('client_contacts', (t) => {
    t.increments('id');
    t.integer('client_id').unsigned().notNullable().references('id').inTable('clients').onDelete('CASCADE');
    t.integer('user_id').unsigned().notNullable().references('id').inTable('users').onDelete('CASCADE');
    t.datetime('created_at');
    t.unique(['client_id', 'user_id']);
  });

  await knex.schema.alterTable('task_comments', (t) => {
    t.boolean('internal').notNullable().defaultTo(false);
  });

  const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
  const owner = await knex('users').where({ role: 'owner', is_active: true }).first();
  const clients = await knex('clients').select('id');
  const seen = new Set();
  const add = async (client_id, user_id) => {
    const key = `${client_id}:${user_id}`;
    if (seen.has(key)) return;
    seen.add(key);
    await knex('client_contacts').insert({ client_id, user_id, created_at: now });
  };
  for (const c of clients) if (owner) await add(c.id, owner.id);

  // Team members already in a conversation with one of the client's people.
  const pairs = await knex('channel_members as a').join('users as u', 'u.id', 'a.user_id').join('channel_members as b', 'b.channel_id', 'a.channel_id')
    .join('users as s', 's.id', 'b.user_id').where('u.role', 'client').whereIn('s.role', ['owner', 'admin', 'staff']).select('u.client_id', 's.id as staff_id');
  for (const p of pairs) if (p.client_id) await add(p.client_id, p.staff_id);
};

exports.down = async function down(knex) {
  await knex.schema.alterTable('task_comments', (t) => { t.dropColumn('internal'); });
  await knex.schema.dropTableIfExists('client_contacts');
};
