// Offline smoke test. No network, no Netlify, no Blobs.
// Run: node test/smoke.js
//
// Every outside call (Stripe, Cal.com, Resend) is stubbed, and the blob store
// runs in memory, so this tells you the logic is right before a deploy ever
// happens. It cannot tell you a live API key works. That is what
// /.netlify/functions/diag is for.

process.env.SESSION_SECRET = 'test-secret-value';
process.env.STRIPE_RESTRICTED_KEY = 'rk_test_fake';
process.env.CALCOM_API_KEY = 'cal_test_fake';
process.env.CALCOM_WEBHOOK_SECRET = 'webhook-secret';
process.env.RESEND_API_KEY = 're_fake';
process.env.RESEND_FROM = 'Augusta Local 308 <noreply@augustalocal308.com>';
process.env.MEMBER_ALLOWLIST = 'bonham.jd@gmail.com, comp@example.com';
process.env.ADMIN_EMAILS = 'bonham.jd@gmail.com';
process.env.URL = 'https://augustalocal308.com';
process.env.AL308_MEMORY_STORE = '1';

const crypto = require('crypto');
const assert = require('assert');

// --- fetch stub -------------------------------------------------------------
const calls = [];
const MEMBERS = new Map([
  ['paid@example.com', { id: 'cus_paid', name: 'Jake Miller' }],
  ['dale@example.com', { id: 'cus_dale', name: 'Dale Warner' }],
]);

const DAY = 24 * 60 * 60 * 1000;
const iso = (msFromNow) => new Date(Date.now() + msFromNow).toISOString();
const unix = (msFromNow) => Math.floor((Date.now() + msFromNow) / 1000);
const slotDay = (msFromNow) => new Date(Date.now() + msFromNow).toLocaleDateString('en-CA');

let bookingsStore = [];
function resetBookings() {
  bookingsStore = [
    { id: 1, uid: 'bk_future_jake', status: 'accepted', start: iso(3 * DAY), end: iso(3 * DAY + 3600000), duration: 60,
      attendees: [{ name: 'Jake Miller', email: 'paid@example.com' }] },
    { id: 2, uid: 'bk_future_dale', status: 'accepted', start: iso(4 * DAY), end: iso(4 * DAY + 3600000), duration: 60,
      attendees: [{ name: 'Dale Warner', email: 'dale@example.com' }] },
    { id: 3, uid: 'bk_cancelled', status: 'cancelled', start: iso(5 * DAY), end: iso(5 * DAY + 3600000), duration: 60,
      attendees: [{ name: 'Nope Person', email: 'x@example.com' }] },
    { id: 4, uid: 'bk_past_jake', status: 'accepted', start: iso(-10 * DAY), end: iso(-10 * DAY + 7200000), duration: 120,
      attendees: [{ name: 'Jake Miller', email: 'paid@example.com' }] },
  ];
}
resetBookings();

let lastBookingPayload = null;
let lastSlotsUrl = null;

