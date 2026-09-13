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
  // Who can open /admin. Falls back to the allowlist so the site is never
  // locked out of its own numbers, but set this explicitly.
  admins: () => process.env.ADMIN_EMAILS || process.env.MEMBER_ALLOWLIST || '',
  calUsername: () => process.env.CALCOM_USERNAME || 'al308',
  calEventSlug: () => process.env.CALCOM_EVENT_SLUG || 'bookbay',
  calEventTypeId: () => process.env.CALCOM_EVENT_TYPE_ID || '',
  clubTimeZone: () => process.env.CLUB_TIMEZONE || 'America/Chicago',
};

// Cal.com pins a different API version per endpoint family.
const CAL_API = 'https://api.cal.com/v2';
const CAL_VERSION_READ = '2026-05-01';   // GET /bookings
const CAL_VERSION_WRITE = '2026-02-25';  // POST /bookings, /confirm, /decline, /cancel
const CAL_VERSION_SLOTS = '2024-09-04';  // GET /slots

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

const SESSION_DAYS = 30;

function sessionCookie(email) {
  const token = sign(
    { email: email, purpose: 'session', exp: Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000 },
    ENV.sessionSecret()
  );
  return (
    'al308_session=' + token +
    '; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=' + SESSION_DAYS * 24 * 60 * 60
  );
}

// ---------------------------------------------------------------------------
// Passwords: scrypt, salted per member, constant-time compare.
// Format: scrypt$N$r$p$salt_b64$key_b64
// ---------------------------------------------------------------------------
const SCRYPT = { N: 16384, r: 8, p: 1, len: 64, maxmem: 64 * 1024 * 1024 };

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(String(password), salt, SCRYPT.len, {
    N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: SCRYPT.maxmem,
  });
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), key.toString('base64')].join('$');
}

function verifyPassword(password, stored) {
  try {
    const parts = String(stored || '').split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
    const salt = Buffer.from(parts[4], 'base64');
    const expected = Buffer.from(parts[5], 'base64');
    if (!expected.length) return false;
    const key = crypto.scryptSync(String(password), salt, expected.length, {
      N: Number(parts[1]), r: Number(parts[2]), p: Number(parts[3]), maxmem: SCRYPT.maxmem,
    });
    return crypto.timingSafeEqual(key, expected);
  } catch (e) {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Query strings. Stripe uses bracket keys like created[gte], so this encodes
// keys as well as values rather than leaning on URLSearchParams.
// ---------------------------------------------------------------------------
function qs(obj) {
  const parts = [];
  Object.keys(obj || {}).forEach(function (k) {
    const v = obj[k];
    if (v === undefined || v === null || v === '') return;
    if (Array.isArray(v)) v.forEach((x) => parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(x)));
    else parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(v));
  });
  return parts.length ? '?' + parts.join('&') : '';
}

