/**
 * GET /api/admin/logs
 *
 * Admin endpoint for viewing activity logs.
 * Returns recent admin actions from the AdminLog tab.
 *
 * Requires admin authentication.
 */

const { google } = require('googleapis');
const {validateSession, isAdmin, findUserById, applyCors } = require('../_lib/auth');

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

    const masterSheetId = process.env.MASTER_SHEET_ID;
    if (!masterSheetId) {
      return res.status(500).json({ error: 'Server configuration error' });
    }

    const auth = getAuthClient();
    const sheets = google.sheets({ version: 'v4', auth });

    // Get admin logs
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: masterSheetId,
      range: 'AdminLog!A:E',
    });

    const rows = response.data.values || [];

    // Check if there's a header row
    let logs = [];
    let startIdx = 0;

    if (rows.length > 0) {
      // Check if first row looks like headers
      const firstRow = rows[0];
      if (firstRow[0] === 'timestamp' || firstRow[0] === 'Timestamp') {
        startIdx = 1;
      }
    }

    // Parse logs
    for (let i = startIdx; i < rows.length; i++) {
      const row = rows[i];
      if (!row[0]) continue; // Skip empty rows

      logs.push({
        timestamp: row[0],
        adminId: row[1] || '',
        action: row[2] || '',
        targetUserId: row[3] || '',
        details: row[4] ? JSON.parse(row[4]) : {}
      });
    }

    // Sort by timestamp descending (most recent first)
    logs.sort((a, b) => {
      const dateA = new Date(a.timestamp || 0);
      const dateB = new Date(b.timestamp || 0);
      return dateB - dateA;
    });

    // Limit to last 100 entries
    logs = logs.slice(0, 100);

    // Enrich with user names (batch lookup)
    const userIds = new Set([
      ...logs.map(l => l.adminId).filter(Boolean),
      ...logs.map(l => l.targetUserId).filter(Boolean)
    ]);

    const userNames = {};

    // Get all users for name lookup
    const usersResponse = await sheets.spreadsheets.values.get({
      spreadsheetId: masterSheetId,
      range: 'Users!A:C',
    });

    const userRows = usersResponse.data.values || [];
    if (userRows.length > 1) {
      const headers = userRows[0];
      const userIdIdx = headers.indexOf('userId');
      const nameIdx = headers.indexOf('name');

      for (let i = 1; i < userRows.length; i++) {
        const id = userRows[i][userIdIdx];
        const name = userRows[i][nameIdx];
        if (id && name) {
          userNames[id] = name;
        }
      }
    }

    // Add names to logs
    logs = logs.map(log => ({
      ...log,
      adminName: userNames[log.adminId] || 'Unknown',
      targetUserName: userNames[log.targetUserId] || 'Unknown'
    }));

    // Apply filters
    const { action, limit } = req.query || {};

    if (action) {
      logs = logs.filter(l => l.action === action);
    }

    if (limit) {
      logs = logs.slice(0, parseInt(limit, 10));
    }

    return res.status(200).json({ logs });

  } catch (error) {
    console.error('Admin logs error:', error);
    return res.status(500).json({
      error: 'Failed to fetch logs',
      details: error.message
    });
  }
};
