'use strict';

// Internship offer letters for students and interns (Education). A letter is a draft until it is
// issued, which gives it a number (HTOL/26-27/0001) and freezes its wording; the student can then
// accept or decline it online at /o/<token>. New table only: see 006.

exports.up = async function up(knex) {
  if (await knex.schema.hasTable('offer_letters')) return;
  await knex.schema.createTable('offer_letters', (t) => {
    t.increments('id');
    t.string('number', 30).unique(); // assigned on issue
    t.integer('client_id').unsigned().notNullable().references('id').inTable('clients').onDelete('CASCADE');
    t.integer('program_id').unsigned().references('id').inTable('programs').onDelete('SET NULL');
    t.string('status', 12).notNullable().defaultTo('draft'); // draft | issued | accepted | declined | withdrawn
    // The candidate as addressed in the letter.
    t.string('candidate_name', 190).notNullable();
    t.string('candidate_email', 190);
    t.string('candidate_phone', 40);
    t.string('college', 190);
    t.string('course', 190);
    t.string('candidate_address', 500);
    // The internship.
    t.string('role_title', 190).notNullable();
    t.string('programme', 190);
    t.date('start_date').notNullable();
    t.date('end_date').notNullable();
    t.string('duration', 60);
    t.string('mode', 10).notNullable().defaultTo('onsite'); // onsite | remote | hybrid
    t.string('location', 255);
    t.string('schedule', 255);
    t.string('reporting_to', 190);
    t.string('reporting_designation', 190);
    t.bigInteger('stipend').notNullable().defaultTo(0); // paise per month; 0 = none
    t.bigInteger('fee').notNullable().defaultTo(0); // programme fee in paise, shown when show_fee
    t.boolean('show_fee').notNullable().defaultTo(false);
    t.date('respond_by');
    t.text('joining_instructions');
    t.text('extra_terms');
    // Frozen on issue, so later changes to the standard wording never alter an issued letter.
    t.text('terms');
    t.string('signatory_name', 190);
    t.string('signatory_designation', 190);
    t.date('issued_on');
    t.datetime('issued_at');
    t.integer('issued_by').unsigned().references('id').inTable('users').onDelete('SET NULL');
    t.string('public_token', 64).notNullable().unique();
    t.datetime('responded_at');
    t.string('responded_name', 190);
    t.string('responded_ip', 64);
    t.string('response_note', 1000);
    t.datetime('withdrawn_at');
    t.string('withdraw_reason', 255);
    t.datetime('emailed_at');
    t.integer('created_by').unsigned().references('id').inTable('users').onDelete('SET NULL');
    t.datetime('created_at');
    t.datetime('updated_at');
    t.index(['client_id']);
    t.index(['status']);
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('offer_letters');
};
