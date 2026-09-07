const crypto = require('crypto');

function b64url(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  return Buffer.from(str, 'base64');
}

// Signs a small JSON payload with HMAC-SHA256. No external deps, no build step.
function sign(payloadObj, secret) {
  const payload = b64url(JSON.stringify(payloadObj));
  const sig = crypto.createHmac('sha256', secret).update(payload).digest();
  return payload + '.' + b64url(sig);
}

function verify(token, secret) {
  if (!token || typeof token !== 'string' || token.indexOf('.') === -1) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const payload = parts[0];
  const sig = parts[1];
  const expectedSig = b64url(crypto.createHmac('sha256', secret).update(payload).digest());
  const a = Buffer.from(sig);
  const b = Buffer.from(expectedSig);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let data;
  try {
    data = JSON.parse(b64urlDecode(payload).toString('utf8'));
  } catch (e) {
    return null;
  }
  if (!data.exp || Date.now() > data.exp) return null;
  return data;
}

function parseCookies(header) {
  const out = {};
  (header || '').split(';').forEach(function (part) {
    const i = part.indexOf('=');
    if (i === -1) return;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}

// Checks Stripe for any active or trialing subscription belonging to this email.
// Uses a restricted key scoped to Customers:Read and Subscriptions:Read only.
async function stripeActiveSubscription(email) {
  const key = process.env.STRIPE_RESTRICTED_KEY;
  if (!key) throw new Error('STRIPE_RESTRICTED_KEY is not set');

  const custRes = await fetch(
    'https://api.stripe.com/v1/customers?email=' + encodeURIComponent(email) + '&limit=5',
    { headers: { Authorization: 'Bearer ' + key } }
  );
  if (!custRes.ok) throw new Error('Stripe customers lookup failed: ' + custRes.status);
  const custData = await custRes.json();
  if (!custData.data || !custData.data.length) return false;

  for (const cust of custData.data) {
    const subRes = await fetch(
      'https://api.stripe.com/v1/subscriptions?customer=' + cust.id + '&status=all&limit=10',
      { headers: { Authorization: 'Bearer ' + key } }
    );
    if (!subRes.ok) continue;
    const subData = await subRes.json();
    if (subData.data && subData.data.some((s) => s.status === 'active' || s.status === 'trialing')) {
      return true;
    }
  }
  return false;
}

module.exports = { sign, verify, parseCookies, stripeActiveSubscription };