global.fetch = async (url, opts = {}) => {
  const method = opts.method || 'GET';
  calls.push({ url, method });
  const res = (status, obj) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => obj,
    text: async () => JSON.stringify(obj),
  });

  // ---- Stripe --------------------------------------------------------------
  if (url.startsWith('https://api.stripe.com/v1/customers')) {
    const email = decodeURIComponent((url.match(/email=([^&]+)/) || [])[1] || '');
    const cust = MEMBERS.get(email);
    return res(200, { data: cust ? [cust] : [], has_more: false });
  }
  if (url.startsWith('https://api.stripe.com/v1/subscriptions')) {
    const custMatch = url.match(/customer=([^&]+)/);
    const makeSub = (custId, email, name, amount, interval) => ({
      id: 'sub_' + custId,
      status: 'active',
      start_date: unix(-200 * DAY),
      current_period_end: unix(20 * DAY),
      cancel_at_period_end: false,
      customer: { id: custId, email: email, name: name },
      items: { data: [{ price: { unit_amount: amount, recurring: { interval: interval } } }] },
    });
    if (custMatch) {
      // Per-customer lookup used by memberInfo.
      return res(200, { data: [{ id: 'sub_1', status: 'active' }], has_more: false });
    }
    // Full list used by the dashboard, with the customer expanded.
    return res(200, {
      has_more: false,
      data: [
        makeSub('cus_paid', 'paid@example.com', 'Jake Miller', 55000, 'year'),
        makeSub('cus_dale', 'dale@example.com', 'Dale Warner', 5000, 'month'),
      ],
    });
  }
  if (url.startsWith('https://api.stripe.com/v1/charges')) {
    return res(200, {
      has_more: false,
      data: [
        { id: 'ch_1', paid: true, status: 'succeeded', amount: 55000, amount_refunded: 0, created: unix(-5 * DAY), invoice: 'in_1' },
        { id: 'ch_2', paid: true, status: 'succeeded', amount: 4500, amount_refunded: 0, created: unix(-6 * DAY), invoice: null },
        { id: 'ch_3', paid: true, status: 'succeeded', amount: 5000, amount_refunded: 5000, created: unix(-7 * DAY), invoice: 'in_2' },
      ],
    });
  }

  // ---- Cal.com -------------------------------------------------------------
  if (url.includes('api.cal.com/v2/slots')) {
    lastSlotsUrl = url;
    return res(200, {
      status: 'success',
      data: {
        [slotDay(2 * DAY)]: [
          { start: iso(2 * DAY), end: iso(2 * DAY + 3600000) },
          { start: iso(2 * DAY + 3600000), end: iso(2 * DAY + 7200000) },
        ],
        [slotDay(3 * DAY)]: [{ start: iso(3 * DAY) }],
      },
    });
  }
  if (url.includes('api.cal.com/v2/bookings') && method === 'POST') {
    if (/\/(confirm|decline|cancel)$/.test(url)) {
      const uid = (url.match(/bookings\/([^/]+)\//) || [])[1];
      const b = bookingsStore.find((x) => x.uid === uid);
      if (b && url.endsWith('/cancel')) b.status = 'cancelled';
      if (b && url.endsWith('/confirm')) b.status = 'accepted';
      return res(200, { status: 'success', data: { uid: uid } });
    }
    lastBookingPayload = JSON.parse(opts.body || '{}');
    const start = lastBookingPayload.start;
    const created = {
      id: 99, uid: 'bk_new_' + Math.random().toString(36).slice(2, 8), status: 'pending',
      start: start, end: new Date(new Date(start).getTime() + 3600000).toISOString(), duration: 60,
      attendees: [{ name: lastBookingPayload.attendee.name, email: lastBookingPayload.attendee.email }],
    };
    bookingsStore.push(created);
    return res(201, { status: 'success', data: created });
  }
  if (url.includes('api.cal.com/v2/bookings')) {
    const emailMatch = url.match(/attendeeEmail=([^&]+)/);
    let rows = bookingsStore;
    if (emailMatch) {
      const want = decodeURIComponent(emailMatch[1]).toLowerCase();
      rows = rows.filter((b) => (b.attendees[0].email || '').toLowerCase() === want);
    }
    return res(200, { status: 'success', data: rows, pagination: { hasMore: false, nextCursor: null } });
  }

  // ---- Resend --------------------------------------------------------------
  if (url.startsWith('https://api.resend.com/emails')) return res(200, { id: 'email_1' });

  return res(404, { error: 'unstubbed ' + url });
};

// --- helpers ----------------------------------------------------------------
const shared = require('../netlify/functions/_shared');
let passed = 0;
let failed = 0;

async function check(label, fn) {
  try {
    await fn();
    passed++;
    console.log('  ok   ' + label);
  } catch (e) {
    failed++;
    console.log('  FAIL ' + label + ' :: ' + e.message);
    process.exitCode = 1;
  }
}

function sessionEvent(email, extra) {
  const t = shared.sign(
    { email, purpose: 'session', exp: Date.now() + 60000 },
    process.env.SESSION_SECRET
  );
  return Object.assign({ httpMethod: 'POST', headers: { cookie: 'al308_session=' + t } }, extra || {});
}
function body(obj) {
  return { body: JSON.stringify(obj) };
}
function parse(r) {
  return JSON.parse(r.body);
}

const login = require('../netlify/functions/login');
const setPassword = require('../netlify/functions/set-password');
const profile = require('../netlify/functions/profile');
const me = require('../netlify/functions/me');
const slots = require('../netlify/functions/slots');
const book = require('../netlify/functions/book');
const cancel = require('../netlify/functions/cancel');
const admin = require('../netlify/functions/admin');
const schedule = require('../netlify/functions/schedule');
const webhook = require('../netlify/functions/cal-webhook');
const reqLogin = require('../netlify/functions/request-login');
const diag = require('../netlify/functions/diag');
const verifyLogin = require('../netlify/functions/verify-login');

(async () => {
  console.log('\nmaskName');
  await check('full name reduces to initial', () => assert.strictEqual(shared.maskName('Jake Miller'), 'Jake M.'));
  await check('single name passes through', () => assert.strictEqual(shared.maskName('Dale'), 'Dale'));
  await check('three names use the last', () => assert.strictEqual(shared.maskName('Mary Jo Smith'), 'Mary S.'));
  await check('empty becomes Member', () => assert.strictEqual(shared.maskName('  '), 'Member'));

  console.log('\ntokens');
  await check('sign/verify roundtrip', () => {
    const t = shared.sign({ email: 'a@b.com', purpose: 'session', exp: Date.now() + 1000 }, 's');
    assert.strictEqual(shared.verify(t, 's').email, 'a@b.com');
  });
  await check('wrong secret rejected', () => {
    const t = shared.sign({ email: 'a@b.com', purpose: 'session', exp: Date.now() + 1000 }, 's');
    assert.strictEqual(shared.verify(t, 'other'), null);
  });
  await check('expired token rejected', () => {
    const t = shared.sign({ email: 'a@b.com', purpose: 'session', exp: Date.now() - 1 }, 's');
    assert.strictEqual(shared.verify(t, 's'), null);
  });
  await check('tampered payload rejected', () => {
    const t = shared.sign({ email: 'a@b.com', purpose: 'session', exp: Date.now() + 1000 }, 's');
    assert.strictEqual(shared.verify('x' + t.slice(1), 's'), null);
  });

  console.log('\npasswords');
  await check('right password verifies', () => {
    const h = shared.hashPassword('correct horse');
    assert.strictEqual(shared.verifyPassword('correct horse', h), true);
  });
  await check('wrong password fails', () => {
    const h = shared.hashPassword('correct horse');
    assert.strictEqual(shared.verifyPassword('Correct Horse', h), false);
  });
  await check('two hashes of the same password differ (salted)', () => {
    assert.notStrictEqual(shared.hashPassword('same'), shared.hashPassword('same'));
  });
  await check('garbage hash does not throw', () => {
    assert.strictEqual(shared.verifyPassword('x', 'not-a-hash'), false);
    assert.strictEqual(shared.verifyPassword('x', null), false);
  });

  console.log('\nmembership');
  await check('allowlist email is a member with no Stripe sub', async () =>
    assert.strictEqual(await shared.isMember('bonham.jd@gmail.com'), true));
  await check('paying Stripe customer is a member', async () =>
    assert.strictEqual(await shared.isMember('paid@example.com'), true));
  await check('stranger is not a member', async () =>
    assert.strictEqual(await shared.isMember('stranger@example.com'), false));
  await check('member name comes off the Stripe customer', async () => {
    const info = await shared.memberInfo('paid@example.com');
    assert.strictEqual(info.name, 'Jake Miller');
  });
  await check('no name falls back to the email', () =>
    assert.strictEqual(shared.nameFromEmail('jake.miller99@gmail.com'), 'Jake Miller'));

  console.log('\nset-password and login');
  await check('short password rejected', async () => {
    const r = await setPassword.handler(sessionEvent('paid@example.com', body({ password: 'short' })));
    assert.strictEqual(r.statusCode, 400);
  });
  await check('no session and no token rejected', async () => {
    const r = await setPassword.handler({ httpMethod: 'POST', headers: {}, body: JSON.stringify({ password: 'longenough1' }) });
    assert.strictEqual(r.statusCode, 401);
  });
  await check('magic-link token can set a password', async () => {
    const t = shared.sign({ email: 'paid@example.com', purpose: 'login', exp: Date.now() + 60000 }, process.env.SESSION_SECRET);
    const r = await setPassword.handler({ httpMethod: 'POST', headers: {}, body: JSON.stringify({ password: 'bogeyfree2026', token: t }) });
    assert.strictEqual(r.statusCode, 200);
    assert.ok(String(r.headers['Set-Cookie']).indexOf('al308_session=') === 0, 'no session cookie issued');
  });
  await check('right password logs in and sets a cookie', async () => {
    const r = await login.handler({ httpMethod: 'POST', headers: {}, body: JSON.stringify({ email: 'paid@example.com', password: 'bogeyfree2026' }) });
    assert.strictEqual(r.statusCode, 200);
    assert.ok(String(r.headers['Set-Cookie']).indexOf('HttpOnly') !== -1, 'cookie is not HttpOnly');
    assert.ok(String(r.headers['Set-Cookie']).indexOf('Secure') !== -1, 'cookie is not Secure');
  });
  await check('wrong password is refused', async () => {
    const r = await login.handler({ httpMethod: 'POST', headers: {}, body: JSON.stringify({ email: 'paid@example.com', password: 'nope' }) });
    assert.strictEqual(r.statusCode, 401);
  });
  await check('failure message does not reveal membership', async () => {
    const a = await login.handler({ httpMethod: 'POST', headers: {}, body: JSON.stringify({ email: 'paid@example.com', password: 'nope' }) });
    const b = await login.handler({ httpMethod: 'POST', headers: {}, body: JSON.stringify({ email: 'stranger@example.com', password: 'nope' }) });
    assert.strictEqual(parse(a).message, parse(b).message);
  });
  await check('five wrong tries locks the account out', async () => {
    for (let i = 0; i < 5; i++) {
      await login.handler({ httpMethod: 'POST', headers: {}, body: JSON.stringify({ email: 'dale@example.com', password: 'wrong' }) });
    }
    const r = await login.handler({ httpMethod: 'POST', headers: {}, body: JSON.stringify({ email: 'dale@example.com', password: 'wrong' }) });
    assert.strictEqual(r.statusCode, 429);
  });
  await check('a lapsed member cannot set a password', async () => {
    const t = shared.sign({ email: 'stranger@example.com', purpose: 'login', exp: Date.now() + 60000 }, process.env.SESSION_SECRET);
    const r = await setPassword.handler({ httpMethod: 'POST', headers: {}, body: JSON.stringify({ password: 'longenough1', token: t }) });
    assert.strictEqual(r.statusCode, 403);
  });

  console.log('\nverify-login');
  await check('good link sets a session and asks for a password', async () => {
    const t = shared.sign({ email: 'dale@example.com', purpose: 'login', exp: Date.now() + 60000 }, process.env.SESSION_SECRET);
    const r = await verifyLogin.handler({ queryStringParameters: { token: t } });
    assert.strictEqual(r.statusCode, 302);
    assert.ok(r.headers.Location.indexOf('setpw=1') !== -1, 'did not send a passwordless member to set one');
  });
  await check('member with a password skips the prompt', async () => {
    const t = shared.sign({ email: 'paid@example.com', purpose: 'login', exp: Date.now() + 60000 }, process.env.SESSION_SECRET);
    const r = await verifyLogin.handler({ queryStringParameters: { token: t } });
    assert.ok(r.headers.Location.indexOf('setpw=1') === -1);
  });
  await check('bad link goes back to the form', async () => {
    const r = await verifyLogin.handler({ queryStringParameters: { token: 'garbage' } });
    assert.ok(r.headers.Location.indexOf('login=expired') !== -1);
  });

  console.log('\nme');
  await check('no cookie means 401', async () => {
    const r = await me.handler({ headers: {} });
    assert.strictEqual(r.statusCode, 401);
  });
  await check('lapsed member gets 403', async () => {
    const r = await me.handler(sessionEvent('stranger@example.com'));
    assert.strictEqual(r.statusCode, 403);
  });
  await check('member gets their name, password flag and bookings', async () => {
    const r = await me.handler(sessionEvent('paid@example.com'));
    const d = parse(r);
    assert.strictEqual(d.name, 'Jake Miller');
    assert.strictEqual(d.hasPassword, true);
    assert.ok(d.upcoming.length >= 1, 'no upcoming bookings');
    assert.ok(d.upcoming[0].uid, 'booking has no uid to cancel with');
  });
  await check('non-admin is not flagged as admin', async () => {
    const r = await me.handler(sessionEvent('paid@example.com'));
    assert.strictEqual(parse(r).admin, false);
  });
  await check('JD is flagged as admin', async () => {
    const r = await me.handler(sessionEvent('bonham.jd@gmail.com'));
    assert.strictEqual(parse(r).admin, true);
  });

  console.log('\nprofile');
  await check('member can set the name shown on the calendar', async () => {
    const r = await profile.handler(sessionEvent('paid@example.com', body({ name: 'Jacob Miller' })));
    assert.strictEqual(r.statusCode, 200);
    assert.strictEqual(parse(r).name, 'Jacob Miller');
  });
  await check('stranger cannot', async () => {
    const r = await profile.handler(sessionEvent('stranger@example.com', body({ name: 'Hacker' })));
    assert.strictEqual(r.statusCode, 401);
  });

  console.log('\nslots');
  await check('no session means no availability', async () => {
    const r = await slots.handler({ headers: {}, queryStringParameters: {} });
    assert.strictEqual(r.statusCode, 401);
  });
  await check('member sees open times grouped by day', async () => {
    const r = await slots.handler(sessionEvent('paid@example.com', { queryStringParameters: {} }));
    assert.strictEqual(r.statusCode, 200);
    const d = parse(r);
    const days = Object.keys(d.slots);
    assert.ok(days.length >= 1, 'no days returned');
    assert.ok(d.slots[days[0]][0].start, 'slot has no start');
  });
  await check('asking for a longer block passes duration to Cal.com', async () => {
    lastSlotsUrl = null;
    await slots.handler(sessionEvent('paid@example.com', { queryStringParameters: { duration: '180' } }));
    assert.ok(/[?&]duration=180(&|$)/.test(lastSlotsUrl), 'duration was not forwarded: ' + lastSlotsUrl);
  });
  await check('no format parameter is sent (it broke the live call)', async () => {
    lastSlotsUrl = null;
    await slots.handler(sessionEvent('paid@example.com', { queryStringParameters: {} }));
    assert.ok(!/format=/i.test(lastSlotsUrl), 'a format param came back: ' + lastSlotsUrl);
  });

  console.log('\nbook');
  await check('no session cannot book', async () => {
    const r = await book.handler({ httpMethod: 'POST', headers: {}, body: JSON.stringify({ start: iso(2 * DAY) }) });
    assert.strictEqual(r.statusCode, 401);
  });
  await check('a time in the past is refused', async () => {
    const r = await book.handler(sessionEvent('paid@example.com', body({ start: iso(-2 * DAY) })));
    assert.strictEqual(r.statusCode, 400);
  });
  await check('member books with no name or address typed in', async () => {
    lastBookingPayload = null;
    const r = await book.handler(sessionEvent('paid@example.com', body({ start: iso(6 * DAY), timeZone: 'America/Chicago' })));
    assert.strictEqual(r.statusCode, 200);
    assert.ok(lastBookingPayload, 'Cal.com was never called');
    assert.strictEqual(lastBookingPayload.attendee.email, 'paid@example.com');
    assert.strictEqual(lastBookingPayload.attendee.name, 'Jacob Miller');
    assert.strictEqual(Object.keys(lastBookingPayload).indexOf('address'), -1);
  });
  await check('booking comes back confirmed, not pending', async () => {
    const r = await book.handler(sessionEvent('paid@example.com', body({ start: iso(7 * DAY) })));
    assert.strictEqual(parse(r).booking.status, 'accepted');
  });
  await check('a two hour booking sends lengthInMinutes, not duration', async () => {
    lastBookingPayload = null;
    await book.handler(sessionEvent('paid@example.com', body({ start: iso(8 * DAY), duration: 120 })));
    assert.strictEqual(lastBookingPayload.lengthInMinutes, 120);
    assert.strictEqual(lastBookingPayload.duration, undefined, 'sent the slots-endpoint spelling');
  });
  await check('no length asked for means the event type default', async () => {
    lastBookingPayload = null;
    await book.handler(sessionEvent('paid@example.com', body({ start: iso(9 * DAY) })));
    assert.strictEqual(lastBookingPayload.lengthInMinutes, undefined);
  });
  await check('a nonsense length is dropped rather than sent', async () => {
    lastBookingPayload = null;
    await book.handler(sessionEvent('paid@example.com', body({ start: iso(10 * DAY), duration: 5 })));
    assert.strictEqual(lastBookingPayload.lengthInMinutes, undefined);
    lastBookingPayload = null;
    await book.handler(sessionEvent('paid@example.com', body({ start: iso(11 * DAY), duration: 9999 })));
    assert.strictEqual(lastBookingPayload.lengthInMinutes, undefined);
  });

  console.log('\ncancel');
  await check('cannot cancel someone else booking', async () => {
    const r = await cancel.handler(sessionEvent('paid@example.com', body({ uid: 'bk_future_dale' })));
    assert.strictEqual(r.statusCode, 403);
  });
  await check('member cancels their own', async () => {
    const r = await cancel.handler(sessionEvent('paid@example.com', body({ uid: 'bk_future_jake' })));
    assert.strictEqual(r.statusCode, 200);
    assert.strictEqual(bookingsStore.find((b) => b.uid === 'bk_future_jake').status, 'cancelled');
  });

  console.log('\nschedule');
  resetBookings();
  await check('no cookie means 401', async () => {
    const r = await schedule.handler({ headers: {} });
    assert.strictEqual(r.statusCode, 401);
  });
  await check('lapsed member gets 401, not data', async () => {
    const r = await schedule.handler(sessionEvent('stranger@example.com'));
    assert.strictEqual(r.statusCode, 401);
  });
  await check('member sees masked names, no emails, no cancelled', async () => {
    const r = await schedule.handler(sessionEvent('paid@example.com'));
    assert.strictEqual(r.statusCode, 200);
    const d = parse(r);
    assert.ok(!d.bookings.some((b) => b.who === 'Nope Person'), 'cancelled booking leaked');
    assert.ok(d.bookings.some((b) => b.who === 'Jake M.' && b.mine === true), 'own booking not marked');
    assert.ok(r.body.indexOf('@') === -1, 'an email address leaked into the response');
  });

  console.log('\nadmin dashboard');
  await check('a member who is not an admin gets 404', async () => {
    const r = await admin.handler(sessionEvent('paid@example.com', { queryStringParameters: {} }));
    assert.strictEqual(r.statusCode, 404);
  });
  await check('a stranger gets 404', async () => {
    const r = await admin.handler({ headers: {}, queryStringParameters: {} });
    assert.strictEqual(r.statusCode, 404);
  });
  await check('JD gets the numbers', async () => {
    const r = await admin.handler(sessionEvent('bonham.jd@gmail.com', { queryStringParameters: { months: '12' } }));
    assert.strictEqual(r.statusCode, 200);
    const d = parse(r);
    assert.strictEqual(d.summary.paying, 2, 'wrong paying count');
    assert.ok(d.summary.comped >= 1, 'comps not counted');
    // Single yearly 550 -> 4583/mo, plus Single monthly 5000 -> 9583 cents.
    assert.strictEqual(d.summary.mrr, 4583 + 5000);
    assert.strictEqual(d.revenue.length, 12);
    assert.strictEqual(d.usage.length, 12);
  });
  await check('refunded charges do not count as revenue', async () => {
    const r = await admin.handler(sessionEvent('bonham.jd@gmail.com', { queryStringParameters: { months: '3' } }));
    const d = parse(r);
    const total = d.revenue.reduce((s, m) => s + m.total, 0);
    assert.strictEqual(total, 55000 + 4500);
  });
  await check('membership and swag are split apart', async () => {
    const r = await admin.handler(sessionEvent('bonham.jd@gmail.com', { queryStringParameters: { months: '3' } }));
    const d = parse(r);
    assert.strictEqual(d.revenue.reduce((s, m) => s + m.membership, 0), 55000);
    assert.strictEqual(d.revenue.reduce((s, m) => s + m.other, 0), 4500);
  });
  await check('future bookings are not counted as hours played', async () => {
    const r = await admin.handler(sessionEvent('bonham.jd@gmail.com', { queryStringParameters: { months: '12' } }));
    const d = parse(r);
    const hours = d.usage.reduce((s, m) => s + m.hours, 0);
    assert.strictEqual(hours, 2, 'only the single past two hour booking should count');
  });

  console.log('\ncal-webhook');
  function signed(payload) {
    const raw = JSON.stringify(payload);
    const sig = crypto.createHmac('sha256', 'webhook-secret').update(raw).digest('hex');
    return { httpMethod: 'POST', body: raw, headers: { 'x-cal-signature-256': 'sha256=' + sig } };
  }
  const requested = (email) => ({
    triggerEvent: 'BOOKING_REQUESTED',
    payload: { uid: 'bk_1', attendees: [{ name: 'Someone', email }] },
  });

  await check('unsigned request rejected 401', async () => {
    const r = await webhook.handler({ httpMethod: 'POST', body: '{}', headers: {} });
    assert.strictEqual(r.statusCode, 401);
  });
  await check('tampered body rejected 401', async () => {
    const ev = signed(requested('paid@example.com'));
    ev.body = ev.body.replace('paid@', 'hacker@');
    const r = await webhook.handler(ev);
    assert.strictEqual(r.statusCode, 401);
  });
  await check('member booking is confirmed', async () => {
    const r = await webhook.handler(signed(requested('paid@example.com')));
    assert.strictEqual(parse(r).action, 'confirm');
  });
  await check('allowlisted booking is confirmed', async () => {
    const r = await webhook.handler(signed(requested('comp@example.com')));
    assert.strictEqual(parse(r).action, 'confirm');
  });
  await check('non-member booking is declined', async () => {
    const r = await webhook.handler(signed(requested('stranger@example.com')));
    assert.strictEqual(parse(r).action, 'decline');
  });
  await check('other triggers ignored', async () => {
    const r = await webhook.handler(signed({ triggerEvent: 'MEETING_ENDED', payload: {} }));
    assert.ok(parse(r).ignored);
  });

  console.log('\nrequest-login');
  await check('missing config returns 503, not a false promise', async () => {
    const saved = process.env.RESEND_API_KEY;
    delete process.env.RESEND_API_KEY;
    const r = await reqLogin.handler({ httpMethod: 'POST', body: JSON.stringify({ email: 'paid@example.com' }) });
    process.env.RESEND_API_KEY = saved;
    assert.strictEqual(r.statusCode, 503);
  });
  await check('non-member gets the generic message', async () => {
    const r = await reqLogin.handler({ httpMethod: 'POST', body: JSON.stringify({ email: 'stranger@example.com' }) });
    assert.strictEqual(r.statusCode, 200);
    assert.ok(parse(r).message.indexOf('on its way') !== -1);
  });
  await check('member triggers a Resend send', async () => {
    calls.length = 0;
    const r = await reqLogin.handler({ httpMethod: 'POST', body: JSON.stringify({ email: 'paid@example.com' }) });
    assert.strictEqual(r.statusCode, 200);
    assert.ok(calls.some((c) => c.url.indexOf('api.resend.com/emails') !== -1), 'no email was sent');
  });
  await check('bad email returns 400', async () => {
    const r = await reqLogin.handler({ httpMethod: 'POST', body: JSON.stringify({ email: 'nope' }) });
    assert.strictEqual(r.statusCode, 400);
  });

  console.log('\ndiag');
  await check('wrong key returns 404', async () => {
    const r = await diag.handler({ queryStringParameters: { key: 'wrong' } });
    assert.strictEqual(r.statusCode, 404);
  });
  await check('no key returns 404', async () => {
    const r = await diag.handler({ queryStringParameters: {} });
    assert.strictEqual(r.statusCode, 404);
  });

  console.log('\n' + passed + ' checks passed' + (failed ? ', ' + failed + ' FAILED' : '') + '\n');
})();
