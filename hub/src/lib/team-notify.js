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

/**
 * Rings everyone in a call (DM, group or channel) except the caller. Open tabs ring at once; anyone with no
 * open tab is emailed a Join link, so nobody misses the call. Emails go out in the background.
 */
async function notifyCall({ userIds, by, title, url, channelId = null }) {
  const targets = [...new Set(userIds.map(Number))].filter((id) => id && id !== Number(by.id));
  if (!targets.length) return [];
  rt.publish({ users: targets }, 'call.ring', { channelId, by: by.name, title, url });
  const online = new Set(rt.onlineUsers());
  const offline = await db('users').whereIn('id', targets.filter((id) => !online.has(id))).where({ is_active: true }).select('name', 'email');
  const mails = offline.filter((p) => p.email).map((p) => sendMail({
    to: p.email, subject: `${by.name} is calling you`, heading: `${by.name} is calling`,
    lines: [`Hi ${String(p.name || '').split(' ')[0]},`, `${by.name} started “${title}”. Join now while it is still live.`],
    button: { label: 'Join the call', url: `${config.baseUrl}${url}` },
  }).catch(() => false));
  notifyCall.lastEmails = Promise.all(mails); // tests wait on this
  return targets;
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

module.exports = { notifyLeaders, notifyCall, reviewNotice };
