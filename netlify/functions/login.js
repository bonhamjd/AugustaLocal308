// Email plus password. The normal way in.
//
// A member who has never set a password uses "Email me a link" instead, which
// is request-login. That path ends at set-password.

const { ENV, memberInfo, verifyPassword, sessionCookie, json } = require('./_shared');
const store = require('./_store');

const DOWN = {
  ok: false,
  message: 'Login is down right now. Text JD at 402-215-7000 and he will get you in.',
};

// Same wording whether the email is unknown, the password is wrong, or the
// membership lapsed. The form cannot be used to find out who is a member.
const NOPE = {
  ok: false,
  message: 'That email and password do not match. If you have not set a password yet, use "Email me a link".',
};

const MAX_FAILS = 5;
const LOCKOUT_MS = 15 * 60 * 1000;

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'method_not_allowed' });

  if (!ENV.sessionSecret() || !ENV.stripeKey()) {
    console.error('[login] missing SESSION_SECRET or STRIPE_RESTRICTED_KEY');
    return json(503, DOWN);
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (e) {
    return json(400, { ok: false, message: 'Enter your email and password.' });
  }

  const email = String(body.email || '').trim().toLowerCase();
  const password = String(body.password || '');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !password) {
    return json(400, { ok: false, message: 'Enter your email and password.' });
  }

  const tKey = store.throttleKey(email);

  let throttle;
  try {
    throttle = (await store.getJSON(event, tKey)) || { fails: 0, until: 0 };
  } catch (e) {
    console.error('[login] store unavailable:', e.message);
    return json(503, DOWN);
  }

  if (throttle.until && throttle.until > Date.now()) {
    return json(429, {
      ok: false,
      message: 'Too many tries. Wait fifteen minutes, or use "Email me a link" below.',
    });
  }

  let info;
  try {
    info = await memberInfo(email);
  } catch (e) {
    console.error('[login] membership check threw:', e.message);
    return json(503, DOWN);
  }

  let record = null;
  try {
    record = await store.getAuth(event, email);
  } catch (e) {
    console.error('[login] auth read failed:', e.message);
    return json(503, DOWN);
  }

  const ok = info.active && record && record.hash && verifyPassword(password, record.hash);

  if (!ok) {
    const fails = (throttle.fails || 0) + 1;
    try {
      await store.setJSON(event, tKey, {
        fails: fails,
        until: fails >= MAX_FAILS ? Date.now() + LOCKOUT_MS : 0,
      });
    } catch (e) {
      /* throttling is best effort, never block on it */
    }
    return json(401, NOPE);
  }

  try {
    await store.del(event, tKey);
  } catch (e) {
    /* best effort */
  }

  return json(200, { ok: true, email: info.email }, { 'Set-Cookie': sessionCookie(info.email) });
};
