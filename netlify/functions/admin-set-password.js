// Lets JD set a member's password from the dashboard.
//
// This exists because email is the slowest part of onboarding: Resend cannot
// deliver until the domain is verified, and that waits on DNS. With twenty
// members JD already knows, handing out a starting password by text is faster
// and needs nothing but Stripe.
//
// The member changes it themselves under Account. Until then, be aware this
// means an admin can log in as any member. That is the tradeoff, and it is
// only acceptable because the admin owns the club.

const { isAdmin, memberInfo, hashPassword, requireActiveSession, json } = require('./_shared');
const store = require('./_store');

const MIN_LENGTH = 8;

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'method_not_allowed' });

  let session;
  try {
    session = await requireActiveSession(event);
  } catch (e) {
    console.error('[admin-set-password] session check failed:', e.message);
    return json(502, { ok: false, message: 'Try again in a minute.' });
  }
  // Same answer a stranger gets. Nothing here hints the endpoint exists.
  if (!session || !isAdmin(session.email)) return json(404, { error: 'not_found' });

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (e) {
    return json(400, { ok: false, message: 'Something went wrong.' });
  }

  const email = String(body.email || '').trim().toLowerCase();
  const password = String(body.password || '');

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return json(400, { ok: false, message: 'Enter a valid email.' });
  }
  if (password.length < MIN_LENGTH) {
    return json(400, { ok: false, message: 'Use at least ' + MIN_LENGTH + ' characters.' });
  }

  // Only for people Stripe says are members. This is not a back door for
  // creating access that billing does not already support.
  let info;
  try {
    info = await memberInfo(email);
  } catch (e) {
    console.error('[admin-set-password] membership check threw:', e.message);
    return json(502, { ok: false, message: 'Could not reach Stripe. Try again.' });
  }
  if (!info.active) {
    return json(400, {
      ok: false,
      message: 'No active membership for that email. Add the subscription in Stripe first, or put them on MEMBER_ALLOWLIST.',
    });
  }

  try {
    const record = (await store.getAuth(event, info.email)) || {};
    record.hash = hashPassword(password);
    record.updated = new Date().toISOString();
    record.setByAdmin = true;
    await store.putAuth(event, info.email, record);
    await store.del(event, store.throttleKey(info.email));
  } catch (e) {
    console.error('[admin-set-password] write failed:', e.message);
    return json(503, { ok: false, message: 'Could not save that. Try again in a minute.' });
  }

  console.log('[admin-set-password] an admin set a starting password for a member');
  return json(200, { ok: true, message: 'Password set. Text it to them.' });
};
