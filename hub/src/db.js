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

const MIGRATIONS = { directory: path.join(__dirname, 'migrations'), loadExtensions: ['.js'] };

async function clearStaleLock() {
  if (!(await db.schema.hasTable('knex_migrations_lock'))) return;
  const lock = await db('knex_migrations_lock').first();
  if (lock && Number(lock.is_locked) === 1) {
    console.warn('[db] Clearing a migration lock left by a stopped start.');
    await db.migrate.forceFreeMigrationsLock(MIGRATIONS);
  }
}

async function runMigrations() {
  await renamePortalMigrations();
  const [, pending] = await db.migrate.list(MIGRATIONS);
  if (pending.length) console.log(`[db] Running migrations: ${pending.map((m) => m.file || m.name || m).join(', ')}`);
  await db.migrate.latest(MIGRATIONS);
}

/**
 * On MySQL, knex's own migration lock is a row that stays set if the process is stopped mid-way
 * (a deploy restarting the app does exactly that), and every later start then refuses to run.
 * So the real mutex is a MySQL named lock, which the server releases when the connection dies:
 * whoever holds it knows no one else is migrating and can clear a stale knex lock.
 */
async function migrate() {
  if (config.db.client === 'better-sqlite3') {
    await db.raw('PRAGMA foreign_keys = ON');
    await db.raw('PRAGMA journal_mode = WAL');
    await clearStaleLock(); // SQLite means one app process on one server, so a set lock is a stale one
    return runMigrations();
  }
  const conn = await db.client.acquireConnection();
  try {
    const [rows] = await db.raw("SELECT GET_LOCK('haptags_hub_migrate', 120) AS got").connection(conn);
    if (!rows || Number(rows[0].got) !== 1) throw new Error('Another copy of the app is running the migrations; try again shortly.');
    try {
      await clearStaleLock();
      await runMigrations();
    } finally {
      await db.raw("SELECT RELEASE_LOCK('haptags_hub_migrate')").connection(conn).catch(() => {});
    }
  } finally {
    await db.client.releaseConnection(conn);
  }
}

module.exports = { db, migrate };
