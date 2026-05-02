/**
 * GET/POST /api/admin/master-override
 *
 * GET  → returns the current master override code (the magic code that lets
 *        the operator sign in as any existing user without email access).
 * POST → rotates the code. Body: { code: string }
 *
 * Both require admin session. The code lives in the master sheet's Config tab
 * so it can be rotated from the admin UI without redeploying.
 *
 * SECURITY: this endpoint exposes a code that grants login-as-anyone power.
 * Admin-only is enforced. Set MASTER_OVERRIDE_CODE='' (empty) in env or
 * blank the Config row to disable the override entirely.
 */

const {validateSession, isAdmin, getMasterOverrideCode, setConfigValue, logAdminAction, applyCors } = require('../_lib/auth');

module.exports = async function handler(req, res) {
  applyCors(req, res, 'GET, POST, OPTIONS');

  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const session = await validateSession(req);
    if (!session) return res.status(401).json({ error: 'Authentication required' });
    if (!isAdmin(session.email)) return res.status(403).json({ error: 'Admin access required' });

    if (req.method === 'GET') {
      const code = await getMasterOverrideCode();
      return res.status(200).json({
        code: code || '',
        enabled: !!(code && code.length > 0),
      });
    }

    if (req.method === 'POST') {
      const { code } = req.body || {};

      // Allow blank string to DISABLE the override entirely
      if (code === undefined || code === null) {
        return res.status(400).json({ error: 'code field is required (use empty string to disable)' });
      }

      const trimmed = String(code).trim();

      // If non-empty, validate format
      if (trimmed.length > 0) {
        if (!/^\d{4,12}$/.test(trimmed)) {
          return res.status(400).json({ error: 'Code must be 4-12 digits' });
        }
      }

      await setConfigValue('masterOverrideCode', trimmed, session.email || session.userId);
      await logAdminAction(
        session.userId,
        trimmed.length === 0 ? 'override_code_disabled' : 'override_code_rotated',
        '',
        { byEmail: session.email, codeLength: trimmed.length }
      );

      return res.status(200).json({
        success: true,
        enabled: trimmed.length > 0,
        message: trimmed.length === 0 ? 'Master override disabled' : 'Master override code updated',
      });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (error) {
    console.error('master-override error:', error);
    return res.status(500).json({ error: 'Failed to process request', detail: error.message });
  }
};
