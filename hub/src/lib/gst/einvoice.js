'use strict';

// E-invoicing (IRN + signed QR from the GST Invoice Registration Portal). Not switched on:
// it becomes mandatory once turnover passes ₹5 crore. This module builds the IRP request in
// the NIC e-invoice schema (version 1.1) from a finalised document, so turning it on later
// means: send buildPayload() to the IRP through a GSP, then store the reply with saveIrn().
// The PDF already prints the IRN, acknowledgement and signed QR once they are saved.

const { db } = require('../../db');
const { countryCode } = require('./constants');
const { GstError } = require('./numbering');
const { nowSql } = require('../util');

const TYPES = { invoice: 'INV', credit_note: 'CRN', debit_note: 'DBN' };
const dmy = (ymd) => `${ymd.slice(8, 10)}/${ymd.slice(5, 7)}/${ymd.slice(0, 4)}`;
const rs = (minor) => Math.round(Number(minor)) / 100;
const pin = (text) => Number((String(text || '').match(/\b\d{6}\b/) || [])[0]) || null;

/** Whether a document goes to the IRP: B2B and export tax documents, not B2C or proformas. */
const eligible = (doc) => Boolean(TYPES[doc.kind] && doc.number && doc.status !== 'cancelled' && (doc.client_type === 'b2b' || doc.supply_type === 'export'));

function buildPayload({ doc, lines, supplier, original }) {
  if (!eligible(doc)) throw new GstError('Only finalised B2B and export tax invoices and notes are reported for e-invoicing.');
  const exportDoc = doc.supply_type === 'export';
  const inr = (minor) => rs(doc.currency === 'INR' ? minor : Math.round(Number(minor) * Number(doc.exchange_rate)));
  const [addr1, ...rest] = String(supplier.address || '').split(/\n/);
  const billAddr = String(doc.bill_address || '').split(/\n/);
  return {
    Version: '1.1',
    TranDtls: { TaxSch: 'GST', SupTyp: exportDoc ? 'EXPWOP' : 'B2B', RegRev: doc.reverse_charge ? 'Y' : 'N', IgstOnIntra: 'N' },
    DocDtls: { Typ: TYPES[doc.kind], No: doc.number, Dt: dmy(doc.issue_date) },
    SellerDtls: {
      Gstin: supplier.gstin, LglNm: supplier.legal_name, TrdNm: supplier.trade_name || undefined,
      Addr1: addr1.slice(0, 100), Addr2: rest.join(', ').slice(0, 100) || undefined, Loc: supplier.city,
      Pin: Number(supplier.pincode), Stcd: supplier.state_code,
      Ph: String(supplier.phone || '').replace(/\D/g, '').slice(-12) || undefined, Em: supplier.email || undefined,
    },
    BuyerDtls: {
      Gstin: exportDoc ? 'URP' : doc.bill_gstin, LglNm: doc.bill_name, Pos: doc.pos_code,
      Addr1: (billAddr[0] || doc.bill_country || '').slice(0, 100), Addr2: billAddr.slice(1).join(', ').slice(0, 100) || undefined,
      Loc: (billAddr[billAddr.length - 1] || doc.bill_country || '').replace(/\s*–\s*\S+$/, '').slice(0, 50),
      Pin: exportDoc ? 999999 : pin(doc.bill_address), Stcd: exportDoc ? '96' : doc.bill_state_code,
      Ph: String(doc.bill_phone || '').replace(/\D/g, '').slice(-12) || undefined, Em: doc.bill_email || undefined,
    },
    ItemList: lines.map((l, i) => ({
      SlNo: String(i + 1), PrdDesc: l.description.slice(0, 300), IsServc: String(l.sac || '').startsWith('99') ? 'Y' : 'N', HsnCd: l.sac,
      Qty: Number(l.quantity), Unit: String(l.sac || '').startsWith('99') ? 'OTH' : 'NOS',
      UnitPrice: inr(l.rate), TotAmt: inr(l.gross), Discount: inr(l.discount), AssAmt: inr(l.taxable), GstRt: Number(l.gst_rate),
      IgstAmt: inr(l.igst), CgstAmt: inr(l.cgst), SgstAmt: inr(l.sgst), CesRt: 0, CesAmt: 0, CesNonAdvlAmt: 0,
      StateCesRt: 0, StateCesAmt: 0, StateCesNonAdvlAmt: 0, OthChrg: 0, TotItemVal: inr(l.total),
    })),
    ValDtls: {
      AssVal: inr(doc.taxable), CgstVal: inr(doc.cgst), SgstVal: inr(doc.sgst), IgstVal: inr(doc.igst), CesVal: 0, StCesVal: 0,
      Discount: 0, OthChrg: 0, RndOffAmt: rs(doc.round_off), TotInvVal: inr(doc.total), TotInvValFc: exportDoc ? rs(doc.total) : undefined,
    },
    ExpDtls: exportDoc ? { RefClm: 'N', ForCur: doc.currency, CntCode: countryCode(doc.bill_country) || undefined } : undefined,
    RefDtls: original ? { PrecDocDtls: [{ InvNo: original.number, InvDt: dmy(original.issue_date) }] } : undefined,
  };
}

/** Stores the IRP's reply (Irn, AckNo, AckDt, SignedQRCode) on the document. */
async function saveIrn(docId, { Irn, AckNo, AckDt, SignedQRCode }) {
  await db('gst_documents').where({ id: docId }).update({
    irn: Irn, irn_ack_no: String(AckNo || ''), irn_ack_date: AckDt || null, irn_signed_qr: SignedQRCode || null, updated_at: nowSql(),
  });
}

module.exports = { eligible, buildPayload, saveIrn };
