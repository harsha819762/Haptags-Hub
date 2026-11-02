'use strict';

// Education → Offer letters: internship offer letters for students, mounted at /admin/education/offers.

const express = require('express');
const { db } = require('../../db');
const offers = require('../../lib/offers');
const { renderOfferPdf } = require('../../lib/offer-pdf');
const { imageDataUri } = require('../../lib/gst/profile');
const { getActivities } = require('../../lib/activity');
const { mailEnabled } = require('../../lib/mailer');
const { str, int, todayIST } = require('../../lib/util');
const { paginate, idParam, back } = require('./_helpers');

const router = express.Router();

const findStudent = (id) => db('clients').where({ id: id || 0, segment: 'student' }).first();
const load = (req) => db('offer_letters').where({ id: idParam(req) }).first();
const fileName = (o) => `Offer-letter-${String(o.number || `draft-${o.id}`).replace(/\//g, '-')}.pdf`;

async function pdfFor(letter) {
  return renderOfferPdf(await offers.letterContent(letter));
}

router.get('/', async (req, res) => {
  const status = ['draft', 'issued', 'accepted', 'declined', 'withdrawn', 'expired'].includes(req.query.status) ? req.query.status : '';
  const q = str(req.query.q, 100);
  const today = todayIST();
  const query = db('offer_letters').orderByRaw('CASE WHEN number IS NULL THEN 0 ELSE 1 END').orderBy('id', 'desc');
  if (status === 'expired') query.where('status', 'issued').where('respond_by', '<', today);
  else if (status === 'issued') query.where('status', 'issued').where((w) => w.whereNull('respond_by').orWhere('respond_by', '>=', today));
  else if (status) query.where({ status });
  if (q) query.where((w) => w.where('candidate_name', 'like', `%${q}%`).orWhere('number', 'like', `%${q}%`).orWhere('role_title', 'like', `%${q}%`).orWhere('college', 'like', `%${q}%`));
  const page = await paginate(query, req);
  const counts = Object.fromEntries((await db('offer_letters').select('status').count({ n: '*' }).groupBy('status')).map((r) => [r.status, Number(r.n)]));
  res.render('admin/education/offers', { title: 'Offer letters', tab: 'offers', ...page, status, q, today, counts, displayStatus: offers.displayStatus });
});

// Pick a student, or go straight to the form with ?student=<id>.
router.get('/new', async (req, res) => {
  const st = await findStudent(int(req.query.student, 0));
  if (!st) {
    const q = str(req.query.q, 100);
    const query = db('clients as c').leftJoin('programs as p', 'p.id', 'c.program_id').where('c.segment', 'student').orderBy('c.id', 'desc').limit(30)
      .select('c.id', 'c.name', 'c.college', 'c.email', 'p.name as program_name');
    if (q) query.where((w) => w.where('c.name', 'like', `%${q}%`).orWhere('c.email', 'like', `%${q}%`).orWhere('c.college', 'like', `%${q}%`).orWhere('c.phone', 'like', `%${q}%`));
    return res.render('admin/education/offer-pick', { title: 'New offer letter', tab: 'offers', students: await query, q });
  }
  res.render('admin/education/offer-form', {
    title: `Offer letter for ${st.name}`, tab: 'offers', student: st, letter: await offers.defaultsFor(st), errors: {}, nextNumber: await offers.previewOfferNumber(),
  });
});

async function save(req, res, { id = null, student, programId }) {
  const { letter, errors } = offers.parseForm(req.body);
  if (Object.keys(errors).length) {
    return res.status(422).render('admin/education/offer-form', {
      title: `Offer letter for ${student.name}`, tab: 'offers', student, letter: { ...letter, id }, errors, nextNumber: await offers.previewOfferNumber(),
    });
  }
  const offerId = await offers.saveDraft({ id, clientId: student.id, programId, letter, userId: req.user.id });
  if (req.body.action === 'issue') {
    const number = await offers.issue(offerId, req.user.id);
    req.flash('success', `Offer letter ${number} issued. Email it or share the link so ${letter.candidate_name.split(/\s+/)[0]} can accept online.`);
  } else {
    req.flash('success', 'Draft saved.');
  }
  return res.redirect(`/admin/education/offers/${offerId}`);
}

router.post('/', async (req, res, next) => {
  const student = await findStudent(int(req.body.client_id, 0));
  if (!student) return next();
  return save(req, res, { student, programId: student.program_id || null });
});

