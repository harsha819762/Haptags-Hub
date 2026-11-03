'use strict';

/** "Assigned to" is just a name now, not a link to a team account. Existing assignees are carried over. */
exports.up = async function up(knex) {
  for (const table of ['projects', 'project_tasks']) {
    await knex.schema.alterTable(table, (t) => { t.string('assignee', 80); });
    const rows = await knex(table).whereNotNull('assigned_to').select('id', 'assigned_to');
    for (const row of rows) {
      const user = await knex('users').where({ id: row.assigned_to }).first();
      if (user) await knex(table).where({ id: row.id }).update({ assignee: user.name.slice(0, 80) });
    }
  }
};

exports.down = async function down(knex) {
  for (const table of ['projects', 'project_tasks']) {
    await knex.schema.alterTable(table, (t) => { t.dropColumn('assignee'); });
  }
};
