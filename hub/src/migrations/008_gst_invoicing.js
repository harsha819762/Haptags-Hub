'use strict';

// GST invoicing (/invoices): an admin-only module kept apart from the rest of the Hub, for tax
// invoices under CGST Rule 46, proformas, and credit/debit notes. Money follows 001_init:
// integer minor units in the document's currency (paise, or cents on export invoices), and every
// document also carries its INR amounts for reports and GST returns.
//
// Documents, their lines and payments are never deleted. Triggers refuse deletes, and a
// document's number can't change once it is assigned. New tables only: see 006 for why
// existing tables get no foreign keys.
//
// MySQL can't roll back CREATE TABLE, so every step checks first: if a start is interrupted
// halfway, the next start carries on instead of failing on tables that already exist.

const fs = require('fs');
const path = require('path');

const SIGNATURE = path.join(__dirname, '..', 'lib', 'gst', 'assets', 'authorised-signature.png');

const ITEMS = [
  ['Website / software development', 'Design and development of websites, web and mobile applications', '998314'],
  ['IT consulting', 'IT consulting and support services', '998313'],
  ['Digital marketing / SEO / ads management', 'Digital marketing, search engine optimisation and ads management', '998365'],
  ['Online training / LMS courses', 'Online training and LMS courses', '999293'],
];

const MYSQL_TRIGGERS = [
  `CREATE TRIGGER gst_documents_no_delete BEFORE DELETE ON gst_documents FOR EACH ROW
   SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'GST documents are never deleted'`,
  `CREATE TRIGGER gst_documents_number_lock BEFORE UPDATE ON gst_documents FOR EACH ROW
   BEGIN
     IF OLD.number IS NOT NULL AND NOT (NEW.number <=> OLD.number) THEN
       SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'A GST document number cannot be changed';
     END IF;
   END`,
  `CREATE TRIGGER gst_lines_lock BEFORE DELETE ON gst_document_lines FOR EACH ROW
   BEGIN
     IF (SELECT status FROM gst_documents WHERE id = OLD.document_id) <> 'draft' THEN
       SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Lines of a finalised GST document cannot be removed';
     END IF;
   END`,
  `CREATE TRIGGER gst_payments_no_delete BEFORE DELETE ON gst_payments FOR EACH ROW
   SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'GST payments are never deleted; reverse them instead'`,
];

const SQLITE_TRIGGERS = [
  `CREATE TRIGGER gst_documents_no_delete BEFORE DELETE ON gst_documents
   BEGIN SELECT RAISE(ABORT, 'GST documents are never deleted'); END`,
  `CREATE TRIGGER gst_documents_number_lock BEFORE UPDATE OF number ON gst_documents
   WHEN OLD.number IS NOT NULL AND NEW.number IS NOT OLD.number
   BEGIN SELECT RAISE(ABORT, 'A GST document number cannot be changed'); END`,
  `CREATE TRIGGER gst_lines_lock BEFORE DELETE ON gst_document_lines
   WHEN (SELECT status FROM gst_documents WHERE id = OLD.document_id) <> 'draft'
   BEGIN SELECT RAISE(ABORT, 'Lines of a finalised GST document cannot be removed'); END`,
  `CREATE TRIGGER gst_payments_no_delete BEFORE DELETE ON gst_payments
   BEGIN SELECT RAISE(ABORT, 'GST payments are never deleted; reverse them instead'); END`,
];

