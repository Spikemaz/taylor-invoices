/**
 * GET /api/auth/verify?token=xxx
 *
 * Verify a magic link token and create a session.
 * Redirects to app with session token, or to login with error.
 */

const {
  validateMagicLink,
  findUserByEmail,
  createSessionToken,
  updateLastLogin,
  SESSION_EXPIRY_MS
} = require('../_lib/auth');

module.exports = async function handler(req, res) {
  // This endpoint handles GET requests (user clicks link in email)
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { token } = req.query;

    if (!token) {
      return redirectWithError(res, 'Missing token');
    }

    // Validate the magic link token
    const validation = await validateMagicLink(token);

    if (!validation.valid) {
      return redirectWithError(res, validation.error);
    }

    // Find the user
    const user = await findUserByEmail(validation.email);

    if (!user) {
      return redirectWithError(res, 'User not found');
    }

    if (user.status === 'suspended') {
      return redirectWithError(res, 'Account suspended');
    }

    if (user.status === 'pending') {
      return redirectWithError(res, 'Account pending approval');
    }

    // Create session token
    const sessionToken = createSessionToken(user);

    // Update last login
    await updateLastLogin(user.userId);

    // Build session data for client
    const sessionData = {
      token: sessionToken,
      userId: user.userId,
      email: user.email,
      name: user.name,
      role: user.role || 'user',
      sheetId: user.sheetId,
      driveFolderId: user.driveFolderId,
      exp: Date.now() + SESSION_EXPIRY_MS
    };

    // Redirect to app with session data in hash fragment
    // Using hash fragment so it's not logged in server logs
    const sessionB64 = Buffer.from(JSON.stringify(sessionData)).toString('base64url');
    const baseUrl = process.env.APP_URL || `https://${req.headers.host}`;
    const redirectUrl = `${baseUrl}/#auth=${sessionB64}`;

    return res.redirect(302, redirectUrl);

  } catch (error) {
    console.error('Verify error:', error);
    return redirectWithError(res, 'Internal error');
  }
};

/**
 * Redirect to login page with error message
 */
function redirectWithError(res, error) {
  const baseUrl = process.env.APP_URL || 'https://localhost:3000';
  const errorEncoded = encodeURIComponent(error);
  return res.redirect(302, `${baseUrl}/login.html?error=${errorEncoded}`);
}
