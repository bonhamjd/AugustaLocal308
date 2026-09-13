// Lands here from the emailed link. Issues the session, then sends the member
// to set a password if they do not have one yet, so this is the last time they
// need email to get in.

const { ENV, verify, sessionCookie } = require('./_shared');
const store = require('./_store');

exports.handler = async (event) => {
  const token = event.queryStringParameters && event.queryStringParameters.token;
  const site = ENV.siteUrl();
  const data = verify(token, ENV.sessionSecret());

  if (!data || data.purpose !== 'login') {
    return { statusCode: 302, headers: { Location: site + '/?login=expired#reserve' } };
  }

  let hasPassword = false;
  try {
    const record = await store.getAuth(event, data.email);
    hasPassword = !!(record && record.hash);
  } catch (e) {
    console.error('[verify-login] auth read failed:', e.message);
  }

  return {
    statusCode: 302,
    multiValueHeaders: { 'Set-Cookie': [sessionCookie(data.email)] },
    headers: { Location: site + (hasPassword ? '/#reserve' : '/?setpw=1#reserve') },
  };
};