exports.up = async function up(knex) {
  const mysql = knex.client.config.client === 'mysql2';
  const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
  const create = async (name, build) => {
    if (!(await knex.schema.hasTable(name))) await knex.schema.createTable(name, build);
  };

  await create('gst_profile', (t) => {
    t.string('key', 100).primary();
    t.text('value');
  });

  await create('gst_clients', (t) => {
    t.increments('id');
    t.string('name', 190).notNullable();
    t.string('client_type', 10).notNullable().defaultTo('b2b'); // b2b | b2c | export
    t.string('contact_person', 190);
    t.string('email', 190);
    t.string('phone', 40);
    t.text('address');
    t.string('city', 100);
    t.string('pincode', 12);
    t.string('country', 80).notNullable().defaultTo('India');
    t.string('state_code', 2); // GST state code; 96 = other countries
    t.string('state_name', 100);
    t.string('gstin', 15);
    t.string('pan', 10);
    t.text('notes');
    t.integer('hub_client_id').unsigned(); // when copied from the Hub's clients
    t.boolean('is_active').notNullable().defaultTo(true);
    t.integer('created_by').unsigned().references('id').inTable('users').onDelete('SET NULL');
    t.datetime('created_at');
    t.datetime('updated_at');
    t.index(['name']);
    t.index(['gstin']);
  });

  await create('gst_items', (t) => {
    t.increments('id');
    t.string('name', 190).notNullable();
    t.string('description', 500);
    t.string('sac', 8).notNullable();
    t.string('unit', 20).notNullable().defaultTo('Nos');
    t.bigInteger('rate').notNullable().defaultTo(0); // paise, before tax
    t.decimal('gst_rate', 5, 2).notNullable().defaultTo(18);
    t.boolean('is_active').notNullable().defaultTo(true);
    t.integer('sort').notNullable().defaultTo(0);
    t.datetime('created_at');
    t.datetime('updated_at');
  });

  await create('gst_documents', (t) => {
    t.increments('id');
    t.string('kind', 12).notNullable(); // invoice | proforma | credit_note | debit_note
    t.string('number', 16).unique(); // assigned on finalising
    t.string('series', 8);
    t.string('fy', 5);
    t.integer('seq');
    t.string('status', 20).notNullable().defaultTo('draft'); // draft | unpaid | partially_paid | paid | issued | converted | cancelled
    t.integer('client_id').unsigned().notNullable().references('id').inTable('gst_clients').onDelete('RESTRICT');
    // The recipient as printed: copied from the client on every save, frozen once finalised.
    t.string('client_type', 10).notNullable();
    t.string('bill_name', 190).notNullable();
    t.text('bill_address');
    t.string('bill_country', 80);
    t.string('bill_state_code', 2);
    t.string('bill_state_name', 100);
    t.string('bill_gstin', 15);
    t.string('bill_pan', 10);
    t.string('bill_email', 190);
    t.string('bill_phone', 40);
    t.string('bill_contact', 190);
    t.date('issue_date').notNullable();
    t.date('due_date'); // "valid until" on a proforma
    t.string('payment_terms', 60);
    t.string('pos_code', 2).notNullable();
    t.string('pos_name', 100).notNullable();
    t.string('supply_type', 8).notNullable(); // intra | inter | export
    t.boolean('reverse_charge').notNullable().defaultTo(false);
    t.string('currency', 3).notNullable().defaultTo('INR');
    t.decimal('exchange_rate', 14, 4).notNullable().defaultTo(1);
    t.string('subject', 255);
    // In the document's currency.
    t.bigInteger('gross').notNullable().defaultTo(0);
    t.bigInteger('discount').notNullable().defaultTo(0);
    t.bigInteger('taxable').notNullable().defaultTo(0);
    t.bigInteger('cgst').notNullable().defaultTo(0);
    t.bigInteger('sgst').notNullable().defaultTo(0);
    t.bigInteger('igst').notNullable().defaultTo(0);
    t.bigInteger('round_off').notNullable().defaultTo(0);
    t.bigInteger('total').notNullable().defaultTo(0);
    // INR equivalents (paise).
    t.bigInteger('inr_taxable').notNullable().defaultTo(0);
    t.bigInteger('inr_cgst').notNullable().defaultTo(0);
    t.bigInteger('inr_sgst').notNullable().defaultTo(0);
    t.bigInteger('inr_igst').notNullable().defaultTo(0);
    t.bigInteger('inr_total').notNullable().defaultTo(0);
    // How a tax invoice is settled (document currency): payments, TDS, credit and debit notes.
    t.bigInteger('paid').notNullable().defaultTo(0);
    t.bigInteger('tds').notNullable().defaultTo(0);
    t.bigInteger('credited').notNullable().defaultTo(0);
    t.bigInteger('debited').notNullable().defaultTo(0);
    t.bigInteger('balance').notNullable().defaultTo(0);
    t.date('settled_on');
    t.integer('original_id').unsigned().references('id').inTable('gst_documents').onDelete('RESTRICT'); // note → invoice
    t.string('note_reason', 255);
    t.integer('source_id').unsigned(); // invoice ← proforma
    t.integer('converted_id').unsigned(); // proforma → invoice
    t.text('notes');
    t.text('terms');
    t.string('lut_number', 40);
    t.date('lut_valid_until');
    t.text('supplier_json'); // our business profile as printed, frozen on finalising
    // E-invoicing (IRN from the GST IRP), for when it is switched on.
    t.string('irn', 64);
    t.string('irn_ack_no', 30);
    t.datetime('irn_ack_date');
    t.text('irn_signed_qr');
    t.datetime('finalised_at');
    t.integer('finalised_by').unsigned().references('id').inTable('users').onDelete('SET NULL');
    t.datetime('cancelled_at');
    t.integer('cancelled_by').unsigned().references('id').inTable('users').onDelete('SET NULL');
    t.string('cancel_reason', 255);
    t.datetime('discarded_at'); // abandoned drafts are hidden, never deleted
    t.datetime('emailed_at');
    t.integer('created_by').unsigned().references('id').inTable('users').onDelete('SET NULL');
    t.integer('updated_by').unsigned().references('id').inTable('users').onDelete('SET NULL');
    t.datetime('created_at');
    t.datetime('updated_at');
    t.index(['kind', 'status']);
    t.index(['client_id']);
    t.index(['issue_date']);
    t.index(['original_id']);
  });

  await create('gst_document_lines', (t) => {
    t.increments('id');
    t.integer('document_id').unsigned().notNullable().references('id').inTable('gst_documents').onDelete('RESTRICT');
    t.integer('sort').notNullable().defaultTo(0);
    t.integer('item_id').unsigned(); // the catalog item it came from, if any
    t.string('description', 500).notNullable();
    t.string('sac', 8);
    t.string('unit', 20);
    t.decimal('quantity', 14, 3).notNullable().defaultTo(1);
    t.bigInteger('rate').notNullable().defaultTo(0);
    t.bigInteger('gross').notNullable().defaultTo(0);
    t.bigInteger('discount').notNullable().defaultTo(0);
    t.bigInteger('taxable').notNullable().defaultTo(0);
    t.decimal('gst_rate', 5, 2).notNullable().defaultTo(0);
    t.bigInteger('cgst').notNullable().defaultTo(0);
    t.bigInteger('sgst').notNullable().defaultTo(0);
    t.bigInteger('igst').notNullable().defaultTo(0);
    t.bigInteger('total').notNullable().defaultTo(0);
    t.index(['document_id']);
  });

  await create('gst_payments', (t) => {
    t.increments('id');
    t.integer('document_id').unsigned().notNullable().references('id').inTable('gst_documents').onDelete('RESTRICT');
    t.date('paid_on').notNullable();
    t.bigInteger('amount').notNullable().defaultTo(0); // received, in the invoice's currency
    t.bigInteger('inr_amount').notNullable().defaultTo(0); // what reached the bank, in paise
    t.bigInteger('tds').notNullable().defaultTo(0); // deducted by the client, invoice currency
    t.string('tds_section', 10);
    t.decimal('tds_rate', 5, 2);
    t.string('mode', 20).notNullable(); // upi | neft | rtgs | imps | cheque | cash | wire | card | other
    t.string('reference', 190);
    t.text('notes');
    t.string('status', 10).notNullable().defaultTo('active'); // active | reversed
    t.datetime('reversed_at');
    t.integer('reversed_by').unsigned().references('id').inTable('users').onDelete('SET NULL');
    t.string('reverse_reason', 255);
    t.integer('created_by').unsigned().references('id').inTable('users').onDelete('SET NULL');
    t.datetime('created_at');
    t.index(['document_id']);
    t.index(['paid_on']);
  });

  await create('gst_audit', (t) => {
    t.increments('id');
    t.string('entity_type', 20).notNullable(); // document | client | item | payment | profile | report | backup
    t.integer('entity_id').unsigned();
    t.string('action', 30).notNullable();
    t.string('summary', 500).notNullable();
    t.text('changes'); // JSON: { field: [before, after] }
    t.integer('user_id').unsigned().references('id').inTable('users').onDelete('SET NULL');
    t.string('user_name', 190);
    t.string('ip', 64);
    t.datetime('created_at');
    t.index(['entity_type', 'entity_id']);
    t.index(['created_at']);
  });

  for (const sql of mysql ? MYSQL_TRIGGERS : SQLITE_TRIGGERS) {
    const name = sql.match(/CREATE TRIGGER (\w+)/)[1];
    try {
      await knex.raw(`DROP TRIGGER IF EXISTS ${name}`);
      await knex.raw(sql);
    } catch (err) {
      // Some MySQL hosts need SUPER to create triggers when binary logging is on. The app never
      // deletes these rows either way; the triggers are a second lock.
      console.warn(`[migrate] GST safety trigger ${name} not created (${err.message}). The app still never deletes GST records.`);
    }
  }

  if (!(await knex('gst_items').first())) {
    await knex('gst_items').insert(ITEMS.map(([name, description, sac], i) => ({
      name, description, sac, unit: 'Nos', rate: 0, gst_rate: 18, is_active: true, sort: i, created_at: now, updated_at: now,
    })));
  }

  // Start from what the Hub already knows: bank, UPI and contact details.
  const saved = new Set(await knex('gst_profile').pluck('key'));
  const profile = {};
  const hub = Object.fromEntries((await knex('settings').select('key', 'value')).map((r) => [r.key, r.value]));
  for (const key of ['email', 'phone', 'website', 'upi_id', 'bank_name', 'bank_account_number', 'bank_ifsc', 'bank_branch']) {
    if (hub[key] && !saved.has(key)) profile[key] = hub[key];
  }
  if (fs.existsSync(SIGNATURE) && !saved.has('signature_file_id')) {
    const data = fs.readFileSync(SIGNATURE);
    const [fileId] = await knex('files').insert({ name: 'authorised-signature.png', mime: 'image/png', size: data.length, data, created_at: now });
    profile.signature_file_id = String(typeof fileId === 'object' ? fileId.id : fileId);
  }
  const rows = Object.entries(profile).map(([key, value]) => ({ key, value }));
  if (rows.length) await knex('gst_profile').insert(rows);
};

exports.down = async function down(knex) {
  for (const name of ['gst_documents_no_delete', 'gst_documents_number_lock', 'gst_lines_lock', 'gst_payments_no_delete']) {
    await knex.raw(`DROP TRIGGER IF EXISTS ${name}`);
  }
  for (const name of ['gst_audit', 'gst_payments', 'gst_document_lines', 'gst_documents', 'gst_items', 'gst_clients', 'gst_profile']) {
    await knex.schema.dropTableIfExists(name);
  }
};
