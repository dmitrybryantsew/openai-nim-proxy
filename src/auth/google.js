const { OAuth2Client } = require('google-auth-library');

function getGoogleAuthClient() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_REDIRECT_URI || 'http://localhost:3000/auth/google/callback';

  return new OAuth2Client(clientId, clientSecret, redirectUri);
}

function getGoogleAuthUrl() {
  const client = getGoogleAuthClient();
  const authorizeUrl = client.generateAuthUrl({
    access_type: 'offline',
    scope: [
      'https://www.googleapis.com/auth/userinfo.profile',
      'https://www.googleapis.com/auth/userinfo.email',
    ],
    prompt: 'consent',
  });
  return authorizeUrl;
}

async function getGoogleUserFromCode(code) {
  const client = getGoogleAuthClient();
  const { tokens } = await client.getToken(code);
  client.setCredentials(tokens);

  const ticket = await client.verifyIdToken({
    idToken: tokens.id_token,
    audience: process.env.GOOGLE_CLIENT_ID,
  });

  const payload = ticket.getPayload();
  return {
    googleId: payload.sub,
    email: payload.email,
    name: payload.name,
    picture: payload.picture,
  };
}

module.exports = {
  getGoogleAuthUrl,
  getGoogleUserFromCode,
};