'use strict';

const { amountInWords } = require('../money');
const { CURRENCIES } = require('./constants');

const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve',
  'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

const twoDigits = (n) => (n < 20 ? ONES[n] : `${TENS[Math.floor(n / 10)]}${n % 10 ? ` ${ONES[n % 10]}` : ''}`);
const threeDigits = (n) => [Math.floor(n / 100) ? `${ONES[Math.floor(n / 100)]} Hundred` : '', n % 100 ? twoDigits(n % 100) : ''].filter(Boolean).join(' ');

/** International grouping (thousand, million, billion) for foreign-currency invoices. */
function internationalWords(minor, currency) {
  const c = CURRENCIES[currency] || CURRENCIES.USD;
  const total = Math.round(Math.abs(Number(minor) || 0));
  let major = Math.floor(total / 100);
  const cents = total % 100;
  const parts = [];
  for (const [size, name] of [[1e9, 'Billion'], [1e6, 'Million'], [1e3, 'Thousand']]) {
    if (major >= size) {
      parts.push(`${threeDigits(Math.floor(major / size))} ${name}`);
      major %= size;
    }
  }
  if (major) parts.push(threeDigits(major));
  let words = `${c.major} ${parts.length ? parts.join(' ') : 'Zero'}`;
  if (cents) words += ` and ${twoDigits(cents)} ${c.minor}`;
  return `${words} Only`;
}

/** 'Rupees One Lakh Twenty Thousand Only' for INR (lakh/crore); international words otherwise. */
function inWords(minor, currency = 'INR') {
  return currency === 'INR' ? amountInWords(Math.abs(Number(minor) || 0)) : internationalWords(minor, currency);
}

module.exports = { inWords };
