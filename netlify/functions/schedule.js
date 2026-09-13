// Live members calendar: who is on the sim and when.
//
// Members only, enforced server-side. No session cookie or no active
// membership means no data, not a hidden div. Never returns email addresses,
// and last names are reduced to an initial, so the response is not a roster.

const { isMember, calFetch, maskName, json, requireActiveSession } = require('./_shared');

const DAYS_AHEAD = 21;

exports.handler = async (event) => {
  let session;
  try {
    session = await requireActiveSession(event);
  } catch (e) {
    console.error('[schedule] membership check failed:', e.message);
    return json(502, { error: 'membership_check_failed' });
  }
  if (!session) return json(401, { error: 'not_a_member' });

  const now = new Date();
  const until = new Date(now.getTime() + DAYS_AHEAD * 24 * 60 * 60 * 1000);

  const qs =
    '?status=upcoming' +
    '&afterStart=' + encodeURIComponent(now.toISOString()) +
    '&beforeEnd=' + encodeURIComponent(until.toISOString()) +
    '&limit=100';

  const res = await calFetch('/bookings' + qs);
  if (!res.ok) {
    console.error('[schedule] Cal.com bookings lookup failed:', res.status, res.text.slice(0, 300));
    return json(502, { error: 'calendar_unavailable', calStatus: res.status });
  }

  const rows = ((res.json && res.json.data) || [])
    .filter((b) => b.status === 'accepted')
    .map((b) => {
      const attendee = (b.attendees && b.attendees[0]) || {};
      const attendeeEmail = String(attendee.email || '').trim().toLowerCase();
      return {
        start: b.start,
        end: b.end,
        who: maskName(attendee.name),
        mine: attendeeEmail === session.email,
      };
    })
    .sort((a, b) => new Date(a.start) - new Date(b.start));

  return json(200, { days: DAYS_AHEAD, bookings: rows });
};
