/**
 * GET /api/admin/user?userId=xxx
 *
 * Admin endpoint for getting detailed user information.
 * Returns user data plus their sheet statistics.
 *
 * Requires admin authentication.
 */

const { google } = require('googleapis');
const {validateSession, isAdmin, applyCors } = require('../_lib/auth');

// Get auth client
function getAuthClient() {
  return new google.auth.GoogleAuth({
    credentials: {
      client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      private_key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    },
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
}

module.exports = async function handler(req, res) {
  // CORS headers
  applyCors(req, res, 'GET, OPTIONS');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // Validate admin session
    const session = await validateSession(req);
    if (!session) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    if (!isAdmin(session.email)) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const { userId } = req.query || {};

    if (!userId) {
      return res.status(400).json({ error: 'userId is required' });
    }

    const masterSheetId = process.env.MASTER_SHEET_ID;
    if (!masterSheetId) {
      return res.status(500).json({ error: 'Server configuration error' });
    }

    const auth = getAuthClient();
    const sheets = google.sheets({ version: 'v4', auth });

    // Get user from Master Sheet
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: masterSheetId,
      range: 'Users!A:J',
    });

    const rows = response.data.values || [];
    if (rows.length <= 1) {
      return res.status(404).json({ error: 'User not found' });
    }

    const headers = rows[0];
    let user = null;

    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      const rowUserId = row[headers.indexOf('userId')];
      if (rowUserId === userId) {
        user = {};
        headers.forEach((h, idx) => {
          user[h] = row[idx] || '';
        });
        break;
      }
    }

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Get user's sheet statistics
    let stats = {
      entriesCount: 0,
      invoicesCount: 0,
      practicesCount: 0,
      lastEntryDate: null
    };

    if (user.sheetId) {
      try {
        // Get entries count
        const entriesResp = await sheets.spreadsheets.values.get({
          spreadsheetId: user.sheetId,
          range: 'Entries!A:B',
        });
        const entries = entriesResp.data.values || [];
        stats.entriesCount = Math.max(0, entries.length - 1); // Exclude header

        if (entries.length > 1) {
          // Get last entry date (assuming date is in column B)
          const lastEntry = entries[entries.length - 1];
          stats.lastEntryDate = lastEntry[1] || null;
        }

        // Get invoices count
        const invoicesResp = await sheets.spreadsheets.values.get({
          spreadsheetId: user.sheetId,
          range: 'Invoices!A:A',
        });
        const invoices = invoicesResp.data.values || [];
        stats.invoicesCount = Math.max(0, invoices.length - 1);

        // Get practices count
        const practicesResp = await sheets.spreadsheets.values.get({
          spreadsheetId: user.sheetId,
          range: 'Practices!A:A',
        });
        const practices = practicesResp.data.values || [];
        stats.practicesCount = Math.max(0, practices.length - 1);

      } catch (e) {
        // Sheet might not be accessible or doesn't exist
        console.error('Error fetching user sheet stats:', e.message);
      }
    }

    // Get recent activity for this user from AdminLog
    let recentActivity = [];
    try {
      const logsResp = await sheets.spreadsheets.values.get({
        spreadsheetId: masterSheetId,
        range: 'AdminLog!A:E',
      });
      const logs = logsResp.data.values || [];

      for (let i = 1; i < logs.length; i++) {
        const log = logs[i];
        if (log[3] === userId) { // targetUserId column
          recentActivity.push({
            timestamp: log[0],
            action: log[2],
            details: log[4] ? JSON.parse(log[4]) : {}
          });
        }
      }

      // Sort by timestamp desc and limit
      recentActivity.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
      recentActivity = recentActivity.slice(0, 10);
    } catch (e) {
      // Ignore errors fetching activity
    }

    return res.status(200).json({
      user,
      stats,
      recentActivity
    });

  } catch (error) {
    console.error('Admin user detail error:', error);
    return res.status(500).json({
      error: 'Failed to fetch user details',
      details: error.message
    });
  }
};
