exports.handler = async () => {
  const site = process.env.URL || 'https://augustalocal308.netlify.app';
  return {
    statusCode: 302,
    multiValueHeaders: {
      'Set-Cookie': ['al308_session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0'],
    },
    headers: { Location: site + '/' },
  };
};
