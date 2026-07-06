// Google Sheets sync endpoint
// Actions: append_entry, append_invoice, update_entry, delete_entry, load_all, etc.
// Supports dual sheets: Self-Employed and Ltd Company
// Multi-user support: Uses session token to route to user-specific sheets

const { google } = require('googleapis');
const {
  validateSessionToken, applyCors, requireSession, auditAdminOverride,
  getAuthClient,
} = require('./_lib/auth');
const {
  extractDriveFileId,
  deriveYearMonthForFolder,
  inferInvoiceFileName,
  findFolderByName,
  findMirrorPdfId,
} = require('./_lib/pdf-mirror');

// Set of action names that mutate user data — used to decide whether an
// admin's override-header use should be audited. Read-only loads are noisy
// and uninteresting (the impersonation start/stop already shows intent).
const WRITE_ACTIONS = new Set([
  'append_entry', 'append_invoice', 'update_entry', 'batch_update_entries',
  'delete_entry', 'update_invoice', 'update_invoice_status', 'delete_invoice',
  'sync_entries', 'sync_invoices', 'sync_practices', 'sync_settings',
  'rename_sheet', 'setup_log_tab', 'setup_tabs',
  'trigger_pdf_regeneration', 'queue_pdf_deletion'
]);

// Master Sheet ID for central backup (mirror mode)
const MASTER_SHEET_ID = process.env.MASTER_SHEET_ID;

// Mirror entry to Master Sheet's AllEntries tab
async function mirrorEntryToMaster(sheets, userId, entry) {
  if (!MASTER_SHEET_ID) return;
  try {
    const row = [userId, ...ENTRY_COLUMNS.map(col => {
      if (col === 'createdAt') return entry.createdAt || new Date().toISOString();
      const val = entry[col];
      if (val === null || val === undefined) return '';
      if (typeof val === 'object') return JSON.stringify(val);
      return val;
    })];

    await sheets.spreadsheets.values.append({
      spreadsheetId: MASTER_SHEET_ID,
      range: 'AllEntries!A:U',
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [row] }
    });
  } catch (e) {
    console.error('[Mirror] Failed to mirror entry to Master Sheet:', e.message);
  }
}

// Mirror invoice to Master Sheet's AllInvoices tab
async function mirrorInvoiceToMaster(sheets, userId, invoice) {
  if (!MASTER_SHEET_ID) return;
  try {
    const row = [userId, ...INVOICE_COLUMNS.map(col => {
      if (col === 'createdAt') return invoice.createdAt || new Date().toISOString();
      const val = invoice[col];
      if (val === null || val === undefined) return '';
      if (typeof val === 'object') return JSON.stringify(val);
      return val;
    })];

    await sheets.spreadsheets.values.append({
      spreadsheetId: MASTER_SHEET_ID,
      range: 'AllInvoices!A:AD',
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [row] }
    });
  } catch (e) {
    console.error('[Mirror] Failed to mirror invoice to Master Sheet:', e.message);
  }
}

// Update mirrored entry in Master Sheet
async function updateMirroredEntry(sheets, entryId, updates) {
  if (!MASTER_SHEET_ID) return;
  try {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: MASTER_SHEET_ID,
      range: 'AllEntries!A:U',
    });
    const rows = response.data.values || [];
    // Find by entry ID (column B, index 1)
    const rowIndex = rows.findIndex(row => row[1] === entryId);
    if (rowIndex === -1) return;

    const currentRow = rows[rowIndex];
    const updatedRow = currentRow.map((val, i) => {
      if (i === 0) return val; // Keep userId
      const col = ENTRY_COLUMNS[i - 1];
      if (updates.hasOwnProperty(col)) {
        const newVal = updates[col];
        if (newVal === null || newVal === undefined) return '';
        if (typeof newVal === 'object') return JSON.stringify(newVal);
        return newVal;
      }
      return val;
    });

    await sheets.spreadsheets.values.update({
      spreadsheetId: MASTER_SHEET_ID,
      range: `AllEntries!A${rowIndex + 1}:U${rowIndex + 1}`,
      valueInputOption: 'RAW',
      requestBody: { values: [updatedRow] }
    });
  } catch (e) {
    console.error('[Mirror] Failed to update mirrored entry:', e.message);
  }
}

// Move mirrored entry to DeletedEntries in Master Sheet (keeps permanent record)
async function deleteMirroredEntry(sheets, entryId, userId, deletedData) {
  if (!MASTER_SHEET_ID) return;
  try {
    // First, add to DeletedEntries tab for permanent record
    const deletedRow = [
      new Date().toISOString(), // deletedAt
      userId || 'unknown',
      entryId,
      JSON.stringify(deletedData || {})
    ];

    await sheets.spreadsheets.values.append({
      spreadsheetId: MASTER_SHEET_ID,
      range: 'DeletedEntries!A:D',
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [deletedRow] }
    });

    // Then remove from AllEntries
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: MASTER_SHEET_ID,
      range: 'AllEntries!A:U',
    });
    const rows = response.data.values || [];
    const rowIndex = rows.findIndex(row => row[1] === entryId);
    if (rowIndex === -1) return;

    const sheetMetadata = await sheets.spreadsheets.get({ spreadsheetId: MASTER_SHEET_ID });
    const allEntriesSheet = sheetMetadata.data.sheets.find(s => s.properties.title === 'AllEntries');
    if (!allEntriesSheet) return;

    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: MASTER_SHEET_ID,
      requestBody: {
        requests: [{
          deleteDimension: {
            range: {
              sheetId: allEntriesSheet.properties.sheetId,
              dimension: 'ROWS',
              startIndex: rowIndex,
              endIndex: rowIndex + 1
            }
          }
        }]
      }
    });
  } catch (e) {
    console.error('[Mirror] Failed to archive mirrored entry:', e.message);
  }
}

// Move mirrored invoice to DeletedInvoices in Master Sheet (keeps permanent record)
async function deleteMirroredInvoice(sheets, invoiceNum, userId, deletedData) {
  if (!MASTER_SHEET_ID) return;
  try {
    // Add to DeletedInvoices tab for permanent record
    const deletedRow = [
      new Date().toISOString(), // deletedAt
      userId || 'unknown',
      invoiceNum,
      deletedData.practice || '',
      deletedData.amount || '',
      deletedData.driveLink || '', // Keep drive link so we know where backup PDF is
      JSON.stringify(deletedData || {})
    ];

    await sheets.spreadsheets.values.append({
      spreadsheetId: MASTER_SHEET_ID,
      range: 'DeletedInvoices!A:G',
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [deletedRow] }
    });

    // Then remove from AllInvoices
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: MASTER_SHEET_ID,
      range: 'AllInvoices!A:AD',
    });
    const rows = response.data.values || [];
    // Invoice num is in column B (index 1) since column A is userId
    const rowIndex = rows.findIndex(row => row[1] === invoiceNum || row[1] === String(invoiceNum));
    if (rowIndex === -1) return;

    const sheetMetadata = await sheets.spreadsheets.get({ spreadsheetId: MASTER_SHEET_ID });
    const allInvoicesSheet = sheetMetadata.data.sheets.find(s => s.properties.title === 'AllInvoices');
    if (!allInvoicesSheet) return;

    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: MASTER_SHEET_ID,
      requestBody: {
        requests: [{
          deleteDimension: {
            range: {
              sheetId: allInvoicesSheet.properties.sheetId,
              dimension: 'ROWS',
              startIndex: rowIndex,
              endIndex: rowIndex + 1
            }
          }
        }]
      }
    });

    console.log(`[Mirror] Invoice #${invoiceNum} moved to DeletedInvoices (backup PDF retained)`);
  } catch (e) {
    console.error('[Mirror] Failed to archive mirrored invoice:', e.message);
  }
}

