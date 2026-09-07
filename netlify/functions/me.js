const { verify, parseCookies, stripeActiveSubscription } = require('./_shared');

exports.handler = async (event) => {
  const cookieHeader = event.headers.cookie || event.headers.Cookie;
  const cookies = parseCookies(cookieHeader);
  const data = verify(cookies.al308_session, process.env.SESSION_SECRET);

  if (!data || data.purpose !== 'session') {
    return { statusCode: 401, body: JSON.stringify({ error: 'not_logged_in' }) };
  }

  let active = false;
  try {
    active = await stripeActiveSubscription(data.email);
  } catch (e) {
    return { statusCode: 502, body: JSON.stringify({ error: 'membership_check_failed' }) };
  }

  if (!active) {
    return { statusCode: 403, body: JSON.stringify({ error: 'membership_inactive' }) };
  }

  let upcoming = [];
  let past = [];
  try {
    const res = await fetch(
      'https://api.cal.com/v2/bookings?attendeeEmail=' + encodeURIComponent(data.email) + '&limit=100',
      {
        headers: {
          Authorization: 'Bearer ' + process.env.CALCOM_API_KEY,
          'cal-api-version': '2026-05-01',
        },
      }
    );
    if (res.ok) {
      const json = await res.json();
      const all = (json.data || []).map((b) => ({
        id: b.id,
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
        .sort((a, b) => new Date(b.start) - new Date(a.start));
    }
  } catch (e) {
    // Booking lookup failed; still return membership status so the page can render.
  }

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: data.email, active: true, upcoming: upcoming, past: past }),
  };
};
