'use strict';

// Tells the people in charge about something: a live pop-up in any open Haptags tab (and a desktop
// notification when the tab is in the background), plus an email so nobody misses it while away.

const { db } = require('../db');
const rt = require('./realtime');
const { sendMail } = require('./mailer');
const config = require('../config');

/**
 * Notifies every active person with one of `roles` (owners and admins by default), except `except`.
 * Returns the people notified. The emails go out in the background, so a drag on the board stays quick.
 */
async function notifyLeaders({ roles = ['owner', 'admin'], except = null, title, body, url, tag, related, email = true }) {
  const people = await db('users').whereIn('role', roles).where({ is_active: true })
    .modify((q) => { if (except) q.whereNot('id', except); }).select('id', 'name', 'email');
  if (!people.length) return [];
  rt.publish({ users: people.map((p) => p.id) }, 'team.notice', { title, body, url, tag: tag || null });
  if (email) {
    const mails = people.map((p) => sendMail({
      to: p.email, subject: title, heading: title, related,
      lines: [`Hi ${p.name.split(' ')[0]},`, body], button: url ? { label: 'Open in Haptags', url: `${config.baseUrl}${url}` } : undefined,
    }).catch(() => false));
    notifyLeaders.lastEmails = Promise.all(mails); // tests wait on this
  }
  return people;
}

/** "Under review" means the client is checking it: owners and admins hear about it straight away. */
function reviewNotice({ who, kind, name, project, url }) {
  return notifyLeaders({
    except: who.id,
    title: kind === 'task' ? `In review: ${name}` : `Project in review: ${name}`,
    body: kind === 'task'
      ? `${who.name} moved the task “${name}” on ${project} to Under review.`
      : `${who.name} moved the project “${name}”${project ? ` for ${project}` : ''} to Under review.`,
    url, tag: `review-${url}`,
  }).catch((err) => { console.error('[notify] review', err.message); return []; });
}

module.exports = { notifyLeaders, reviewNotice };
