// Offline smoke test. No network, no Netlify. Run: node test/smoke.js
// Stubs fetch so Stripe/Cal.com/Resend are never actually called.

process.env.SESSION_SECRET = 'test-secret-value';
process.env.STRIPE_RESTRICTED_KEY = 'rk_test_fake';
process.env.CALCOM_API_KEY = 'cal_test_fake';
process.env.CALCOM_WEBHOOK_SECRET = 'webhook-secret';
process.env.RESEND_API_KEY = 're_fake';
process.env.RESEND_FROM = 'Augusta Local 308 <noreply@augustalocal308.com>';
process.env.MEMBER_ALLOWLIST = 'bonham.jd@gmail.com, comp@example.com';
process.env.URL = 'https://augustalocal308.com';

const crypto = require('crypto');
const assert = require('assert');

// --- fetch stub -------------------------------------------------------------
const calls = [];
const MEMBERS = new Set(['paid@example.com']);

global.fetch = async (url, opts = {}) => {
  calls.push({ url, method: opts.method || 'GET' });
  const res = (status, obj) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => obj,
    text: async () => JSON.stringify(obj),
  });

  if (url.startsWith('https://api.stripe.com/v1/customers')) {
    const email = decodeURIComponent((url.match(/email=([^&]+)/) || [])[1] || '');
    return res(200, { data: MEMBERS.has(email) ? [{ id: 'cus_1' }] : [] });
  }
  if (url.startsWith('https://api.stripe.com/v1/subscriptions')) {
    return res(200, { data: [{ status: 'active' }] });
  }
  if (url.includes('api.cal.com/v2/bookings') && (opts.method || 'GET') === 'GET') {
    return res(200, {
      data: [
        {
          id: 1, status: 'accepted',
          start: '2026-09-20T15:00:00.000Z', end: '2026-09-20T16:00:00.000Z',
          attendees: [{ name: 'Jake Miller', email: 'paid@example.com' }],
        },
        {
          id: 2, status: 'accepted',
          start: '2026-09-21T01:00:00.000Z', end: '2026-09-21T02:00:00.000Z',
          attendees: [{ name: 'Dale', email: 'dale@example.com' }],
        },
        {
          id: 3, status: 'cancelled',
          start: '2026-09-22T01:00:00.000Z', end: '2026-09-22T02:00:00.000Z',
          attendees: [{ name: 'Nope Person', email: 'x@example.com' }],
        },
      ],
    });
  }
  if (url.includes('/confirm') || url.includes('/decline')) return res(200, { ok: true });
  if (url.startsWith('https://api.resend.com/emails')) return res(200, { id: 'email_1' });
  return res(404, { error: 'unstubbed ' + url });
};

// --- helpers ----------------------------------------------------------------
const shared = require('../netlify/functions/_shared');
let passed = 0;
function check(label, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') return r.then(() => { passed++; console.log('  ok   ' + label); },
      (e) => { console.log('  FAIL ' + label + ' :: ' + e.message); process.exitCode = 1; });
    passed++; console.log('  ok   ' + label);
  } catch (e) {
    console.log('  FAIL ' + label + ' :: ' + e.message);
    process.exitCode = 1;
  }
}

function sessionCookie(email) {
  const t = shared.sign({ email, purpose: 'session', exp: Date.now() + 60000 }, process.env.SESSION_SECRET);
  return { headers: { cookie: 'al308_session=' + t } };
}

