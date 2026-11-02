'use strict';

// Internship offer letters for students and interns. letterContent() holds the wording, so the web
// page, the PDF and the email all say the same thing. A letter is a draft until it is issued;
// issuing numbers it (HTOL/26-27/0001) and freezes its terms and signatory, and the student then
// accepts or declines it online at /o/<token>.

const config = require('../config');
const { db } = require('../db');
const { getSettings } = require('./settings');
const { getProfile } = require('./gst/profile');
const { stateName } = require('./gst/constants');
const { nextNumber } = require('./billing');
const { logActivity } = require('./activity');
const { sendMail } = require('./mailer');
const { formatINR, toPaise } = require('./money');
const {
  nowSql, todayIST, addDays, addMonths, daysBetween, formatDate, formatDateTime, financialYear, isDate, isEmail, str, int, randomToken,
} = require('./util');

const MODES = [['onsite', 'On-site'], ['hybrid', 'Hybrid'], ['remote', 'Remote']];
const modeLabel = (m) => (MODES.find((x) => x[0] === m) || MODES[0])[1];

class OfferError extends Error {
  constructor(message) {
    super(message);
    this.status = 422;
    this.offer = true;
  }
}

/** An issued offer past its accept-by date shows as expired. */
function displayStatus(letter, today = todayIST()) {
  if (letter.status === 'issued' && letter.respond_by && letter.respond_by < today) return 'expired';
  return letter.status;
}

/** 'Java Internship Training' → 'Java Intern'. */
function roleFor(programName) {
  const base = String(programName || '').replace(/\b(internships?|interns?|training|programmes?|programs?|courses?)\b/gi, ' ').replace(/\s+/g, ' ').trim();
  return base ? `${base} Intern` : 'Intern';
}

/** '3 months', '6 weeks' or '10 days' between two dates, inclusive. */
function durationText(start, end) {
  if (!isDate(start) || !isDate(end) || end < start) return '';
  const days = daysBetween(start, end) + 1;
  const months = Math.round(days / 30.44);
  if (months >= 1 && Math.abs(days - months * 30.44) <= 4) return `${months} month${months === 1 ? '' : 's'}`;
  if (days >= 14) {
    const weeks = Math.round(days / 7);
    return `${weeks} week${weeks === 1 ? '' : 's'}`;
  }
  return `${days} day${days === 1 ? '' : 's'}`;
}

function joiningText({ mode, location, reporting_to: reportingTo, start_date: start }) {
  const when = formatDate(start);
  if (mode === 'remote') {
    return `Your internship begins on ${when}. You will receive the onboarding call link and your login details by email the day before. Please keep your college ID card and a government-issued photo ID ready for verification.`;
  }
  return `Please report${reportingTo ? ` to ${reportingTo}` : ''} at ${location || 'our office'} at 10:00 am on ${when}, carrying your college ID card and a government-issued photo ID.`;
}

/** A new letter for a student, filled from their record, their programme and the defaults. */
async function defaultsFor(student) {
  const s = await getSettings();
  const program = student.program_id ? await db('programs').where({ id: student.program_id }).first() : null;
  const today = todayIST();
  const start = isDate(student.start_date) && student.start_date >= today ? student.start_date : addDays(today, 7);
  // End: the student's own date, else the programme's length ('3 months', '6 weeks'), else a month.
  const length = String((program && program.duration) || '').match(/(\d+)\s*(month|week|day)/i);
  const unit = length ? length[2].toLowerCase() : 'month';
  const n = length ? Number(length[1]) : 1;
  const fromLength = unit === 'month' ? addMonths(start, n) : addDays(start, unit === 'week' ? n * 7 : n);
  const end = isDate(student.end_date) && student.end_date > start ? student.end_date : addDays(fromLength, -1);
  const letter = {
    client_id: student.id,
    program_id: program ? program.id : null,
    candidate_name: student.name,
    candidate_email: student.email || '',
    candidate_phone: student.phone || '',
    college: student.college || '',
    course: student.course || '',
    candidate_address: [student.address, student.city, student.state, student.pincode].filter(Boolean).join(', '),
    role_title: roleFor(program ? program.name : ''),
    programme: program ? program.name : '',
    start_date: start,
    end_date: end,
    duration: durationText(start, end) || (program && program.duration) || '',
    mode: s.offer_mode,
    location: s.offer_location,
    schedule: s.offer_schedule,
    reporting_to: s.offer_reporting_to,
    reporting_designation: s.offer_reporting_designation,
    stipend: 0,
    fee: program ? Number(program.fee) : 0,
    show_fee: false,
    respond_by: addDays(today, int(s.offer_respond_days, 7)),
    extra_terms: '',
  };
  letter.joining_instructions = joiningText(letter);
  return letter;
}

