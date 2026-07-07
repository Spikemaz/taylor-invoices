/**
 * GET /api/admin/health
 *
 * System health check for the admin panel. Returns at-a-glance status of:
 *   - environment configuration (which secrets are present)
 *   - Google Sheets API + Master sheet reachability
 *   - Resend email configuration
 *   - aggregate counts (users by status, admins, etc.)
 *
 * Never returns the actual values of any secret — only presence flags.
 *
 * Requires admin authentication.
 */

const { google } = require('googleapis');
const {validateSession, isAdmin, applyCors, getAuthClient } = require('../_lib/auth');

module.exports = async function handler(req, res) {
  applyCors(req, res, 'GET, OPTIONS');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const session = await validateSession(req);
    if (!session) return res.status(401).json({ error: 'Authentication required' });
    if (!isAdmin(session.email)) return res.status(403).json({ error: 'Admin access required' });

    // Env presence flags only — NEVER return the values themselves.
    const env = {
      MASTER_SHEET_ID: !!process.env.MASTER_SHEET_ID,
      GOOGLE_SERVICE_ACCOUNT_EMAIL: !!process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      GOOGLE_PRIVATE_KEY: !!process.env.GOOGLE_PRIVATE_KEY,
      SESSION_SECRET: !!process.env.SESSION_SECRET,
      RESEND_API_KEY: !!process.env.RESEND_API_KEY,
      EMAIL_FROM: !!process.env.EMAIL_FROM,
      ADMIN_EMAILS: !!process.env.ADMIN_EMAILS,
    };

    // Try a real read against the Master sheet to confirm Sheets API works.
    let masterSheet = { ok: false, error: null, rowsRead: 0 };
    let userCounts = { active: 0, suspended: 0, deleted: 0, pending: 0, total: 0, admins: 0 };
    try {
      const auth = getAuthClient();
      const sheets = google.sheets({ version: 'v4', auth });
      const r = await sheets.spreadsheets.values.get({
        spreadsheetId: process.env.MASTER_SHEET_ID,
        range: 'Users!A:E',
      });
      const rows = r.data.values || [];
      masterSheet.ok = true;
      masterSheet.rowsRead = rows.length;

      const headers = rows[0] || [];
      const statusIdx = headers.indexOf('status');
      const roleIdx = headers.indexOf('role');
      for (let i = 1; i < rows.length; i++) {
        const status = (rows[i][statusIdx] || 'active').toLowerCase();
        const role = (rows[i][roleIdx] || '').toLowerCase();
        userCounts.total++;
        if (userCounts[status] !== undefined) userCounts[status]++;
        if (role === 'admin') userCounts.admins++;
      }
    } catch (e) {
      masterSheet.ok = false;
      masterSheet.error = e.message;
    }

    // Resend health: presence + key prefix sanity check (Resend keys start with "re_").
    // We deliberately do NOT send a test email — that would cost a send and spam the
    // inbox each time the admin opens the panel.
    const resend = {
      configured: env.RESEND_API_KEY && env.EMAIL_FROM,
      keyPrefixOk: (process.env.RESEND_API_KEY || '').startsWith('re_'),
      fromAddress: process.env.EMAIL_FROM ? maskEmail(process.env.EMAIL_FROM) : null,
    };

    // Overall green/yellow/red rollup
    const critical = !env.MASTER_SHEET_ID || !env.GOOGLE_SERVICE_ACCOUNT_EMAIL ||
                     !env.GOOGLE_PRIVATE_KEY || !env.SESSION_SECRET || !masterSheet.ok;
    const warning = !resend.configured || !resend.keyPrefixOk;
    const status = critical ? 'critical' : (warning ? 'warning' : 'ok');

    return res.status(200).json({
      status,
      env,
      masterSheet,
      resend,
      userCounts,
      checkedAt: new Date().toISOString(),
    });
  } catch (e) {
    console.error('[admin/health] error:', e);
    return res.status(500).json({ error: 'Health check failed', details: e.message });
  }
};

// Mask an email like "support@booksiq.app" → "s******@booksiq.app"
function maskEmail(e) {
  const [local, domain] = String(e).split('@');
  if (!domain) return '***';
  const visible = local.slice(0, 1);
  return visible + '*'.repeat(Math.max(1, local.length - 1)) + '@' + domain;
}
