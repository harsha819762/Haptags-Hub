'use strict';

// The GST arithmetic, kept pure so it can be tested on its own and mirrored in the browser
// (public/js/gst.js). Amounts are integers in minor units (paise, cents). Tax is worked out
// per line, then summed; INR totals are rounded to the nearest rupee with a round-off line.

/**
 * Where the tax goes. Exports are zero-rated (0% IGST under LUT); a place of supply in our own
 * state is intra-state (CGST + SGST at half the rate each); anywhere else in India is IGST.
 */
function supplyTypeFor({ clientType, posCode }, homeStateCode) {
  if (clientType === 'export' || posCode === '96') return 'export';
  return posCode === homeStateCode ? 'intra' : 'inter';
}

function computeLine(line, supplyType) {
  const quantity = Math.round(Math.max(0, Number(line.quantity) || 0) * 1000) / 1000;
  const rate = Math.max(0, Math.round(Number(line.rate) || 0));
  const gross = Math.round(quantity * rate);
  const discount = Math.min(gross, Math.max(0, Math.round(Number(line.discount) || 0)));
  const taxable = gross - discount;
  const gstRate = supplyType === 'export' ? 0 : Math.max(0, Number(line.gst_rate) || 0);
  let cgst = 0;
  let sgst = 0;
  let igst = 0;
  if (supplyType === 'intra') {
    cgst = Math.round((taxable * gstRate) / 200);
    sgst = cgst;
  } else if (supplyType === 'inter') {
    igst = Math.round((taxable * gstRate) / 100);
  }
  return { ...line, quantity, rate, gross, discount, taxable, gst_rate: gstRate, cgst, sgst, igst, total: taxable + cgst + sgst + igst };
}

/** Lines → document totals. exchangeRate converts a foreign-currency document to INR. */
function computeDocument(lines, { supplyType, currency = 'INR', exchangeRate = 1 }) {
  const computed = lines.map((l) => computeLine(l, supplyType));
  const sum = (key) => computed.reduce((s, l) => s + l[key], 0);
  const taxable = sum('taxable');
  const cgst = sum('cgst');
  const sgst = sum('sgst');
  const igst = sum('igst');
  const beforeRounding = taxable + cgst + sgst + igst;
  const roundOff = currency === 'INR' ? Math.round(beforeRounding / 100) * 100 - beforeRounding : 0;
  const total = beforeRounding + roundOff;
  const fx = currency === 'INR' ? 1 : Number(exchangeRate) || 0;
  const inr = (v) => (currency === 'INR' ? v : Math.round(v * fx));
  return {
    lines: computed,
    gross: sum('gross'),
    discount: sum('discount'),
    taxable,
    cgst,
    sgst,
    igst,
    round_off: roundOff,
    total,
    inr_taxable: inr(taxable),
    inr_cgst: inr(cgst),
    inr_sgst: inr(sgst),
    inr_igst: inr(igst),
    inr_total: inr(total),
  };
}

/** The tax table printed on the invoice: one row per SAC and rate. */
function taxSummary(lines) {
  const groups = new Map();
  for (const l of lines) {
    const rate = Number(l.gst_rate) || 0;
    const key = `${l.sac || ''}|${rate}`;
    const g = groups.get(key) || { sac: l.sac || '', gst_rate: rate, taxable: 0, cgst: 0, sgst: 0, igst: 0, tax: 0 };
    g.taxable += Number(l.taxable);
    g.cgst += Number(l.cgst);
    g.sgst += Number(l.sgst);
    g.igst += Number(l.igst);
    g.tax += Number(l.cgst) + Number(l.sgst) + Number(l.igst);
    groups.set(key, g);
  }
  return [...groups.values()].sort((a, b) => a.sac.localeCompare(b.sac) || a.gst_rate - b.gst_rate);
}

/** A typed discount: '500' is an amount, '10%' is a share of the line's value. */
function parseDiscount(value, gross) {
  const s = String(value ?? '').replace(/[,\s₹$€£]/g, '');
  if (!s) return 0;
  if (s.endsWith('%')) {
    const pct = Math.min(100, Math.max(0, Number(s.slice(0, -1)) || 0));
    return Math.round((gross * pct) / 100);
  }
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : 0;
}

module.exports = { supplyTypeFor, computeLine, computeDocument, taxSummary, parseDiscount };
