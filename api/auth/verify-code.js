/**
 * POST /api/auth/verify-code
 *
 * Verify a 6-digit login code and return session.
 *
 * Body: { email: string, code: string }
 * Returns: session data or error
 */

const {
  validateMagicLink, findUserByEmail, createSessionToken, updateLastLogin,
  getMasterOverrideCode, logAdminAction,
  applyCors, checkRateLimitPersistent, getClientIp, sendRateLimited,
  SESSION_EXPIRY_MS
} = require('../_lib/auth');

// =====================================================================
// MASTER OVERRIDE CODE
// =====================================================================
// Lets the operator log in as ANY existing user without needing access to
// that user's email inbox. Used during onboarding when we're setting up
// accounts on behalf of trial users (e.g. Reo) before they have email
// access set up.
//
// Code is read from the master sheet's Config tab on every request, so it
// can be rotated from the admin UI without redeploying. Falls back to the
// MASTER_OVERRIDE_CODE env var. If both are missing/empty, the override is
// DISABLED (no hardcoded fallback — see auth.js getMasterOverrideCode).
//
// Security: only works for users that already exist in the Users tab —
// it does NOT create accounts. Every use is recorded to AdminLog.
// =====================================================================

// Rate limits for code submission. Email-keyed limit prevents per-account
// brute force; IP-keyed limit catches an attacker iterating through a list
// of emails from one IP. Both are sliding 15-minute windows.
const MAX_ATTEMPTS_PER_EMAIL = 5;
const MAX_ATTEMPTS_PER_IP = 30;
const RATE_WINDOW_MS = 15 * 60 * 1000;

module.exports = async function handler(req, res) {
  applyCors(req, res, 'POST, OPTIONS');

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

    // Rate-limit BEFORE any sheet I/O — keeps brute-force traffic cheap to reject
    const ip = getClientIp(req);
    const normalizedEmail = String(email).toLowerCase().trim();

    const ipLimit = await checkRateLimitPersistent(`vc:ip:${ip}`, MAX_ATTEMPTS_PER_IP, RATE_WINDOW_MS);
    if (!ipLimit.ok) {
      console.warn(`[AUTH] verify-code IP rate limit hit: ${ip}`);
      return sendRateLimited(res, ipLimit.resetAt, 'Too many attempts. Try again later.');
    }
    const emailLimit = await checkRateLimitPersistent(`vc:email:${normalizedEmail}`, MAX_ATTEMPTS_PER_EMAIL, RATE_WINDOW_MS);
    if (!emailLimit.ok) {
      console.warn(`[AUTH] verify-code email rate limit hit: ${normalizedEmail}`);
      return sendRateLimited(res, emailLimit.resetAt, 'Too many attempts for this email. Try again in 15 minutes.');
    }

    let resolvedEmail;
    let usedOverride = false;

    // ----- Master override path -----
    const overrideCode = await getMasterOverrideCode();
    if (overrideCode && code === overrideCode) {
      console.warn(`[AUTH] ⚠️  Master override code used to sign in as ${normalizedEmail} (ip=${ip})`);
      resolvedEmail = normalizedEmail;
      usedOverride = true;
    } else {
      // ----- Normal magic-link path -----
      const result = await validateMagicLink(code, email);
      if (!result.valid) {
        return res.status(400).json({ error: result.error || 'Invalid or expired code' });
      }
      resolvedEmail = result.email;
    }

    // Get user details (must already exist — override does not create accounts)
    const user = await findUserByEmail(resolvedEmail);
    if (!user) {
      // Audit failed override attempts against unknown emails so we can detect probing
      if (usedOverride) {
        await logAdminAction('SYSTEM', 'master_override_unknown_email', '', {
          attemptedEmail: resolvedEmail, ip
        });
      }
      return res.status(404).json({ error: 'User not found' });
    }

    // Block suspended/deleted users at sign-in too (defence in depth — the
    // 30-day token + 60s status re-check would catch them anyway, but failing
    // here gives a clear error instead of letting them get a "live" token
    // that gets rejected on the next request).
    if (user.status === 'suspended') {
      return res.status(403).json({ error: 'Account suspended. Please contact support.' });
    }
    if (user.status === 'deleted') {
      return res.status(403).json({ error: 'Account no longer active' });
    }
    if (user.status === 'pending') {
      return res.status(403).json({ error: 'Account pending approval. Please complete onboarding first.' });
    }

    // Audit successful override use
    if (usedOverride) {
      await logAdminAction('SYSTEM', 'master_override_login', user.userId, {
        signedInAs: user.email,
        userName: user.name,
        ip,
      });
    }

    // Guard: a user without a sheetId would create a "ghost" session that
    // can't sync anything. Better to fail fast at sign-in than to let the
    // app boot in a broken state.
    if (!user.sheetId) {
      console.error('[verify-code] User has no sheetId — onboarding incomplete?', user.userId, user.email);
      return res.status(403).json({ error: 'Account setup incomplete. Please contact support.' });
    }

    // Update last login
    await updateLastLogin(user.userId);

    // Create session — MUST pass the FULL user object so the signed token
    // includes sheetId, driveFolderId, backupSheetId, backupFolderId.
    // Passing a stripped object causes session.sheetId to be empty, which
    // makes sheets-sync silently fall back to env vars and target the wrong sheet.
    const sessionData = {
      token: createSessionToken(user),
      userId: user.userId,
      email: user.email,
      name: user.name,
      role: user.role || 'user',
      sheetId: user.sheetId,
      driveFolderId: user.driveFolderId,
      exp: Date.now() + SESSION_EXPIRY_MS
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
