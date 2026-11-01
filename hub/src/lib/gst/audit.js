'use strict';

const { db } = require('../../db');
const { nowSql } = require('../util');

/** Who did something, taken from the request: kept by name too, in case the user is removed. */
const actor = (req) => ({ id: req.user ? req.user.id : null, name: req.user ? req.user.name : 'System', ip: req.ip || null });

/**
 * Appends to the GST audit log. `changes` is { field: [before, after] }. Pass the transaction
 * when inside one, so the entry commits (or rolls back) with the change it describes.
 */
async function audit(who, { entity, id = null, action, summary, changes = null }, trx = db) {
  await trx('gst_audit').insert({
    entity_type: entity,
    entity_id: id,
    action,
    summary: String(summary).slice(0, 500),
    changes: changes && Object.keys(changes).length ? JSON.stringify(changes) : null,
    user_id: who.id || null,
    user_name: who.name ? String(who.name).slice(0, 190) : null,
    ip: who.ip ? String(who.ip).slice(0, 64) : null,
    created_at: nowSql(),
  });
}

/** Field-level differences between two records, for the given fields. */
function diff(before, after, fields) {
  const out = {};
  for (const f of fields) {
    const a = before[f] === undefined || before[f] === null ? '' : String(before[f]);
    const b = after[f] === undefined || after[f] === null ? '' : String(after[f]);
    if (a !== b) out[f] = [a, b];
  }
  return out;
}

async function trail(entity, id) {
  return db('gst_audit').where({ entity_type: entity, entity_id: id }).orderBy('id', 'desc');
}

/** Everything about a document, including its payments. */
async function documentTrail(docId) {
  const paymentIds = await db('gst_payments').where({ document_id: docId }).pluck('id');
  return db('gst_audit')
    .where((w) => {
      w.where({ entity_type: 'document', entity_id: docId });
      if (paymentIds.length) w.orWhere((x) => x.where('entity_type', 'payment').whereIn('entity_id', paymentIds));
    })
    .orderBy('id', 'desc');
}

module.exports = { actor, audit, diff, trail, documentTrail };
