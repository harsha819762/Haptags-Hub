'use strict';

// Programmes from lms.haptags.com: its published public courses, each with an Internship plan
// (the programme's fee) and a Certificate plan (certificate_fee). They are matched to the Hub's
// programs by LMS id, or the first time by name, so nothing is duplicated.

const config = require('../config');
const { db } = require('../db');
const { nowSql } = require('./util');

/** [lms_id, slug, title, category, subtitle, internship ₹, certificate ₹] → programme fields. */
const fromRow = ([lmsId, slug, name, category, description, internship, certificate]) => ({
  lms_id: lmsId, lms_slug: slug, name, category: category || null, description: description || null,
  fee: Math.round(Number(internship) || 0) * 100, certificate_fee: Math.round(Number(certificate) || 0) * 100,
});

/** An LMS (PocketBase) course record → programme fields. */
const fromLms = (c) => fromRow([
  c.id, c.slug, c.title, c.expand && c.expand.category ? c.expand.category.name : '', c.subtitle,
  c.plan_internship_price || c.price, c.plan_certificate_price || c.price,
]);

/**
 * Adds or updates programmes. archiveMissing archives LMS programmes no longer published there.
 * Pass the migration's knex (or a transaction) as `q`. Returns { added, updated, archived }.
 */
async function upsertPrograms(q, programs, { archiveMissing = false } = {}) {
  const now = nowSql();
  const counts = { added: 0, updated: 0, archived: 0 };
  for (const p of programs) {
    let row = await q('programs').where({ lms_id: p.lms_id }).first();
    if (!row) row = await q('programs').whereNull('lms_id').whereRaw('lower(name) = ?', [p.name.toLowerCase()]).first();
    const fields = { name: p.name, lms_id: p.lms_id, lms_slug: p.lms_slug, category: p.category, fee: p.fee, certificate_fee: p.certificate_fee, updated_at: now };
    if (row) {
      await q('programs').where({ id: row.id }).update({ ...fields, is_active: true, ...(row.description ? {} : { description: p.description }) });
      counts.updated += 1;
    } else {
      await q('programs').insert({ ...fields, kind: 'internship', fee_includes_gst: true, description: p.description, is_active: true, created_at: now });
      counts.added += 1;
    }
  }
  if (archiveMissing && programs.length) {
    counts.archived = await q('programs').whereNotNull('lms_id').whereNotIn('lms_id', programs.map((p) => p.lms_id)).where({ is_active: true })
      .update({ is_active: false, updated_at: now });
  }
  return counts;
}

/** The LMS's published public courses, the same list its catalogue shows. */
async function fetchLmsPrograms() {
  if (!config.lms.platformUrl) throw new Error('The LMS address isn’t set (LMS_API_URL).');
  const params = new URLSearchParams({ page: '1', perPage: '500', sort: 'title', expand: 'category', filter: "status='published' && course_type='public'" });
  const res = await fetch(`${config.lms.platformUrl}/api/collections/courses/records?${params}`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`The LMS answered ${res.status}.`);
  return ((await res.json()).items || []).map(fromLms);
}

async function syncPrograms() {
  const programs = await fetchLmsPrograms();
  if (!programs.length) throw new Error('The LMS returned no published courses, so nothing was changed.');
  return db.transaction((trx) => upsertPrograms(trx, programs, { archiveMissing: true }));
}

const lmsCourseUrl = (slug) => `https://lms.haptags.com/course/${slug}`;

module.exports = { fromRow, fromLms, upsertPrograms, fetchLmsPrograms, syncPrograms, lmsCourseUrl };
