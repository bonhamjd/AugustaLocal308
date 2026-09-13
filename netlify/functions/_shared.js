const crypto = require('crypto');

// ---------------------------------------------------------------------------
// Env helpers. Netlify env var names have drifted, so each secret has one
// canonical name plus the legacy name that is currently set in the dashboard.
// ---------------------------------------------------------------------------
const ENV = {
  stripeKey: () => process.env.STRIPE_RESTRICTED_KEY || process.env.Stripe_Restricted_Key,
  calKey: () => process.env.CALCOM_API_KEY || process.env.Cal_Netlify_Key,
  resendKey: () => process.env.RESEND_API_KEY || process.env.Resend_Api_Key,
  resendFrom: () => process.env.RESEND_FROM,
  sessionSecret: () => process.env.SESSION_SECRET,
  calWebhookSecret: () => process.env.CALCOM_WEBHOOK_SECRET,
  siteUrl: () => process.env.URL || 'https://augustalocal308.netlify.app',
  allowlist: () => process.env.MEMBER_ALLOWLIST || '',
};

// Cal.com pins a different API version per endpoint family.
const CAL_API = 'https://api.cal.com/v2';
const CAL_VERSION_READ = '2026-05-01';  // GET /bookings
const CAL_VERSION_WRITE = '2026-02-25'; // POST /bookings/{uid}/confirm and /decline

// ---------------------------------------------------------------------------
// Tokens: HMAC-SHA256 over a small JSON payload. No deps, no build step.
// ---------------------------------------------------------------------------
function b64url(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  return Buffer.from(str, 'base64');
}

function sign(payloadObj, secret) {
  if (!secret) throw new Error('SESSION_SECRET is not set');
  const payload = b64url(JSON.stringify(payloadObj));
  const sig = crypto.createHmac('sha256', secret).update(payload).digest();
  return payload + '.' + b64url(sig);
}

function verify(token, secret) {
  if (!secret) return null;
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const expectedSig = b64url(crypto.createHmac('sha256', secret).update(parts[0]).digest());
  if (!safeEqual(parts[1], expectedSig)) return null;
  let data;
  try {
    data = JSON.parse(b64urlDecode(parts[0]).toString('utf8'));
  } catch (e) {
    return null;
  }
  if (!data.exp || Date.now() > data.exp) return null;
  return data;
}

function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

function parseCookies(header) {
  const out = {};
  (header || '').split(';').forEach(function (part) {
    const i = part.indexOf('=');
    if (i === -1) return;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}

// ---------------------------------------------------------------------------
// Membership
// ---------------------------------------------------------------------------

// Comps, the owner, and anyone who pays outside Stripe. Set MEMBER_ALLOWLIST to
// a comma-separated list of emails. Without this JD cannot book his own bay,
// because he has no Stripe subscription.
function onAllowlist(email) {
  return ENV.allowlist()
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .includes(String(email).trim().toLowerCase());
}

// Any active or trialing Stripe subscription on this email.
// Uses a restricted key scoped to Customers:Read and Subscriptions:Read.
async function stripeActiveSubscription(email) {
  const key = ENV.stripeKey();
  if (!key) throw new Error('STRIPE_RESTRICTED_KEY is not set');

  const custRes = await fetch(
    'https://api.stripe.com/v1/customers?email=' + encodeURIComponent(email) + '&limit=5',
    { headers: { Authorization: 'Bearer ' + key } }
  );
  if (!custRes.ok) throw new Error('Stripe customers lookup failed: ' + custRes.status);
  const custData = await custRes.json();
  if (!custData.data || !custData.data.length) return false;

  for (const cust of custData.data) {
    const subRes = await fetch(
      'https://api.stripe.com/v1/subscriptions?customer=' + cust.id + '&status=all&limit=10',
      { headers: { Authorization: 'Bearer ' + key } }
    );
    if (!subRes.ok) continue;
    const subData = await subRes.json();
    if (subData.data && subData.data.some((s) => s.status === 'active' || s.status === 'trialing')) {
      return true;
    }
  }
  return false;
}

// The single question the whole site asks: is this email allowed to book?
// Throws if the membership check itself is broken, so callers can tell
// "not a member" apart from "our config is wrong".
async function isMember(email) {
  if (onAllowlist(email)) return true;
  return stripeActiveSubscription(email);
}

// ---------------------------------------------------------------------------
// Cal.com
// ---------------------------------------------------------------------------
async function calFetch(path, { method = 'GET', version = CAL_VERSION_READ, body } = {}) {
  const key = ENV.calKey();
  if (!key) throw new Error('CALCOM_API_KEY is not set');
  const res = await fetch(CAL_API + path, {
    method,
    headers: {
      Authorization: 'Bearer ' + key,
      'cal-api-version': version,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch (e) {
    /* non-JSON error body */
  }
  return { ok: res.ok, status: res.status, json, text };
}

// "Jake Miller" -> "Jake M."   "Jake" -> "Jake"   "" -> "Member"
// Used so the shared calendar never publishes a full roster or any email.
function maskName(name) {
  const clean = String(name || '').trim().replace(/\s+/g, ' ');
  if (!clean) return 'Member';
  const parts = clean.split(' ');
  if (parts.length === 1) return parts[0];
  return parts[0] + ' ' + parts[parts.length - 1][0].toUpperCase() + '.';
}

function json(statusCode, obj, extraHeaders) {
  return {
    statusCode,
    headers: Object.assign({ 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, extraHeaders || {}),
    body: JSON.stringify(obj),
  };
}

// Reads the session cookie and confirms the membership is still active.
// Returns { email } or null.
async function requireActiveSession(event) {
  const cookies = parseCookies(event.headers.cookie || event.headers.Cookie);
  const data = verify(cookies.al308_session, ENV.sessionSecret());
  if (!data || data.purpose !== 'session') return null;
  const active = await isMember(data.email);
  if (!active) return null;
  return { email: data.email };
}

module.exports = {
  ENV,
  CAL_VERSION_READ,
  CAL_VERSION_WRITE,
  sign,
  verify,
  safeEqual,
  parseCookies,
  onAllowlist,
  stripeActiveSubscription,
  isMember,
  calFetch,
  maskName,
  json,
  requireActiveSession,
};