/** Reads the offer letter form. Returns { letter, errors }; money in paise. */
function parseForm(body) {
  const errors = {};
  const letter = {
    candidate_name: str(body.candidate_name, 190),
    candidate_email: (str(body.candidate_email, 190) || '').toLowerCase() || null,
    candidate_phone: str(body.candidate_phone, 40),
    college: str(body.college, 190),
    course: str(body.course, 190),
    candidate_address: str(body.candidate_address, 500),
    role_title: str(body.role_title, 190),
    programme: str(body.programme, 190),
    start_date: isDate(body.start_date) ? body.start_date : null,
    end_date: isDate(body.end_date) ? body.end_date : null,
    duration: str(body.duration, 60),
    mode: MODES.some((m) => m[0] === body.mode) ? body.mode : 'onsite',
    location: str(body.location, 255),
    schedule: str(body.schedule, 255),
    reporting_to: str(body.reporting_to, 190),
    reporting_designation: str(body.reporting_designation, 190),
    stipend: Math.max(0, toPaise(body.stipend)),
    fee: Math.max(0, toPaise(body.fee)),
    show_fee: body.show_fee === '1',
    respond_by: isDate(body.respond_by) ? body.respond_by : null,
    joining_instructions: str(body.joining_instructions, 2000),
    extra_terms: str(body.extra_terms, 5000),
  };
  if (!letter.candidate_name) errors.candidate_name = 'Enter the student’s full name.';
  if (letter.candidate_email && !isEmail(letter.candidate_email)) errors.candidate_email = 'Enter a valid email address.';
  if (!letter.role_title) errors.role_title = 'Name the internship position, e.g. Java Full Stack Development Intern.';
  if (!letter.start_date) errors.start_date = 'Choose the start date.';
  if (!letter.end_date) errors.end_date = 'Choose the end date.';
  if (letter.start_date && letter.end_date && letter.end_date < letter.start_date) errors.end_date = 'The internship can’t end before it starts.';
  if (letter.mode !== 'remote' && !letter.location) errors.location = 'Enter where the intern will work.';
  if (letter.show_fee && !letter.fee) errors.fee = 'Enter the programme fee, or untick “Mention the programme fee”.';
  if (!letter.duration && letter.start_date && letter.end_date) letter.duration = durationText(letter.start_date, letter.end_date);
  return { letter, errors };
}

/** "Heading: text" paragraphs → [{ heading, text }]. */
function parseTerms(text) {
  return String(text || '').split(/\n\s*\n/).map((p) => p.replace(/\s*\n\s*/g, ' ').trim()).filter(Boolean).map((p) => {
    const m = p.match(/^([^:.]{2,60}):\s+(.+)$/);
    return m ? { heading: m[1].trim(), text: m[2].trim() } : { heading: '', text: p };
  });
}

