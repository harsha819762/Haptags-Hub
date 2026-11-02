'use strict';

// Official GST tax invoices for payments taken on lms.haptags.com (src/lib/lms-invoices.js,
// POST /api/v1/lms/invoice). After a successful PhonePe payment the LMS posts the order here; the
// Hub issues the tax invoice in GST Invoices (HTG series), records the payment, and keeps this row
// so a repeated call (the PhonePe webhook and the status poll both fire, and an admin can resync)
// returns the same invoice instead of issuing a second one. New table only: see 006 on why
// existing tables get no foreign keys, and 008 on checking before creating.

exports.up = async function up(knex) {
  if (await knex.schema.hasTable('lms_invoices')) return;
  await knex.schema.createTable('lms_invoices', (t) => {
    t.increments('id');
    t.string('merchant_order_id', 100).notNullable().unique(); // the LMS order reference (PhonePe merchantOrderId)
    t.string('lms_order_id', 40);
    t.integer('document_id').unsigned(); // gst_documents.id once issued (null while being issued)
    t.integer('client_id').unsigned(); // the student's Hub client
    t.text('request_json'); // what the LMS sent, for the record
    t.datetime('created_at');
    t.datetime('updated_at');
    t.index(['document_id']);
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('lms_invoices');
};
