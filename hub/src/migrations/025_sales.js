'use strict';

/** Sales logged by the team: who sold what, to whom, for how much. Owners and admins see everyone's; teammates see their own. */
exports.up = async function up(knex) {
  await knex.schema.createTable('sales', (t) => {
    t.increments('id');
    t.integer('user_id').unsigned().notNullable().references('id').inTable('users').onDelete('CASCADE'); // credited to
    t.integer('client_id').unsigned().references('id').inTable('clients').onDelete('SET NULL'); // optional link to an existing client
    t.string('customer', 190).notNullable();
    t.string('title', 190).notNullable(); // what was sold
    t.bigInteger('amount').notNullable().defaultTo(0); // paise, like every other amount in the app
    t.date('sale_date').notNullable();
    t.string('status', 12).notNullable().defaultTo('won'); // won | pipeline
    t.text('notes');
    t.integer('created_by').unsigned().references('id').inTable('users').onDelete('SET NULL');
    t.datetime('created_at');
    t.datetime('updated_at');
    t.index(['user_id', 'sale_date']);
    t.index(['sale_date']);
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('sales');
};
