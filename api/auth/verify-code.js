/**
 * POST /api/auth/verify-code
 *
 * Verify a 6-digit login code and return session.
 *
 * Body: { email: string, code: string }
 * Returns: session data or error
 */

const { validateMagicLink, findUserByEmail, createSessionToken, updateLastLogin } = require('../_lib/auth');

module.exports = async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { email, code } = req.body;

    if (!email || !code) {
      return res.status(400).json({ error: 'Email and code are required' });
    }

    // Validate the code (pass code as token, email for matching)
    const result = await validateMagicLink(code, email);

    if (!result.valid) {
      return res.status(400).json({ error: result.error || 'Invalid or expired code' });
    }

    // Get user details
    const user = await findUserByEmail(result.email);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Update last login
    await updateLastLogin(user.userId);

    // Create session
    const sessionData = {
      token: createSessionToken({
        userId: user.userId,
        email: user.email,
        role: user.role || 'user'
      }),
      userId: user.userId,
      email: user.email,
      name: user.name,
      role: user.role || 'user',
      sheetId: user.sheetId,
      driveFolderId: user.driveFolderId,
      exp: Date.now() + (365 * 24 * 60 * 60 * 1000) // 365 days
    };

    return res.status(200).json({
      success: true,
      session: sessionData
    });

  } catch (error) {
    console.error('Code verification error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
