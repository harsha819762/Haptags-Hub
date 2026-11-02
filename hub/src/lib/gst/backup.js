'use strict';

// Backups of the GST module: every gst_* table plus the logo and signature images, as gzipped
// JSON. A copy is written to disk once a day (by the hourly automation), the last 30 are kept,
// and owners/admins can download one at any time. Hostinger's own MySQL backups still apply.
//
// In production they go to the hosting account's home folder, not the app's: Hostinger swaps the
// app folder on every deploy, and it sits under public_html.

const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const config = require('../../config');
const { db } = require('../../db');
const { nowSql, todayIST } = require('../util');
const { getProfile, setProfile } = require('./profile');

const TABLES = ['gst_profile', 'gst_clients', 'gst_items', 'gst_documents', 'gst_document_lines', 'gst_payments', 'gst_audit'];
const KEEP = 30;
// Daily backups are pruned; a 'before-…' one (written before a one-off cleanup) is always kept.
const DAILY = /^gst-\d{4}-\d{2}-\d{2}\.json\.gz$/;
const NAME = /^gst-(\d{4}-\d{2}-\d{2}|before-[a-z-]+-\d{8}T\d{6})\.json\.gz$/;
const dir = () => process.env.GST_BACKUP_DIR
  || (config.isProd ? path.join(os.homedir(), 'haptags-hub-backups') : path.join(__dirname, '..', '..', '..', 'data', 'backups'));

async function snapshot() {
  const tables = {};
  for (const t of TABLES) tables[t] = await db(t).select('*').orderBy(t === 'gst_profile' ? 'key' : 'id');
  // The images that documents print, including ones since replaced.
  const fileIds = new Set();
  for (const r of tables.gst_profile) if (/_file_id$/.test(r.key) && r.value) fileIds.add(Number(r.value));
  for (const d of tables.gst_documents) {
    if (!d.supplier_json) continue;
    const s = JSON.parse(d.supplier_json);
    for (const k of ['logo_file_id', 'signature_file_id']) if (s[k]) fileIds.add(Number(s[k]));
  }
  const files = fileIds.size ? await db('files').whereIn('id', [...fileIds]).select('id', 'name', 'mime', 'data') : [];
  return {
    format: 'haptags-gst-backup',
    version: 1,
    created_at: nowSql(),
    tables,
    files: files.map((f) => ({ id: f.id, name: f.name, mime: f.mime, data: Buffer.from(f.data).toString('base64') })),
  };
}

async function gzipped() {
  return zlib.gzipSync(Buffer.from(JSON.stringify(await snapshot())));
}

function listBackups() {
  if (!fs.existsSync(dir())) return [];
  return fs.readdirSync(dir()).filter((f) => NAME.test(f)).sort().reverse()
    .map((name) => ({ name, size: fs.statSync(path.join(dir(), name)).size }));
}

/** Writes today's backup (if it isn't there yet) and prunes old ones. Returns the file name. */
async function writeBackup({ force = false } = {}) {
  const name = `gst-${todayIST()}.json.gz`;
  const file = path.join(dir(), name);
  if (!force && fs.existsSync(file)) return null;
  fs.mkdirSync(dir(), { recursive: true });
  fs.writeFileSync(file, await gzipped());
  for (const old of listBackups().filter((b) => DAILY.test(b.name)).slice(KEEP)) fs.rmSync(path.join(dir(), old.name), { force: true });
  await setProfile({ backup_last_run: nowSql() });
  return name;
}

/** For the hourly automation: one backup a day, and never let a disk problem stop the rest. */
async function dailyBackup() {
  try {
    const p = await getProfile();
    if (p.backup_last_run && p.backup_last_run.slice(0, 10) >= todayIST()) return null;
    return await writeBackup();
  } catch (err) {
    console.error('[gst-backup]', err.message);
    return null;
  }
}

/** Writes a backup that is never pruned, e.g. before a one-off cleanup. Returns the file name. */
async function keepBackup(label) {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15);
  const name = `gst-before-${label}-${stamp}.json.gz`;
  fs.mkdirSync(dir(), { recursive: true });
  fs.writeFileSync(path.join(dir(), name), await gzipped());
  return name;
}

function backupPath(name) {
  if (!NAME.test(String(name))) return null;
  const file = path.join(dir(), name);
  return fs.existsSync(file) ? file : null;
}

module.exports = { snapshot, gzipped, writeBackup, keepBackup, dailyBackup, listBackups, backupPath, TABLES };
