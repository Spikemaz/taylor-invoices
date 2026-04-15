/**
 * POST /api/auth/request-magic-link
 *
 * Request a magic link for email login.
 *
 * Body: { email: string }
 * Returns: { success: true } or { error: string }
 */

const { findUserByEmail, generateToken, storeMagicLink } = require('../_lib/auth');

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
    const { email } = req.body;

    if (!email || typeof email !== 'string') {
      return res.status(400).json({ error: 'Email is required' });
    }

    const normalizedEmail = email.toLowerCase().trim();

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(normalizedEmail)) {
      return res.status(400).json({ error: 'Invalid email format' });
    }

    // Check if user exists
    const user = await findUserByEmail(normalizedEmail);

    if (!user) {
      // Don't reveal if user exists or not for security
      // But we won't send an email
      console.log(`Magic link requested for non-existent user: ${normalizedEmail}`);
      // Still return success to prevent email enumeration
      return res.status(200).json({
        success: true,
        message: 'If your email is registered, you will receive a magic link shortly.'
      });
    }

    // Check user status
    if (user.status === 'suspended') {
      return res.status(403).json({ error: 'Account suspended. Please contact support.' });
    }

    if (user.status === 'pending') {
      return res.status(403).json({ error: 'Account pending approval. Please complete onboarding first.' });
    }

    // Generate and store magic link token
    const token = generateToken();
    await storeMagicLink(normalizedEmail, token);

    // Build magic link URL
    const baseUrl = process.env.APP_URL || `https://${req.headers.host}`;
    const magicLink = `${baseUrl}/api/auth/verify?token=${token}`;

    // Send email via Resend
    if (process.env.RESEND_API_KEY) {
      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          from: process.env.EMAIL_FROM || 'BooksIQ <noreply@booksiq.app>',
          to: normalizedEmail,
          subject: 'Your BooksIQ Login Link',
          html: `
            <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 500px; margin: 0 auto; padding: 20px;">
              <h2 style="color: #2d6a4f; margin-bottom: 24px;">Sign in to BooksIQ</h2>
              <p style="color: #1a1a1a; font-size: 16px; line-height: 1.5;">
                Hi ${user.name || 'there'},
              </p>
              <p style="color: #1a1a1a; font-size: 16px; line-height: 1.5;">
                Click the button below to sign in to your BooksIQ account. This link will expire in 15 minutes.
              </p>
              <a href="${magicLink}"
                 style="display: inline-block; background: #2d6a4f; color: white; padding: 14px 28px; text-decoration: none; border-radius: 8px; font-weight: 600; margin: 24px 0;">
                Sign In
              </a>
              <p style="color: #6b7280; font-size: 14px; line-height: 1.5;">
                If you didn't request this link, you can safely ignore this email.
              </p>
              <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 24px 0;">
              <p style="color: #9ca3af; font-size: 12px;">
                BooksIQ - Invoice Management for Healthcare Professionals
              </p>
            </div>
          `
        })
      });

      if (!response.ok) {
        const errorData = await response.json();
        console.error('Resend API error:', errorData);
        return res.status(500).json({ error: 'Failed to send email. Please try again.' });
      }
    } else {
      // Development mode - log the link
      console.log('='.repeat(60));
      console.log('MAGIC LINK (Resend API key not configured):');
      console.log(magicLink);
      console.log('='.repeat(60));
    }

    return res.status(200).json({
      success: true,
      message: 'If your email is registered, you will receive a magic link shortly.'
    });

  } catch (error) {
    console.error('Magic link request error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
