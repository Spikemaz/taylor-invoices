/**
 * POST /api/admin/fix-headers
 *
 * Admin-only endpoint to fix/update all Google Sheets headers.
 * Updates headers for:
 * - All user sheets (from Master Sheet Users tab)
 * - Master Sheet central tabs
 *
 * This ensures all sheets have the correct column headers.
 */

const { google } = require('googleapis');
const {validateSession, isAdmin, applyCors, getAuthClient } = require('../_lib/auth');

const ENTRY_COLUMNS = ['id', 'date', 'pId', 'pName', 'pType', 'svc', 'pts', 'uPrice', 'aoType', 'aoAmt', 'aoPatients', 'gross', 'comm', 'commAmt', 'entity', 'invSt', 'invNo', 'adhocAddr', 'color', 'createdAt'];
const INVOICE_COLUMNS = ['num', 'date', 'practice', 'practiceName', 'practiceAddr', 'period', 'entity', 'entName', 'entAddr', 'entPhone', 'bankName', 'bankAccName', 'bankAcc', 'bankSort', 'amount', 'gross', 'commRate', 'svcs', 'addons', 'airTotal', 'logoType', 'payTerms', 'footerMsg', 'companyNo', 'isAdhoc', 'driveLink', 'paidStatus', 'paidDate', 'createdAt'];
const PRACTICE_COLUMNS = ['id', 'short', 'name', 'type', 'addr', 'email', 'comm', 'services', 'days', 'rate', 'air', 'active', 'color', 'paidHours', 'ptsPerHour', 'paymentDueDay', 'createdAt'];
const SETTINGS_COLUMNS = ['key', 'value', 'updatedAt'];
const LOG_COLUMNS = ['timestamp', 'action', 'dataType', 'recordId', 'changes', 'previousData', 'newData'];
const TRASH_COLUMNS = ['deletedAt', 'dataType', 'originalData'];

const USERS_COLUMNS = ['userId', 'email', 'name', 'status', 'role', 'sheetId', 'driveFolderId', 'entityType', 'createdAt', 'lastLogin', 'consentedAt', 'backupSheetId', 'backupFolderId'];
const MAGIC_LINKS_COLUMNS = ['token', 'email', 'createdAt', 'expiresAt', 'used', 'code'];
const ADMIN_LOG_COLUMNS = ['timestamp', 'adminId', 'action', 'targetUserId', 'details'];
const ALL_ENTRIES_COLUMNS = ['userId', ...ENTRY_COLUMNS];
const ALL_INVOICES_COLUMNS = ['userId', ...INVOICE_COLUMNS];
const DELETED_ENTRIES_COLUMNS = ['deletedAt', 'userId', 'entryId', 'originalData'];

