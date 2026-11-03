'use strict';

const fs = require('fs');
const path = require('path');
const knex = require('knex');
const config = require('./config');

if (config.db.client === 'better-sqlite3') {
  fs.mkdirSync(path.dirname(config.db.connection.filename), { recursive: true });
}

const db = knex(config.db);

// The Haptags Portal (Hub 2) was built from this app and numbered the same migrations differently.
// Its database records them under these names; renaming the records lets knex see them as already
// run, so the one-off GST migrations (010, 011) never run twice. Hub databases have none of them.
const PORTAL_NAMES = {
  '010_project_assignee.js': '017_project_assignee.js',
  '011_project_tasks.js': '018_project_tasks.js',
  '012_assignee_names.js': '019_assignee_names.js',
  '013_billing_docs.js': '020_billing_docs.js',
  '014_portal_features.js': '021_portal_features.js',
  '015_leave.js': '022_leave.js',
  '016_client_contacts.js': '023_client_contacts.js',
  '017_project_access_client_group.js': '024_project_access_client_group.js',
  '018_gst_fresh_start.js': '010_gst_fresh_start.js',
  '019_gst_own_series.js': '011_gst_own_series.js',
  '020_offer_letters.js': '012_offer_letters.js',
  '021_lms_programs.js': '013_lms_programs.js',
  '022_offer_signatory.js': '014_offer_signatory.js',
  '023_sales.js': '025_sales.js',
};

async function renamePortalMigrations() {
  if (!(await db.schema.hasTable('knex_migrations'))) return;
  const done = new Set(await db('knex_migrations').pluck('name'));
  if (!Object.keys(PORTAL_NAMES).some((name) => done.has(name))) return;
  await db.transaction(async (trx) => {
    for (const [from, to] of Object.entries(PORTAL_NAMES)) {
      if (done.has(from) && !done.has(to)) await trx('knex_migrations').where({ name: from }).update({ name: to });
    }
  });
  console.log('[db] Renamed Haptags Portal migration records to this app’s numbering.');
}

async function migrate() {
  if (config.db.client === 'better-sqlite3') {
    await db.raw('PRAGMA foreign_keys = ON');
    await db.raw('PRAGMA journal_mode = WAL');
  }
  await renamePortalMigrations();
  await db.migrate.latest({ directory: path.join(__dirname, 'migrations'), loadExtensions: ['.js'] });
}

module.exports = { db, migrate };
