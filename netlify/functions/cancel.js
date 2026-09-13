// Cancels a booking. A member can only cancel their own.

const { CAL_VERSION_WRITE, calFetch, calAllBookings, requireActiveSession, json } = require('./_shared');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'method_not_allowed' });

  let session;
  try {
    session = await requireActiveSession(event);
  } catch (e) {
    console.error('[cancel] membership check failed:', e.message);
    return json(502, { ok: false, message: 'Try again in a minute.' });
  }
  if (!session) return json(401, { ok: false, message: 'Log in first.' });

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (e) {
    return json(400, { ok: false, message: 'Nothing to cancel.' });
  }

  const uid = String(body.uid || '').trim();
  if (!uid) return json(400, { ok: false, message: 'Nothing to cancel.' });

  // Ownership check. Never take the uid on trust.
  let mine;
  try {
    mine = await calAllBookings({ attendeeEmail: session.email }, 5);
  } catch (e) {
    console.error('[cancel] ownership lookup failed:', e.message);
    return json(502, { ok: false, message: 'Could not reach the calendar. Try again.' });
  }
  if (!mine.some((b) => b.uid === uid)) {
    return json(403, { ok: false, message: 'That booking is not yours.' });
  }

  const res = await calFetch('/bookings/' + encodeURIComponent(uid) + '/cancel', {
    method: 'POST',
    version: CAL_VERSION_WRITE,
    body: { cancellationReason: 'Cancelled by the member from augustalocal308.com' },
  });

  if (!res.ok) {
    console.error('[cancel] Cal.com rejected the cancel:', res.status, res.text.slice(0, 300));
    return json(502, { ok: false, message: 'Could not cancel that. Text JD at 402-215-7000.' });
  }

  return json(200, { ok: true, message: 'Cancelled.' });
};