// Validate required environment variables.
// Multi-user mode: only the SA credentials are required — sheet IDs come from
// each user's session token. GOOGLE_SHEET_ID is a legacy single-user fallback
// and is intentionally NOT required.
function validateEnvVars() {
  const required = ['GOOGLE_SERVICE_ACCOUNT_EMAIL', 'GOOGLE_PRIVATE_KEY'];
  const missing = required.filter(key => !process.env[key]);
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}.`);
  }
}

async function getSheets() {
  validateEnvVars();
  const auth = getAuthClient();
  const sheets = google.sheets({ version: 'v4', auth });
  return sheets;
}

async function getDrive() {
  const auth = getAuthClient();
  const drive = google.drive({ version: 'v3', auth });
  return drive;
}

// Dual sheet IDs - one for each entity type (single-user mode fallback)
const SHEET_IDS = {
  self: process.env.GOOGLE_SHEET_ID,
  ltd: process.env.GOOGLE_SHEET_ID_LTD
};

// Get the correct sheet ID based on entity, session, and admin override
// Admin impersonation: Use X-Override-Sheet-Id header (admin viewing as another user)
// Multi-user mode: Use session's sheetId
// Single-user mode: Use environment variables (LEGACY — only for the original
//   single-user prod deployment; should never fire when GOOGLE_SHEET_ID is unset)
function getSheetId(entity, session, req = null) {
  // Admin impersonation: check for override header (admin viewing as another user)
  if (req && session && session.role === 'admin') {
    const overrideSheetId = req.headers['x-override-sheet-id'];
    if (overrideSheetId) {
      console.log('[sheets-sync] Admin override: using sheetId', overrideSheetId);
      return overrideSheetId;
    }
  }
  // Multi-user mode: session contains user's sheet ID
  if (session) {
    if (session.sheetId) {
      return session.sheetId;
    }
    // Session present but sheetId missing — DO NOT silently fall back to env vars.
    // That used to mask auth bugs by routing the request at the Master Sheet.
    throw new Error(
      `Session for ${session.email || session.userId} is missing sheetId. ` +
      `This usually means the session was created with a stale or stripped user object. ` +
      `Sign out and sign back in to refresh your session.`
    );
  }
  // No session at all: legacy single-user mode (env vars). Only relevant when
  // GOOGLE_SHEET_ID is explicitly set — should NOT be set in multi-user dev/prod.
  if (entity === 'ltd' && SHEET_IDS.ltd) {
    return SHEET_IDS.ltd;
  }
  if (!SHEET_IDS.self) {
    throw new Error(
      'No session token provided and no single-user GOOGLE_SHEET_ID configured. ' +
      'Send X-Session-Token header.'
    );
  }
  return SHEET_IDS.self;
}

// Get the backup sheet ID from session (for dual-write operations)
// Returns null if no backup sheet is configured (legacy users)
function getBackupSheetId(session, req = null) {
  // Admin impersonation: check for override header
  if (req && session && session.role === 'admin') {
    const overrideBackupSheetId = req.headers['x-override-backup-sheet-id'];
    if (overrideBackupSheetId) {
      console.log('[sheets-sync] Admin override: using backupSheetId', overrideBackupSheetId);
      return overrideBackupSheetId;
    }
  }
  // Multi-user mode: session contains backup sheet ID
  if (session && session.backupSheetId) {
    return session.backupSheetId;
  }
  // No backup sheet configured
  return null;
}

// Get the per-user hidden backup FOLDER ID from session.
// Migrated users have one (post May-2026 central-hub migration);
// legacy users return null and we fall back to the Apps Script trash flow.
function getBackupFolderId(session, req = null) {
  if (req && session && session.role === 'admin') {
    const overrideBackupFolderId = req.headers['x-override-backup-folder-id'];
    if (overrideBackupFolderId) {
      console.log('[sheets-sync] Admin override: using backupFolderId', overrideBackupFolderId);
      return overrideBackupFolderId;
    }
  }
  if (session && session.backupFolderId) {
    return session.backupFolderId;
  }
  return null;
}

// ===== SERVER-SIDE PDF CLEANUP (post-migration, replaces Apps Script Trash) =====
// Once a user has a per-user hidden backup folder we own both copies of
// their invoice PDF (primary in the user-facing folder, mirror in the
// backup folder). That means the API server can finally do the cleanup
// itself instead of dropping breadcrumbs in the Trash tab for an Apps
// Script trigger to pick up. Everything below is best-effort: failures
// are logged and surfaced to the caller, never thrown.

// extractDriveFileId, deriveYearMonthForFolder, inferInvoiceFileName,
// findFolderByName and findMirrorPdfId now live in ./_lib/pdf-mirror so
// the migration backfill script can reuse them. Imported at the top of
// this file.

let _driveClient = null;
async function getDrive() {
  if (_driveClient) return _driveClient;
  const auth = getAuthClient();
  _driveClient = google.drive({ version: 'v3', auth });
  return _driveClient;
}

// Best-effort: trash the primary PDF (always, when we have a link) and
// the mirrored backup PDF (if backupFolderId is set). Returns a
// structured report. Never throws.
async function trashInvoicePdfs({ driveLink, fileName, invoiceRow, backupFolderId }) {
  const result = {
    primaryTrashed: false,
    mirrorTrashed: false,
    mirrorAttempted: !!backupFolderId,
    errors: [],
  };
  const fileId = extractDriveFileId(driveLink);
  if (!fileId) {
    result.errors.push({ stage: 'extractFileId', message: 'Could not parse driveLink', driveLink });
    return result;
  }
  let drive;
  try {
    drive = await getDrive();
  } catch (e) {
    result.errors.push({ stage: 'getDrive', message: e.message });
    return result;
  }
  try {
    await drive.files.update({
      fileId,
      requestBody: { trashed: true },
      supportsAllDrives: true,
    });
    result.primaryTrashed = true;
  } catch (e) {
    result.errors.push({ stage: 'trashPrimary', fileId, message: e.message });
  }
  if (backupFolderId && fileName) {
    try {
      const mirrorId = await findMirrorPdfId(drive, backupFolderId, fileName, invoiceRow);
      if (mirrorId) {
        await drive.files.update({
          fileId: mirrorId,
          requestBody: { trashed: true },
          supportsAllDrives: true,
        });
        result.mirrorTrashed = true;
      } else {
        result.errors.push({
          stage: 'findMirror',
          message: `Mirror not found for "${fileName}" in backup folder`,
        });
      }
    } catch (e) {
      result.errors.push({ stage: 'trashMirror', message: e.message });
    }
  }
  return result;
}

// Validate session from request headers (multi-user mode)
function getSessionFromRequest(req) {
  if (!validateSessionToken) return null; // Single-user mode

  const token = req.headers['x-session-token'];
  if (!token) return null;

  return validateSessionToken(token);
}

// Column mappings
// NOTE: PDF deletion is handled by Apps Script (processTrashTab or onChange trigger)
// because the service account doesn't own the files - Taylor does.
// The Trash tab stores deleted invoice data so Apps Script can process it.
const ENTRY_COLUMNS = ['id', 'date', 'pId', 'pName', 'pType', 'svc', 'pts', 'uPrice', 'aoType', 'aoAmt', 'aoPatients', 'gross', 'comm', 'commAmt', 'entity', 'invSt', 'invNo', 'adhocAddr', 'color', 'createdAt'];
const INVOICE_COLUMNS = ['num', 'date', 'practice', 'practiceName', 'practiceAddr', 'period', 'entity', 'entName', 'entAddr', 'entPhone', 'bankName', 'bankAccName', 'bankAcc', 'bankSort', 'amount', 'gross', 'commRate', 'svcs', 'addons', 'airTotal', 'logoType', 'payTerms', 'footerMsg', 'companyNo', 'isAdhoc', 'driveLink', 'paidStatus', 'paidDate', 'createdAt'];

// Find an invoice row by num, optionally also matching its practice so we can
// disambiguate when two practices share an invoice number on the same sheet.
// `rows` is the raw .values array (no header row stripped). Index 2 of each row
// is INVOICE_COLUMNS[2] === 'practice', index 3 is 'practiceName'.
//
// Legacy sheets are heterogeneous: the practice column may hold the short name,
// the FULL name, or be blank on old rows. So we accept an optional
// `practiceAlts` array (all canonical spellings from the client) and match any
// candidate against BOTH the practice and practiceName columns. If nothing
// matches exactly, a single blank-practice row among the num matches is
// treated as the legacy row rather than failing with 404.
function matchInvoiceRowIndex(rows, num, practice, practiceAlts) {
  const wantNum = String(num);
  const numEq = (row) => row[0] === num || row[0] === wantNum;
  // Collect every row that matches the invoice number first.
  const numMatches = [];
  for (let i = 0; i < rows.length; i++) {
    if (numEq(rows[i])) numMatches.push(i);
  }
  if (numMatches.length === 0) return -1;

  // Build the candidate set: primary practice key + any alternate spellings.
  const candidates = new Set();
  const addCand = (v) => {
    const s = String(v == null ? '' : v).trim().toLowerCase();
    if (s) candidates.add(s);
  };
  addCand(practice);
  if (Array.isArray(practiceAlts)) practiceAlts.forEach(addCand);

  if (candidates.size > 0) {
    // 1) Exact match on the practice column (col 2) wins.
    const exact = numMatches.find(i =>
      candidates.has(String(rows[i][2] || '').trim().toLowerCase()));
    if (exact !== undefined) return exact;
    // 1b) Then try the practiceName column (col 3) — legacy rows sometimes
    //     carry the full name there while the practice column differs/blank.
    const byName = numMatches.find(i =>
      candidates.has(String(rows[i][3] || '').trim().toLowerCase()));
    if (byName !== undefined) return byName;
    // 2) Legacy fallback: allow plain-num match when there is no ambiguity —
    //    a single num match exists, or every matching row has a blank
    //    practice column.
    const blanks = numMatches.filter(i =>
      String(rows[i][2] || '').trim() === '');
    if (numMatches.length === 1 || blanks.length === numMatches.length) {
      return numMatches[0];
    }
    // 3) Blank-row rescue: if exactly ONE num-match row has a blank practice
    //    column while the others name a DIFFERENT practice, the blank row is
    //    the legacy row for the practice we're looking for.
    if (blanks.length === 1) return blanks[0];
    // Multiple non-blank rows, none matching: refuse to guess.
    return -1;
  }
  // No practice supplied: preserve legacy behavior (first num match).
  return numMatches[0];
}
const PRACTICE_COLUMNS = ['id', 'short', 'name', 'type', 'addr', 'email', 'comm', 'services', 'days', 'rate', 'air', 'active', 'color', 'paidHours', 'ptsPerHour', 'paymentDueDay', 'createdAt'];
const SETTINGS_COLUMNS = ['key', 'value', 'updatedAt'];
const LOG_COLUMNS = ['timestamp', 'action', 'dataType', 'recordId', 'changes', 'previousData', 'newData'];
const TRASH_COLUMNS = ['deletedAt', 'dataType', 'originalData'];

// ===== COLOR CODING =====
// Practice colors matching the app's CSS variables
// Colors are stored as RGB objects for Google Sheets API
const PRACTICE_COLORS = {
  bupa: { bg: { red: 0.91, green: 0.94, blue: 0.996 }, text: { red: 0, green: 0.34, blue: 0.66 } },      // #e8f0fe bg, #0057a8 text
  grove: { bg: { red: 0.91, green: 0.96, blue: 0.91 }, text: { red: 0.18, green: 0.42, blue: 0.31 } },   // #e8f5e9 bg, #2d6a4f text
  adhoc: { bg: { red: 0.996, green: 0.886, blue: 0.886 }, text: { red: 0.937, green: 0.267, blue: 0.267 } }, // #FEE2E2 bg, #EF4444 text
  haddenham: { bg: { red: 0.996, green: 0.886, blue: 0.886 }, text: { red: 0.937, green: 0.267, blue: 0.267 } }, // Same as adhoc - red
  bankhouse: { bg: { red: 0.996, green: 0.886, blue: 0.886 }, text: { red: 0.937, green: 0.267, blue: 0.267 } }, // Same as adhoc - red
  purple: { bg: { red: 0.93, green: 0.89, blue: 0.99 }, text: { red: 0.486, green: 0.227, blue: 0.929 } }, // #ede9fe bg, #7c3aed text
  orange: { bg: { red: 1, green: 0.95, blue: 0.88 }, text: { red: 0.96, green: 0.62, blue: 0.04 } },     // #fff7e0 bg, #f59e0b text
  teal: { bg: { red: 0.8, green: 0.98, blue: 0.96 }, text: { red: 0.08, green: 0.72, blue: 0.65 } },     // #ccfbf1 bg, #14b8a6 text
  // Default colors for new practices
  default: { bg: { red: 0.97, green: 0.97, blue: 0.94 }, text: { red: 0.06, green: 0.06, blue: 0.06 } }  // Light gray bg
};

// Get color scheme for a practice (by ID, type, or custom color name)
function getPracticeColor(pId, pType, customColor) {
  // Check for custom color first (set in practice settings)
  if (customColor && PRACTICE_COLORS[customColor.toLowerCase()]) {
    return PRACTICE_COLORS[customColor.toLowerCase()];
  }
  // Check for known practice IDs
  if (pId && PRACTICE_COLORS[pId.toLowerCase()]) {
    return PRACTICE_COLORS[pId.toLowerCase()];
  }
  // Ad hoc practices get red color
  if (pType === 'adhoc') {
    return PRACTICE_COLORS.adhoc;
  }
  // Default for unknown practices
  return PRACTICE_COLORS.default;
}

// Apply row formatting to a specific row in a sheet
async function applyRowColor(sheets, sheetId, sheetName, rowIndex, colorScheme) {
  try {
    // Get sheet metadata to find the sheet's gid
    const metadata = await sheets.spreadsheets.get({ spreadsheetId: sheetId });
    const sheet = metadata.data.sheets.find(s => s.properties.title === sheetName);
    if (!sheet) return;

    const sheetGid = sheet.properties.sheetId;

    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: sheetId,
      requestBody: {
        requests: [{
          repeatCell: {
            range: {
              sheetId: sheetGid,
              startRowIndex: rowIndex,
              endRowIndex: rowIndex + 1,
              startColumnIndex: 0,
              endColumnIndex: 35 // Cover all columns (A to AI)
            },
            cell: {
              userEnteredFormat: {
                backgroundColor: colorScheme.bg,
                textFormat: {
                  foregroundColor: colorScheme.text
                }
              }
            },
            fields: 'userEnteredFormat(backgroundColor,textFormat.foregroundColor)'
          }
        }]
      }
    });
  } catch (e) {
    console.error('Failed to apply row color:', e.message);
    // Don't fail the main operation if coloring fails
  }
}

// Get the last row index in a sheet (0-indexed)
async function getLastRowIndex(sheets, sheetId, sheetName) {
  try {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetId,
      range: `${sheetName}!A:A`
    });
    return (response.data.values || []).length - 1; // -1 because we want 0-indexed
  } catch (e) {
    return 0;
  }
}

// ===== MOVE TO TRASH =====
// Moves deleted data to the Trash tab for audit/recovery purposes
async function moveToTrash(sheets, sheetId, dataType, originalData) {
  try {
    const row = [
      new Date().toISOString(),          // deletedAt
      dataType,                           // 'entry' or 'invoice'
      JSON.stringify(originalData)        // Full original data as JSON
    ];

    await sheets.spreadsheets.values.append({
      spreadsheetId: sheetId,
      range: 'Trash!A:C',
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [row] }
    });

    // Apply color coding based on practice from original data
    const rowIndex = await getLastRowIndex(sheets, sheetId, 'Trash');
    const pId = originalData.pId || originalData.practice || '';
    const pType = originalData.pType || (originalData.isAdhoc ? 'adhoc' : 'contract');
    const colorScheme = getPracticeColor(pId, pType, originalData.color);
    await applyRowColor(sheets, sheetId, 'Trash', rowIndex, colorScheme);
  } catch (e) {
    console.error('Failed to move to Trash tab:', e.message);
    // Don't fail the main operation if trash fails
  }
}

// ===== AUDIT LOG =====
// Writes to the entity-specific sheet only (log is per-entity)
async function writeLog(sheets, sheetId, logEntry) {
  try {
    const row = [
      new Date().toISOString(),
      logEntry.action,       // CREATE, UPDATE, DELETE
      logEntry.dataType,     // entry, invoice, practice, settings
      logEntry.recordId,     // ID of the record
      logEntry.changes || '',      // What changed (for updates)
      logEntry.previousData ? JSON.stringify(logEntry.previousData) : '',
      logEntry.newData ? JSON.stringify(logEntry.newData) : ''
    ];

    await sheets.spreadsheets.values.append({
      spreadsheetId: sheetId,
      range: 'Log!A:G',
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [row] }
    });

    // Apply color coding based on practice from log data
    const rowIndex = await getLastRowIndex(sheets, sheetId, 'Log');
    const data = logEntry.newData || logEntry.previousData || {};
    const pId = data.pId || data.practice || '';
    const pType = data.pType || (data.isAdhoc ? 'adhoc' : 'contract');
    if (pId || pType) {
      const colorScheme = getPracticeColor(pId, pType, data.color);
      await applyRowColor(sheets, sheetId, 'Log', rowIndex, colorScheme);
    }
  } catch (e) {
    console.error('Failed to write audit log:', e.message);
    // Don't fail the main operation if logging fails
  }
}

module.exports = async (req, res) => {
  applyCors(req, res, 'POST, OPTIONS');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Require a valid, non-suspended session for ALL data operations. The
  // legacy single-user fallback (env-var GOOGLE_SHEET_ID with no auth) is
  // gone — every read and write must be tied to a known user. If the user
  // was suspended in the last 60s the requireSession status re-check kicks
  // them out here even though their token is still cryptographically valid.
  const session = await requireSession(req, res);
  if (!session) return;

  const { action, data, entity } = req.body;
  console.log('[sheets-sync] user:', session.email, 'action:', action);

  // Audit when admin uses X-Override-* headers on a write action. Read-only
  // loads are skipped to keep AdminLog readable; impersonation start/stop
  // is logged separately from the UI.
  if (WRITE_ACTIONS.has(action)) {
    await auditAdminOverride(session, req, action, { entity });
  }

  try {
    const sheets = await getSheets();
    const sheetId = getSheetId(entity, session, req);
    const backupSheetId = getBackupSheetId(session, req);
    const backupFolderId = getBackupFolderId(session, req);
    const userId = session?.userId || 'single-user';

    switch (action) {
      case 'append_entry': return await appendEntry(sheets, sheetId, data, res, userId, backupSheetId);
      case 'append_invoice': return await appendInvoice(sheets, sheetId, data, res, userId, backupSheetId);
      case 'update_entry': return await updateEntry(sheets, sheetId, data, res, backupSheetId);
      case 'batch_update_entries': return await batchUpdateEntries(sheets, sheetId, data, res, backupSheetId);
      case 'delete_entry': return await deleteEntry(sheets, sheetId, data, res, userId, backupSheetId);
      case 'load_all': return await loadAll(sheets, sheetId, res);
      case 'update_invoice': return await updateInvoice(sheets, sheetId, data, res, backupSheetId);
      case 'update_invoice_status': return await updateInvoiceStatus(sheets, sheetId, data, res, backupSheetId);
      case 'delete_invoice': return await deleteInvoice(sheets, sheetId, data, res, userId, backupSheetId, backupFolderId);
      case 'sync_entries': return await syncEntries(sheets, sheetId, data, res, backupSheetId);
      case 'sync_invoices': return await syncInvoices(sheets, sheetId, data, res, backupSheetId);
      case 'sync_practices': return await syncPractices(sheets, sheetId, data, res, backupSheetId);
      case 'load_practices': return await loadPractices(sheets, sheetId, res);
      case 'sync_settings': return await syncSettings(sheets, sheetId, data, res, backupSheetId);
      case 'load_settings': return await loadSettings(sheets, sheetId, res);
      case 'get_dashboard': return await getDashboard(sheets, sheetId, res);
      case 'rename_sheet': return await renameSheet(sheets, sheetId, data, res);
      case 'setup_log_tab': return await setupLogTab(sheets, sheetId, res);
      case 'setup_tabs': return await setupAllTabs(sheets, res);
      case 'trigger_pdf_regeneration': return await triggerPdfRegeneration(sheets, sheetId, data, res, backupFolderId);
      case 'queue_pdf_deletion': return await queuePdfDeletion(sheets, sheetId, data, res, backupFolderId);
      default: return res.status(400).json({ error: `Unknown action: ${action}` });
    }
  } catch (error) {
    console.error('Sheets API error:', error);
    return res.status(500).json({
      error: 'Sheets API error',
      message: error.message,
      details: error.response?.data?.error?.message || null
    });
  }
};

// ===== ENTRIES =====
async function appendEntry(sheets, sheetId, entry, res, userId, backupSheetId = null) {
  const createdAt = new Date().toISOString();
  entry.createdAt = createdAt;

  // Idempotency guard: the client now re-queues failed/unconfirmed writes, so
  // the same entry id can legitimately arrive more than once (e.g. the row was
  // written but the HTTP response was lost, or a quota error fired after the
  // append landed). If this id already exists in the sheet, treat it as a
  // success instead of appending a duplicate row.
  if (entry.id) {
    try {
      const existing = await sheets.spreadsheets.values.get({
        spreadsheetId: sheetId,
        range: 'Entries!A:A'
      });
      const existingIds = (existing.data.values || []).map(r => r[0]);
      if (existingIds.includes(entry.id)) {
        console.log('[appendEntry] Entry', entry.id, 'already present — skipping duplicate append');
        return res.status(200).json({ success: true, message: 'Entry already exists', id: entry.id, deduped: true });
      }
    } catch (checkErr) {
      console.warn('[appendEntry] Idempotency check failed, proceeding to append:', checkErr.message);
    }
  }

  const row = ENTRY_COLUMNS.map(col => {
    if (col === 'createdAt') return createdAt;
    const val = entry[col];
    if (val === null || val === undefined) return '';
    if (typeof val === 'object') return JSON.stringify(val);
    return val;
  });

  // Write to user-facing sheet
  await sheets.spreadsheets.values.append({
    spreadsheetId: sheetId,
    range: 'Entries!A:T',
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [row] }
  });

  // Write to backup sheet (if configured) - dual write for data safety
  if (backupSheetId) {
    try {
      await sheets.spreadsheets.values.append({
        spreadsheetId: backupSheetId,
        range: 'Entries!A:T',
        valueInputOption: 'RAW',
        insertDataOption: 'INSERT_ROWS',
        requestBody: { values: [row] }
      });
      console.log('[sheets-sync] Entry written to backup sheet');
    } catch (backupError) {
      console.error('[sheets-sync] Warning: Failed to write to backup sheet:', backupError.message);
      // Continue - don't fail the main operation
    }
  }

  // Everything below is best-effort. The authoritative write above already
  // succeeded, so a failure mirroring/coloring/logging must NOT fail the
  // request — otherwise the client would treat a saved entry as failed and
  // re-queue it (the idempotency guard catches the dupe, but we avoid the churn
  // and the misleading error toast on the user's device).

  // Mirror to Master Sheet for central backup
  try {
    await mirrorEntryToMaster(sheets, userId, entry);
  } catch (mirrorErr) {
    console.error('[appendEntry] Warning: failed to mirror entry to Master Sheet:', mirrorErr.message);
  }

  // Apply color coding based on practice
  try {
    const rowIndex = await getLastRowIndex(sheets, sheetId, 'Entries');
    const colorScheme = getPracticeColor(entry.pId, entry.pType, entry.color);
    await applyRowColor(sheets, sheetId, 'Entries', rowIndex, colorScheme);
  } catch (colorErr) {
    console.error('[appendEntry] Warning: failed to apply row color:', colorErr.message);
  }

  // Log the creation
  await writeLog(sheets, sheetId, {
    action: 'CREATE',
    dataType: 'entry',
    recordId: entry.id,
    changes: `New entry: ${entry.pName} - ${entry.svc} - ${entry.pts} pts - £${entry.gross}`,
    newData: entry
  });

  return res.status(200).json({ success: true, message: 'Entry appended', id: entry.id });
}

async function updateEntry(sheets, sheetId, { id, updates }, res, backupSheetId = null) {
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: 'Entries!A:T',
  });

  const rows = response.data.values || [];
  const rowIndex = rows.findIndex(row => row[0] === id);

  if (rowIndex === -1) {
    return res.status(404).json({ error: 'Entry not found', id });
  }

  const currentRow = rows[rowIndex];
  // Convert current row to object for logging
  const previousData = {};
  ENTRY_COLUMNS.forEach((col, i) => { previousData[col] = currentRow[i] || ''; });

  const updatedRow = ENTRY_COLUMNS.map((col, i) => {
    if (updates.hasOwnProperty(col)) {
      const val = updates[col];
      if (val === null || val === undefined) return '';
      if (typeof val === 'object') return JSON.stringify(val);
      return val;
    }
    return currentRow[i] || '';
  });

  // Update user-facing sheet
  await sheets.spreadsheets.values.update({
    spreadsheetId: sheetId,
    range: `Entries!A${rowIndex + 1}:T${rowIndex + 1}`,
    valueInputOption: 'RAW',
    requestBody: { values: [updatedRow] }
  });

  // Update backup sheet (if configured)
  if (backupSheetId) {
    try {
      // Find the entry in backup sheet
      const backupResponse = await sheets.spreadsheets.values.get({
        spreadsheetId: backupSheetId,
        range: 'Entries!A:T',
      });
      const backupRows = backupResponse.data.values || [];
      const backupRowIndex = backupRows.findIndex(row => row[0] === id);
      if (backupRowIndex !== -1) {
        await sheets.spreadsheets.values.update({
          spreadsheetId: backupSheetId,
          range: `Entries!A${backupRowIndex + 1}:T${backupRowIndex + 1}`,
          valueInputOption: 'RAW',
          requestBody: { values: [updatedRow] }
        });
        console.log('[sheets-sync] Entry updated in backup sheet');
      }
    } catch (backupError) {
      console.error('[sheets-sync] Warning: Failed to update backup sheet:', backupError.message);
    }
  }

  // Log the update with before/after data
  const changedFields = Object.keys(updates).filter(k => updates[k] !== previousData[k]).join(', ');
  await writeLog(sheets, sheetId, {
    action: 'UPDATE',
    dataType: 'entry',
    recordId: id,
    changes: `Updated fields: ${changedFields}`,
    previousData: previousData,
    newData: updates
  });

  // Mirror update to Master Sheet
  await updateMirroredEntry(sheets, id, updates);

  return res.status(200).json({ success: true, message: 'Entry updated', id });
}

// Batch update multiple entries at once (reduces API calls from N*2 to 2)
async function batchUpdateEntries(sheets, sheetId, { entries }, res, backupSheetId = null) {
  if (!entries || !entries.length) {
    return res.status(400).json({ error: 'No entries provided' });
  }

  // Single read to get all rows
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: 'Entries!A:T',
  });

  const rows = response.data.values || [];
  const updateRequests = [];
  const results = [];

  for (const { id, updates } of entries) {
    const rowIndex = rows.findIndex(row => row[0] === id);
    if (rowIndex === -1) {
      results.push({ id, success: false, error: 'not found' });
      continue;
    }

    const currentRow = rows[rowIndex];
    const updatedRow = ENTRY_COLUMNS.map((col, i) => {
      if (updates.hasOwnProperty(col)) {
        const val = updates[col];
        if (val === null || val === undefined) return '';
        if (typeof val === 'object') return JSON.stringify(val);
        return val;
      }
      return currentRow[i] || '';
    });

    updateRequests.push({
      range: `Entries!A${rowIndex + 1}:T${rowIndex + 1}`,
      values: [updatedRow]
    });
    results.push({ id, success: true });
  }

  // Single batch update to user-facing sheet
  if (updateRequests.length > 0) {
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: sheetId,
      requestBody: {
        valueInputOption: 'RAW',
        data: updateRequests
      }
    });

    // Also update backup sheet (if configured)
    if (backupSheetId) {
      try {
        // Re-read backup sheet and build update requests for it
        const backupResponse = await sheets.spreadsheets.values.get({
          spreadsheetId: backupSheetId,
          range: 'Entries!A:T',
        });
        const backupRows = backupResponse.data.values || [];
        const backupUpdateRequests = [];

        for (const { id, updates } of entries) {
          const backupRowIndex = backupRows.findIndex(row => row[0] === id);
          if (backupRowIndex !== -1) {
            const currentRow = backupRows[backupRowIndex];
            const updatedRow = ENTRY_COLUMNS.map((col, i) => {
              if (updates.hasOwnProperty(col)) {
                const val = updates[col];
                if (val === null || val === undefined) return '';
                if (typeof val === 'object') return JSON.stringify(val);
                return val;
              }
              return currentRow[i] || '';
            });
            backupUpdateRequests.push({
              range: `Entries!A${backupRowIndex + 1}:T${backupRowIndex + 1}`,
              values: [updatedRow]
            });
          }
        }

        if (backupUpdateRequests.length > 0) {
          await sheets.spreadsheets.values.batchUpdate({
            spreadsheetId: backupSheetId,
            requestBody: {
              valueInputOption: 'RAW',
              data: backupUpdateRequests
            }
          });
          console.log(`[sheets-sync] Batch updated ${backupUpdateRequests.length} entries in backup sheet`);
        }
      } catch (backupError) {
        console.error('[sheets-sync] Warning: Failed to batch update backup sheet:', backupError.message);
      }
    }
  }

  return res.status(200).json({
    success: true,
    message: `Updated ${updateRequests.length} entries`,
    results
  });
}

async function deleteEntry(sheets, sheetId, { id }, res, userId, backupSheetId = null) {
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: 'Entries!A:T',
  });

  const rows = response.data.values || [];
  const rowIndex = rows.findIndex(row => row[0] === id);

  if (rowIndex === -1) {
    return res.status(404).json({ error: 'Entry not found', id });
  }

  // Store the data before deletion for the log and trash
  const deletedRow = rows[rowIndex];
  const deletedData = {};
  ENTRY_COLUMNS.forEach((col, i) => { deletedData[col] = deletedRow[i] || ''; });

  // Move to Trash tab before deleting
  await moveToTrash(sheets, sheetId, 'entry', deletedData);

  const sheetMetadata = await sheets.spreadsheets.get({ spreadsheetId: sheetId });
  const entriesSheet = sheetMetadata.data.sheets.find(s => s.properties.title === 'Entries');
  if (!entriesSheet) {
    return res.status(500).json({ error: 'Entries sheet not found' });
  }

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: sheetId,
    requestBody: {
      requests: [{
        deleteDimension: {
          range: {
            sheetId: entriesSheet.properties.sheetId,
            dimension: 'ROWS',
            startIndex: rowIndex,
            endIndex: rowIndex + 1
          }
        }
      }]
    }
  });

  // Delete from backup sheet (if configured)
  if (backupSheetId) {
    try {
      const backupResponse = await sheets.spreadsheets.values.get({
        spreadsheetId: backupSheetId,
        range: 'Entries!A:T',
      });
      const backupRows = backupResponse.data.values || [];
      const backupRowIndex = backupRows.findIndex(row => row[0] === id);
      if (backupRowIndex !== -1) {
        const backupMetadata = await sheets.spreadsheets.get({ spreadsheetId: backupSheetId });
        const backupEntriesSheet = backupMetadata.data.sheets.find(s => s.properties.title === 'Entries');
        if (backupEntriesSheet) {
          await sheets.spreadsheets.batchUpdate({
            spreadsheetId: backupSheetId,
            requestBody: {
              requests: [{
                deleteDimension: {
                  range: {
                    sheetId: backupEntriesSheet.properties.sheetId,
                    dimension: 'ROWS',
                    startIndex: backupRowIndex,
                    endIndex: backupRowIndex + 1
                  }
                }
              }]
            }
          });
          console.log('[sheets-sync] Entry deleted from backup sheet');
        }
      }
    } catch (backupError) {
      console.error('[sheets-sync] Warning: Failed to delete from backup sheet:', backupError.message);
    }
  }

  // Log the deletion with full previous data
  await writeLog(sheets, sheetId, {
    action: 'DELETE',
    dataType: 'entry',
    recordId: id,
    changes: `Deleted entry: ${deletedData.pName} - ${deletedData.svc} - ${deletedData.pts} pts - £${deletedData.gross} (moved to Trash)`,
    previousData: deletedData
  });

  // Mirror deletion to Master Sheet (moves to DeletedEntries for permanent record)
  await deleteMirroredEntry(sheets, id, userId, deletedData);

  return res.status(200).json({ success: true, message: 'Entry moved to Trash', id });
}

async function deleteInvoice(sheets, sheetId, { num, driveLink, practice, practiceAlts }, res, userId, backupSheetId = null, backupFolderId = null) {
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: 'Invoices!A:AD',
  });

  const rows = response.data.values || [];
  // If a `practice` is supplied, prefer the row that matches both num + practice
  // so two practices sharing an invoice number for the same entity don't collide.
  // Falls back to plain num match when no practice is provided (legacy callers).
  const rowIndex = matchInvoiceRowIndex(rows, num, practice, practiceAlts);

  if (rowIndex === -1) {
    return res.status(404).json({ error: 'Invoice not found', num });
  }

  // Store the data before deletion for the log and trash
  const deletedRow = rows[rowIndex];
  const deletedData = {};
  INVOICE_COLUMNS.forEach((col, i) => { deletedData[col] = deletedRow[i] || ''; });

  // Move to Trash tab before deleting
  await moveToTrash(sheets, sheetId, 'invoice', deletedData);

  // PDF cleanup. Two paths:
  //   - Migrated users (session has backupFolderId): server-side trash now,
  //     using the central-hub setup where the service account owns BOTH the
  //     primary PDF (user-facing folder) and the mirror (hidden backup).
  //     No Apps Script side-channel needed.
  //   - Legacy users: keep the old behaviour — log the link and let the
  //     per-user Apps Script `processTrashTab` move it later. The service
  //     account does not own those files so direct trash would fail.
  const driveLinkToDelete = driveLink || deletedData.driveLink;
  let pdfCleanup = null;
  if (driveLinkToDelete) {
    if (backupFolderId) {
      const fileName = inferInvoiceFileName(deletedData);
      pdfCleanup = await trashInvoicePdfs({
        driveLink: driveLinkToDelete,
        fileName,
        invoiceRow: deletedData,
        backupFolderId,
      });
      console.log('[delete_invoice]', num, 'pdf cleanup:', JSON.stringify(pdfCleanup));
    } else {
      // Legacy / un-migrated user: no per-user hidden backup folder yet,
      // so the SA cannot trash the PDF directly (it's owned by the user
      // in their own Drive). Surface a `requiresMigration: true` flag in
      // the response — the per-user Apps Script Trash trigger handles the
      // actual cleanup until the user is run through migrate-user.js /
      // backfill-architecture and gains a backupFolderId.
      console.log('[delete_invoice]', num, 'requiresMigration: no backupFolderId, deferring PDF cleanup to Apps Script Trash trigger:', driveLinkToDelete);
      pdfCleanup = { requiresMigration: true, driveLink: driveLinkToDelete };
    }
  }

  const sheetMetadata = await sheets.spreadsheets.get({ spreadsheetId: sheetId });
  const invoicesSheet = sheetMetadata.data.sheets.find(s => s.properties.title === 'Invoices');
  if (!invoicesSheet) {
    return res.status(500).json({ error: 'Invoices sheet not found' });
  }

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: sheetId,
    requestBody: {
      requests: [{
        deleteDimension: {
          range: {
            sheetId: invoicesSheet.properties.sheetId,
            dimension: 'ROWS',
            startIndex: rowIndex,
            endIndex: rowIndex + 1
          }
        }
      }]
    }
  });

  // Delete from backup sheet (if configured)
  if (backupSheetId) {
    try {
      const backupResponse = await sheets.spreadsheets.values.get({
        spreadsheetId: backupSheetId,
        range: 'Invoices!A:AD',
      });
      const backupRows = backupResponse.data.values || [];
      const backupRowIndex = matchInvoiceRowIndex(backupRows, num, practice, practiceAlts);
      if (backupRowIndex !== -1) {
        const backupMetadata = await sheets.spreadsheets.get({ spreadsheetId: backupSheetId });
        const backupInvoicesSheet = backupMetadata.data.sheets.find(s => s.properties.title === 'Invoices');
        if (backupInvoicesSheet) {
          await sheets.spreadsheets.batchUpdate({
            spreadsheetId: backupSheetId,
            requestBody: {
              requests: [{
                deleteDimension: {
                  range: {
                    sheetId: backupInvoicesSheet.properties.sheetId,
                    dimension: 'ROWS',
                    startIndex: backupRowIndex,
                    endIndex: backupRowIndex + 1
                  }
                }
              }]
            }
          });
          console.log('[sheets-sync] Invoice deleted from backup sheet');
        }
      }
    } catch (backupError) {
      console.error('[sheets-sync] Warning: Failed to delete invoice from backup sheet:', backupError.message);
    }
  }

  // Log the deletion with full previous data
  const hasPdf = !!driveLinkToDelete;
  const cleanupNote = (() => {
    if (!hasPdf) return '';
    if (pdfCleanup) {
      if (pdfCleanup.requiresMigration) {
        return ', PDF cleanup deferred (account not migrated to hidden-backup tier)';
      }
      const primaryNote = pdfCleanup.primaryTrashed ? 'trashed server-side' : 'PRIMARY TRASH FAILED';
      const mirrorNote = pdfCleanup.mirrorAttempted
        ? ` (mirror ${pdfCleanup.mirrorTrashed ? 'trashed' : 'NOT TRASHED'})`
        : '';
      const errCount = (pdfCleanup.errors && pdfCleanup.errors.length) || 0;
      const errNote = errCount > 0 ? ` [errors: ${errCount}]` : '';
      return `, PDF ${primaryNote}${mirrorNote}${errNote}`;
    }
    return ', PDF pending Apps Script cleanup';
  })();
  await writeLog(sheets, sheetId, {
    action: 'DELETE',
    dataType: 'invoice',
    recordId: num,
    changes: `Deleted invoice: #${num} - ${deletedData.practice} - £${deletedData.amount} (moved to Trash tab${cleanupNote})`,
    previousData: deletedData
  });

  // Mirror deletion to Master Sheet (moves to DeletedInvoices for permanent record)
  // PDF backup is retained in central backup folder
  await deleteMirroredInvoice(sheets, num, userId, deletedData);

  return res.status(200).json({
    success: true,
    message: (() => {
      const base = `Invoice #${num} moved to Trash`;
      if (!hasPdf) return base;
      if (!pdfCleanup) return `${base} (PDF will be moved by Apps Script)`;
      if (pdfCleanup.requiresMigration) return `${base} (PDF cleanup deferred — account migration pending)`;
      // Real cleanup ran — only claim success if the primary actually got trashed.
      if (pdfCleanup.primaryTrashed) {
        return pdfCleanup.mirrorAttempted && !pdfCleanup.mirrorTrashed
          ? `${base} (PDF trashed server-side, mirror cleanup failed — see pdfCleanup.errors)`
          : `${base} (PDF trashed server-side)`;
      }
      return `${base} (PDF cleanup FAILED — see pdfCleanup.errors)`;
    })(),
    num,
    hasPdf,
    ...(pdfCleanup ? { pdfCleanup } : {}),
  });
}

