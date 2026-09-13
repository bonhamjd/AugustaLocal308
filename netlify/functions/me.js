// Everything the member view needs in one call: who you are, whether you still
// have access, whether you have a password yet, and your own bookings.

const { ENV, verify, parseCookies, memberInfo, calAllBookings, displayName, isAdmin, json } = require('./_shared');
const store = require('./_store');

exports.handler = async (event) => {
  const headers = event.headers || {};
  const cookies = parseCookies(headers.cookie || headers.Cookie);
  const data = verify(cookies.al308_session, ENV.sessionSecret());

  if (!data || data.purpose !== 'session') return json(401, { error: 'not_logged_in' });

  let info;
  try {
    info = await memberInfo(data.email);
  } catch (e) {
    console.error('[me] membership check failed:', e.message);
    return json(502, { error: 'membership_check_failed' });
  }

  // This is the lever for unpaid members: cancel or let the Stripe subscription
  // lapse and the next page load drops them back to the login form.
  if (!info.active) return json(403, { error: 'membership_inactive' });

  let record = null;
  try {
    record = await store.getAuth(event, info.email);
  } catch (e) {
    console.error('[me] auth read failed:', e.message);
  }

  let upcoming = [];
  let past = [];
  try {
    const all = (await calAllBookings({ attendeeEmail: info.email }, 5))
      .filter((b) => b.status === 'accepted' || b.status === 'pending')
      .map((b) => ({
        uid: b.uid,
        title: b.title,
        start: b.start,
        end: b.end,
        status: b.status,
      }));
    const now = Date.now();
    upcoming = all
      .filter((b) => new Date(b.start).getTime() >= now)
      .sort((a, b) => new Date(a.start) - new Date(b.start));
    past = all
      .filter((b) => new Date(b.start).getTime() < now)
      .sort((a, b) => new Date(b.start) - new Date(a.start))
      .slice(0, 10);
  } catch (e) {
    console.error('[me] Cal.com lookup failed:', e.message);
  }

  return json(200, {
    email: info.email,
    name: displayName(info, record && record.name),
    active: true,
    comp: info.comp,
    plan: info.comp && !info.plan ? 'Comped' : info.plan,
    amount: info.amount,
    interval: info.interval,
    renews: info.renews,
    cancelAtPeriodEnd: info.cancelAtPeriodEnd,
    hasPassword: !!(record && record.hash),
    admin: isAdmin(info.email),
    timeZone: ENV.clubTimeZone(),
    upcoming: upcoming,
    past: past,
  });
};