(async () => {
  console.log('\nmaskName');
  check('full name reduces to initial', () => assert.strictEqual(shared.maskName('Jake Miller'), 'Jake M.'));
  check('single name passes through', () => assert.strictEqual(shared.maskName('Dale'), 'Dale'));
  check('three names use the last', () => assert.strictEqual(shared.maskName('Mary Jo Smith'), 'Mary S.'));
  check('empty becomes Member', () => assert.strictEqual(shared.maskName('  '), 'Member'));

  console.log('\ntokens');
  check('sign/verify roundtrip', () => {
    const t = shared.sign({ email: 'a@b.com', purpose: 'session', exp: Date.now() + 1000 }, 's');
    assert.strictEqual(shared.verify(t, 's').email, 'a@b.com');
  });
  check('wrong secret rejected', () => {
    const t = shared.sign({ email: 'a@b.com', purpose: 'session', exp: Date.now() + 1000 }, 's');
    assert.strictEqual(shared.verify(t, 'other'), null);
  });
  check('expired token rejected', () => {
    const t = shared.sign({ email: 'a@b.com', purpose: 'session', exp: Date.now() - 1 }, 's');
    assert.strictEqual(shared.verify(t, 's'), null);
  });
  check('tampered payload rejected', () => {
    const t = shared.sign({ email: 'a@b.com', purpose: 'session', exp: Date.now() + 1000 }, 's');
    assert.strictEqual(shared.verify('x' + t.slice(1), 's'), null);
  });

  console.log('\nmembership');
  await check('allowlist email is a member with no Stripe sub', async () =>
    assert.strictEqual(await shared.isMember('bonham.jd@gmail.com'), true));
  await check('paying Stripe customer is a member', async () =>
    assert.strictEqual(await shared.isMember('paid@example.com'), true));
  await check('stranger is not a member', async () =>
    assert.strictEqual(await shared.isMember('stranger@example.com'), false));

  console.log('\ncal-webhook');
  const webhook = require('../netlify/functions/cal-webhook');
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
    assert.strictEqual(JSON.parse(r.body).action, 'confirm');
  });
  await check('allowlisted booking is confirmed', async () => {
    const r = await webhook.handler(signed(requested('comp@example.com')));
    assert.strictEqual(JSON.parse(r.body).action, 'confirm');
  });
  await check('non-member booking is declined', async () => {
    const r = await webhook.handler(signed(requested('stranger@example.com')));
    assert.strictEqual(JSON.parse(r.body).action, 'decline');
  });
  await check('other triggers ignored', async () => {
    const r = await webhook.handler(signed({ triggerEvent: 'MEETING_ENDED', payload: {} }));
    assert.ok(JSON.parse(r.body).ignored);
  });

  console.log('\nschedule');
  const schedule = require('../netlify/functions/schedule');
  await check('no cookie means 401', async () => {
    const r = await schedule.handler({ headers: {} });
    assert.strictEqual(r.statusCode, 401);
  });
  await check('lapsed member gets 401, not data', async () => {
    const r = await schedule.handler(sessionCookie('stranger@example.com'));
    assert.strictEqual(r.statusCode, 401);
  });
  await check('member sees masked names, no emails, no cancelled', async () => {
    const r = await schedule.handler(sessionCookie('paid@example.com'));
    assert.strictEqual(r.statusCode, 200);
    const body = JSON.parse(r.body);
    assert.strictEqual(body.bookings.length, 2, 'cancelled booking leaked');
    assert.strictEqual(body.bookings[0].who, 'Jake M.');
    assert.strictEqual(body.bookings[0].mine, true);
    assert.strictEqual(body.bookings[1].mine, false);
    assert.ok(!r.body.includes('@'), 'an email address leaked into the response');
  });

  console.log('\nrequest-login');
  const reqLogin = require('../netlify/functions/request-login');
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
    assert.ok(JSON.parse(r.body).message.includes('on its way'));
  });
  await check('member triggers a Resend send', async () => {
    calls.length = 0;
    const r = await reqLogin.handler({ httpMethod: 'POST', body: JSON.stringify({ email: 'paid@example.com' }) });
    assert.strictEqual(r.statusCode, 200);
    assert.ok(calls.some((c) => c.url.includes('api.resend.com/emails')), 'no email was sent');
  });
  await check('bad email returns 400', async () => {
    const r = await reqLogin.handler({ httpMethod: 'POST', body: JSON.stringify({ email: 'nope' }) });
    assert.strictEqual(r.statusCode, 400);
  });

  console.log('\ndiag');
  const diag = require('../netlify/functions/diag');
  await check('wrong key returns 404', async () => {
    const r = await diag.handler({ queryStringParameters: { key: 'wrong' } });
    assert.strictEqual(r.statusCode, 404);
  });
  await check('no key returns 404', async () => {
    const r = await diag.handler({ queryStringParameters: {} });
    assert.strictEqual(r.statusCode, 404);
  });

  console.log('\n' + passed + ' checks passed' + (process.exitCode ? ', SOME FAILED' : '') + '\n');
})();
