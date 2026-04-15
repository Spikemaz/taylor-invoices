/**
 * GET/POST /api/admin/users
 *
 * Admin endpoint for user management.
 * GET: List all users (with optional filters)
 * POST: Update user details or status
 *
 * Requires admin authentication.
 */

const { google } = require('googleapis');
const { validateSession, isAdmin } = require('../_lib/auth');

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
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Session-Token');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
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

    if (req.method === 'GET') {
      // List all users
      const response = await sheets.spreadsheets.values.get({
        spreadsheetId: masterSheetId,
        range: 'Users!A:J',
      });

      const rows = response.data.values || [];
      if (rows.length <= 1) {
        return res.status(200).json({ users: [] });
      }

      const headers = rows[0];
      const users = rows.slice(1).map(row => {
        const user = {};
        headers.forEach((h, i) => {
          user[h] = row[i] || '';
        });
        return user;
      });

      // Apply filters from query params
      let filtered = users;
      const { status, search } = req.query || {};

      if (status && status !== 'all') {
        filtered = filtered.filter(u => u.status === status);
      }

      if (search) {
        const searchLower = search.toLowerCase();
        filtered = filtered.filter(u =>
          u.name?.toLowerCase().includes(searchLower) ||
          u.email?.toLowerCase().includes(searchLower)
        );
      }

      // Sort by createdAt desc
      filtered.sort((a, b) => {
        const dateA = new Date(a.createdAt || 0);
        const dateB = new Date(b.createdAt || 0);
        return dateB - dateA;
      });

      return res.status(200).json({ users: filtered });

    } else if (req.method === 'POST') {
      // Update user
      const { action, userId, updates } = req.body;

      if (!userId) {
        return res.status(400).json({ error: 'userId is required' });
      }

      // Get users to find the row
      const response = await sheets.spreadsheets.values.get({
        spreadsheetId: masterSheetId,
        range: 'Users!A:J',
      });

      const rows = response.data.values || [];
      if (rows.length <= 1) {
        return res.status(404).json({ error: 'User not found' });
      }

      const headers = rows[0];
      const userIdIdx = headers.indexOf('userId');
      let userRowIndex = -1;

      for (let i = 1; i < rows.length; i++) {
        if (rows[i][userIdIdx] === userId) {
          userRowIndex = i;
          break;
        }
      }

      if (userRowIndex === -1) {
        return res.status(404).json({ error: 'User not found' });
      }

      const currentRow = rows[userRowIndex];

      if (action === 'suspend') {
        // Update status to suspended
        const statusIdx = headers.indexOf('status');
        currentRow[statusIdx] = 'suspended';

        await sheets.spreadsheets.values.update({
          spreadsheetId: masterSheetId,
          range: `Users!A${userRowIndex + 1}:J${userRowIndex + 1}`,
          valueInputOption: 'RAW',
          requestBody: { values: [currentRow] }
        });

        // Log admin action
        await logAdminAction(sheets, masterSheetId, session.userId, 'suspend_user', userId, { reason: updates?.reason || 'Admin action' });

        return res.status(200).json({ success: true, message: 'User suspended' });

      } else if (action === 'activate') {
        // Update status to active
        const statusIdx = headers.indexOf('status');
        currentRow[statusIdx] = 'active';

        await sheets.spreadsheets.values.update({
          spreadsheetId: masterSheetId,
          range: `Users!A${userRowIndex + 1}:J${userRowIndex + 1}`,
          valueInputOption: 'RAW',
          requestBody: { values: [currentRow] }
        });

        await logAdminAction(sheets, masterSheetId, session.userId, 'activate_user', userId, {});

        return res.status(200).json({ success: true, message: 'User activated' });

      } else if (action === 'update') {
        // Update user fields
        if (!updates) {
          return res.status(400).json({ error: 'Updates required' });
        }

        // Only allow updating certain fields
        const allowedUpdates = ['name', 'role', 'status'];
        const changes = {};

        for (const field of allowedUpdates) {
          if (updates[field] !== undefined) {
            const fieldIdx = headers.indexOf(field);
            if (fieldIdx !== -1) {
              changes[field] = { from: currentRow[fieldIdx], to: updates[field] };
              currentRow[fieldIdx] = updates[field];
            }
          }
        }

        if (Object.keys(changes).length === 0) {
          return res.status(400).json({ error: 'No valid updates provided' });
        }

        await sheets.spreadsheets.values.update({
          spreadsheetId: masterSheetId,
          range: `Users!A${userRowIndex + 1}:J${userRowIndex + 1}`,
          valueInputOption: 'RAW',
          requestBody: { values: [currentRow] }
        });

        await logAdminAction(sheets, masterSheetId, session.userId, 'update_user', userId, changes);

        return res.status(200).json({ success: true, message: 'User updated', changes });

      } else if (action === 'delete') {
        // Delete user (soft delete - change status to deleted)
        const statusIdx = headers.indexOf('status');
        currentRow[statusIdx] = 'deleted';

        await sheets.spreadsheets.values.update({
          spreadsheetId: masterSheetId,
          range: `Users!A${userRowIndex + 1}:J${userRowIndex + 1}`,
          valueInputOption: 'RAW',
          requestBody: { values: [currentRow] }
        });

        await logAdminAction(sheets, masterSheetId, session.userId, 'delete_user', userId, {});

        return res.status(200).json({ success: true, message: 'User deleted' });

      } else {
        return res.status(400).json({ error: 'Invalid action' });
      }

    } else {
      return res.status(405).json({ error: 'Method not allowed' });
    }

  } catch (error) {
    console.error('Admin users error:', error);
    return res.status(500).json({
      error: 'Failed to process request',
      details: error.message
    });
  }
};

/**
 * Log admin action to AdminLog tab
 */
async function logAdminAction(sheets, masterSheetId, adminId, action, targetUserId, details) {
  try {
    await sheets.spreadsheets.values.append({
      spreadsheetId: masterSheetId,
      range: 'AdminLog!A:E',
      valueInputOption: 'RAW',
      requestBody: {
        values: [[
          new Date().toISOString(),
          adminId,
          action,
          targetUserId,
          JSON.stringify(details)
        ]]
      }
    });
  } catch (error) {
    console.error('Failed to log admin action:', error);
    // Don't fail the main operation if logging fails
  }
}
