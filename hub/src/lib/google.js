'use strict';

// "Sign in with Google" (OpenID Connect, authorization-code flow), with no extra dependencies.
//
// It only signs in people who already have an active account here: Google proves they own the
// email address, and the address must match a user. Nobody gets an account by signing in with
// Google; invites stay the only way in.
//
// The ID token comes straight from Google's token endpoint over TLS, in exchange for our client
// secret, so OpenID Connect Core 3.1.3.7 lets TLS stand in for checking its signature. The
// issuer, audience, expiry, nonce and email_verified claims are still checked.

const config = require('../config');

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];

class GoogleError extends Error {}

const enabled = () => Boolean(config.google.clientId && config.google.clientSecret);
const redirectUri = () => `${config.baseUrl}/auth/google/callback`;

/** The Google page to send the browser to. */
function authUrl({ state, nonce }) {
  const q = new URLSearchParams({
    client_id: config.google.clientId,
    redirect_uri: redirectUri(),
    response_type: 'code',
    scope: 'openid email profile',
    state,
    nonce,
    prompt: 'select_account',
  });
  return `${AUTH_URL}?${q}`;
}

function decodeJwtPayload(jwt) {
  const part = String(jwt || '').split('.')[1];
  if (!part) throw new GoogleError('Google sent an unreadable sign-in token.');
  try {
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
  } catch {
    throw new GoogleError('Google sent an unreadable sign-in token.');
  }
}

/** Swaps the code from Google's redirect for the person's verified email. Returns { email, name, sub }. */
async function verifiedIdentity(code, nonce) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: config.google.clientId,
      client_secret: config.google.clientSecret,
      redirect_uri: redirectUri(),
      grant_type: 'authorization_code',
    }),
    signal: AbortSignal.timeout(10000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.id_token) {
    console.warn('[google] Token exchange failed:', res.status, body.error || '', body.error_description || '');
    throw new GoogleError('Google sign-in didn’t complete. Please try again.');
  }
  const claims = decodeJwtPayload(body.id_token);
  const now = Math.floor(Date.now() / 1000);
  if (!ISSUERS.includes(claims.iss) || claims.aud !== config.google.clientId || !(claims.exp > now) || claims.nonce !== nonce) {
    throw new GoogleError('Google sign-in didn’t complete. Please try again.');
  }
  if (!claims.email || claims.email_verified !== true) {
    throw new GoogleError('Google hasn’t verified the email address on that account, so it can’t be used to sign in.');
  }
  return { email: String(claims.email).toLowerCase(), name: claims.name || '', sub: String(claims.sub || '') };
}

module.exports = { enabled, authUrl, verifiedIdentity, redirectUri, GoogleError };