// Queue a PDF for deletion via Trash tab (Apps Script will process it)
// Used when editing invoices - old PDF needs to be replaced.
//
// Migrated users (have backupFolderId) bypass the Trash tab entirely and
// trash the old PDF server-side; legacy users continue to write a Trash
// tab row that their Apps Script picks up.
async function queuePdfDeletion(sheets, sheetId, { num, driveLink, reason }, res, backupFolderId = null) {
  if (!driveLink) {
    return res.status(200).json({ success: true, message: 'No PDF to delete' });
  }

  // Migrated user fast path: trash the old primary PDF directly. We don't
  // touch the mirror here — the new PDF will land in the same backup
  // folder shortly and the old mirror sits alongside it harmlessly until
  // the next time the same invoice is edited or deleted. Storage cost is
  // negligible and avoids a metadata lookup for each edit.
  if (backupFolderId) {
    const cleanup = await trashInvoicePdfs({
      driveLink,
      fileName: null,        // skip mirror lookup on edit
      invoiceRow: null,
      backupFolderId: null,  // explicit: do NOT touch mirror on edit
    });
    await writeLog(sheets, sheetId, {
      action: 'PDF_REPLACE',
      dataType: 'invoice',
      recordId: num,
      changes: `Old PDF trashed server-side: ${driveLink} (reason: ${reason || 'invoice_edit'}, primary=${cleanup.primaryTrashed})`,
    });
    return res.status(200).json({
      success: true,
      message: `Old PDF trashed server-side`,
      num,
      pdfCleanup: cleanup,
    });
  }

  // Legacy user path: queue for Apps Script via Trash tab.
  const trashData = {
    num,
    driveLink,
    reason: reason || 'invoice_edit'
  };

  await moveToTrash(sheets, sheetId, 'pdf_replacement', trashData);

  // Log the action
  await writeLog(sheets, sheetId, {
    action: 'PDF_REPLACE',
    dataType: 'invoice',
    recordId: num,
    changes: `Old PDF queued for deletion: ${driveLink} (reason: ${reason || 'invoice_edit'})`
  });

  return res.status(200).json({
    success: true,
    message: `PDF queued for deletion (Apps Script will move to Trash)`,
    num
  });
}

