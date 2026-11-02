'use strict';

// One-off, asked for on 2 Nov 2026: the cancelled HTG/26-27/0001 (LVS Constructions, re-raised as
// HTG/26-27/0002 to LVS BUILDERS LLP) is removed, and CMR's HTG/26-27/0003 becomes HTG/26-27/0001,
// so the series runs 0001, 0002 with no gap and the next invoice is 0003.
//
// It acts only on exactly that state: 0001 a cancelled LVS invoice with no payments or notes
// against it, 0003 a live CMR invoice with no IRN, and no number after 0003. Anything else is left
// alone. A kept backup comes first; the safety triggers are lifted only for this and put straight
// back; each change is in the audit log. If anything fails it rolls back and the app starts.

const { createTriggers, dropTriggers } = require('../lib/gst/triggers');
const { keepBackup } = require('../lib/gst/backup');

// DROP TRIGGER commits on MySQL, so this migration manages its own transaction.
exports.config = { transaction: false };

const HEAD = 'HTG/26-27/';
const OLD = `${HEAD}0001`;
const CMR = `${HEAD}0003`;
const LOG = '[gst-cmr-first]';
const stamp = () => new Date().toISOString().slice(0, 19).replace('T', ' ');
const inr = (paise) => `₹${(Number(paise) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;

/** Highest serial used in HTG/26-27 by either invoice screen. */
async function maxSerial(q) {
  const numbers = [
    ...(await q('invoices').where('number', 'like', `${HEAD}%`).pluck('number')),
    ...(await q('gst_documents').where('number', 'like', `${HEAD}%`).pluck('number')),
  ];
  return numbers.reduce((m, n) => (/^\d+$/.test(n.slice(HEAD.length)) ? Math.max(m, Number(n.slice(HEAD.length))) : m), 0);
}

exports.up = async function up(knex) {
  const old = await knex('gst_documents').where({ number: OLD }).first();
  const cmr = await knex('gst_documents').where({ number: CMR }).first();
  if (!old || !cmr) return;
  const blockers = [
    !(old.kind === 'invoice' && old.status === 'cancelled' && /\bLVS\b/i.test(old.bill_name)) && `${OLD} isn’t the cancelled LVS invoice`,
    !(cmr.kind === 'invoice' && cmr.status !== 'cancelled' && /\bCMR\b/i.test(cmr.bill_name)) && `${CMR} isn’t a live CMR invoice`,
    cmr.irn && `${CMR} has an e-invoice IRN`,
    (await maxSerial(knex)) > 3 && `numbers after ${CMR} are in use`,
    (await knex('gst_payments').where({ document_id: old.id }).first()) && `${OLD} has payments`,
    (await knex('gst_documents').where({ original_id: old.id }).first()) && `a note adjusts ${OLD}`,
  ].filter(Boolean);
  if (blockers.length) {
    console.warn(`${LOG} Left as it is: ${blockers.join('; ')}.`);
    return;
  }

  let backup;
  try {
    backup = await keepBackup('cmr-first');
  } catch (err) {
    console.error(`${LOG} Backup failed (${err.message}), so nothing was changed.`);
    return;
  }

  try {
    await dropTriggers(knex);
    await knex.transaction(async (trx) => {
      await trx('gst_documents').where({ converted_id: old.id }).update({ converted_id: null });
      await trx('gst_document_lines').where({ document_id: old.id }).del();
      await trx('gst_audit').where({ entity_type: 'document', entity_id: old.id }).del();
      await trx('gst_documents').where({ id: old.id }).del();
      await trx('gst_documents').where({ id: cmr.id }).update({ number: OLD, seq: 1, updated_at: stamp() });
      await trx('gst_audit').insert({
        entity_type: 'document', entity_id: cmr.id, action: 'renumbered', user_name: 'System', created_at: stamp(),
        summary: `Renumbered from ${CMR} to ${OLD}, after the cancelled ${OLD} (${old.bill_name}) was removed at the owner’s request.`,
      });
      await trx('gst_audit').insert({
        entity_type: 'document', entity_id: null, action: 'removed', user_name: 'System', created_at: stamp(),
        summary: `Removed the cancelled ${OLD} to ${old.bill_name} (${inr(old.total)}, dated ${String(old.issue_date).slice(0, 10)}; re-raised to LVS BUILDERS LLP as ${HEAD}0002) at the owner’s request, and renumbered ${CMR} (${cmr.bill_name}) to ${OLD}. Backup kept as ${backup}.`.slice(0, 500),
      });
      const max = await maxSerial(trx);
      const updated = await trx('sequences').where({ name: 'HTG:26-27' }).update({ value: max });
      if (!updated) await trx('sequences').insert({ name: 'HTG:26-27', value: max });
    });
    console.log(`${LOG} Removed the cancelled ${OLD} (${old.bill_name}); ${CMR} (${cmr.bill_name}) is now ${OLD}. Backup: ${backup}`);
  } catch (err) {
    console.error(`${LOG} Failed and was rolled back (${err.message}). Backup: ${backup}`);
  } finally {
    await createTriggers(knex);
  }
};

// The removed invoice is in the kept backup and the audit log; this isn't undone automatically.
exports.down = async function down() {};
