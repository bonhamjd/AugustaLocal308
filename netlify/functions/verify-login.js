const { ENV, verify, sign } = require('./_shared');

exports.handler = async (event) => {
  const token = event.queryStringParameters && event.queryStringParameters.token;
  const site = ENV.siteUrl();
  const data = verify(token, ENV.sessionSecret());

  if (!data || data.purpose !== 'login') {
    return { statusCode: 302, headers: { Location: site + '/?login=expired#reserve' } };
  }

  const session = sign(
    { email: data.email, purpose: 'session', exp: Date.now() + 30 * 24 * 60 * 60 * 1000 },
    ENV.sessionSecret()
  );

  return {
    statusCode: 302,
    multiValueHeaders: {
      'Set-Cookie': [
        'al308_session=' + session + '; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000',
      ],
    },
    headers: { Location: site + '/#reserve' },
  };
};
