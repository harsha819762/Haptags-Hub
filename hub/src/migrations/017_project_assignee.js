'use strict';

/**
 * Projects get an owner on the Haptags team, shown on the client's project board.
 * A plain column, not a foreign key: on SQLite, adding a foreign key to an existing table rebuilds
 * it, and dropping the old `projects` cascades into milestones and updates (see 006).
 */
exports.up = async function up(knex) {
  if (await knex.schema.hasColumn('projects', 'assigned_to')) return;
  await knex.schema.alterTable('projects', (t) => {
    t.integer('assigned_to').unsigned();
  });
};

exports.down = async function down(knex) {
  await knex.schema.alterTable('projects', (t) => {
    t.dropColumn('assigned_to');
  });
};
