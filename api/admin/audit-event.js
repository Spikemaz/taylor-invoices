/**
 * POST /api/admin/audit-event
 *
 * Generic audit logger for the admin UI. Lets the client record events that
 * have no natural backend write — currently used to log impersonation
 * switches (admin viewing as another user) which are entirely client-side
 * state changes but should still leave a paper trail.
 *
 * Body: { action: string, targetUserId?: string, details?: object }
 * Requires admin session.
 */

const {validateSession, isAdmin, logAdminAction, applyCors } = require('../_lib/auth');

const ALLOWED_ACTIONS = new Set([
  'impersonate_user',
  'stop_impersonating',
  'view_audit_log',
  'view_user_details',
]);

module.exports = async function handler(req, res) {
  applyCors(req, res, 'POST, OPTIONS');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const session = await validateSession(req);
    if (!session) return res.status(401).json({ error: 'Authentication required' });
    if (!isAdmin(session.email)) return res.status(403).json({ error: 'Admin access required' });

    const { action, targetUserId, details } = req.body || {};
    if (!action || typeof action !== 'string') {
      return res.status(400).json({ error: 'action is required' });
    }
    if (!ALLOWED_ACTIONS.has(action)) {
      return res.status(400).json({ error: `Action "${action}" is not allowed for client logging` });
    }

    await logAdminAction(session.userId, action, targetUserId || '', details || {});
    return res.status(200).json({ success: true });
  } catch (error) {
    console.error('audit-event error:', error);
    return res.status(500).json({ error: 'Failed to log event' });
  }
};