async function syncEntries(sheets, sheetId, { entries }, res, backupSheetId = null) {
  if (!entries || !entries.length) {
    return res.status(200).json({ success: true, message: 'No entries to sync', count: 0 });
  }

  const rows = entries.map(entry =>
    ENTRY_COLUMNS.map(col => {
      if (col === 'createdAt') return entry.createdAt || new Date().toISOString();
      const val = entry[col];
      if (val === null || val === undefined) return '';
      if (typeof val === 'object') return JSON.stringify(val);
      return val;
    })
  );

  // Helper: clear+write to one target sheet
  const writeToSheet = async (targetId, label) => {
    try {
      await sheets.spreadsheets.values.clear({
        spreadsheetId: targetId,
        range: 'Entries!A2:T',
      });
      if (rows.length > 0) {
        await sheets.spreadsheets.values.update({
          spreadsheetId: targetId,
          range: `Entries!A2:T${rows.length + 1}`,
          valueInputOption: 'RAW',
          requestBody: { values: rows }
        });
      }
    } catch (e) {
      console.error(`[sheets-sync] Warning: syncEntries failed on ${label}:`, e.message);
      if (label === 'primary') throw e;
    }
  };

  await writeToSheet(sheetId, 'primary');
  if (backupSheetId) await writeToSheet(backupSheetId, 'backup');

  return res.status(200).json({ success: true, message: 'Entries synced', count: rows.length });
}

