'use strict';

// Chat, calls and meetings. One router serves both sides: clients at /portal/chat (they can only reach the Haptags team)
// and team members at /team/chat (they can reach clients and each other).
// Clients only ever see conversations they were added to, and can only start chats with the Haptags team.
const express = require('express');
const { db } = require('../db');
const rt = require('../lib/realtime');
const rooms = require('../lib/rooms');
const chat = require('../lib/chat');
const M = require('../lib/meetings');
const { notifyCall } = require('../lib/team-notify');
const { ensureClientGroup } = require('../lib/clientchat');
const { notFound } = require('../lib/middleware');
const { nowSql, str, int, isEmail, istToUtc, utcToIst, addMinutesSql, todayIST } = require('../lib/util');


const MAX_FILE = 8 * 1024 * 1024;
const ids = (v) => [].concat(v || []).map((x) => int(x, 0)).filter(Boolean);
const idParam = (req, key = 'id') => int(req.params[key], 0);
const decode = (v) => {
  try { return decodeURIComponent(v || ''); } catch { return ''; }
};
const emailList = (v) => String(v || '').split(/[\s,;]+/).map((e) => e.trim().toLowerCase()).filter(Boolean);
const wantsJson = (req) => req.accepts(['html', 'json']) === 'json';


module.exports = function createChatRouter({ base: BASE, audience }) {
const router = express.Router();
const isTeam = audience === 'team';

/**
 * Who this person may start chats with. The team can reach everyone. A client only reaches the Haptags people
 * assigned to their account (req.contactIds), never the whole organisation.
 */
const people = (req) => (isTeam
  ? db('users as u').leftJoin('clients as c', 'c.id', 'u.client_id').where('u.is_active', true).whereNot('u.id', req.user.id).orderBy('u.name').select('u.id', 'u.name', 'u.role', 'c.name as company')
  : chat.activeStaff().whereIn('id', req.contactIds.length ? req.contactIds : [0]).orderBy('name').select('id', 'name', 'role'));
const allowedChat = (list) => db('users').where({ is_active: true }).whereNot('role', 'client').whereIn('id', list.length ? list : [0]);
const allowed = (list, req) => (isTeam
  ? db('users').where({ is_active: true }).whereIn('id', list.length ? list : [0])
  : chat.activeStaff().whereIn('id', list.filter((id) => req.contactIds.includes(id)).length ? list.filter((id) => req.contactIds.includes(id)) : [0]));

// Clients: load their contacts once per request.
router.use(async (req, res, next) => {
  req.contactIds = isTeam ? [] : await db('client_contacts').where({ client_id: req.user.client_id }).pluck('user_id');
  next();
});

/** A conversation the client belongs to. Unlike the staff chat, public channels are never opened to clients. */
async function memberChannel(user, channelId) {
  const member = await db('channel_members').where({ channel_id: channelId, user_id: user.id }).first();
  let channel = member ? await db('channels').where({ id: channelId }).first() : null;
  if (!channel && ['owner', 'admin'].includes(user.role)) {
    // Owners and admins oversee every client's group chat, so opening one joins it.
    const group = await db('channels').where({ id: channelId }).whereNotNull('client_id').first();
    if (group) { await chat.addMembers(group.id, [user.id]); channel = group; }
  }
  if (channel && user.role === 'client' && channel.client_id !== user.client_id) return null; // clients only ever see their company's group
  return channel || null;
}

async function channelParam(req, res, next) {
  const channel = await memberChannel(req.user, idParam(req));
  if (!channel) return wantsJson(req) ? res.status(404).json({ error: 'Not found' }) : next('route');
  req.channel = channel;
  next();
}

async function renderChat(req, res, channel) {
  const list = await chat.channelList(req.user.id);
  const conversations = isTeam ? list.direct : list.direct.filter((c) => c.client_id === req.user.client_id);
  const data = { base: BASE, me: { id: req.user.id, name: req.user.name }, channelId: channel ? channel.id : null, messages: [], online: rt.onlineUsers() };
  let members = [];
  let current = null;
  if (channel) {
    current = conversations.find((c) => c.id === channel.id);
    members = await chat.members(channel.id);
    data.messages = await chat.fetchMessages(channel.id);
    data.members = members.map((m) => ({ id: m.id, name: m.name }));
    await chat.markRead(channel.id, req.user.id);
    if (current) {
      res.locals.chatUnread = Math.max(0, res.locals.chatUnread - current.unread);
      current.unread = 0;
    }
  }
  res.render('portal/chat', {
    title: current ? current.label : 'Chat', flush: true, scripts: ['chat'], conversations, current, members, people: await people(req), data, base: BASE, isTeam,
  });
}

router.get('/', async (req, res) => {
  if (!isTeam) return res.redirect(`${BASE}/${await ensureClientGroup(req.user.client_id)}`); // clients have exactly one chat
  const { direct } = await chat.channelList(req.user.id);
  if (req.query.list || !direct.length) return renderChat(req, res, null);
  const recent = [...direct].sort((a, b) => String(b.last_message_at || '').localeCompare(String(a.last_message_at || '')))[0];
  res.redirect(`${BASE}/${recent.id}`);
});

// ---- Meetings ----
const DURATIONS = M.DURATIONS;

function nextSlot() {
  const t = utcToIst(addMinutesSql(nowSql(), 30 - (new Date().getUTCMinutes() % 30)));
  return { date: t.date, time: t.time };
}

router.get('/meetings', async (req, res) => {
  const now = nowSql();
  const live = rooms.liveCounts();
  const rows = (await M.meetingsFor(req.user.id, { from: addMinutesSql(now, -240) }).limit(100))
    .map((m) => ({ ...m, ...M.timing(m, live), when: utcToIst(m.starts_at) })).filter((m) => !m.past || m.inCall);
  const past = (await M.meetingsFor(req.user.id, { to: now }).clearOrder().orderBy('m.starts_at', 'desc').limit(10)).map((m) => ({ ...m, when: utcToIst(m.starts_at) }));
  res.render('portal/meetings', { title: 'Meetings', rows, past, today: todayIST(), base: BASE });
});

router.get('/meetings/new', async (req, res) => {
  const slot = nextSlot();
  res.render('portal/meeting-new', {
    title: 'Schedule a meeting', errors: {}, people: await people(req), durations: DURATIONS, base: BASE,
    values: { title: '', agenda: '', date: slot.date, time: slot.time, duration_min: 30, user_ids: ids(req.query.user_ids), emails: '' },
  });
});

router.post('/meetings', async (req, res) => {
  const emails = emailList(req.body.emails);
  const values = {
    title: str(req.body.title, 190), agenda: str(req.body.agenda, 3000), date: String(req.body.date || ''), time: String(req.body.time || ''),
    duration_min: DURATIONS.includes(int(req.body.duration_min, 0)) ? int(req.body.duration_min, 0) : 30,
    user_ids: ids(req.body.user_ids), emails: req.body.emails || '',
  };
  const startsAt = istToUtc(values.date, values.time);
  const errors = {};
  if (!values.title) errors.title = 'Give the meeting a title.';
  if (!startsAt) errors.date = 'Pick a date and time.';
  if (emails.some((e) => !isEmail(e))) errors.emails = 'Check the email addresses.';
  if (!values.user_ids.length && !emails.length) errors.people = 'Invite at least one person from the team.';
  if (Object.keys(errors).length) {
    return res.status(422).render('portal/meeting-new', { title: 'Schedule a meeting', errors, values, people: await people(req), durations: DURATIONS, base: BASE });
  }
  const invited = await allowed(values.user_ids, req).pluck('id');
  const id = await M.createMeeting({
    title: values.title, agenda: values.agenda, startsAt, duration: values.duration_min, allowGuests: emails.length > 0,
    createdBy: req.user.id, userIds: invited, emails,
  });
  const m = await db('meetings').where({ id }).first();
  const sent = await M.emailInvites(id, { skipUserId: req.user.id }).catch(() => 0);
  rt.publish({ users: (await M.teamIds(m)).filter((u) => u !== req.user.id) }, 'meeting.invite', {
    id, title: m.title, by: req.user.name, url: `${BASE}/meetings/${id}`, startsAt: `${m.starts_at.replace(' ', 'T')}Z`,
  });
  req.flash('success', sent ? `Meeting scheduled. ${sent} invitation${sent === 1 ? '' : 's'} emailed.` : 'Meeting scheduled.');
  res.redirect(`${BASE}/meetings/${id}`);
});

// "Meet now": an instant room, straight in. ?voice=1 opens with the camera off.
router.post('/meetings/now', async (req, res) => {
  const invited = await allowed(ids(req.body.user_ids), req).pluck('id');
  const id = await M.createMeeting({
    title: str(req.body.title, 190) || `${req.user.name.split(' ')[0]}'s meeting`, startsAt: nowSql(), duration: 60, allowGuests: false,
    createdBy: req.user.id, userIds: invited,
  });
  const m = await db('meetings').where({ id }).first();
  if (invited.length) {
    await notifyCall({ userIds: invited, by: req.user, title: m.title, url: `/meet/${m.room_token}` });
  }
  res.redirect(`/meet/${m.room_token}${req.body.voice ? '?voice=1' : ''}`);
});

async function loadMeeting(req, res, next) {
  const m = await db('meetings as m').leftJoin('users as u', 'u.id', 'm.created_by').where('m.id', idParam(req)).select('m.*', 'u.name as organizer_name').first();
  if (!m) return next('route');
  const people = await M.invitees(m.id);
  if (m.created_by !== req.user.id && !people.some((p) => p.user_id === req.user.id)) return next('route');
  req.meeting = m;
  req.people = people;
  next();
}

router.get('/meetings/:id', loadMeeting, (req, res) => {
  const m = req.meeting;
  res.render('portal/meeting', {
    title: m.title, meeting: { ...m, ...M.timing(m), when: utcToIst(m.starts_at) }, people: req.people, joinUrl: M.joinUrl(m), mine: m.created_by === req.user.id, base: BASE,
  });
});

router.get('/meetings/:id/invite.ics', loadMeeting, (req, res) => {
  res.set({ 'Content-Type': 'text/calendar; charset=utf-8', 'Content-Disposition': `attachment; filename="meeting-${req.meeting.id}.ics"` });
  res.send(M.ics(req.meeting, { organizerName: req.meeting.organizer_name || 'Haptags' }));
});

router.post('/meetings/:id/cancel', loadMeeting, async (req, res) => {
  const m = req.meeting;
  if (m.created_by === req.user.id && m.status === 'scheduled') {
    await db('meetings').where({ id: m.id }).update({ status: 'cancelled', updated_at: nowSql() });
    await M.emailInvites(m.id, { kind: 'cancel', skipUserId: req.user.id }).catch(() => 0);
    req.flash('success', 'Meeting cancelled.');
  }
  res.redirect(`${BASE}/meetings`);
});

router.post('/meetings/:id/rsvp', loadMeeting, async (req, res) => {
  const response = ['accepted', 'declined'].includes(req.body.response) ? req.body.response : 'pending';
  await db('meeting_invitees').where({ meeting_id: req.meeting.id, user_id: req.user.id }).update({ response });
  res.redirect(`${BASE}/meetings/${req.meeting.id}`);
});

// ---- Conversations ----

// A private chat with one person from the team.
const teamOnly = (req, res, next) => (isTeam ? next() : notFound(req, res));
router.post('/new', teamOnly, async (req, res) => {
  const other = await allowedChat(ids(req.body.user_ids).slice(0, 1)).first();
  if (!other) {
    req.flash('error', 'Choose someone from the team.');
    return res.redirect(BASE);
  }
  res.redirect(`${BASE}/${await chat.directChannel(req.user.id, other.id)}`);
});

// A named group with several people from the team.
router.post('/groups', teamOnly, async (req, res) => {
  const name = str(req.body.name, 120);
  const valid = await allowedChat(ids(req.body.user_ids)).pluck('id');
  if (!name || !valid.length) {
    req.flash('error', !name ? 'Give the group a name.' : 'Pick at least one person for the group.');
    return res.redirect(BASE);
  }
  const id = await chat.groupChannel(req.user.id, valid, name);
  await chat.postMessage({ channelId: id, kind: 'system', body: `${req.user.name} created the group “${name}”` });
  res.redirect(`${BASE}/${id}`);
});

// Files are only served to people in the conversation they were shared in.
router.get('/files/:fid', async (req, res, next) => {
  const msg = await db('messages').where({ file_id: idParam(req, 'fid') }).whereNull('deleted_at').first();
  if (!msg || !(await memberChannel(req.user, msg.channel_id))) return next('route');
  const file = await db('files').where({ id: msg.file_id }).first();
  const inline = chat.IMAGE_TYPES.includes(file.mime) && !req.query.download;
  res.set({
    'Content-Type': file.mime,
    'Content-Length': file.size,
    'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="${file.name.replace(/[^ -~]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(file.name)}`,
    'Cache-Control': 'private, max-age=86400',
    'Content-Security-Policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
  });
  res.end(Buffer.from(file.data));
});

router.get('/:id', channelParam, (req, res) => renderChat(req, res, req.channel));

router.get('/:id/messages', channelParam, async (req, res) => {
  res.json({ messages: await chat.fetchMessages(req.channel.id, { before: int(req.query.before, 0), after: int(req.query.after, 0) }) });
});

router.post('/:id/messages', channelParam, async (req, res) => {
  const body = str(req.body.body, 5000);
  if (!body) return res.status(422).json({ error: 'Write a message first.' });
  res.status(201).json({ message: await chat.postMessage({ channelId: req.channel.id, userId: req.user.id, body }) });
});

router.post('/:id/files', channelParam, express.raw({ type: () => true, limit: MAX_FILE }), async (req, res) => {
  const data = req.body;
  if (!Buffer.isBuffer(data) || !data.length) return res.status(422).json({ error: 'The file is empty.' });
  const name = decode(req.get('x-file-name')).replace(/[\\/\r\n"]/g, '_').slice(0, 200) || 'file';
  const mime = /^[\w.+-]+\/[\w.+-]+$/.test(req.get('content-type') || '') ? req.get('content-type').toLowerCase() : 'application/octet-stream';
  const [fileId] = await db('files').insert({ name, mime, size: data.length, data, uploaded_by: req.user.id, created_at: nowSql() });
  const message = await chat.postMessage({ channelId: req.channel.id, userId: req.user.id, fileId, body: str(decode(req.get('x-caption')), 5000) || '' });
  res.status(201).json({ message });
});

router.post('/:id/read', channelParam, async (req, res) => {
  await chat.markRead(req.channel.id, req.user.id, int(req.body.id, 0));
  res.status(204).end();
});

router.post('/:id/typing', channelParam, async (req, res) => {
  const others = (await chat.memberIds(req.channel.id)).filter((id) => id !== req.user.id);
  rt.publish({ users: others }, 'chat.typing', { channelId: req.channel.id, userId: req.user.id, name: req.user.name });
  res.status(204).end();
});

const groupOnly = (req, res, next) => (req.channel.kind === 'group' ? next() : res.redirect(`${BASE}/${req.channel.id}`));

router.post('/:id/rename', teamOnly, channelParam, groupOnly, async (req, res) => {
  const name = str(req.body.name, 120);
  if (name) {
    await db('channels').where({ id: req.channel.id }).update({ name });
    await chat.postMessage({ channelId: req.channel.id, kind: 'system', body: `${req.user.name} renamed the group to “${name}”` });
  }
  res.redirect(`${BASE}/${req.channel.id}`);
});

router.post('/:id/members', teamOnly, channelParam, groupOnly, async (req, res) => {
  const before = await chat.memberIds(req.channel.id);
  const add = await allowedChat(ids(req.body.user_ids)).whereNotIn('id', before).select('id', 'name');
  if (add.length) {
    await chat.addMembers(req.channel.id, add.map((u) => u.id));
    await chat.postMessage({ channelId: req.channel.id, kind: 'system', body: `${req.user.name} added ${add.map((u) => u.name).join(', ')}` });
  }
  res.redirect(`${BASE}/${req.channel.id}`);
});

router.post('/:id/leave', teamOnly, channelParam, groupOnly, async (req, res) => {
  await db('channel_members').where({ channel_id: req.channel.id, user_id: req.user.id }).del();
  await chat.postMessage({ channelId: req.channel.id, kind: 'system', body: `${req.user.name} left the group` });
  req.flash('success', 'You left the group.');
  res.redirect(BASE);
});

// Start a call with everyone in this conversation: posts a Join card and rings their tabs. voice=1 starts with the camera off.
router.post('/:id/call', channelParam, async (req, res) => {
  const c = req.channel;
  const memberIds = await chat.memberIds(c.id);
  const voice = Boolean(req.body.voice);
  const title = `${voice ? 'Voice' : 'Video'} call with ${req.user.name}`;
  const meetingId = await M.createMeeting({ title, startsAt: nowSql(), duration: 30, allowGuests: false, createdBy: req.user.id, userIds: memberIds, channelId: c.id });
  const meeting = await db('meetings').where({ id: meetingId }).first();
  await chat.postMessage({ channelId: c.id, userId: req.user.id, kind: 'call', body: `${req.user.name} started a ${voice ? 'voice' : 'video'} call`, meetingId });
  await notifyCall({ userIds: memberIds, by: req.user, title, url: `/meet/${meeting.room_token}`, channelId: c.id });
  const url = `/meet/${meeting.room_token}${voice ? '?voice=1' : ''}`;
  if (wantsJson(req)) return res.json({ url });
  res.redirect(url);
});

router.post('/messages/:mid/edit', async (req, res) => {
  const m = await db('messages').where({ id: idParam(req, 'mid'), user_id: req.user.id, kind: 'text' }).whereNull('deleted_at').first();
  const body = str(req.body.body, 5000);
  if (!m || !body) return res.status(404).json({ error: 'Not found' });
  await db('messages').where({ id: m.id }).update({ body, edited_at: nowSql() });
  res.json({ message: await chat.broadcastUpdate(m.id) });
});

router.post('/messages/:mid/delete', async (req, res) => {
  const m = await db('messages').where({ id: idParam(req, 'mid'), user_id: req.user.id }).whereNull('deleted_at').first();
  if (!m) return res.status(404).json({ error: 'Not found' });
  await db('messages').where({ id: m.id }).update({ deleted_at: nowSql(), body: null });
  if (m.file_id) await db('files').where({ id: m.file_id }).del();
  res.json({ message: await chat.broadcastUpdate(m.id) });
});

return router;
};
