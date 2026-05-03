/**
 * POST /api/admin/send-magic-link
 *
 * Admin sends a magic-link email to a target user. Useful when onboarding
 * trial users (e.g. once Reo gets email access, click here to send him a code
 * directly without him needing to type his email on the login screen).
 *
 * Body: { userId: string }
 * Requires admin session.
 */

const {validateSession, isAdmin, findUserById, generateToken, generateCode, storeMagicLink, logAdminAction, applyCors } = require('../_lib/auth');

module.exports = async function handler(req, res) {
  applyCors(req, res, 'POST, OPTIONS');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const session = await validateSession(req);
    if (!session) return res.status(401).json({ error: 'Authentication required' });
    if (!isAdmin(session.email)) return res.status(403).json({ error: 'Admin access required' });

    const { userId } = req.body || {};
    if (!userId) return res.status(400).json({ error: 'userId is required' });

    const user = await findUserById(userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (!user.email) return res.status(400).json({ error: 'Target user has no email on file' });

    if (user.status === 'suspended') {
      return res.status(403).json({ error: `Cannot send magic link — user is ${user.status}` });
    }

    // Generate token + 6-digit code, store in MagicLinks tab
    const token = generateToken();
    const code = generateCode();
    await storeMagicLink(user.email.toLowerCase().trim(), token, code);

    const baseUrl = process.env.APP_URL || `https://${req.headers.host}`;
    const magicLink = `${baseUrl}/api/auth/verify?token=${token}`;

    let emailSent = false;
    let emailError = null;

    if (process.env.RESEND_API_KEY) {
      try {
        const response = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            from: process.env.EMAIL_FROM || 'BooksIQ <noreply@booksiq.app>',
            to: user.email,
            subject: 'Your BooksIQ Login Link',
            html: `
              <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 500px; margin: 0 auto; padding: 20px;">
                <h2 style="color: #2d6a4f; margin-bottom: 24px;">Sign in to BooksIQ</h2>
                <p style="color: #1a1a1a; font-size: 16px; line-height: 1.5;">Hi ${user.name || 'there'},</p>
                <p style="color: #1a1a1a; font-size: 16px; line-height: 1.5;">
                  An admin sent you a sign-in link. Click the button below or use the code:
                </p>
                <div style="background: #f3f4f6; border-radius: 12px; padding: 20px; margin: 20px 0; text-align: center;">
                  <p style="color: #6b7280; font-size: 11px; text-transform: uppercase; letter-spacing: 1px; margin: 0 0 8px 0;">Your Login Code</p>
                  <span style="font-family: 'SF Mono', Monaco, 'Courier New', monospace; font-size: 36px; font-weight: 700; letter-spacing: 12px; color: #2d6a4f; user-select: all;">${code}</span>
                </div>
                <a href="${magicLink}" style="display: inline-block; background: #2d6a4f; color: white; padding: 14px 28px; text-decoration: none; border-radius: 8px; font-weight: 600; margin: 16px 0;">Sign In Instantly</a>
                <p style="color: #6b7280; font-size: 14px; line-height: 1.5; margin-top: 16px;">This code expires in 15 minutes.</p>
              </div>
            `
          })
        });
        if (!response.ok) {
          const errData = await response.json().catch(() => ({}));
          emailError = errData?.message || `Resend returned ${response.status}`;
        } else {
          emailSent = true;
        }
      } catch (e) {
        emailError = e.message;
      }
    } else {
      // Dev mode — surface the code so the operator can pass it to the user manually
      console.log(`[admin/send-magic-link] DEV MODE — no RESEND_API_KEY. Code for ${user.email}: ${code}`);
    }

    await logAdminAction(session.userId, 'send_magic_link', user.userId, {
      targetEmail: user.email,
      emailSent,
      emailError: emailError || undefined,
    });

    // In dev mode, return the code so the admin can copy/paste it.
    // In prod, NEVER return the code — it must only travel via email.
    const isProd = process.env.NODE_ENV === 'production' || !!process.env.RESEND_API_KEY;
    return res.status(200).json({
      success: true,
      emailSent,
      emailError,
      ...(isProd ? {} : { devCode: code }),
      message: emailSent
        ? `Magic link sent to ${user.email}`
        : (emailError
            ? `Failed to send email: ${emailError}`
            : `Code generated (dev mode — see server logs or copy from response)`),
    });

  } catch (error) {
    console.error('send-magic-link error:', error);
    return res.status(500).json({ error: 'Failed to send magic link', detail: error.message });
  }
};
