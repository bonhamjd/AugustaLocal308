// Sets or changes a member's password.
//
// Two ways in, both of which prove the person owns the email:
//   1. A live session cookie (changing a password while logged in).
//   2. A fresh magic-link token (first time, or forgot password).
//
// On success it also issues a session, so the member lands logged in.

const { ENV, verify, parseCookies, memberInfo, hashPassword, sessionCookie, json } = require('./_shared');
const store = require('./_store');

const MIN_LENGTH = 8;

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'method_not_allowed' });
  if (!ENV.sessionSecret()) return json(503, { ok: false, message: 'Login is down right now.' });

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (e) {
    return json(400, { ok: false, message: 'Something went wrong. Try again.' });
  }

  const password = String(body.password || '');
  if (password.length < MIN_LENGTH) {
    return json(400, { ok: false, message: 'Use at least ' + MIN_LENGTH + ' characters.' });
  }

  // Who is asking.
  let email = null;
  const headers = event.headers || {};
  const cookies = parseCookies(headers.cookie || headers.Cookie);
  const session = verify(cookies.al308_session, ENV.sessionSecret());
  if (session && session.purpose === 'session') email = session.email;

  if (!email && body.token) {
    const t = verify(String(body.token), ENV.sessionSecret());
    if (t && t.purpose === 'login') email = t.email;
  }

  if (!email) {
    return json(401, { ok: false, message: 'That link expired. Ask for a new one and try again.' });
  }

  let info;
  try {
    info = await memberInfo(email);
  } catch (e) {
    console.error('[set-password] membership check threw:', e.message);
    return json(503, { ok: false, message: 'Login is down right now. Text JD at 402-215-7000.' });
  }
  if (!info.active) {
    return json(403, { ok: false, message: 'That membership is not active right now.' });
  }

  let record;
  try {
    record = (await store.getAuth(event, info.email)) || {};
  } catch (e) {
    console.error('[set-password] auth read failed:', e.message);
    return json(503, { ok: false, message: 'Could not save that. Try again in a minute.' });
  }

  record.hash = hashPassword(password);
  record.updated = new Date().toISOString();
  const name = String(body.name || '').trim().slice(0, 60);
  if (name) record.name = name;

  try {
    await store.putAuth(event, info.email, record);
    await store.del(event, store.throttleKey(info.email));
  } catch (e) {
    console.error('[set-password] auth write failed:', e.message);
    return json(503, { ok: false, message: 'Could not save that. Try again in a minute.' });
  }

  return json(
    200,
    { ok: true, message: 'Password saved.', email: info.email },
    { 'Set-Cookie': sessionCookie(info.email) }
  );
};
