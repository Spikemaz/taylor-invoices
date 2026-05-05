/**
 * POST /api/auth/request-magic-link
 *
 * Request a magic link for email login.
 *
 * Body: { email: string }
 * Returns: { success: true } or { error: string }
 */

const {
  findUserByEmail, generateToken, generateCode, storeMagicLink,
  applyCors, checkRateLimitPersistent, getClientIp, sendRateLimited
} = require('../_lib/auth');

// Rate limits for magic-link requests. Tighter than verify-code because
// each request sends a real email (cost) and shows up in the user's inbox
// (annoyance). Per-email is the dominant control; per-IP catches scripted
// abuse across many emails.
const MAX_REQUESTS_PER_EMAIL = 3;
const EMAIL_WINDOW_MS = 15 * 60 * 1000;
const MAX_REQUESTS_PER_IP = 10;
const IP_WINDOW_MS = 60 * 60 * 1000;

module.exports = async function handler(req, res) {
  applyCors(req, res, 'POST, OPTIONS');

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

    // Rate-limit BEFORE the user lookup. Per-IP first so an attacker
    // iterating through emails from one IP gets stopped without us hitting
    // the Sheets API for each lookup.
    const ip = getClientIp(req);
    const ipLimit = await checkRateLimitPersistent(`rml:ip:${ip}`, MAX_REQUESTS_PER_IP, IP_WINDOW_MS);
    if (!ipLimit.ok) {
      console.warn(`[AUTH] request-magic-link IP rate limit hit: ${ip}`);
      return sendRateLimited(res, ipLimit.resetAt, 'Too many requests. Please try again later.');
    }
    const emailLimit = await checkRateLimitPersistent(`rml:email:${normalizedEmail}`, MAX_REQUESTS_PER_EMAIL, EMAIL_WINDOW_MS);
    if (!emailLimit.ok) {
      console.warn(`[AUTH] request-magic-link email rate limit hit: ${normalizedEmail}`);
      // Generic message — don't confirm the email exists
      return sendRateLimited(res, emailLimit.resetAt, 'Too many requests. Please check your inbox or try again in 15 minutes.');
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

    // Generate and store magic link token + 6-digit code
    const token = generateToken();
    const code = generateCode();
    await storeMagicLink(normalizedEmail, token, code);

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
                Click the button below to sign in, or tap your code to copy it:
              </p>
              <div style="background: #f3f4f6; border-radius: 12px; padding: 20px; margin: 20px 0; text-align: center; cursor: pointer;" onclick="navigator.clipboard?.writeText('${code}')">
                <p style="color: #6b7280; font-size: 11px; text-transform: uppercase; letter-spacing: 1px; margin: 0 0 8px 0;">Your Login Code (tap to copy)</p>
                <span style="font-family: 'SF Mono', Monaco, 'Courier New', monospace; font-size: 36px; font-weight: 700; letter-spacing: 12px; color: #2d6a4f; user-select: all;">${code}</span>
              </div>
              <a href="${magicLink}"
                 style="display: inline-block; background: #2d6a4f; color: white; padding: 14px 28px; text-decoration: none; border-radius: 8px; font-weight: 600; margin: 16px 0;">
                Sign In Instantly
              </a>
              <p style="color: #6b7280; font-size: 14px; line-height: 1.5; margin-top: 16px;">
                This code expires in 15 minutes. If you didn't request this, you can safely ignore this email.
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
      // Development mode - log the link and code
      console.log('='.repeat(60));
      console.log('MAGIC LINK (Resend API key not configured):');
      console.log(magicLink);
      console.log('CODE:', code);
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
