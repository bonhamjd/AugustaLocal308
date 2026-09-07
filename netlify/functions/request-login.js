const { sign, stripeActiveSubscription } = require('./_shared');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'method_not_allowed' }) };
  }

  let email;
  try {
    email = JSON.parse(event.body || '{}').email;
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'bad_request' }) };
  }

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { statusCode: 400, body: JSON.stringify({ error: 'invalid_email' }) };
  }
  email = email.trim().toLowerCase();

  const genericBody = JSON.stringify({
    ok: true,
    message: "If that email is on an active membership, a login link is on its way.",
  });

  let isMember = false;
  try {
    isMember = await stripeActiveSubscription(email);
  } catch (e) {
    return { statusCode: 200, body: genericBody };
  }

  if (isMember) {
    const site = process.env.URL || 'https://augustalocal308.netlify.app';
    const token = sign(
      { email: email, purpose: 'login', exp: Date.now() + 15 * 60 * 1000 },
      process.env.SESSION_SECRET
    );
    const link = site + '/.netlify/functions/verify-login?token=' + encodeURIComponent(token);

    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + (process.env.RESEND_API_KEY || process.env.Resend_Api_Key),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: process.env.RESEND_FROM || 'Augusta Local 308 <onboarding@resend.dev>',
        to: [email],
        subject: 'Your Augusta Local 308 login link',
        html:
          '<p>Tap below to log in and manage your bookings. This link expires in 15 minutes.</p>' +
          '<p><a href="' + link + '">Log in to Augusta Local 308</a></p>' +
          '<p style="color:#888;font-size:12px">Didn\'t request this? You can ignore this email.</p>',
      }),
    }).catch(() => {});
  }

  return { statusCode: 200, body: genericBody };
};