/** Letterhead details: the registered business profile from GST Invoices. */
async function company() {
  const p = await getProfile();
  const s = await getSettings();
  return {
    legal_name: p.legal_name,
    brand: s.company_name || p.trade_name || p.legal_name,
    tagline: s.tagline,
    address: [String(p.address || '').replace(/\s*\n\s*/g, ', '), [p.city, p.pincode].filter(Boolean).join(' – '), stateName(p.state_code)].filter(Boolean).join(', '),
    gstin: p.gstin,
    llpin: p.llpin,
    email: p.email,
    phone: p.phone,
    website: String(p.website || '').replace(/^https?:\/\//, ''),
    logo_file_id: p.logo_file_id,
    signature_file_id: p.signature_file_id,
  };
}

/** Everything the letter says, in order. Drafts use the current standard terms and signatory. */
async function letterContent(letter) {
  const s = await getSettings();
  const co = await company();
  const issued = letter.status !== 'draft';
  const terms = issued ? letter.terms : s.offer_terms;
  const signatory = {
    name: issued ? letter.signatory_name : s.offer_signatory_name,
    designation: (issued ? letter.signatory_designation : s.offer_signatory_designation) || 'Authorised Signatory',
  };
  const first = String(letter.candidate_name).trim().split(/\s+/)[0];
  const where = letter.mode === 'remote' ? 'Remote (online)' : `${modeLabel(letter.mode)}${letter.location ? `, ${letter.location}` : ''}`;
  const details = [
    ['Position', letter.role_title],
    letter.programme && ['Programme', letter.programme],
    ['Internship period', `${formatDate(letter.start_date)} to ${formatDate(letter.end_date)}${letter.duration ? ` (${letter.duration})` : ''}`],
    ['Mode and location', where],
    letter.schedule && ['Working days and hours', letter.schedule],
    letter.reporting_to && ['Reporting to', [letter.reporting_to, letter.reporting_designation].filter(Boolean).join(', ')],
    ['Stipend', Number(letter.stipend) > 0 ? `${formatINR(letter.stipend)} per month` : 'Not applicable'],
    letter.show_fee && Number(letter.fee) > 0 && ['Programme fee', `${formatINR(letter.fee)}, payable as per your fee invoice`],
    letter.respond_by && ['Please accept by', formatDate(letter.respond_by)],
  ].filter(Boolean);
  return {
    company: co,
    title: 'Internship Offer Letter',
    reference: letter.number || 'Draft, not yet issued',
    date: formatDate(letter.issued_on || todayIST()),
    to: [
      letter.candidate_name,
      [letter.course, letter.college].filter(Boolean).join(', '),
      letter.candidate_address,
      [letter.candidate_email, letter.candidate_phone].filter(Boolean).join(' · '),
    ].filter(Boolean),
    subject: `Offer of internship: ${letter.role_title}`,
    salutation: `Dear ${first},`,
    intro: [
      `On behalf of ${co.legal_name}, I am pleased to offer you an internship as ${letter.role_title}${letter.programme ? ` in our ${letter.programme} programme` : ''}. We were impressed by your interest and potential, and this internship is designed to give you real, hands-on experience of working on live projects alongside our team.`,
      'The key terms of your internship are set out below, followed by the conditions that apply to it. Please read them carefully.',
    ],
    details,
    joining: letter.joining_instructions || '',
    terms: [...parseTerms(terms), ...parseTerms(letter.extra_terms)],
    closing: [
      `We look forward to welcoming you to ${co.brand}. Please confirm that you accept this offer${letter.respond_by ? ` by ${formatDate(letter.respond_by)}` : ''}, either online using the link in our email or by signing and returning a copy of this letter. If we do not hear from you by then, this offer will lapse.`,
      'I wish you a rewarding internship with us.',
    ],
    signoff: { lead: 'Yours sincerely,', company: `For ${co.legal_name}`, ...signatory },
    acceptance: {
      heading: 'Acceptance by the intern',
      text: `I, ${letter.candidate_name}, have read and understood the terms of this offer letter, and I accept the internship on these terms.`,
      accepted: letter.status === 'accepted'
        ? `Accepted online by ${letter.responded_name} on ${formatDateTime(letter.responded_at)} IST${letter.responded_ip ? `, from IP address ${letter.responded_ip}` : ''}.`
        : null,
    },
    status: displayStatus(letter),
  };
}

const offerUrl = (letter) => `${config.baseUrl}/o/${letter.public_token}`;

/** What the next issued letter will be numbered, without taking it. */
async function previewOfferNumber() {
  const s = await getSettings();
  const today = todayIST();
  const fy = financialYear(today);
  const row = await db('sequences').where({ name: `${s.offer_prefix}:${fy}` }).first();
  let seq = (row ? Number(row.value) : 0) + 1;
  const fmt = (n) => `${s.offer_prefix}/${fy}/${String(n).padStart(4, '0')}`;
  while (await db('offer_letters').where({ number: fmt(seq) }).first()) seq += 1;
  return fmt(seq);
}

async function saveDraft({ id = null, clientId, programId = null, letter, userId }) {
  const now = nowSql();
  if (id) {
    const current = await db('offer_letters').where({ id }).first();
    if (!current || current.status !== 'draft') throw new OfferError('Only drafts can be edited. Make a revised copy of an issued letter instead.');
    await db('offer_letters').where({ id }).update({ ...letter, updated_at: now });
    return id;
  }
  const [newId] = await db('offer_letters').insert({
    ...letter, client_id: clientId, program_id: programId, status: 'draft', public_token: randomToken(24), created_by: userId || null, created_at: now, updated_at: now,
  });
  const offerId = typeof newId === 'object' ? newId.id : newId;
  await logActivity('client', clientId, userId, 'system', `Offer letter drafted: ${letter.role_title}`);
  return offerId;
}

/** Numbers the letter and freezes its wording. Returns the number. */
async function issue(id, userId) {
  const s = await getSettings();
  const letter = await db('offer_letters').where({ id }).first();
  if (!letter || letter.status !== 'draft') throw new OfferError('This letter has already been issued.');
  const today = todayIST();
  if (letter.end_date < today) throw new OfferError('This internship has already ended. Check the dates before issuing.');
  const respondBy = letter.respond_by && letter.respond_by >= today ? letter.respond_by : addDays(today, int(s.offer_respond_days, 7));
  const number = await db.transaction(async (trx) => {
    const n = await nextNumber(trx, s.offer_prefix, today, 'offer_letters');
    await trx('offer_letters').where({ id }).update({
      number: n, status: 'issued', issued_on: today, issued_at: nowSql(), issued_by: userId || null, respond_by: respondBy,
      terms: s.offer_terms, signatory_name: s.offer_signatory_name || null, signatory_designation: s.offer_signatory_designation || 'Authorised Signatory',
      updated_at: nowSql(),
    });
    return n;
  });
  await logActivity('offer', id, userId, 'status', `Issued as ${number}`);
  await logActivity('client', letter.client_id, userId, 'system', `Offer letter ${number} issued (${letter.role_title})`);
  return number;
}

async function withdraw(id, reason, userId) {
  const letter = await db('offer_letters').where({ id }).first();
  if (!letter || !['issued', 'accepted'].includes(letter.status)) throw new OfferError('Only an issued letter can be withdrawn.');
  if (!reason) throw new OfferError('Give a reason for withdrawing the offer.');
  await db('offer_letters').where({ id }).update({ status: 'withdrawn', withdrawn_at: nowSql(), withdraw_reason: reason, updated_at: nowSql() });
  await logActivity('offer', id, userId, 'status', `Withdrawn: ${reason}`);
  await logActivity('client', letter.client_id, userId, 'system', `Offer letter ${letter.number} withdrawn: ${reason}`);
}

/** A copy of an issued letter as a new draft, to correct and issue again. */
async function revise(id, userId) {
  const letter = await db('offer_letters').where({ id }).first();
  if (!letter) throw new OfferError('Letter not found.');
  const keep = ['candidate_name', 'candidate_email', 'candidate_phone', 'college', 'course', 'candidate_address', 'role_title', 'programme', 'start_date',
    'end_date', 'duration', 'mode', 'location', 'schedule', 'reporting_to', 'reporting_designation', 'stipend', 'fee', 'show_fee', 'joining_instructions', 'extra_terms'];
  const copy = Object.fromEntries(keep.map((k) => [k, letter[k]]));
  copy.respond_by = addDays(todayIST(), int((await getSettings()).offer_respond_days, 7));
  return saveDraft({ clientId: letter.client_id, programId: letter.program_id, letter: copy, userId });
}

/** The student's answer from /o/<token>. */
async function respond(letter, { accept, name, note, ip }) {
  if (displayStatus(letter) !== 'issued') throw new OfferError('This offer can no longer be accepted or declined.');
  if (!name) throw new OfferError('Please type your full name to confirm.');
  await db('offer_letters').where({ id: letter.id }).update({
    status: accept ? 'accepted' : 'declined', responded_at: nowSql(), responded_name: name, responded_ip: ip ? String(ip).slice(0, 64) : null,
    response_note: note || null, updated_at: nowSql(),
  });
  const verb = accept ? 'Accepted' : 'Declined';
  await logActivity('offer', letter.id, null, 'status', `${verb} online by ${name}${note ? `: “${note}”` : ''}`);
  await logActivity('client', letter.client_id, null, 'system', `Offer letter ${letter.number} ${verb.toLowerCase()} by ${name}`);
  await sendMail({
    to: config.notifyEmail,
    subject: `${accept ? '🎉 Offer accepted' : 'Offer declined'}: ${letter.number} · ${letter.candidate_name}`,
    related: ['offer', letter.id],
    heading: accept ? 'Internship offer accepted' : 'Internship offer declined',
    lines: [`${name} ${accept ? 'accepted' : 'declined'} offer letter ${letter.number} (${letter.role_title}).`, note ? `Note: “${note}”` : ''].filter(Boolean),
    rows: [['Starts', formatDate(letter.start_date)], ['Ends', formatDate(letter.end_date)]],
    button: { label: 'Open the letter', url: `${config.baseUrl}/admin/education/offers/${letter.id}` },
  });
  return db('offer_letters').where({ id: letter.id }).first();
}

async function emailLetter(id, { to, message, pdf }, userId) {
  const letter = await db('offer_letters').where({ id }).first();
  if (!letter || letter.status === 'draft') throw new OfferError('Issue the letter before emailing it.');
  const recipient = String(to || letter.candidate_email || '').trim();
  if (!isEmail(recipient)) throw new OfferError('Enter the student’s email address.');
  const co = await company();
  const first = letter.candidate_name.split(/\s+/)[0];
  const lines = message
    ? String(message).split(/\n{2,}/)
    : [
      `Dear ${first},`,
      `Congratulations! I am pleased to offer you an internship at ${co.legal_name} as ${letter.role_title}, starting on ${formatDate(letter.start_date)}. Your offer letter ${letter.number} is attached.`,
      `Please read it and accept it online${letter.respond_by ? ` by ${formatDate(letter.respond_by)}` : ''} using the button below.`,
    ];
  const ok = await sendMail({
    to: recipient,
    replyTo: co.email || undefined,
    subject: `Your internship offer from ${co.legal_name}: ${letter.role_title}`,
    related: ['offer', letter.id],
    heading: 'Your internship offer letter',
    lines,
    rows: [['Reference', letter.number], ['Position', letter.role_title], ['Starts', formatDate(letter.start_date)]],
    button: { label: 'View and accept your offer', url: offerUrl(letter) },
    attachments: pdf ? [{ filename: `Offer-letter-${letter.number.replace(/\//g, '-')}.pdf`, content: pdf, contentType: 'application/pdf' }] : undefined,
  });
  await db('offer_letters').where({ id }).update({ emailed_at: nowSql() });
  await logActivity('offer', id, userId, 'email', `Emailed to ${recipient}${ok ? '' : ' (not delivered; check the email settings)'}`);
  return ok;
}

module.exports = {
  MODES, OfferError, modeLabel, displayStatus, roleFor, durationText, joiningText, defaultsFor, parseForm, parseTerms, letterContent, company,
  offerUrl, previewOfferNumber, saveDraft, issue, withdraw, revise, respond, emailLetter,
};
