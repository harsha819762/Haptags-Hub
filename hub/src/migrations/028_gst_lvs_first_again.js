'use strict';

// One-off, asked for on 5 Nov 2026 (027 found CMR's 0001 cancelled, so left it): LVS BUILDERS LLP's 0002 should
// have been 0001, so it swaps numbers with CMR's HTG/26-27/0001 (live or cancelled; a cancelled one stays
// cancelled). The series stays 0001, 0002 with no gap.
//
// It acts only on exactly that state: 0001 a CMR invoice and 0002 a live LVS invoice, neither
// with an e-invoice IRN. Anything else (including after the swap) is left alone, so it is safe to
// re-run. A kept backup comes first; the safety triggers are lifted only for this and put straight
// back; each change is in the audit log. If anything fails it rolls back and the app starts.

const { createTriggers, dropTriggers } = require('../lib/gst/triggers');
const { keepBackup } = require('../lib/gst/backup');

// DROP TRIGGER commits on MySQL, so this migration manages its own transaction.
exports.config = { transaction: false };

const ONE = 'HTG/26-27/0001';
const TWO = 'HTG/26-27/0002';
const LOG = '[gst-lvs-first-again]';
const stamp = () => new Date().toISOString().slice(0, 19).replace('T', ' ');

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('gst_documents'))) return;
  const cmr = await knex('gst_documents').where({ number: ONE }).first();
  const lvs = await knex('gst_documents').where({ number: TWO }).first();
  if (!cmr || !lvs) return;
  const blockers = [
    !(cmr.kind === 'invoice' && /\bCMR\b/i.test(cmr.bill_name)) && `${ONE} isn’t a CMR invoice`,
    !(lvs.kind === 'invoice' && lvs.status !== 'cancelled' && /\bLVS\b/i.test(lvs.bill_name)) && `${TWO} isn’t a live LVS invoice`,
    (cmr.irn || lvs.irn) && 'an e-invoice IRN is already issued',
  ].filter(Boolean);
  if (blockers.length) {
    if (/\bLVS\b/i.test(cmr.bill_name || '')) return; // already swapped
    console.warn(`${LOG} Left as it is: ${blockers.join('; ')}.`);
    return;
  }

  let backup;
  try {
    backup = await keepBackup('lvs-first-again');
  } catch (err) {
    console.error(`${LOG} Backup failed (${err.message}), so nothing was changed.`);
    return;
  }

  try {
    await dropTriggers(knex);
    await knex.transaction(async (trx) => {
      const now = stamp();
      await trx('gst_documents').where({ id: lvs.id }).update({ number: `SWAP-${lvs.id}`, updated_at: now });
      await trx('gst_documents').where({ id: cmr.id }).update({ number: TWO, seq: 2, updated_at: now });
      await trx('gst_documents').where({ id: lvs.id }).update({ number: ONE, seq: 1, updated_at: now });
      await trx('gst_audit').insert([
        { entity_type: 'document', entity_id: lvs.id, action: 'renumbered', user_name: 'System', created_at: now,
          summary: `Renumbered from ${TWO} to ${ONE} (swapped with ${cmr.bill_name}) at the owner’s request. Backup kept as ${backup}.`.slice(0, 500) },
        { entity_type: 'document', entity_id: cmr.id, action: 'renumbered', user_name: 'System', created_at: now,
          summary: `Renumbered from ${ONE} to ${TWO} (swapped with ${lvs.bill_name}) at the owner’s request. Backup kept as ${backup}.`.slice(0, 500) },
      ]);
    });
    console.log(`${LOG} ${lvs.bill_name} is now ${ONE}; ${cmr.bill_name} is now ${TWO}. Backup: ${backup}`);
  } catch (err) {
    console.error(`${LOG} Failed and was rolled back (${err.message}). Backup: ${backup}`);
  } finally {
    await createTriggers(knex);
  }
};

// Swapping back is another one-off; the backup and audit log hold the old numbers.
exports.down = async function down() {};