// ===== INVOICES =====
async function appendInvoice(sheets, sheetId, invoice, res, userId, backupSheetId = null) {
  const createdAt = new Date().toISOString();
  invoice.createdAt = createdAt;

  const row = INVOICE_COLUMNS.map(col => {
    if (col === 'createdAt') return createdAt;
    const val = invoice[col];
    if (val === null || val === undefined) return '';
    if (typeof val === 'object') return JSON.stringify(val);
    return val;
  });

  // Write to user-facing sheet
  await sheets.spreadsheets.values.append({
    spreadsheetId: sheetId,
    range: 'Invoices!A:AD',
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [row] }
  });

  // Write to backup sheet (if configured) - dual write for data safety
  if (backupSheetId) {
    try {
      await sheets.spreadsheets.values.append({
        spreadsheetId: backupSheetId,
        range: 'Invoices!A:AD',
        valueInputOption: 'RAW',
        insertDataOption: 'INSERT_ROWS',
        requestBody: { values: [row] }
      });
      console.log('[sheets-sync] Invoice written to backup sheet');
    } catch (backupError) {
      console.error('[sheets-sync] Warning: Failed to write invoice to backup sheet:', backupError.message);
    }
  }

  // Mirror to Master Sheet for central backup
  await mirrorInvoiceToMaster(sheets, userId, invoice);

  // Apply color coding based on practice
  const rowIndex = await getLastRowIndex(sheets, sheetId, 'Invoices');
  // Use pId if available, otherwise try to match practice name to known practices
  let practiceId = invoice.pId || '';
  if (!practiceId && invoice.practice) {
    const practiceLower = invoice.practice.toLowerCase();
    if (practiceLower.includes('bupa')) practiceId = 'bupa';
    else if (practiceLower.includes('grove')) practiceId = 'grove';
    else if (practiceLower.includes('haddenham')) practiceId = 'haddenham';
    else if (practiceLower.includes('bankhouse') || practiceLower.includes('bank house')) practiceId = 'bankhouse';
  }
  const isAdhoc = invoice.isAdhoc === true || invoice.isAdhoc === 'true';
  const colorScheme = getPracticeColor(practiceId, isAdhoc ? 'adhoc' : 'contract', invoice.logoType);
  await applyRowColor(sheets, sheetId, 'Invoices', rowIndex, colorScheme);

  // Log the invoice creation
  await writeLog(sheets, sheetId, {
    action: 'CREATE',
    dataType: 'invoice',
    recordId: invoice.num,
    changes: `New invoice #${invoice.num}: ${invoice.practiceName || invoice.practice} - £${invoice.amount}`,
    newData: invoice
  });

  return res.status(200).json({ success: true, message: 'Invoice appended', num: invoice.num });
}

async function updateInvoice(sheets, sheetId, { num, updates, practice, practiceAlts }, res, backupSheetId = null) {
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: 'Invoices!A:AD',
  });

  const rows = response.data.values || [];
  // Scope by practice when provided so a same-numbered invoice in another
  // practice cannot be updated by mistake.
  const rowIndex = matchInvoiceRowIndex(rows, num, practice, practiceAlts);

  if (rowIndex === -1) {
    return res.status(404).json({ error: 'Invoice not found', num });
  }

  const currentRow = rows[rowIndex];
  // Convert current row to object for logging
  const previousData = {};
  INVOICE_COLUMNS.forEach((col, i) => { previousData[col] = currentRow[i] || ''; });

  const updatedRow = INVOICE_COLUMNS.map((col, i) => {
    if (updates.hasOwnProperty(col)) {
      const val = updates[col];
      if (val === null || val === undefined) return '';
      if (typeof val === 'object') return JSON.stringify(val);
      return val;
    }
    return currentRow[i] || '';
  });

  await sheets.spreadsheets.values.update({
    spreadsheetId: sheetId,
    range: `Invoices!A${rowIndex + 1}:AA${rowIndex + 1}`,
    valueInputOption: 'RAW',
    requestBody: { values: [updatedRow] }
  });

  // Update backup sheet (if configured)
  if (backupSheetId) {
    try {
      const backupResponse = await sheets.spreadsheets.values.get({
        spreadsheetId: backupSheetId,
        range: 'Invoices!A:AD',
      });
      const backupRows = backupResponse.data.values || [];
      const backupRowIndex = matchInvoiceRowIndex(backupRows, num, practice, practiceAlts);
      if (backupRowIndex !== -1) {
        await sheets.spreadsheets.values.update({
          spreadsheetId: backupSheetId,
          range: `Invoices!A${backupRowIndex + 1}:AA${backupRowIndex + 1}`,
          valueInputOption: 'RAW',
          requestBody: { values: [updatedRow] }
        });
        console.log('[sheets-sync] Invoice updated in backup sheet');
      }
    } catch (backupError) {
      console.error('[sheets-sync] Warning: Failed to update invoice in backup sheet:', backupError.message);
    }
  }

  // Log the update
  const changedFields = Object.keys(updates).filter(k => updates[k] !== previousData[k]).join(', ');
  await writeLog(sheets, sheetId, {
    action: 'UPDATE',
    dataType: 'invoice',
    recordId: num,
    changes: `Updated fields: ${changedFields}`,
    previousData: previousData,
    newData: updates
  });

  return res.status(200).json({ success: true, message: 'Invoice updated', num });
}

