'use strict';

/** Quotations, invoices and receipts made with the simple document builder. Money is in paise. */
exports.up = async function up(knex) {
  await knex.schema.createTable('billing_docs', (t) => {
    t.increments('id');
    t.integer('client_id').unsigned().notNullable().references('id').inTable('clients').onDelete('CASCADE');
    t.string('type', 12).notNullable(); // quotation | invoice | receipt
    t.string('number', 40).notNullable();
    t.date('issue_date').notNullable();
    t.date('due_date');
    t.string('bill_name', 190).notNullable();
    t.string('bill_email', 190);
    t.string('bill_phone', 40);
    t.text('bill_address');
    t.string('bill_gstin', 20);
    t.text('items').notNullable(); // JSON: [{ description, quantity, rate }] with rate in paise
    t.decimal('gst_rate', 5, 2).notNullable().defaultTo(0);
    t.boolean('igst').notNullable().defaultTo(false);
    t.bigInteger('discount').notNullable().defaultTo(0);
    t.bigInteger('total').notNullable().defaultTo(0);
    t.string('pay_method', 40);
    t.string('pay_ref', 120);
    t.text('notes');
    t.datetime('created_at');
    t.index(['client_id', 'type']);
    t.unique(['type', 'number']);
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('billing_docs');
};
