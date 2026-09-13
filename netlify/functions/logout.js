const { ENV } = require('./_shared');

exports.handler = async () => {
  return {
    statusCode: 302,
    multiValueHeaders: {
      'Set-Cookie': ['al308_session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0'],
    },
    headers: { Location: ENV.siteUrl() + '/' },
  };
};
