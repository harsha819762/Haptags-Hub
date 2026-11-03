'use strict';

/**
 * Per-person access for staff: the sections an owner or admin has opened to them (Billing, GST Invoices,
 * Education, Income & expenses, managing clients, managing projects), as a JSON list of keys. Owners and
 * admins always have everything. A plain column on an existing table, and safe to re-run.
 */
exports.up = async function up(knex) {
  if (await knex.schema.hasColumn('users', 'permissions')) return;
  await knex.schema.alterTable('users', (t) => { t.string('permissions', 500); });
};

exports.down = async function down(knex) {
  if (await knex.schema.hasColumn('users', 'permissions')) await knex.schema.alterTable('users', (t) => { t.dropColumn('permissions'); });
};
