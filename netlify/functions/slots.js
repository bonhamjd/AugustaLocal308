// Open times on the bay. Members only.
//
// The site asks Cal.com for availability and renders it itself, so a member
// never sees a booking form. Name and email come from the session, not from
// anything they type.

const { ENV, CAL_VERSION_SLOTS, calFetch, calEventRef, qs, requireActiveSession, json } = require('./_shared');

const MAX_DAYS = 30;

exports.handler = async (event) => {
  let session;
  try {
    session = await requireActiveSession(event);
  } catch (e) {
    console.error('[slots] membership check failed:', e.message);
    return json(502, { error: 'membership_check_failed' });
  }
  if (!session) return json(401, { error: 'not_a_member' });

  const p = event.queryStringParameters || {};
  const days = Math.min(Math.max(parseInt(p.days, 10) || 14, 1), MAX_DAYS);
  const timeZone = p.timeZone || ENV.clubTimeZone();

  const now = new Date();
  const end = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);

  // Both spellings are sent on purpose: Cal.com has documented this parameter
  // as "format" and as "slotFormat" in different places, and the extra one is
  // ignored. Either way we get ranges when the API supports them.
  const params = Object.assign(
    {
      start: now.toISOString(),
      end: end.toISOString(),
      timeZone: timeZone,
      format: 'range',
      slotFormat: 'range',
    },
    calEventRef(),
    p.duration ? { duration: parseInt(p.duration, 10) } : {}
  );

  const res = await calFetch('/slots' + qs(params), { version: CAL_VERSION_SLOTS });
  if (!res.ok) {
    console.error('[slots] Cal.com slots lookup failed:', res.status, res.text.slice(0, 300));
    return json(502, { error: 'slots_unavailable', calStatus: res.status });
  }

  // Response is an object keyed by date: { "2026-09-14": [{start, end?}, ...] }
  const raw = (res.json && res.json.data) || {};
  const byDay = {};
  Object.keys(raw).forEach(function (day) {
    const list = Array.isArray(raw[day]) ? raw[day] : [];
    const cleaned = list
      .map(function (s) {
        if (typeof s === 'string') return { start: s, end: null };
        return { start: s.start || s.time || null, end: s.end || null };
      })
      .filter((s) => s.start);
    if (cleaned.length) byDay[day] = cleaned;
  });

  return json(200, { timeZone: timeZone, days: days, slots: byDay });
};