// Update invoice payment status (paid/unpaid)
async function updateInvoiceStatus(sheets, sheetId, { num, paidStatus, paidDate, practice, practiceAlts }, res, backupSheetId = null) {
  try {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetId,
      range: 'Invoices!A:AE',
    });

    const rows = response.data.values || [];
    let headers = rows[0] || [...INVOICE_COLUMNS];
    // Skip header row, then scope by practice when provided.
    const dataRows = rows.slice(1);
    const dataIdx = matchInvoiceRowIndex(dataRows, num, practice, practiceAlts);
    const rowIndex = dataIdx === -1 ? -1 : dataIdx + 1;

    if (rowIndex === -1) {
      return res.status(404).json({ error: 'Invoice not found', num });
    }

    // Find column indices for paidStatus and paidDate
    let paidStatusIdx = headers.indexOf('paidStatus');
    let paidDateIdx = headers.indexOf('paidDate');

    // If columns don't exist in header, add them
    if (paidStatusIdx === -1 || paidDateIdx === -1) {
      if (paidStatusIdx === -1) {
        headers.push('paidStatus');
        paidStatusIdx = headers.length - 1;
      }
      if (paidDateIdx === -1) {
        headers.push('paidDate');
        paidDateIdx = headers.length - 1;
      }

      await sheets.spreadsheets.values.update({
        spreadsheetId: sheetId,
        range: 'Invoices!A1',
        valueInputOption: 'RAW',
        requestBody: { values: [headers] }
      });
    }

    // Update the row with payment status
    const currentRow = [...rows[rowIndex]];

    // Ensure row has enough columns
    while (currentRow.length <= Math.max(paidStatusIdx, paidDateIdx)) {
      currentRow.push('');
    }

    currentRow[paidStatusIdx] = paidStatus || '';
    currentRow[paidDateIdx] = paidDate || '';

    await sheets.spreadsheets.values.update({
      spreadsheetId: sheetId,
      range: `Invoices!A${rowIndex + 1}`,
      valueInputOption: 'RAW',
      requestBody: { values: [currentRow] }
    });

    // Update backup sheet (if configured)
    if (backupSheetId) {
      try {
        const backupResponse = await sheets.spreadsheets.values.get({
          spreadsheetId: backupSheetId,
          range: 'Invoices!A:AE',
        });
        const backupRows = backupResponse.data.values || [];
        const backupDataRows = backupRows.slice(1);
        const backupDataIdx = matchInvoiceRowIndex(backupDataRows, num, practice, practiceAlts);
        const backupRowIndex = backupDataIdx === -1 ? -1 : backupDataIdx + 1;
        if (backupRowIndex !== -1) {
          const backupCurrentRow = [...backupRows[backupRowIndex]];
          while (backupCurrentRow.length <= Math.max(paidStatusIdx, paidDateIdx)) {
            backupCurrentRow.push('');
          }
          backupCurrentRow[paidStatusIdx] = paidStatus || '';
          backupCurrentRow[paidDateIdx] = paidDate || '';
          await sheets.spreadsheets.values.update({
            spreadsheetId: backupSheetId,
            range: `Invoices!A${backupRowIndex + 1}`,
            valueInputOption: 'RAW',
            requestBody: { values: [backupCurrentRow] }
          });
          console.log('[sheets-sync] Invoice status updated in backup sheet');
        }
      } catch (backupError) {
        console.error('[sheets-sync] Warning: Failed to update invoice status in backup sheet:', backupError.message);
      }
    }

    // Log the status change
    await writeLog(sheets, sheetId, {
      action: 'UPDATE',
      dataType: 'invoice',
      recordId: num,
      changes: `Payment status: ${paidStatus}${paidDate ? ' on ' + paidDate : ''}`,
      previousData: {},
      newData: { paidStatus, paidDate }
    });

    return res.status(200).json({ success: true, message: 'Invoice status updated', num, paidStatus });
  } catch (error) {
    console.error('updateInvoiceStatus error:', error);
    return res.status(500).json({ error: 'Failed to update invoice status', message: error.message });
  }
}

// Trigger PDF regeneration by clearing driveLink and setting needsRegeneration flag
// Apps Script will detect this on next onChange trigger and regenerate the PDF
async function triggerPdfRegeneration(sheets, sheetId, { num, practice, practiceAlts }, res, backupFolderId = null) {
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: 'Invoices!A:AD',
  });

  const rows = response.data.values || [];
  const headers = rows[0] || INVOICE_COLUMNS;
  // Scope by practice when supplied so we regenerate the right invoice.
  const rowIndex = matchInvoiceRowIndex(rows, num, practice, practiceAlts);

  if (rowIndex === -1) {
    return res.status(404).json({ error: 'Invoice not found', num });
  }

  // Find the driveLink column index
  const driveLinkCol = headers.indexOf('driveLink');
  if (driveLinkCol === -1) {
    return res.status(500).json({ error: 'driveLink column not found' });
  }

  // Store old driveLink for moving to trash
  const oldDriveLink = rows[rowIndex][driveLinkCol];

  // Build a row object so the mirror lookup can read period/date/logoType/isAdhoc.
  // Migrated users go through the server-side trash path (next block); legacy
  // users still use the Apps Script Trash-tab side channel below.
  const invoiceRow = {};
  for (let i = 0; i < headers.length && i < (rows[rowIndex] || []).length; i++) {
    invoiceRow[headers[i]] = rows[rowIndex][i];
  }

  // Clear driveLink either way:
  //   - migrated users: frontend will see no link, call generate-pdf.js, which
  //     uploads a fresh PDF to the user-facing folder AND mirrors it.
  //   - legacy users: Apps Script's checkForNewInvoices() picks it up.
  const currentRow = rows[rowIndex];
  currentRow[driveLinkCol] = '';

  await sheets.spreadsheets.values.update({
    spreadsheetId: sheetId,
    range: `Invoices!A${rowIndex + 1}:AA${rowIndex + 1}`,
    valueInputOption: 'RAW',
    requestBody: { values: [currentRow] }
  });

  let pdfCleanup = null;

  if (backupFolderId && oldDriveLink) {
    // Migrated-user path. Trash both the old primary AND the old mirror —
    // unlike queuePdfDeletion (invoice-edit) which leaves the mirror, here
    // the new PDF will land in a potentially different folder (entity move
    // or period change) so the old mirror can't be assumed to be replaced.
    pdfCleanup = await trashInvoicePdfs({
      driveLink: oldDriveLink,
      fileName: inferInvoiceFileName(invoiceRow),
      invoiceRow,
      backupFolderId,
    });
    await writeLog(sheets, sheetId, {
      action: 'UPDATE',
      dataType: 'invoice',
      recordId: num,
      changes: `PDF regeneration triggered - cleared driveLink, trashed old PDF server-side (primary=${pdfCleanup.primaryTrashed}, mirror=${pdfCleanup.mirrorTrashed})`,
      previousData: { driveLink: oldDriveLink },
      newData: { driveLink: '', needsRegeneration: true },
    });
  } else {
    // Legacy-user path. Old behaviour: log + Trash-tab row for Apps Script.
    await writeLog(sheets, sheetId, {
      action: 'UPDATE',
      dataType: 'invoice',
      recordId: num,
      changes: `PDF regeneration triggered - cleared driveLink${oldDriveLink ? ' (old PDF will be moved to Trash by Apps Script)' : ''}`,
      previousData: { driveLink: oldDriveLink },
      newData: { driveLink: '', needsRegeneration: true }
    });
    if (oldDriveLink) {
      try {
        await moveToTrash(sheets, sheetId, 'pdf_replacement', {
          num: num,
          driveLink: oldDriveLink,
          reason: 'PDF regeneration - entry edited'
        });
      } catch (e) {
        console.log('Failed to move old PDF to trash:', e.message);
        // Continue anyway - Apps Script will handle cleanup
      }
    }
  }

  return res.status(200).json({
    success: true,
    message: `PDF regeneration triggered for invoice #${num}${pdfCleanup ? ' (old PDF trashed server-side)' : ''}`,
    num,
    oldDriveLink: oldDriveLink || null,
    ...(pdfCleanup ? { pdfCleanup } : {}),
  });
}

async function syncInvoices(sheets, sheetId, { invoices }, res, backupSheetId = null) {
  if (!invoices || !invoices.length) {
    return res.status(200).json({ success: true, message: 'No invoices to sync', count: 0 });
  }

  const rows = invoices.map(invoice =>
    INVOICE_COLUMNS.map(col => {
      if (col === 'createdAt') return invoice.createdAt || new Date().toISOString();
      const val = invoice[col];
      if (val === null || val === undefined) return '';
      if (typeof val === 'object') return JSON.stringify(val);
      return val;
    })
  );

  const writeToSheet = async (targetId, label) => {
    try {
      // INVOICE_COLUMNS has 29 entries (A..AC). The previous A2:AA range
      // silently truncated paidStatus/paidDate/createdAt on bulk sync.
      await sheets.spreadsheets.values.clear({
        spreadsheetId: targetId,
        range: 'Invoices!A2:AC',
      });
      if (rows.length > 0) {
        await sheets.spreadsheets.values.update({
          spreadsheetId: targetId,
          range: `Invoices!A2:AC${rows.length + 1}`,
          valueInputOption: 'RAW',
          requestBody: { values: rows }
        });
      }
    } catch (e) {
      console.error(`[sheets-sync] Warning: syncInvoices failed on ${label}:`, e.message);
      if (label === 'primary') throw e;
    }
  };

  await writeToSheet(sheetId, 'primary');
  if (backupSheetId) await writeToSheet(backupSheetId, 'backup');

  return res.status(200).json({ success: true, message: 'Invoices synced', count: rows.length });
}

// ===== LOAD ALL =====
async function loadAll(sheets, sheetId, res) {
  const [entriesRes, invoicesRes] = await Promise.all([
    sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range: 'Entries!A:T' }),
    sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range: 'Invoices!A:AD' })  // Extended to include paidStatus, paidDate
  ]);

  const entriesRows = entriesRes.data.values || [];
  const invoicesRows = invoicesRes.data.values || [];

  const entries = entriesRows
    .filter(row => row[0] && row[0] !== 'id')
    .map(row => {
      const obj = {};
      ENTRY_COLUMNS.forEach((col, i) => {
        let val = row[i];
        if (['pts', 'uPrice', 'aoAmt', 'aoPatients', 'gross', 'comm', 'commAmt'].includes(col)) {
          val = parseFloat(val) || 0;
        }
        if (col === 'svcs' && val) {
          try { val = JSON.parse(val); } catch(e) {}
        }
        obj[col] = val || (col === 'pts' ? 0 : '');
      });
      return obj;
    });

  // Get headers from first row to map columns dynamically
  const invoiceHeaders = invoicesRows[0] || INVOICE_COLUMNS;

  // Debug: Log header info for paidStatus
  const paidStatusIdx = invoiceHeaders.indexOf('paidStatus');
  const paidDateIdx = invoiceHeaders.indexOf('paidDate');
  console.log('[loadAll] Invoice headers count:', invoiceHeaders.length);
  console.log('[loadAll] paidStatus at index:', paidStatusIdx, 'paidDate at index:', paidDateIdx);

  const invoices = invoicesRows
    .filter((row, idx) => idx > 0 && row[0] && row[0] !== 'num')
    .map(row => {
      const obj = {};
      // Pad row to match header length (Google Sheets API omits trailing empty cells)
      while (row.length < invoiceHeaders.length) {
        row.push('');
      }
      invoiceHeaders.forEach((col, i) => {
        if (!col) return; // Skip empty header columns
        let val = row[i];
        if (['amount', 'gross', 'airTotal'].includes(col)) {
          val = parseFloat(val) || 0;
        }
        if (col === 'isAdhoc') {
          val = val === 'true' || val === true;
        }
        if ((col === 'svcs' || col === 'addons') && val) {
          try { val = JSON.parse(val); } catch(e) {}
        }
        obj[col] = val || '';
      });
      // Debug: Log paidStatus for each invoice
      console.log('[loadAll] Invoice', obj.num, 'row length:', row.length, 'paidStatus:', obj.paidStatus || '(empty)', 'paidDate:', obj.paidDate || '(empty)');
      return obj;
    });

  return res.status(200).json({
    success: true,
    entries,
    invoices,
    entriesCount: entries.length,
    invoicesCount: invoices.length
  });
}

