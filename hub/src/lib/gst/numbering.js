'use strict';

// Document numbers: PREFIX/FY/0001 (e.g. HT/26-27/0001), at most 16 characters (Rule 46(b)),
// consecutive within a financial year and restarting on 1 April. A number is taken when the
// document is finalised and never released, even if it is later cancelled.
//
// The counter lives in the shared `sequences` table under the same name the Hub's older invoice
// screen uses (`HT:26-27`), and both check each other's table, so a number can never be issued
// twice under one GSTIN, whichever screen issues it.

const { db } = require('../../db');
const { financialYear } = require('../util');
const { KINDS } = require('./constants');

const MAX_LENGTH = 16;

class GstError extends Error {
  constructor(message) {
    super(message);
    this.status = 422;
    this.gst = true;
  }
}

const formatNumber = (prefix, fy, seq) => `${prefix}/${fy}/${String(seq).padStart(4, '0')}`;
const prefixFor = (kind, profile) => profile[KINDS[kind].prefixKey];

async function numberInUse(trx, number) {
  if (await trx('gst_documents').where({ number }).first()) return true;
  return Boolean(await trx('invoices').where({ number }).first());
}

async function bump(trx, name) {
  const updated = await trx('sequences').where({ name }).increment('value', 1);
  if (!updated) {
    await trx('sequences').insert({ name, value: 1 });
    return 1;
  }
  return Number((await trx('sequences').where({ name }).first()).value);
}

/** Takes the next number in a series. Must run inside the finalising transaction. */
async function takeNumber(trx, prefix, dateYmd) {
  const fy = financialYear(dateYmd);
  for (let i = 0; i < 1000; i += 1) {
    const seq = await bump(trx, `${prefix}:${fy}`);
    const number = formatNumber(prefix, fy, seq);
    if (number.length > MAX_LENGTH) throw new GstError(`${number} is longer than 16 characters. Use a shorter prefix on the Business Profile page.`);
    if (!(await numberInUse(trx, number))) return { number, fy, seq };
  }
  throw new GstError('Could not find a free number in this series.');
}

/** The number the next finalised document in a series will get, without taking it. */
async function previewNumber(prefix, dateYmd, trx = db) {
  const fy = financialYear(dateYmd);
  const row = await trx('sequences').where({ name: `${prefix}:${fy}` }).first();
  let seq = (row ? Number(row.value) : 0) + 1;
  while (await numberInUse(trx, formatNumber(prefix, fy, seq))) seq += 1;
  return formatNumber(prefix, fy, seq);
}

/**
 * Moves a series forward, e.g. to continue after invoices issued elsewhere this year. Never
 * backwards: numbers already passed are not handed out again.
 */
async function advanceSeries(prefix, dateYmd, next) {
  const name = `${prefix}:${financialYear(dateYmd)}`;
  const row = await db('sequences').where({ name }).first();
  const current = row ? Number(row.value) : 0;
  const value = Math.floor(next) - 1;
  if (value <= current) return false;
  if (row) await db('sequences').where({ name }).update({ value });
  else await db('sequences').insert({ name, value });
  return true;
}

module.exports = { GstError, MAX_LENGTH, formatNumber, prefixFor, takeNumber, previewNumber, advanceSeries, numberInUse };