router.get('/:id', async (req, res, next) => {
  const letter = await load(req);
  if (!letter) return next();
  const [content, student, activities, logo, signature] = await Promise.all([
    offers.letterContent(letter), findStudent(letter.client_id), getActivities('offer', letter.id), imageDataUri('logo'), imageDataUri('signature'),
  ]);
  res.render('admin/education/offer', {
    title: `${letter.number || 'Draft offer letter'} · ${letter.candidate_name}`, tab: 'offers', letter, c: content, student, activities, logo, signature,
    status: offers.displayStatus(letter), link: offers.offerUrl(letter), mailEnabled, styles: ['offer'],
  });
});

router.get('/:id/edit', async (req, res, next) => {
  const letter = await load(req);
  if (!letter) return next();
  if (letter.status !== 'draft') {
    req.flash('error', `${letter.number} is issued, so its wording is fixed. Make a revised copy to change it.`);
    return res.redirect(`/admin/education/offers/${letter.id}`);
  }
  res.render('admin/education/offer-form', {
    title: `Edit offer letter for ${letter.candidate_name}`, tab: 'offers', student: await findStudent(letter.client_id), letter, errors: {}, nextNumber: await offers.previewOfferNumber(),
  });
});

router.post('/:id', async (req, res, next) => {
  const letter = await load(req);
  if (!letter) return next();
  if (letter.status !== 'draft') return res.redirect(`/admin/education/offers/${letter.id}`);
  return save(req, res, { id: letter.id, student: await findStudent(letter.client_id), programId: letter.program_id });
});

router.post('/:id/issue', async (req, res, next) => {
  const letter = await load(req);
  if (!letter) return next();
  const number = await offers.issue(letter.id, req.user.id);
  req.flash('success', `Offer letter ${number} issued.`);
  res.redirect(`/admin/education/offers/${letter.id}`);
});

router.get('/:id/pdf', async (req, res, next) => {
  const letter = await load(req);
  if (!letter) return next();
  res.set({
    'Content-Type': 'application/pdf', 'Cache-Control': 'private, no-store',
    'Content-Disposition': `${req.query.download ? 'attachment' : 'inline'}; filename="${fileName(letter)}"`,
  });
  res.send(await pdfFor(letter));
});

router.post('/:id/email', async (req, res, next) => {
  const letter = await load(req);
  if (!letter) return next();
  const ok = await offers.emailLetter(letter.id, { to: str(req.body.to, 190), message: str(req.body.message, 5000), pdf: await pdfFor(letter) }, req.user.id);
  req.flash(ok ? 'success' : 'error', ok ? 'Offer letter emailed with the PDF attached.' : 'The email could not be sent. Check the email settings; the attempt is in the history.');
  res.redirect(`/admin/education/offers/${letter.id}`);
});

router.post('/:id/withdraw', async (req, res, next) => {
  const letter = await load(req);
  if (!letter) return next();
  await offers.withdraw(letter.id, str(req.body.reason, 255), req.user.id);
  req.flash('success', `${letter.number} withdrawn. The student’s link now shows that the offer is no longer open.`);
  res.redirect(`/admin/education/offers/${letter.id}`);
});

router.post('/:id/revise', async (req, res, next) => {
  const letter = await load(req);
  if (!letter) return next();
  const id = await offers.revise(letter.id, req.user.id);
  req.flash('success', `Revised copy of ${letter.number || 'the draft'} created. Edit it and issue it; withdraw the old one if it has been sent.`);
  res.redirect(`/admin/education/offers/${id}/edit`);
});

router.post('/:id/delete', async (req, res, next) => {
  const letter = await load(req);
  if (!letter) return next();
  if (letter.status !== 'draft') {
    req.flash('error', 'Issued letters are kept. Withdraw it instead.');
    return res.redirect(`/admin/education/offers/${letter.id}`);
  }
  await db('offer_letters').where({ id: letter.id }).del();
  req.flash('success', 'Draft deleted.');
  res.redirect(`/admin/education/students/${letter.client_id}#offers`);
});

// A rule the user can fix (dates, missing email…): show it and go back.
router.use((err, req, res, next) => {
  if (!err.offer) return next(err);
  req.flash('error', err.message);
  res.redirect(back(req, '/admin/education/offers'));
});

module.exports = router;
