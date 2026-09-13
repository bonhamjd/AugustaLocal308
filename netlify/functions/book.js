// Books the bay for the member who is already logged in.
//
// The member sends one thing: a start time. Their name and email come off the
// session, so there is nothing to type and nothing to get wrong. Membership is
// checked here, server side, before Cal.com is ever called.

const { CAL_VERSION_WRITE, ENV, calFetch, calEventRef, displayName, requireActiveSession, json } = require('./_shared');
const store = require('./_store');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'method_not_allowed' });

  let session;
  try {
    session = await requireActiveSession(event);
  } catch (e) {
    console.error('[book] membership check failed:', e.message);
    return json(502, { ok: false, message: 'Could not reach billing. Try again in a minute.' });
  }
  if (!session) return json(401, { ok: false, message: 'Log in to book.' });

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (e) {
    return json(400, { ok: false, message: 'Pick a time and try again.' });
  }

  const start = String(body.start || '');
  if (!start || isNaN(new Date(start).getTime())) {
    return json(400, { ok: false, message: 'Pick a time and try again.' });
  }
  if (new Date(start).getTime() < Date.now() - 60 * 1000) {
    return json(400, { ok: false, message: 'That time is already past.' });
  }

  let record = null;
  try {
    record = await store.getAuth(event, session.email);
  } catch (e) {
    /* a missing display name is not a reason to block a booking */
  }

  const payload = Object.assign(
    {
      start: new Date(start).toISOString(),
      attendee: {
        name: displayName(session.info, record && record.name),
        email: session.email,
        timeZone: String(body.timeZone || ENV.clubTimeZone()),
        language: 'en',
      },
    },
    calEventRef(),
    body.duration ? { duration: parseInt(body.duration, 10) } : {}
  );

  const res = await calFetch('/bookings', { method: 'POST', version: CAL_VERSION_WRITE, body: payload });

  if (!res.ok) {
    console.error('[book] Cal.com rejected the booking:', res.status, res.text.slice(0, 400));
    const msg =
      res.status === 400 || res.status === 409
        ? 'That time just got taken. Pick another.'
        : 'Could not book that. Text JD at 402-215-7000.';
    return json(502, { ok: false, message: msg, calStatus: res.status });
  }

  const data = (res.json && res.json.data) || {};
  const booking = Array.isArray(data) ? data[0] || {} : data;
  let status = booking.status || 'pending';

  // The event type requires confirmation, which is what keeps the public
  // cal.com link locked down. Membership was already proven above, so confirm
  // it here rather than making the member wait on the webhook.
  if (status !== 'accepted' && booking.uid) {
    const confirm = await calFetch('/bookings/' + encodeURIComponent(booking.uid) + '/confirm', {
      method: 'POST',
      version: CAL_VERSION_WRITE,
      body: {},
    });
    if (confirm.ok) {
      status = 'accepted';
    } else {
      console.error('[book] confirm failed:', confirm.status, confirm.text.slice(0, 300));
    }
  }

  return json(200, {
    ok: true,
    booking: { uid: booking.uid, start: booking.start, end: booking.end, status: status },
    message:
      status === 'accepted'
        ? 'Booked. See you there.'
        : 'Requested. JD will confirm it shortly.',
  });
};