// ===== PRACTICES =====
// Syncs practices to the user-facing sheet AND (if configured) the hidden
// backup sheet — both are full mirrors in central-hub multi-user mode.
// Single-user legacy mode also writes to GOOGLE_SHEET_ID_LTD if set and
// distinct from the primary sheet (preserves dual-entity behaviour).
async function syncPractices(sheets, sheetId, { practices }, res, backupSheetId = null) {
  console.log('[syncPractices] Received practices:', practices ? practices.length : 'null/undefined');
  if (practices && practices.length > 0) {
    console.log('[syncPractices] Practice types:', practices.map(p => `${p.id}:${p.type}`).join(', '));
  }

  if (!practices || !practices.length) {
    return res.status(200).json({ success: true, message: 'No practices to sync', count: 0 });
  }

  const rows = practices.map(p =>
    PRACTICE_COLUMNS.map(col => {
      if (col === 'createdAt') return p.createdAt || new Date().toISOString();
      const val = p[col];
      if (val === null || val === undefined) return '';
      if (typeof val === 'object') return JSON.stringify(val);
      return val;
    })
  );

  console.log('[syncPractices] Built', rows.length, 'rows');
  console.log('[syncPractices] Row IDs:', rows.map(r => r[0]).join(', '));
  // Log services column for debugging (column index 7 = services)
  rows.forEach(r => console.log('[syncPractices] Row', r[0], 'services:', r[7]));

  // Helper to sync to a single sheet and apply colors
  async function syncToSheet(targetSheetId) {
    // Clear all data from row 1 onwards (including header to fix column structure)
    await sheets.spreadsheets.values.clear({
      spreadsheetId: targetSheetId,
      range: 'Practices!A1:Q100',
    });

    // Clear formatting for rows 2-100 to remove any leftover colored rows
    try {
      const metadata = await sheets.spreadsheets.get({ spreadsheetId: targetSheetId });
      const sheet = metadata.data.sheets.find(s => s.properties.title === 'Practices');
      if (sheet) {
        await sheets.spreadsheets.batchUpdate({
          spreadsheetId: targetSheetId,
          requestBody: {
            requests: [{
              repeatCell: {
                range: {
                  sheetId: sheet.properties.sheetId,
                  startRowIndex: 1, // Row 2 (0-indexed)
                  endRowIndex: 100,
                  startColumnIndex: 0,
                  endColumnIndex: 17  // Columns A-Q (17 columns)
                },
                cell: {
                  userEnteredFormat: {
                    backgroundColor: { red: 1, green: 1, blue: 1 } // White
                  }
                },
                fields: 'userEnteredFormat.backgroundColor'
              }
            }]
          }
        });
      }
    } catch (e) {
      console.log('Could not clear formatting:', e.message);
    }

    // Always write header row first with current column structure
    await sheets.spreadsheets.values.update({
      spreadsheetId: targetSheetId,
      range: 'Practices!A1:Q1',
      valueInputOption: 'RAW',
      requestBody: { values: [PRACTICE_COLUMNS] }
    });

    if (rows.length > 0) {
      // Write data rows starting at A2
      await sheets.spreadsheets.values.update({
        spreadsheetId: targetSheetId,
        range: `Practices!A2:Q${rows.length + 1}`,
        valueInputOption: 'RAW',
        requestBody: { values: rows }
      });

      // Apply color coding to each practice row
      for (let i = 0; i < practices.length; i++) {
        const p = practices[i];
        const colorScheme = getPracticeColor(p.id, p.type, p.color);
        await applyRowColor(sheets, targetSheetId, 'Practices', i + 1, colorScheme); // +1 for header row
      }
    }
  }

  // Sync to the user-facing sheet (passed in from session.sheetId in
  // multi-user mode, or env-var fallback in legacy single-user mode).
  // Then mirror to the hidden backup sheet if the session provides one.
  // In legacy single-user mode, also mirror to the distinct LTD env sheet
  // so both entities keep parity (back-compat).
  const targets = [];
  if (sheetId) targets.push({ id: sheetId, label: 'user-facing' });
  if (backupSheetId && backupSheetId !== sheetId) {
    targets.push({ id: backupSheetId, label: 'hidden-backup' });
  }
  // Legacy single-user mode: env-based dual sheet (only when no session
  // sheet was provided AND the legacy LTD sheet is configured + distinct).
  if (!backupSheetId && SHEET_IDS.ltd && SHEET_IDS.ltd !== sheetId) {
    targets.push({ id: SHEET_IDS.ltd, label: 'legacy-ltd' });
  }

  console.log('[syncPractices] Writing to', targets.length, 'sheet(s):',
    targets.map(t => `${t.label}=${t.id}`).join(', '));

  if (targets.length === 0) {
    return res.status(500).json({
      success: false,
      error: 'No target sheet resolved for sync_practices (no session.sheetId, no env fallback)'
    });
  }

  // The FIRST target is always the user-facing sheet (or the legacy primary
  // sheet in single-user mode) — the one the user actually opens. If that
  // write fails the operation MUST fail so the client doesn't show a false
  // "saved" state. Backup/mirror failures are downgraded to warnings: data
  // is correct in the user-facing sheet and ops can re-mirror later.
  const results = await Promise.allSettled(targets.map(t => syncToSheet(t.id)));
  const enriched = results.map((r, i) => ({
    target: targets[i].label,
    id: targets[i].id,
    ok: r.status === 'fulfilled',
    reason: r.status === 'rejected' ? (r.reason?.message || String(r.reason)) : null
  }));

  const primary = enriched[0];
  const secondaryFailures = enriched.slice(1).filter(e => !e.ok);

  if (!primary.ok) {
    console.error('[syncPractices] Primary target failed:', JSON.stringify(enriched));
    return res.status(500).json({
      success: false,
      error: 'Sheets API error',
      message: primary.reason,
      details: enriched
    });
  }

  if (secondaryFailures.length > 0) {
    console.error('[syncPractices] Mirror target(s) failed (primary OK):', JSON.stringify(secondaryFailures));
  }

  return res.status(200).json({
    success: true,
    message: `Practices synced to primary${secondaryFailures.length ? ` (${secondaryFailures.length} mirror failure(s))` : ''}`,
    count: rows.length,
    targets: enriched.map(e => ({ target: e.target, ok: e.ok })),
    mirrorFailures: secondaryFailures.length > 0 ? secondaryFailures : undefined
  });
}

async function loadPractices(sheets, sheetId, res) {
  console.log('[loadPractices] Loading from sheet:', sheetId);
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: 'Practices!A:Q',
  });

  const rows = response.data.values || [];
  console.log('[loadPractices] Raw rows count:', rows.length);
  console.log('[loadPractices] Raw rows (first 5):', JSON.stringify(rows.slice(0, 5)));

  // Get header row to determine column positions dynamically
  // This handles column order changes gracefully
  const headerRow = rows[0] || [];
  console.log('[loadPractices] Header row:', headerRow);

  const practices = rows
    .filter(row => row[0] && row[0] !== 'id')
    .map(row => {
      const obj = {};
      // Map each header to its value in this row
      headerRow.forEach((colName, i) => {
        let val = row[i];
        if (['comm', 'rate', 'air', 'ptsPerHour', 'paymentDueDay'].includes(colName)) val = parseFloat(val) || 0;
        if (colName === 'active') val = val === '' ? true : (val === 'true' || val === true);
        if ((colName === 'services' || colName === 'days' || colName === 'paidHours') && val) {
          try { val = JSON.parse(val); } catch(e) {}
        }
        obj[colName] = val !== undefined ? val : '';
      });
      return obj;
    });

  console.log('[loadPractices] Parsed practices:', practices.map(p => ({ id: p.id, type: p.type, name: p.name, services: typeof p.services })));
  // Log full services for debugging
  practices.forEach(p => console.log('[loadPractices] Practice', p.id, 'services:', JSON.stringify(p.services)));
  return res.status(200).json({ success: true, practices, count: practices.length });
}

// ===== SETTINGS =====
// Settings are split: entity-specific (nextInv only) vs shared (dayMap, ahPrac, payTerms, entities, defComm, etc.)
// Shared settings are mirrored to both sheets so both entities have access to all configurations
const SHARED_SETTINGS_KEYS = ['dayMap', 'ahPrac', 'payTerms', 'invoiceFooter', 'entities', 'defComm', 'customHolidays', 'scheduleExceptions', 'workSchedule', 'scheduleHours', 'draftServices', 'serviceDurations'];
const ENTITY_SPECIFIC_KEYS = ['nextInv'];

async function syncSettings(sheets, sheetId, { settings, entity }, res, backupSheetId = null) {
  if (!settings || Object.keys(settings).length === 0) {
    return res.status(200).json({ success: true, message: 'No settings to sync', count: 0 });
  }

  // Separate entity-specific vs shared settings
  const entitySpecificSettings = {};
  const sharedSettings = {};

  Object.entries(settings).forEach(([key, value]) => {
    if (ENTITY_SPECIFIC_KEYS.includes(key)) {
      entitySpecificSettings[key] = value;
    } else if (SHARED_SETTINGS_KEYS.includes(key)) {
      sharedSettings[key] = value;
    } else {
      // Default to entity-specific for unknown keys
      entitySpecificSettings[key] = value;
    }
  });

  // Helper to build rows from settings object
  const buildRows = (settingsObj) => Object.entries(settingsObj).map(([key, value]) => [
    key,
    typeof value === 'object' ? JSON.stringify(value) : String(value),
    new Date().toISOString()
  ]);

  // Helper to sync settings to a sheet (merge, don't replace all)
  async function syncToSheet(targetSheetId, settingsToSync) {
    if (Object.keys(settingsToSync).length === 0) return;

    // First, load existing settings
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: targetSheetId,
      range: 'Settings!A:C',
    });

    const existingRows = response.data.values || [];
    const existingSettings = {};
    existingRows
      .filter(row => row[0] && row[0] !== 'key')
      .forEach(row => {
        existingSettings[row[0]] = row[1];
      });

    // Merge new settings into existing
    Object.entries(settingsToSync).forEach(([key, value]) => {
      existingSettings[key] = typeof value === 'object' ? JSON.stringify(value) : String(value);
    });

    // Write back all settings
    const rows = Object.entries(existingSettings).map(([key, value]) => [
      key,
      value,
      new Date().toISOString()
    ]);

    // Clear data rows (not header)
    await sheets.spreadsheets.values.clear({
      spreadsheetId: targetSheetId,
      range: 'Settings!A2:C',
    });

    if (rows.length > 0) {
      // Use update with explicit range starting at A2 to avoid header issues
      await sheets.spreadsheets.values.update({
        spreadsheetId: targetSheetId,
        range: `Settings!A2:C${rows.length + 1}`,
        valueInputOption: 'RAW',
        requestBody: { values: rows }
      });
    }
  }

  // Determine which sheet we're syncing to
  const isSelfSheet = sheetId === SHEET_IDS.self;
  const isLtdSheet = sheetId === SHEET_IDS.ltd;
  const otherSheetId = isSelfSheet ? SHEET_IDS.ltd : SHEET_IDS.self;

  // Sync to the CURRENT entity's sheet: entity-specific + shared settings together
  const currentSheetSettings = { ...entitySpecificSettings, ...sharedSettings };
  if (Object.keys(currentSheetSettings).length > 0) {
    await syncToSheet(sheetId, currentSheetSettings);
  }

  // Sync shared settings ONLY to the OTHER sheet (if different)
  if (Object.keys(sharedSettings).length > 0 && otherSheetId && otherSheetId !== sheetId) {
    await syncToSheet(otherSheetId, sharedSettings);
  }

  // Multi-user dual-write: mirror full settings to the user's backup sheet
  // so disaster recovery can restore from the hidden backup. Failure here
  // must not break the primary write — log and continue.
  if (backupSheetId && Object.keys(currentSheetSettings).length > 0) {
    try {
      await syncToSheet(backupSheetId, currentSheetSettings);
    } catch (e) {
      console.error('[sheets-sync] Warning: syncSettings failed on backup:', e.message);
    }
  }

  return res.status(200).json({
    success: true,
    message: 'Settings synced',
    entitySpecificCount: Object.keys(entitySpecificSettings).length,
    sharedCount: Object.keys(sharedSettings).length
  });
}

