const { ENV, verify, parseCookies, isMember, calFetch, json } = require('./_shared');

exports.handler = async (event) => {
  const cookies = parseCookies(event.headers.cookie || event.headers.Cookie);
  const data = verify(cookies.al308_session, ENV.sessionSecret());

  if (!data || data.purpose !== 'session') return json(401, { error: 'not_logged_in' });

  let active;
  try {
    active = await isMember(data.email);
  } catch (e) {
    console.error('[me] membership check failed:', e.message);
    return json(502, { error: 'membership_check_failed' });
  }

  // This is the lever for unpaid members: cancel or let the Stripe subscription
  // lapse and the next page load drops them back to the login form.
  if (!active) return json(403, { error: 'membership_inactive' });

  let upcoming = [];
  let past = [];
  try {
    const res = await calFetch(
      '/bookings?attendeeEmail=' + encodeURIComponent(data.email) + '&limit=100'
    );
    if (res.ok) {
      const all = ((res.json && res.json.data) || [])
        .filter((b) => b.status === 'accepted' || b.status === 'pending')
        .map((b) => ({ id: b.id, title: b.title, start: b.start, end: b.end, status: b.status }));
      const now = Date.now();
      upcoming = all
        .filter((b) => new Date(b.start).getTime() >= now)
        .sort((a, b) => new Date(a.start) - new Date(b.start));
      past = all
        .filter((b) => new Date(b.start).getTime() < now)
        .sort((a, b) => new Date(b.start) - new Date(a.start));
    } else {
      console.error('[me] Cal.com lookup failed:', res.status, res.text.slice(0, 300));
    }
  } catch (e) {
    console.error('[me] Cal.com lookup threw:', e.message);
  }

  return json(200, { email: data.email, active: true, upcoming: upcoming, past: past });
};
