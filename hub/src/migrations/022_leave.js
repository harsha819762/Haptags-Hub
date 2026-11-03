'use strict';

/** Leave requests from the Haptags team, approved or rejected by an owner or admin. */
exports.up = async function up(knex) {
  await knex.schema.createTable('leave_requests', (t) => {
    t.increments('id');
    t.integer('user_id').unsigned().notNullable().references('id').inTable('users').onDelete('CASCADE');
    t.string('type', 12).notNullable(); // casual | sick | earned | unpaid
    t.date('start_date').notNullable();
    t.date('end_date').notNullable();
    t.decimal('days', 5, 1).notNullable();
    t.boolean('half_day').notNullable().defaultTo(false);
    t.text('reason');
    t.string('status', 12).notNullable().defaultTo('pending'); // pending | approved | rejected | cancelled
    t.integer('decided_by').unsigned().references('id').inTable('users').onDelete('SET NULL');
    t.datetime('decided_at');
    t.text('decision_note');
    t.datetime('created_at');
    t.index(['user_id', 'status']);
    t.index(['start_date']);
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('leave_requests');
};
