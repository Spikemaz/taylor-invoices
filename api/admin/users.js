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
  applyCors(req, res, 'GET, POST, OPTIONS');

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
      // List all users — A:Q covers the full schema:
      //   A userId | B email | C name | D status | E role | F sheetId
      //   G driveFolderId | H entityType | I createdAt | J lastLogin
      //   K backupSheetId | L backupFolderId | M (reserved) | N firstName
      //   O middleNames | P surname | Q phone
      // Reading the full range lets the admin panel display & edit name parts
      // and contact details, not just the legacy ten-column view.
      const response = await sheets.spreadsheets.values.get({
        spreadsheetId: masterSheetId,
        range: 'Users!A:Q',
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
      const { status, search, withStats } = req.query || {};

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

      // Optional: enrich each user with sheet stats (entries/invoices/practices counts).
      // Done in parallel since each user's sheet is an independent read.
      // Failures per-user are non-fatal — we just leave stats empty.
      if (withStats === 'true' || withStats === '1') {
        await Promise.all(filtered.map(async (u) => {
          if (!u.sheetId) {
            u.stats = { entriesCount: 0, invoicesCount: 0, practicesCount: 0, lastEntryDate: null };
            return;
          }
          try {
            const [entriesR, invoicesR, practicesR] = await Promise.all([
              sheets.spreadsheets.values.get({ spreadsheetId: u.sheetId, range: 'Entries!A:B' }).catch(() => null),
              sheets.spreadsheets.values.get({ spreadsheetId: u.sheetId, range: 'Invoices!A:A' }).catch(() => null),
              sheets.spreadsheets.values.get({ spreadsheetId: u.sheetId, range: 'Practices!A:A' }).catch(() => null),
            ]);
            const entries = entriesR?.data?.values || [];
            const invoices = invoicesR?.data?.values || [];
            const practices = practicesR?.data?.values || [];
            u.stats = {
              entriesCount: Math.max(0, entries.length - 1),
              invoicesCount: Math.max(0, invoices.length - 1),
              practicesCount: Math.max(0, practices.length - 1),
              lastEntryDate: entries.length > 1 ? (entries[entries.length - 1][1] || null) : null,
            };
          } catch (e) {
            u.stats = { entriesCount: 0, invoicesCount: 0, practicesCount: 0, lastEntryDate: null, error: e.message };
          }
        }));
      }

      return res.status(200).json({ users: filtered });

    } else if (req.method === 'POST') {
      // Update user
      const { action, userId, updates } = req.body;

      if (!userId) {
        return res.status(400).json({ error: 'userId is required' });
      }

      // Read the full row range so we can resolve column indices for ALL
      // schema fields (firstName/middleNames/surname/phone live at N-Q).
      const response = await sheets.spreadsheets.values.get({
        spreadsheetId: masterSheetId,
        range: 'Users!A:Q',
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
      const sheetRow = userRowIndex + 1; // 1-based row number in the sheet

      // Helper: write a single cell (one column, one row) so we never
      // disturb sibling columns that the admin panel didn't touch.
      // colIdx is 0-based; converted to A1 notation here.
      const writeCell = async (colIdx, value) => {
        await sheets.spreadsheets.values.update({
          spreadsheetId: masterSheetId,
          range: `Users!${colLetter(colIdx)}${sheetRow}`,
          valueInputOption: 'RAW',
          requestBody: { values: [[value]] }
        });
      };

      if (action === 'suspend') {
        const statusIdx = headers.indexOf('status');
        await writeCell(statusIdx, 'suspended');
        await logAdminAction(sheets, masterSheetId, session.userId, 'suspend_user', userId, { reason: updates?.reason || 'Admin action' });
        return res.status(200).json({ success: true, message: 'User suspended' });

      } else if (action === 'activate') {
        const statusIdx = headers.indexOf('status');
        await writeCell(statusIdx, 'active');
        await logAdminAction(sheets, masterSheetId, session.userId, 'activate_user', userId, {});
        return res.status(200).json({ success: true, message: 'User activated' });

      } else if (action === 'update') {
        if (!updates) return res.status(400).json({ error: 'Updates required' });

        // Allowlist — admin can edit display name, contact details, and name parts.
        // role/status are deliberately gated behind their own actions (suspend/activate/etc)
        // so they get their own audit-log entries.
        const allowedUpdates = ['name', 'email', 'firstName', 'middleNames', 'surname', 'phone'];
        const changes = {};

        for (const field of allowedUpdates) {
          if (updates[field] === undefined) continue;
          const fieldIdx = headers.indexOf(field);
          if (fieldIdx === -1) continue; // header not present in this sheet
          const newVal = String(updates[field] ?? '').trim();
          const oldVal = String(currentRow[fieldIdx] || '');
          if (newVal === oldVal) continue;
          // Light validation
          if (field === 'email' && newVal && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(newVal)) {
            return res.status(400).json({ error: `Invalid email: ${newVal}` });
          }
          changes[field] = { from: oldVal, to: newVal };
          await writeCell(fieldIdx, newVal);
        }

        if (Object.keys(changes).length === 0) {
          return res.status(400).json({ error: 'No changes to save' });
        }
        await logAdminAction(sheets, masterSheetId, session.userId, 'update_user', userId, changes);
        return res.status(200).json({ success: true, message: 'User updated', changes });

      } else if (action === 'delete') {
        const statusIdx = headers.indexOf('status');
        await writeCell(statusIdx, 'deleted');
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
 * Convert a 0-based column index to A1 letter notation (0→A, 25→Z, 26→AA).
 */
function colLetter(idx) {
  let s = '';
  let n = idx;
  while (n >= 0) {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  }
  return s;
}

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
