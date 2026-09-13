const { ENV, sign, isMember, json } = require('./_shared');

// Shown whether or not the email is on a membership, so the form cannot be
// used to test who is a member.
const GENERIC = {
  ok: true,
  message: "If that email is on an active membership, a login link is on its way.",
};

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'method_not_allowed' });

  // Fail loudly on bad config instead of telling the member a link is coming.
  // This is the class of bug that made logins "work" while nothing arrived.
  const missing = [];
  if (!ENV.sessionSecret()) missing.push('SESSION_SECRET');
  if (!ENV.stripeKey()) missing.push('STRIPE_RESTRICTED_KEY');
  if (!ENV.resendKey()) missing.push('RESEND_API_KEY');
  if (missing.length) {
    console.error('[request-login] missing env vars:', missing.join(', '));
    return json(503, {
      ok: false,
      message: 'Login is down right now. Text JD at 402-215-7000 and he will get you in.',
    });
  }

  let email;
  try {
    email = JSON.parse(event.body || '{}').email;
  } catch (e) {
    return json(400, { ok: false, message: 'Enter a valid email.' });
  }
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return json(400, { ok: false, message: 'Enter a valid email.' });
  }
  email = email.trim().toLowerCase();

  let member;
  try {
    member = await isMember(email);
  } catch (e) {
    console.error('[request-login] membership check threw:', e.message);
    return json(503, {
      ok: false,
      message: 'Login is down right now. Text JD at 402-215-7000 and he will get you in.',
    });
  }

  if (!member) {
    console.log('[request-login] no active membership for this address');
    return json(200, GENERIC);
  }

  const token = sign(
    { email: email, purpose: 'login', exp: Date.now() + 15 * 60 * 1000 },
    ENV.sessionSecret()
  );
  const link = ENV.siteUrl() + '/.netlify/functions/verify-login?token=' + encodeURIComponent(token);

  let sendStatus = 0;
  let sendBody = '';
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + ENV.resendKey(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: ENV.resendFrom() || 'Augusta Local 308 <onboarding@resend.dev>',
        to: [email],
        subject: 'Your Augusta Local 308 login link',
        html:
          '<p>Tap below to log in. Once you are in, set a password and you will not need one of these again. This link expires in 15 minutes.</p>' +
          '<p><a href="' + link + '">Log in to Augusta Local 308</a></p>' +
          '<p style="color:#888;font-size:12px">Didn\'t request this? You can ignore this email.</p>',
      }),
    });
    sendStatus = res.status;
    sendBody = await res.text();
  } catch (e) {
    console.error('[request-login] Resend call threw:', e.message);
  }

  if (sendStatus < 200 || sendStatus >= 300) {
    // Deliberate tradeoff: this reveals that the address is a member, but only
    // while email delivery is broken. Better than a paying member staring at
    // "a link is on its way" when nothing was ever sent.
    console.error('[request-login] Resend failed:', sendStatus, sendBody.slice(0, 400));
    return json(502, {
      ok: false,
      message: "We couldn't send that email. Text JD at 402-215-7000 and he will get you in.",
    });
  }

  console.log('[request-login] login link sent, Resend status', sendStatus);
  return json(200, GENERIC);
};