module.exports = async function handler(req, res) {
  // CORS headers
  applyCors(req, res, 'POST, OPTIONS');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
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
      return res.status(500).json({ error: 'MASTER_SHEET_ID not configured' });
    }

    const auth = getAuthClient();
    const sheets = google.sheets({ version: 'v4', auth });

    const results = {
      masterSheet: {},
      userSheets: [],
      errors: []
    };

    // ========== FIX MASTER SHEET HEADERS ==========
    console.log('[fix-headers] Updating Master Sheet headers...');

    const masterTabs = [
      { name: 'Users', columns: USERS_COLUMNS, range: 'A1:M1' },
      { name: 'MagicLinks', columns: MAGIC_LINKS_COLUMNS, range: 'A1:F1' },
      { name: 'AdminLog', columns: ADMIN_LOG_COLUMNS, range: 'A1:E1' },
      { name: 'AllEntries', columns: ALL_ENTRIES_COLUMNS, range: 'A1:U1' },
      { name: 'AllInvoices', columns: ALL_INVOICES_COLUMNS, range: 'A1:AD1' },
      { name: 'DeletedEntries', columns: DELETED_ENTRIES_COLUMNS, range: 'A1:D1' }
    ];

    for (const tab of masterTabs) {
      try {
        await sheets.spreadsheets.values.update({
          spreadsheetId: masterSheetId,
          range: `${tab.name}!${tab.range}`,
          valueInputOption: 'RAW',
          requestBody: { values: [tab.columns] }
        });
        results.masterSheet[tab.name] = 'updated';
        console.log(`[fix-headers] Updated ${tab.name} headers (${tab.columns.length} columns)`);
      } catch (e) {
        results.masterSheet[tab.name] = `error: ${e.message}`;
        results.errors.push(`Master/${tab.name}: ${e.message}`);
        console.error(`[fix-headers] Error updating ${tab.name}:`, e.message);
      }
    }

    // ========== GET ALL USER SHEETS ==========
    console.log('[fix-headers] Fetching user list...');

    const usersResponse = await sheets.spreadsheets.values.get({
      spreadsheetId: masterSheetId,
      range: 'Users!A:M'
    });

    const rows = usersResponse.data.values || [];
    if (rows.length < 2) {
      return res.status(200).json({
        success: true,
        message: 'Master sheet headers updated. No user sheets to update.',
        results
      });
    }

    const headers = rows[0];
    const sheetIdIdx = headers.indexOf('sheetId');
    const backupSheetIdIdx = headers.indexOf('backupSheetId');
    const emailIdx = headers.indexOf('email');
    const statusIdx = headers.indexOf('status');

    // Collect all sheet IDs to update
    const sheetsToUpdate = [];
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      const email = row[emailIdx] || '';
      const status = row[statusIdx] || '';

      // Only update active users
      if (status !== 'active') continue;

      const userSheetId = row[sheetIdIdx];
      const backupSheetId = row[backupSheetIdIdx];

      if (userSheetId) {
        sheetsToUpdate.push({ id: userSheetId, email, type: 'user' });
      }
      if (backupSheetId) {
        sheetsToUpdate.push({ id: backupSheetId, email, type: 'backup' });
      }
    }

    console.log(`[fix-headers] Found ${sheetsToUpdate.length} sheets to update`);

    // ========== FIX USER SHEET HEADERS ==========
    const userTabs = [
      { name: 'Entries', columns: ENTRY_COLUMNS, range: 'A1:T1' },
      { name: 'Invoices', columns: INVOICE_COLUMNS, range: 'A1:AC1' },
      { name: 'Practices', columns: PRACTICE_COLUMNS, range: 'A1:Q1' },
      { name: 'Settings', columns: SETTINGS_COLUMNS, range: 'A1:C1' },
      { name: 'Log', columns: LOG_COLUMNS, range: 'A1:G1' },
      { name: 'Trash', columns: TRASH_COLUMNS, range: 'A1:C1' }
    ];

    for (const sheet of sheetsToUpdate) {
      const sheetResult = { email: sheet.email, type: sheet.type, tabs: {} };

      for (const tab of userTabs) {
        try {
          await sheets.spreadsheets.values.update({
            spreadsheetId: sheet.id,
            range: `${tab.name}!${tab.range}`,
            valueInputOption: 'RAW',
            requestBody: { values: [tab.columns] }
          });
          sheetResult.tabs[tab.name] = 'updated';
        } catch (e) {
          // Tab might not exist - that's ok for some older sheets
          sheetResult.tabs[tab.name] = `error: ${e.message}`;
          if (!e.message.includes('Unable to parse range')) {
            results.errors.push(`${sheet.email}/${tab.name}: ${e.message}`);
          }
        }
      }

      results.userSheets.push(sheetResult);
      console.log(`[fix-headers] Updated headers for ${sheet.email} (${sheet.type})`);
    }

    console.log('[fix-headers] Complete!');

    return res.status(200).json({
      success: true,
      message: `Updated headers for Master Sheet and ${sheetsToUpdate.length} user sheets`,
      results
    });

  } catch (error) {
    console.error('[fix-headers] Error:', error);
    return res.status(500).json({
      error: 'Failed to fix headers',
      details: error.message
    });
  }
};
