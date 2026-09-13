// The one thing a member can change about themselves: the name that shows on
// the shared calendar. No address, no phone, nothing else stored.

const { requireActiveSession, displayName, json } = require('./_shared');
const store = require('./_store');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'method_not_allowed' });

  let session;
  try {
    session = await requireActiveSession(event);
  } catch (e) {
    console.error('[profile] membership check failed:', e.message);
    return json(502, { ok: false, message: 'Try again in a minute.' });
  }
  if (!session) return json(401, { ok: false, message: 'Log in again.' });

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (e) {
    return json(400, { ok: false, message: 'Something went wrong.' });
  }

  const name = String(body.name || '').trim().replace(/\s+/g, ' ').slice(0, 60);
  if (name.length < 2) return json(400, { ok: false, message: 'Enter your name.' });

  try {
    const record = (await store.getAuth(event, session.email)) || {};
    record.name = name;
    await store.putAuth(event, session.email, record);
  } catch (e) {
    console.error('[profile] write failed:', e.message);
    return json(503, { ok: false, message: 'Could not save that. Try again.' });
  }

  return json(200, { ok: true, name: displayName(session.info, name) });
};
