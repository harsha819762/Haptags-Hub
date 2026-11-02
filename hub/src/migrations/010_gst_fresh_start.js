'use strict';

// One-off fresh start for GST Invoices, asked for on 2 Nov 2026 before the first real invoice.
// The documents created while trying the module out (tax invoices, proformas, credit and debit
// notes, with their lines and payments) are removed, and each number series continues after the
// last number still in use: HT/26-27/0001, unless the Hub's older Invoices screen has already
// issued HT numbers this year (it shares the series).
//
// A full backup is written first and kept. The no-delete triggers are lifted only for this and
// put straight back. If anything fails, the deletes roll back and the app starts as normal.
// Runs once; on a new installation there is nothing to remove.

const { createTriggers, dropTriggers } = require('../lib/gst/triggers');
const { keepBackup } = require('../lib/gst/backup');
const { financialYear, todayIST } = require('../lib/util');

// DROP TRIGGER commits on MySQL, so this migration manages its own transaction.
exports.config = { transaction: false };

const DEFAULT_PREFIXES = { invoice_prefix: 'HT', proforma_prefix: 'PF', credit_prefix: 'CN', debit_prefix: 'DN' };
const LOG = '[gst-fresh-start]';

exports.up = async function up(knex) {
  const docs = await knex('gst_documents').select('id', 'kind', 'number', 'series', 'fy');
  if (!docs.length) return;

  let backup;
  try {
    backup = await keepBackup('fresh-start');
  } catch (err) {
    console.error(`${LOG} Backup failed (${err.message}), so nothing was removed.`);
    return;
  }

  const ids = docs.map((d) => d.id);
  const paymentIds = await knex('gst_payments').whereIn('document_id', ids).pluck('id');
  const profile = Object.fromEntries((await knex('gst_profile').select('key', 'value')).map((r) => [r.key, r.value]));
  const prefixes = new Set([...Object.entries(DEFAULT_PREFIXES).map(([k, v]) => profile[k] || v), ...docs.map((d) => d.series)].filter(Boolean));
  const fys = new Set([financialYear(todayIST()), ...docs.map((d) => d.fy)].filter(Boolean));
  const counts = docs.reduce((c, d) => ({ ...c, [d.kind]: (c[d.kind] || 0) + 1 }), {});
  const what = Object.entries(counts).map(([k, n]) => `${n} ${k.replace('_', ' ')}${n === 1 ? '' : 's'}`).join(', ');

  try {
    await dropTriggers(knex);
    const next = await knex.transaction(async (trx) => {
      await trx('gst_document_lines').whereIn('document_id', ids).del();
      await trx('gst_payments').whereIn('document_id', ids).del();
      // Notes point at their invoices, so they go first.
      await trx('gst_documents').whereIn('id', ids).whereNotNull('original_id').del();
      await trx('gst_documents').whereIn('id', ids).del();
      await trx('gst_audit').where((w) => {
        w.where((x) => x.where('entity_type', 'document').whereIn('entity_id', ids));
        if (paymentIds.length) w.orWhere((x) => x.where('entity_type', 'payment').whereIn('entity_id', paymentIds));
      }).del();

      // Each series continues after the highest number still used (by either invoice screen).
      const out = [];
      for (const prefix of prefixes) {
        for (const fy of fys) {
          const head = `${prefix}/${fy}/`;
          const used = [
            ...(await trx('invoices').where('number', 'like', `${head}%`).pluck('number')),
            ...(await trx('gst_documents').where('number', 'like', `${head}%`).pluck('number')),
          ];
          const max = used.reduce((m, n) => (/^\d+$/.test(n.slice(head.length)) ? Math.max(m, Number(n.slice(head.length))) : m), 0);
          const name = `${prefix}:${fy}`;
          const updated = await trx('sequences').where({ name }).update({ value: max });
          if (!updated && max) await trx('sequences').insert({ name, value: max });
          out.push(`${head}${String(max + 1).padStart(4, '0')}`);
        }
      }
      await trx('gst_audit').insert({
        entity_type: 'document',
        entity_id: null,
        action: 'reset',
        summary: `Fresh start before the first real invoice: removed ${what} and ${paymentIds.length} payment${paymentIds.length === 1 ? '' : 's'}. Backup kept as ${backup}. Next numbers: ${out.join(', ')}.`.slice(0, 500),
        user_name: 'System',
        created_at: new Date().toISOString().slice(0, 19).replace('T', ' '),
      });
      return out;
    });
    console.log(`${LOG} Removed ${what} and ${paymentIds.length} payments. Backup: ${backup}. Next numbers: ${next.join(', ')}`);
  } catch (err) {
    console.error(`${LOG} Cleanup failed and was rolled back (${err.message}). Backup: ${backup}`);
  } finally {
    await createTriggers(knex);
  }
};

// The removed documents are in the kept backup; this can't be undone automatically.
exports.down = async function down() {};
