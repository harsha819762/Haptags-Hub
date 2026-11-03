'use strict';

/** Task details and comments, project files, billing status, notification read-state, and profile fields. */
// Each step checks first, so a start that was stopped half-way can finish the rest.
exports.up = async function up(knex) {
  if (!(await knex.schema.hasColumn('billing_docs', 'status'))) await knex.schema.alterTable('billing_docs', (t) => {
    t.string('status', 12).notNullable().defaultTo('open'); // open | paid | accepted | void
    t.integer('source_id').unsigned(); // the document this one was made from
  });

  if (!(await knex.schema.hasColumn('project_tasks', 'description'))) await knex.schema.alterTable('project_tasks', (t) => {
    t.text('description');
    t.string('priority', 10).notNullable().defaultTo('normal'); // low | normal | high
    t.datetime('approved_at');
  });

  if (!(await knex.schema.hasTable('task_comments'))) await knex.schema.createTable('task_comments', (t) => {
    t.increments('id');
    t.integer('task_id').unsigned().notNullable().references('id').inTable('project_tasks').onDelete('CASCADE');
    t.integer('user_id').unsigned().references('id').inTable('users').onDelete('SET NULL');
    t.text('body').notNullable();
    t.datetime('created_at');
    t.index(['task_id']);
  });

  if (!(await knex.schema.hasTable('project_files'))) await knex.schema.createTable('project_files', (t) => {
    t.increments('id');
    t.integer('project_id').unsigned().notNullable().references('id').inTable('projects').onDelete('CASCADE');
    t.integer('task_id').unsigned().references('id').inTable('project_tasks').onDelete('CASCADE');
    t.integer('file_id').unsigned().references('id').inTable('files').onDelete('CASCADE');
    t.string('label', 190).notNullable();
    t.string('url', 500); // set for links, empty for uploads
    t.string('mime', 120);
    t.integer('size');
    t.integer('uploaded_by').unsigned().references('id').inTable('users').onDelete('SET NULL');
    t.datetime('created_at');
    t.index(['project_id']);
    t.index(['task_id']);
  });

  if (!(await knex.schema.hasTable('notification_reads'))) await knex.schema.createTable('notification_reads', (t) => {
    t.increments('id');
    t.integer('user_id').unsigned().notNullable().references('id').inTable('users').onDelete('CASCADE');
    t.string('key', 120).notNullable();
    t.datetime('created_at');
    t.unique(['user_id', 'key']);
  });

  if (!(await knex.schema.hasColumn('users', 'avatar_file_id'))) await knex.schema.alterTable('users', (t) => {
    t.integer('avatar_file_id').unsigned();
    t.string('job_title', 120);
    t.boolean('email_updates').notNullable().defaultTo(true);
  });
};

exports.down = async function down(knex) {
  await knex.schema.alterTable('users', (t) => { t.dropColumn('avatar_file_id'); t.dropColumn('job_title'); t.dropColumn('email_updates'); });
  await knex.schema.dropTableIfExists('notification_reads');
  await knex.schema.dropTableIfExists('project_files');
  await knex.schema.dropTableIfExists('task_comments');
  await knex.schema.alterTable('project_tasks', (t) => { t.dropColumn('description'); t.dropColumn('priority'); t.dropColumn('approved_at'); });
  await knex.schema.alterTable('billing_docs', (t) => { t.dropColumn('status'); t.dropColumn('source_id'); });
};