// ---------------------------------------------------------------------------
// Stripe. Read only. The restricted key cannot move money.
// ---------------------------------------------------------------------------
async function stripeGet(path) {
  const key = ENV.stripeKey();
  if (!key) throw new Error('STRIPE_RESTRICTED_KEY is not set');
  const res = await fetch('https://api.stripe.com/v1' + path, {
    headers: { Authorization: 'Bearer ' + key },
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch (e) {
    /* non-JSON error body */
  }
  if (!res.ok) {
    const msg = (json && json.error && json.error.message) || text.slice(0, 200);
    const err = new Error('Stripe ' + res.status + ': ' + msg);
    err.status = res.status;
    err.stripeCode = json && json.error && json.error.code;
    throw err;
  }
  return json;
}

// Walks every page. Capped so a bad filter can never spin forever.
async function stripeList(resource, params, maxPages) {
  const out = [];
  let startingAfter = null;
  const cap = maxPages || 20;
  for (let page = 0; page < cap; page++) {
    const data = await stripeGet(
      resource + qs(Object.assign({ limit: 100, starting_after: startingAfter }, params))
    );
    const rows = (data && data.data) || [];
    out.push.apply(out, rows);
    if (!data.has_more || !rows.length) break;
    startingAfter = rows[rows.length - 1].id;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Membership
// ---------------------------------------------------------------------------

// Comps, the owner, and anyone who pays outside Stripe. Set MEMBER_ALLOWLIST to
// a comma-separated list of emails. Without this JD cannot book his own bay,
// because he has no Stripe subscription.
function emailList(raw) {
  return String(raw || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

function onAllowlist(email) {
  return emailList(ENV.allowlist()).includes(String(email).trim().toLowerCase());
}

function isAdmin(email) {
  return emailList(ENV.admins()).includes(String(email).trim().toLowerCase());
}

const ACTIVE_STATUSES = ['active', 'trialing'];

// The published rates, so "Family, yearly" shows instead of a bare "$850".
// Used by the members page and the dashboard alike.
const KNOWN_PLANS = {
  '85000:year': 'Family, yearly',
  '55000:year': 'Single, yearly',
  '7500:month': 'Family, monthly',
  '5000:month': 'Single, monthly',
};

function planLabel(sub) {
  const item = (sub && sub.items && sub.items.data && sub.items.data[0]) || {};
  const price = item.price || {};
  const amount = price.unit_amount || 0;
  const interval = (price.recurring && price.recurring.interval) || '';
  const known = KNOWN_PLANS[amount + ':' + interval];
  const label = known
    ? known
    : amount
    ? '$' + (amount / 100).toFixed(2).replace(/\.00$/, '') + '/' + (interval === 'year' ? 'yr' : 'mo')
    : 'Membership';
  return { label: label, amount: amount, interval: interval };
}

function periodEnd(sub) {
  const end =
    (sub && sub.current_period_end) ||
    (sub && sub.items && sub.items.data && sub.items.data[0] && sub.items.data[0].current_period_end);
  return end ? new Date(end * 1000).toISOString() : null;
}

// Everything the site knows about one email: whether they can book, what to
// call them, and which Stripe customer they are.
async function memberInfo(email) {
  const clean = String(email || '').trim().toLowerCase();
  const info = {
    email: clean,
    active: false,
    comp: false,
    name: '',
    customerId: null,
    status: null,
    plan: null,
    amount: 0,
    interval: '',
    renews: null,
    cancelAtPeriodEnd: false,
  };

  if (onAllowlist(clean)) {
    info.active = true;
    info.comp = true;
    info.status = 'comp';
  }

  if (!ENV.stripeKey()) {
    if (info.active) return info;
    throw new Error('STRIPE_RESTRICTED_KEY is not set');
  }

  try {
    const custData = await stripeGet('/customers' + qs({ email: clean, limit: 5 }));
    const customers = (custData && custData.data) || [];
    for (const cust of customers) {
      if (!info.customerId) {
        info.customerId = cust.id;
        if (cust.name) info.name = cust.name;
      }
      const subData = await stripeGet(
        '/subscriptions' + qs({ customer: cust.id, status: 'all', limit: 10 })
      );
      const subs = (subData && subData.data) || [];
      const live = subs.find((s) => ACTIVE_STATUSES.indexOf(s.status) !== -1);
      if (live) {
        const plan = planLabel(live);
        info.active = true;
        info.customerId = cust.id;
        info.status = live.status;
        info.plan = plan.label;
        info.amount = plan.amount;
        info.interval = plan.interval;
        info.renews = periodEnd(live);
        info.cancelAtPeriodEnd = !!live.cancel_at_period_end;
        if (cust.name) info.name = cust.name;
        break;
      }
      if (!info.status && subs.length) info.status = subs[0].status;
    }
  } catch (e) {
    // A comped member must still get in when Stripe is unreachable.
    if (info.active) {
      console.error('[memberInfo] Stripe lookup failed for a comped member:', e.message);
      return info;
    }
    throw e;
  }

  return info;
}

// Back-compat: the single yes/no question most callers ask.
async function isMember(email) {
  const info = await memberInfo(email);
  return info.active;
}

// Kept because older callers and tests import it.
async function stripeActiveSubscription(email) {
  const info = await memberInfo(email);
  return info.active && !info.comp ? true : info.active;
}

// "jake.miller@gmail.com" -> "Jake Miller". Last resort only.
function nameFromEmail(email) {
  const local = String(email || '').split('@')[0] || '';
  return (
    local
      .replace(/[._-]+/g, ' ')
      .replace(/\d+/g, '')
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ') || 'Member'
  );
}

// What goes on the booking and on the shared calendar. Member's own choice
// first, then the name on the Stripe customer, then the email.
function displayName(info, storedName) {
  return String(storedName || (info && info.name) || nameFromEmail(info && info.email)).trim().slice(0, 60);
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

// Which event type to book. An explicit ID wins; otherwise username + slug.
function calEventRef() {
  const id = ENV.calEventTypeId();
  if (id) return { eventTypeId: Number(id) };
  return { eventTypeSlug: ENV.calEventSlug(), username: ENV.calUsername() };
}

// Pages through GET /bookings, which is cursor based.
async function calAllBookings(params, maxPages) {
  const out = [];
  let cursor = null;
  const cap = maxPages || 20;
  for (let page = 0; page < cap; page++) {
    const res = await calFetch('/bookings' + qs(Object.assign({ limit: 100, cursor: cursor }, params)));
    if (!res.ok) {
      const err = new Error('Cal.com bookings ' + res.status + ': ' + res.text.slice(0, 200));
      err.status = res.status;
      throw err;
    }
    const rows = (res.json && res.json.data) || [];
    out.push.apply(out, rows);
    const pg = (res.json && res.json.pagination) || {};
    if (!pg.hasMore || !pg.nextCursor || !rows.length) break;
    cursor = pg.nextCursor;
  }
  return out;
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
    headers: Object.assign(
      { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      extraHeaders || {}
    ),
    body: JSON.stringify(obj),
  };
}

// Reads the session cookie and confirms the membership is still active.
// Returns { email, info } or null.
async function requireActiveSession(event) {
  const headers = (event && event.headers) || {};
  const cookies = parseCookies(headers.cookie || headers.Cookie);
  const data = verify(cookies.al308_session, ENV.sessionSecret());
  if (!data || data.purpose !== 'session') return null;
  const info = await memberInfo(data.email);
  if (!info.active) return null;
  return { email: info.email, info: info };
}

module.exports = {
  ENV,
  CAL_VERSION_READ,
  CAL_VERSION_WRITE,
  CAL_VERSION_SLOTS,
  sign,
  verify,
  safeEqual,
  parseCookies,
  sessionCookie,
  hashPassword,
  verifyPassword,
  qs,
  stripeGet,
  stripeList,
  emailList,
  onAllowlist,
  isAdmin,
  KNOWN_PLANS,
  planLabel,
  periodEnd,
  stripeActiveSubscription,
  memberInfo,
  isMember,
  nameFromEmail,
  displayName,
  calFetch,
  calEventRef,
  calAllBookings,
  maskName,
  json,
  requireActiveSession,
};
