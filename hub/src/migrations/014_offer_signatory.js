'use strict';

// Offer letters are signed by Reddivari Harshavardhan Reddy, Chief Executive Officer, above the
// company stamp. Fills the name only where it is blank: in Settings → Offer letters, and on letters
// already issued without one. A name typed in Settings is never overwritten.

const NAME = 'Reddivari Harshavardhan Reddy';

exports.up = async function up(knex) {
  const row = await knex('settings').where({ key: 'offer_signatory_name' }).first();
  if (!row) await knex('settings').insert({ key: 'offer_signatory_name', value: NAME });
  else if (!String(row.value || '').trim()) await knex('settings').where({ key: 'offer_signatory_name' }).update({ value: NAME });

  await knex('offer_letters').whereNotNull('number').where((q) => q.whereNull('signatory_name').orWhere('signatory_name', ''))
    .update({ signatory_name: NAME });
};

exports.down = async function down() {};
