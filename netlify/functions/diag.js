// Config check. Open this when something "works" but nothing happens.
//
//   https://augustalocal308.com/.netlify/functions/diag?key=<SESSION_SECRET>
//
// Reports whether each secret is SET and whether each service actually answers.
// Never prints a secret value. Not linked from anywhere on the site.

const { ENV, safeEqual, json } = require('./_shared');

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
    URL: ENV.siteUrl(),
  };

  const checks = {};
  const results = await Promise.all([
    ENV.stripeKey()
      ? ping('stripe', 'https://api.stripe.com/v1/customers?limit=1', {
          Authorization: 'Bearer ' + ENV.stripeKey(),
        })
      : Promise.resolve(['stripe', { ok: false, error: 'key not set' }]),

    ENV.calKey()
      ? ping('calcom', 'https://api.cal.com/v2/bookings?limit=1', {
          Authorization: 'Bearer ' + ENV.calKey(),
          'cal-api-version': '2026-05-01',
        })
      : Promise.resolve(['calcom', { ok: false, error: 'key not set' }]),

    ENV.resendKey()
      ? ping(
          'resend',
          'https://api.resend.com/domains',
          { Authorization: 'Bearer ' + ENV.resendKey() },
          (body) => {
            const list = (body && (body.data || body)) || [];
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

  // The one that silently eats member login emails.
  const from = ENV.resendFrom() || 'onboarding@resend.dev';
  const warnings = [];

  if (/@resend\.dev\s*>?\s*$/.test(from) || from.indexOf('resend.dev') !== -1) {
    warnings.push(
      'RESEND_FROM uses resend.dev. Resend returns 403 for every recipient except your own Resend account email, so login links reach nobody but you. Verify augustalocal308.com at resend.com/domains and set RESEND_FROM to something like "Augusta Local 308 <noreply@augustalocal308.com>".'
    );
  }
  if (checks.resend && checks.resend.verifiedDomains) {
    const verified = checks.resend.verifiedDomains.filter((d) => d.status === 'verified');
    if (!verified.length) {
      warnings.push('No verified sending domain in Resend. Member login emails will not deliver.');
    }
  }
  if (!ENV.calWebhookSecret()) {
    warnings.push(
      'CALCOM_WEBHOOK_SECRET is not set, so cal-webhook refuses to run and nothing gates cal.com/al308/bookbay. Non-members can book.'
    );
  }
  if (!env.MEMBER_ALLOWLIST_COUNT) {
    warnings.push(
      'MEMBER_ALLOWLIST is empty. Anyone without a Stripe subscription, including JD, cannot log in or book.'
    );
  }

  return json(200, { env, checks, warnings });
};
