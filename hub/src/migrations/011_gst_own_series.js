'use strict';

// GST tax invoices get a series of their own, HTG, separate from the older Invoices screen's HT
// (asked for on 2 Nov 2026). Tax invoices already issued in the HT series move into HTG in date
// order (HT/26-27/0024 → HTG/26-27/0001), and the HT counter goes back to the last number the
// older screen used, so its next invoice follows on without a gap.
//
// A kept backup comes first; the number lock is lifted only for the renumbering and put straight
// back, and each change is in the audit log. If anything fails it rolls back and the app starts
// as normal. A prefix someone has already changed to something other than HT is left alone.

const { createTriggers, dropTriggers } = require('../lib/gst/triggers');
const { keepBackup } = require('../lib/gst/backup');

// DROP TRIGGER commits on MySQL, so this migration manages its own transaction.
exports.config = { transaction: false };

const OLD = 'HT';
const NEW = 'HTG';
const LOG = '[gst-own-series]';
const stamp = () => new Date().toISOString().slice(0, 19).replace('T', ' ');

/** Highest serial among numbers like 'HT/26-27/0007', or 0. */
const maxSerial = (numbers, head) => numbers.reduce((m, n) => (/^\d+$/.test(n.slice(head.length)) ? Math.max(m, Number(n.slice(head.length))) : m), 0);

async function usedNumbers(trx, head) {
  return [
    ...(await trx('invoices').where('number', 'like', `${head}%`).pluck('number')),
    ...(await trx('gst_documents').where('number', 'like', `${head}%`).pluck('number')),
  ];
}

async function setSequence(trx, name, value) {
  const updated = await trx('sequences').where({ name }).update({ value });
  if (!updated) await trx('sequences').insert({ name, value });
}

exports.up = async function up(knex) {
  const prefixRow = await knex('gst_profile').where({ key: 'invoice_prefix' }).first();
  if (prefixRow && prefixRow.value !== OLD) return;
  const docs = await knex('gst_documents').where({ kind: 'invoice', series: OLD }).whereNotNull('number')
    .orderBy('fy').orderBy('issue_date').orderBy('seq');
  if (!docs.length) {
    if (prefixRow) await knex('gst_profile').where({ key: 'invoice_prefix' }).update({ value: NEW });
    return;
  }

  let backup;
  try {
    backup = await keepBackup('own-series');
  } catch (err) {
    console.error(`${LOG} Backup failed (${err.message}), so nothing was renumbered.`);
    return;
  }

  try {
    await dropTriggers(knex);
    const moved = await knex.transaction(async (trx) => {
      const out = [];
      for (const fy of [...new Set(docs.map((d) => d.fy))]) {
        let seq = maxSerial(await usedNumbers(trx, `${NEW}/${fy}/`), `${NEW}/${fy}/`);
        for (const d of docs.filter((x) => x.fy === fy)) {
          seq += 1;
          const number = `${NEW}/${fy}/${String(seq).padStart(4, '0')}`;
          await trx('gst_documents').where({ id: d.id }).update({ number, series: NEW, seq, updated_at: stamp() });
          await trx('gst_audit').insert({
            entity_type: 'document', entity_id: d.id, action: 'renumbered', user_name: 'System', created_at: stamp(),
            summary: `Renumbered from ${d.number} to ${number}: GST tax invoices now have their own series (${NEW}).`,
          });
          out.push(`${d.number} → ${number}`);
        }
        await setSequence(trx, `${NEW}:${fy}`, seq);
        await setSequence(trx, `${OLD}:${fy}`, maxSerial(await usedNumbers(trx, `${OLD}/${fy}/`), `${OLD}/${fy}/`));
      }
      if (prefixRow) await trx('gst_profile').where({ key: 'invoice_prefix' }).update({ value: NEW });
      return out;
    });
    console.log(`${LOG} ${moved.join(', ')}. Backup: ${backup}`);
  } catch (err) {
    console.error(`${LOG} Renumbering failed and was rolled back (${err.message}). Backup: ${backup}`);
  } finally {
    await createTriggers(knex);
  }
};

// The old numbers are in the audit log and the kept backup; this isn't undone automatically.
exports.down = async function down() {};