async function loadSettings(sheets, sheetId, res) {
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: 'Settings!A:C',
  });

  const rows = response.data.values || [];
  const settings = {};
  rows
    .filter(row => row[0] && row[0] !== 'key')
    .forEach(row => {
      let val = row[1];
      try { val = JSON.parse(val); } catch(e) {}
      settings[row[0]] = val;
    });

  return res.status(200).json({ success: true, settings });
}

// ===== DASHBOARD =====
async function getDashboard(sheets, sheetId, res) {
  const [entriesRes, invoicesRes] = await Promise.all([
    sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range: 'Entries!A:T' }),
    sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range: 'Invoices!A:AD' })
  ]);

  const entriesRows = entriesRes.data.values || [];
  const invoicesRows = invoicesRes.data.values || [];

  // Parse entries
  const entries = entriesRows
    .filter(row => row[0] && row[0] !== 'id')
    .map(row => ({
      date: row[1],
      pName: row[3],
      gross: parseFloat(row[11]) || 0,
      commAmt: parseFloat(row[13]) || 0
    }));

  // Parse invoices
  const invoices = invoicesRows
    .filter(row => row[0] && row[0] !== 'num')
    .map(row => ({
      num: row[0],
      date: row[1],
      practice: row[2],
      amount: parseFloat(row[14]) || 0,
      gross: parseFloat(row[15]) || 0
    }));

  const now = new Date();
  const currentYear = now.getFullYear();
  const currentMonth = now.getMonth();
  const currentWeekStart = new Date(now);
  currentWeekStart.setDate(now.getDate() - now.getDay());
  currentWeekStart.setHours(0, 0, 0, 0);

  // Calculate totals
  let weeklyGross = 0, weeklyComm = 0, weeklyEntries = 0;
  let monthlyGross = 0, monthlyComm = 0, monthlyEntries = 0;
  let ytdGross = 0, ytdComm = 0, ytdEntries = 0;
  const practiceBreakdown = {};

  entries.forEach(e => {
    const d = new Date(e.date);
    if (isNaN(d.getTime())) return;

    // YTD
    if (d.getFullYear() === currentYear) {
      ytdGross += e.gross;
      ytdComm += e.commAmt;
      ytdEntries++;
    }

    // Monthly
    if (d.getFullYear() === currentYear && d.getMonth() === currentMonth) {
      monthlyGross += e.gross;
      monthlyComm += e.commAmt;
      monthlyEntries++;
    }

    // Weekly
    if (d >= currentWeekStart) {
      weeklyGross += e.gross;
      weeklyComm += e.commAmt;
      weeklyEntries++;
    }

    // Practice breakdown (YTD)
    if (d.getFullYear() === currentYear) {
      if (!practiceBreakdown[e.pName]) {
        practiceBreakdown[e.pName] = { gross: 0, comm: 0, entries: 0 };
      }
      practiceBreakdown[e.pName].gross += e.gross;
      practiceBreakdown[e.pName].comm += e.commAmt;
      practiceBreakdown[e.pName].entries++;
    }
  });

  // Invoice totals
  let weeklyInvoiced = 0, monthlyInvoiced = 0, ytdInvoiced = 0;
  invoices.forEach(inv => {
    const d = new Date(inv.date);
    if (isNaN(d.getTime())) return;

    if (d.getFullYear() === currentYear) ytdInvoiced += inv.amount;
    if (d.getFullYear() === currentYear && d.getMonth() === currentMonth) monthlyInvoiced += inv.amount;
    if (d >= currentWeekStart) weeklyInvoiced += inv.amount;
  });

  // Mirror the computed dashboard data into a `Dashboard` tab on the user's
  // sheet so they can see it directly in Sheets. This is purely a side effect
  // — the frontend reads the JSON response below, not this tab — so if the
  // tab doesn't exist (it's not in setupAllTabs's canonical 6) we just skip
  // the write rather than 500-ing the whole call. Pre-existing user sheets
  // (Marcus, Taylor, Reo) were created before this tab was added; new sheets
  // from onboarding don't get it either.
  const dashboardData = [
    ['Metric', 'Weekly', 'Monthly', 'YTD'],
    ['Gross Revenue', weeklyGross.toFixed(2), monthlyGross.toFixed(2), ytdGross.toFixed(2)],
    ['Commission Earned', weeklyComm.toFixed(2), monthlyComm.toFixed(2), ytdComm.toFixed(2)],
    ['Amount Invoiced', weeklyInvoiced.toFixed(2), monthlyInvoiced.toFixed(2), ytdInvoiced.toFixed(2)],
    ['Patient Entries', weeklyEntries, monthlyEntries, ytdEntries],
    ['Total Invoices', '', '', invoices.length],
    [],
    ['Practice Breakdown (YTD)', 'Gross', 'Commission', 'Entries'],
    ...Object.entries(practiceBreakdown).map(([name, data]) => [
      name, data.gross.toFixed(2), data.comm.toFixed(2), data.entries
    ])
  ];

  try {
    await sheets.spreadsheets.values.update({
      spreadsheetId: sheetId,
      range: 'Dashboard!A1:D50',
      valueInputOption: 'RAW',
      requestBody: { values: dashboardData }
    });
  } catch (e) {
    // Tab missing → expected for sheets created before Dashboard was added.
    // Any other error is logged but still non-fatal.
    if (!/Unable to parse range/i.test(e?.message || '')) {
      console.warn('[getDashboard] Dashboard tab write failed:', e.message);
    }
  }

  return res.status(200).json({
    success: true,
    dashboard: {
      weekly: { gross: weeklyGross, commission: weeklyComm, invoiced: weeklyInvoiced, entries: weeklyEntries },
      monthly: { gross: monthlyGross, commission: monthlyComm, invoiced: monthlyInvoiced, entries: monthlyEntries },
      ytd: { gross: ytdGross, commission: ytdComm, invoiced: ytdInvoiced, entries: ytdEntries },
      practiceBreakdown,
      totalInvoices: invoices.length
    }
  });
}

// ===== RENAME SHEET =====
async function renameSheet(sheets, sheetId, { title }, res) {
  if (!title) {
    return res.status(400).json({ error: 'Missing title' });
  }

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: sheetId,
    requestBody: {
      requests: [{
        updateSpreadsheetProperties: {
          properties: { title },
          fields: 'title'
        }
      }]
    }
  });

  return res.status(200).json({ success: true, message: `Sheet renamed to: ${title}` });
}

// ===== SETUP LOG TAB =====
async function setupLogTab(sheets, sheetId, res) {
  try {
    // First check if Log tab exists, if not create it
    const sheetMetadata = await sheets.spreadsheets.get({ spreadsheetId: sheetId });
    const logSheet = sheetMetadata.data.sheets.find(s => s.properties.title === 'Log');

    if (!logSheet) {
      // Create the Log tab
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: sheetId,
        requestBody: {
          requests: [{
            addSheet: {
              properties: { title: 'Log' }
            }
          }]
        }
      });
    }

    // Add headers
    await sheets.spreadsheets.values.update({
      spreadsheetId: sheetId,
      range: 'Log!A1:G1',
      valueInputOption: 'RAW',
      requestBody: { values: [LOG_COLUMNS] }
    });

    return res.status(200).json({ success: true, message: 'Log tab setup complete' });
  } catch (e) {
    return res.status(500).json({ error: 'Failed to setup Log tab', message: e.message });
  }
}

// ===== SETUP ALL TABS =====
// Ensures all tabs exist with correct headers in both Self and Ltd sheets
async function setupAllTabs(sheets, res) {
  const results = { self: {}, ltd: {} };

  // Define all tabs with their headers
  const TABS = [
    { name: 'Entries', columns: ENTRY_COLUMNS, range: 'A:T' },
    { name: 'Invoices', columns: INVOICE_COLUMNS, range: 'A:AA' },
    { name: 'Practices', columns: PRACTICE_COLUMNS, range: 'A:P' },
    { name: 'Settings', columns: SETTINGS_COLUMNS, range: 'A:C' },
    { name: 'Log', columns: LOG_COLUMNS, range: 'A:G' },
    { name: 'Trash', columns: TRASH_COLUMNS, range: 'A:C' }
  ];

  async function setupSheet(sheetId, sheetName) {
    const tabResults = {};

    for (const tab of TABS) {
      try {
        // Check if tab exists
        const metadata = await sheets.spreadsheets.get({ spreadsheetId: sheetId });
        const existingTab = metadata.data.sheets.find(s => s.properties.title === tab.name);

        if (!existingTab) {
          // Create the tab
          await sheets.spreadsheets.batchUpdate({
            spreadsheetId: sheetId,
            requestBody: {
              requests: [{
                addSheet: {
                  properties: { title: tab.name }
                }
              }]
            }
          });
          tabResults[tab.name] = 'created';
        } else {
          tabResults[tab.name] = 'exists';
        }

        // Check current headers
        const headerResponse = await sheets.spreadsheets.values.get({
          spreadsheetId: sheetId,
          range: `${tab.name}!1:1`,
        });

        const currentHeaders = headerResponse.data.values?.[0] || [];
        const expectedHeaders = tab.columns;

        // Compare headers
        const headersMatch = expectedHeaders.every((col, i) => currentHeaders[i] === col);

        if (!headersMatch || currentHeaders.length !== expectedHeaders.length) {
          // Update headers - handle columns beyond Z (AA, AB, etc.)
          const colCount = expectedHeaders.length;
          let endCol;
          if (colCount <= 26) {
            endCol = String.fromCharCode(64 + colCount);
          } else {
            // For columns beyond Z: AA=27, AB=28, etc.
            const firstLetter = String.fromCharCode(64 + Math.floor((colCount - 1) / 26));
            const secondLetter = String.fromCharCode(64 + ((colCount - 1) % 26) + 1);
            endCol = firstLetter + secondLetter;
          }
          await sheets.spreadsheets.values.update({
            spreadsheetId: sheetId,
            range: `${tab.name}!A1:${endCol}1`,
            valueInputOption: 'RAW',
            requestBody: { values: [expectedHeaders] }
          });
          tabResults[tab.name] = tabResults[tab.name] === 'created' ? 'created+headers' : 'headers_fixed';
        }
      } catch (e) {
        tabResults[tab.name] = `error: ${e.message}`;
      }
    }

    return tabResults;
  }

  // Setup both sheets
  try {
    if (SHEET_IDS.self) {
      results.self = await setupSheet(SHEET_IDS.self, 'Self-Employed');
    }
    if (SHEET_IDS.ltd && SHEET_IDS.ltd !== SHEET_IDS.self) {
      results.ltd = await setupSheet(SHEET_IDS.ltd, 'Ltd Company');
    }

    return res.status(200).json({
      success: true,
      message: 'All tabs setup complete',
      results
    });
  } catch (e) {
    return res.status(500).json({
      error: 'Failed to setup tabs',
      message: e.message,
      results
    });
  }
}
