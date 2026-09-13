// The real booking gate.
//
// The login form on the site only hides the Cal.com embed. Anyone who finds
// cal.com/al308/bookbay can still open it. So the event type is set to
// "Requires confirmation" in Cal.com, and this webhook is what actually
// decides: active member -> confirm, everyone else -> decline.
//
// Cal.com setup (one time):
//   Event type "bookbay" -> Advanced -> Requires confirmation: ON
//   Settings -> Webhooks -> New
//     URL:     https://augustalocal308.com/.netlify/functions/cal-webhook
//     Secret:  same value as the CALCOM_WEBHOOK_SECRET env var
//     Trigger: Booking Requested
//
// Env: CALCOM_WEBHOOK_SECRET, CALCOM_API_KEY, STRIPE_RESTRICTED_KEY, MEMBER_ALLOWLIST

const crypto = require('crypto');
const { ENV, CAL_VERSION_WRITE, safeEqual, isMember, calFetch, json } = require('./_shared');

const DECLINE_REASON =
  'Augusta Local 308 is members only. Join at augustalocal308.com, or text JD at 402-215-7000 for events and one-off gatherings.';

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'method_not_allowed' });

  const secret = ENV.calWebhookSecret();
  if (!secret) {
    console.error('[cal-webhook] CALCOM_WEBHOOK_SECRET is not set. Refusing to act.');
    return json(500, { error: 'not_configured' });
  }

  // Signature is over the exact raw body. Netlify base64-encodes some bodies.
  const raw = event.isBase64Encoded
    ? Buffer.from(event.body || '', 'base64').toString('utf8')
    : event.body || '';

  const headers = event.headers || {};
  const sigHeader = headers['x-cal-signature-256'] || headers['X-Cal-Signature-256'] || '';
  const provided = String(sigHeader).replace(/^sha256=/i, '').trim();
  const expected = crypto.createHmac('sha256', secret).update(raw).digest('hex');

  if (!provided || !safeEqual(provided, expected)) {
    console.warn('[cal-webhook] rejected: bad or missing signature');
    return json(401, { error: 'bad_signature' });
  }

  let body;
  try {
    body = JSON.parse(raw);
  } catch (e) {
    return json(400, { error: 'bad_json' });
  }

  const trigger = body.triggerEvent;
  if (trigger !== 'BOOKING_REQUESTED') {
    return json(200, { ignored: trigger || 'unknown' });
  }

  const payload = body.payload || {};
  const uid = payload.uid;
  const attendee = (payload.attendees && payload.attendees[0]) || {};
  const email = String(attendee.email || '').trim().toLowerCase();

  if (!uid || !email) {
    console.error('[cal-webhook] payload missing uid or attendee email');
    return json(200, { error: 'incomplete_payload' });
  }

  let allowed;
  try {
    allowed = await isMember(email);
  } catch (e) {
    // Membership check is broken. Leave the booking pending rather than
    // declining a paying member because Stripe was unreachable. It shows up
    // in Cal.com as unconfirmed and JD can approve it by hand.
    console.error('[cal-webhook] membership check failed, leaving pending:', e.message);
    return json(200, { action: 'left_pending', reason: 'membership_check_failed' });
  }

  const action = allowed ? 'confirm' : 'decline';
  const res = await calFetch('/bookings/' + encodeURIComponent(uid) + '/' + action, {
    method: 'POST',
    version: CAL_VERSION_WRITE,
    body: allowed ? {} : { reason: DECLINE_REASON },
  });

  console.log(
    '[cal-webhook] ' + action + ' ' + uid + ' for ' + email + ' -> Cal.com ' + res.status
  );

  if (!res.ok) {
    console.error('[cal-webhook] Cal.com rejected the ' + action + ':', res.text.slice(0, 400));
    return json(200, { action: action, calStatus: res.status, ok: false });
  }

  return json(200, { action: action, ok: true });
};
