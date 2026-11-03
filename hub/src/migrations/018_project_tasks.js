'use strict';

/** Tasks live inside a project and move across the project's To do / In progress / Under review / Completed board. */
exports.up = async function up(knex) {
  await knex.schema.createTable('project_tasks', (t) => {
    t.increments('id');
    t.integer('project_id').unsigned().notNullable().references('id').inTable('projects').onDelete('CASCADE');
    t.string('title', 255).notNullable();
    t.string('status', 20).notNullable().defaultTo('todo'); // todo | doing | review | done
    t.integer('assigned_to').unsigned().references('id').inTable('users').onDelete('SET NULL');
    t.date('due_date');
    t.datetime('created_at');
    t.datetime('updated_at');
    t.index(['project_id', 'status']);
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('project_tasks');
};
