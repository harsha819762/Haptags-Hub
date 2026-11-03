'use strict';

// Inviting people: creates the account, makes a single-use "set your password" link and emails it.
// The link is also returned so an admin can share it by hand when email isn't set up.
const { db } = require('../db');
const { createPasswordLink, INVITE_DAYS } = require('./auth');
const { sendMail } = require('./mailer');
const { nowSql } = require('./util');
const { ensureClientGroup } = require('./clientchat');

const idOf = (v) => (Array.isArray(v) ? v[0] : v);

function message(user, invitedBy) {
  if (user.role === 'client') {
    return {
      subject: 'You’re invited to the Haptags client portal', heading: `Welcome, ${user.name.split(' ')[0]}`,
      lines: [`${invitedBy.name} from Haptags invited you to your client portal. There you can follow your projects, approve work, pay invoices and chat with the team.`, `Set your password to get started (the link works for ${INVITE_DAYS} days).`],
    };
  }
  return {
    subject: 'You’ve been added to Haptags', heading: 'Welcome to Haptags',
    lines: [`Hi ${user.name},`, `${invitedBy.name} added you to the Haptags portal as ${user.role}. Set your password to get started (the link works for ${INVITE_DAYS} days).`],
  };
}

/** Creates an account and sends the invite. */
async function inviteUser({ name, email, role, clientId = null, jobTitle = null, invitedBy, send = true, allProjects = true, projectIds = [] }) {
  const isClient = role === 'client';
  const [uid] = await db('users').insert({
    name, email, role, client_id: clientId, job_title: jobTitle, is_active: true, token_version: 1,
    all_projects: isClient ? Boolean(allProjects) : true, created_at: nowSql(), updated_at: nowSql(),
  });
  const id = idOf(uid);
  if (isClient) {
    await setProjectAccess(id, clientId, { all: Boolean(allProjects), projectIds });
    await ensureClientGroup(clientId); // they join their company's one group chat with the team
  }
  const user = { id, name, email, role };
  const link = await createPasswordLink(id);
  const m = message(user, invitedBy);
  const sent = send ? await sendMail({ to: email, subject: m.subject, heading: m.heading, lines: m.lines, button: { label: 'Set my password', url: link } }).catch(() => false) : false;
  return { id, link, sent: Boolean(sent) };
}

/** A fresh link for someone who hasn't set a password yet (or lost the email). */
async function resendInvite(user, invitedBy) {
  const link = await createPasswordLink(user.id);
  const m = message(user, invitedBy);
  const sent = await sendMail({ to: user.email, subject: m.subject, heading: m.heading, lines: m.lines, button: { label: 'Set my password', url: link } }).catch(() => false);
  return { link, sent: Boolean(sent) };
}

/** Sets which of the client's projects a person can see. `all` means every project, now and later. */
async function setProjectAccess(userId, clientId, { all, projectIds = [] }) {
  await db('users').where({ id: userId }).update({ all_projects: Boolean(all), updated_at: nowSql() });
  await db('project_members').where({ user_id: userId }).del();
  if (all) return;
  const valid = await db('projects').where({ client_id: clientId }).whereIn('id', projectIds.length ? projectIds : [0]).pluck('id');
  for (const projectId of valid) await db('project_members').insert({ project_id: projectId, user_id: userId, created_at: nowSql() });
}

module.exports = { inviteUser, resendInvite, setProjectAccess };
