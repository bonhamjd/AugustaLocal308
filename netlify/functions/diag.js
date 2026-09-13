// Config check. Open this when something "works" but nothing happens.
//
//   https://augustalocal308.com/.netlify/functions/diag?key=<SESSION_SECRET>
//
// Reports whether each secret is SET and whether each service actually answers,
// including the two Cal.com calls the booker depends on and the blob store the
// passwords live in. Never prints a secret value. Not linked from anywhere.

const { ENV, CAL_VERSION_READ, CAL_VERSION_SLOTS, safeEqual, qs, calEventRef, json } = require('./_shared');
const store = require('./_store');

async function ping(name, url, headers, extra) {
  try {
    const res = await fetch(url, { headers });
    const text = await res.text();
    const out = { ok: res.ok, status: res.status };
    if (!res.ok) out.body = text.slice(0, 300);
    if (extra) Object.assign(out, extra(res.ok ? safeJson(text) : null));
    return [name, out];
  } catch (e) {
    return [name, { ok: false, error: e.message }];
  }
}

function safeJson(t) {
  try {
    return JSON.parse(t);
  } catch (e) {
    return null;
  }
}

exports.handler = async (event) => {
  const secret = ENV.sessionSecret();
  const key = (event.queryStringParameters || {}).key || '';
  if (!secret || !key || !safeEqual(key, secret)) {
    return { statusCode: 404, body: 'Not found' };
  }

  const env = {
    SESSION_SECRET: !!ENV.sessionSecret(),
    STRIPE_RESTRICTED_KEY: !!ENV.stripeKey(),
    CALCOM_API_KEY: !!ENV.calKey(),
    CALCOM_WEBHOOK_SECRET: !!ENV.calWebhookSecret(),
    RESEND_API_KEY: !!ENV.resendKey(),
    RESEND_FROM: ENV.resendFrom() || '(not set - defaults to onboarding@resend.dev)',
    MEMBER_ALLOWLIST_COUNT: ENV.allowlist().split(',').filter((s) => s.trim()).length,
    ADMIN_EMAILS_SET: !!process.env.ADMIN_EMAILS,
    ADMIN_COUNT: ENV.admins().split(',').filter((s) => s.trim()).length,
    CAL_EVENT: calEventRef(),
    CLUB_TIMEZONE: ENV.clubTimeZone(),
    URL: ENV.siteUrl(),
  };

  const now = new Date();
  const slotsUrl =
    'https://api.cal.com/v2/slots' +
    qs(
      Object.assign(
        {
          start: now.toISOString(),
          end: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString(),
          timeZone: ENV.clubTimeZone(),
        },
        calEventRef()
      )
    );

  const checks = {};
  const results = await Promise.all([
    ENV.stripeKey()
      ? ping('stripe_customers', 'https://api.stripe.com/v1/customers?limit=1', {
          Authorization: 'Bearer ' + ENV.stripeKey(),
        })
      : Promise.resolve(['stripe_customers', { ok: false, error: 'key not set' }]),

    ENV.stripeKey()
      ? ping('stripe_subscriptions', 'https://api.stripe.com/v1/subscriptions?limit=1&status=all', {
          Authorization: 'Bearer ' + ENV.stripeKey(),
        })
      : Promise.resolve(['stripe_subscriptions', { ok: false, error: 'key not set' }]),

    // The dashboard's revenue numbers come from here. A 403 means the
    // restricted key is missing Charges: Read. Everything else still works.
    ENV.stripeKey()
      ? ping('stripe_charges', 'https://api.stripe.com/v1/charges?limit=1', {
          Authorization: 'Bearer ' + ENV.stripeKey(),
        })
      : Promise.resolve(['stripe_charges', { ok: false, error: 'key not set' }]),

    ENV.calKey()
      ? ping('calcom_bookings', 'https://api.cal.com/v2/bookings?limit=1', {
          Authorization: 'Bearer ' + ENV.calKey(),
          'cal-api-version': CAL_VERSION_READ,
        })
      : Promise.resolve(['calcom_bookings', { ok: false, error: 'key not set' }]),

    // This is the call the booker makes. If it fails, members see no times.
    ENV.calKey()
      ? ping(
          'calcom_slots',
          slotsUrl,
          { Authorization: 'Bearer ' + ENV.calKey(), 'cal-api-version': CAL_VERSION_SLOTS },
          (bodyJson) => {
            const data = (bodyJson && bodyJson.data) || {};
            const days = Object.keys(data);
            let count = 0;
            days.forEach((d) => { count += (data[d] || []).length; });
            return { openDaysNext7: days.length, openSlotsNext7: count };
          }
        )
      : Promise.resolve(['calcom_slots', { ok: false, error: 'key not set' }]),

    ENV.resendKey()
      ? ping(
          'resend',
          'https://api.resend.com/domains',
          { Authorization: 'Bearer ' + ENV.resendKey() },
          (bodyJson) => {
            const list = (bodyJson && (bodyJson.data || bodyJson)) || [];
            const domains = Array.isArray(list)
              ? list.map((d) => ({ name: d.name, status: d.status }))
              : [];
            return { verifiedDomains: domains };
          }
        )
      : Promise.resolve(['resend', { ok: false, error: 'key not set' }]),
  ]);

  results.forEach(([name, result]) => {
    checks[name] = result;
  });

  // Blobs: write, read back, delete. Passwords live here, so if this is broken
  // nobody can log in with one.
  try {
    const probe = 'diag/probe';
    const stamp = Date.now();
    await store.setJSON(event, probe, { stamp: stamp });
    const back = await store.getJSON(event, probe);
    await store.del(event, probe);
    checks.blobs = { ok: !!back && back.stamp === stamp };
    if (!checks.blobs.ok) checks.blobs.note = 'wrote but read back the wrong value';
  } catch (e) {
    checks.blobs = { ok: false, error: e.message };
  }

  const warnings = [];

  const from = ENV.resendFrom() || 'onboarding@resend.dev';
  if (from.indexOf('resend.dev') !== -1) {
    warnings.push(
      'RESEND_FROM uses resend.dev. Resend returns 403 for every recipient except your own Resend account email, so first-login links reach nobody but you. Verify augustalocal308.com at resend.com/domains and set RESEND_FROM to something like "Augusta Local 308 <noreply@augustalocal308.com>".'
    );
  }

  // A send-only Resend key returns 401 on /domains. That is a correctly scoped
  // key, not a fault, and it means this check simply cannot see your domains.
  const resendCheck = checks.resend || {};
  const sendOnlyKey = resendCheck.status === 401 && /restricted/i.test(resendCheck.body || '');
  if (sendOnlyKey) {
    resendCheck.note =
      'Send-only Resend key: it can send email but cannot list domains, so this check cannot confirm your verified domains. Expected, not a fault.';
  } else if (resendCheck.verifiedDomains) {
    const verified = resendCheck.verifiedDomains.filter((d) => d.status === 'verified');
    if (!verified.length) {
      warnings.push('No verified sending domain in Resend. First-login links will not deliver.');
    }
  }

  if (checks.stripe_charges && !checks.stripe_charges.ok) {
    warnings.push(
      'The Stripe key cannot read charges, so the dashboard shows no revenue. Add Charges: Read to the restricted key. Logins and booking are unaffected.'
    );
  }
  if (checks.calcom_slots && checks.calcom_slots.ok && !checks.calcom_slots.openSlotsNext7) {
    warnings.push(
      'Cal.com answered but reports zero open times in the next seven days. Members will see "no open times". Check the availability schedule and booking limits on the bookbay event type.'
    );
  }
  if (checks.blobs && !checks.blobs.ok) {
    warnings.push(
      'The blob store is not working, so passwords cannot be saved or checked. Members can still get in with an email link.'
    );
  }
  if (!ENV.calWebhookSecret()) {
    warnings.push(
      'CALCOM_WEBHOOK_SECRET is not set, so cal-webhook refuses to run and nothing gates cal.com/al308/bookbay. Non-members can book there directly.'
    );
  }
  if (!env.MEMBER_ALLOWLIST_COUNT) {
    warnings.push(
      'MEMBER_ALLOWLIST is empty. Anyone without a Stripe subscription, including JD, cannot log in or book.'
    );
  }
  if (!env.ADMIN_EMAILS_SET) {
    warnings.push(
      'ADMIN_EMAILS is not set, so /admin falls back to MEMBER_ALLOWLIST. Every comped member on that list can read your revenue. Set ADMIN_EMAILS.'
    );
  }

  return json(200, { env, checks, warnings });
};
