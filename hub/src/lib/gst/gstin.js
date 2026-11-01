'use strict';

const { GST_STATES } = require('./constants');

const CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/;

/** The 15th character of a GSTIN: a mod-36 check over the first 14. */
function checkChar(first14) {
  let sum = 0;
  for (let i = 0; i < 14; i += 1) {
    const product = CHARS.indexOf(first14[i]) * (i % 2 ? 2 : 1);
    sum += Math.floor(product / 36) + (product % 36);
  }
  return CHARS[(36 - (sum % 36)) % 36];
}

/**
 * Checks a GSTIN: 15 characters, a known state code, and the check digit. Returns
 * { ok, gstin, stateCode, stateName, pan } or { ok: false, error }.
 */
function parseGstin(value) {
  const gstin = String(value || '').toUpperCase().replace(/\s+/g, '');
  if (!gstin) return { ok: false, error: 'Enter the GSTIN.' };
  if (!/^[0-9A-Z]{15}$/.test(gstin)) return { ok: false, error: 'A GSTIN is 15 letters and digits, e.g. 29AASFH7857G1ZK.' };
  const state = GST_STATES.find((s) => s[0] === gstin.slice(0, 2));
  if (!state) return { ok: false, error: `${gstin.slice(0, 2)} isn't a GST state code.` };
  if (checkChar(gstin.slice(0, 14)) !== gstin[14]) return { ok: false, error: 'This GSTIN fails its check digit. Please check it for typos.' };
  const pan = gstin.slice(2, 12);
  return { ok: true, gstin, stateCode: state[0], stateName: state[1], pan: PAN_RE.test(pan) ? pan : null };
}

const isPan = (value) => PAN_RE.test(String(value || '').toUpperCase());

module.exports = { parseGstin, checkChar, isPan };
