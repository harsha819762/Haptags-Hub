'use strict';

// Every client company has exactly one group chat with its Haptags contacts. Clients see only this chat.
const { db } = require('../db');
const chat = require('./chat');
const { nowSql } = require('./util');

/** The company's group chat id, created on first use with everyone who belongs in it. */
async function ensureClientGroup(clientId) {
  const found = await db('channels').where({ client_id: clientId }).first();
  const client = await db('clients').where({ id: clientId }).first();
  let id = found && found.id;
  if (!id) {
    const [gid] = await db('channels').insert({ kind: 'group', name: `${client.name} × Haptags`, is_private: true, client_id: clientId, created_at: nowSql(), last_message_at: nowSql() });
    id = Array.isArray(gid) ? gid[0] : gid;
  }
  await syncMembers(clientId, id);
  return id;
}

/** Group members = the company's active people plus its Haptags contacts. Adds anyone missing. */
async function syncMembers(clientId, channelId) {
  const people = await db('users').where({ client_id: clientId, role: 'client', is_active: true }).pluck('id');
  const contacts = await db('client_contacts as cc').join('users as u', 'u.id', 'cc.user_id').where({ 'cc.client_id': clientId, 'u.is_active': true }).pluck('u.id');
  await chat.addMembers(channelId, [...people, ...contacts]);
}

const groupIdFor = async (clientId) => (await db('channels').where({ client_id: clientId }).first() || {}).id || null;

module.exports = { ensureClientGroup, syncMembers, groupIdFor };
