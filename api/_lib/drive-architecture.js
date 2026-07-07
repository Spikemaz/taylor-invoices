/**
 * Shared helpers for the central-hub + hidden-backup Drive architecture.
 *
 * Two parents matter:
 *   GOOGLE_DRIVE_FOLDER_ID                   — central hub, holds user-facing sheets/folders
 *   GOOGLE_DRIVE_HIDDEN_BACKUP_ROOT_ID       — hidden tier, holds backup sheets/folders the user CANNOT see
 *
 * Per-user we create FOUR things:
 *   1. user-facing sheet   inside CENTRAL, shared to user email as editor
 *   2. user-facing folder  inside CENTRAL, shared to user email as editor (PDFs land here)
 *   3. hidden backup sheet inside HIDDEN_BACKUP_ROOT, NEVER shared with user
 *   4. hidden backup folder inside HIDDEN_BACKUP_ROOT, NEVER shared with user
 *
 * Master Sheet Users tab columns F/G hold the user-facing IDs, L/M hold the hidden backup IDs.
 *
 * If GOOGLE_DRIVE_HIDDEN_BACKUP_ROOT_ID is not set, callers fall back to L=F, M=G
 * (same as the original onboarding behaviour). The admin/backfill-architecture
 * endpoint sweeps those users into a real backup later, once the env var is set.
 */

const { google } = require('googleapis');
const { getAuthClient } = require('./auth');

function getClients() {
  const auth = getAuthClient();
  return {
    auth,
    sheets: google.sheets({ version: 'v4', auth }),
    drive: google.drive({ version: 'v3', auth }),
  };
}

function getCentralFolderId() {
  const v = process.env.GOOGLE_DRIVE_FOLDER_ID;
  if (!v) throw new Error('GOOGLE_DRIVE_FOLDER_ID is not set');
  return v;
}

/** Returns the hidden backup root ID, or null if unset (caller decides fallback). */
function getHiddenBackupRootId() {
  return process.env.GOOGLE_DRIVE_HIDDEN_BACKUP_ROOT_ID || null;
}

/**
 * Idempotent: returns existing folder of `name` under `parentId` or creates one.
 */
async function getOrCreateFolder(drive, name, parentId) {
  const escapedName = name.replace(/'/g, "\\'");
  const q = `name='${escapedName}' and mimeType='application/vnd.google-apps.folder' and '${parentId}' in parents and trashed=false`;
  const r = await drive.files.list({
    q,
    fields: 'files(id, name)',
    spaces: 'drive',
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });
  if (r.data.files && r.data.files.length > 0) return r.data.files[0].id;
  const f = await drive.files.create({
    requestBody: {
      name,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [parentId],
    },
    fields: 'id',
    supportsAllDrives: true,
  });
  return f.data.id;
}

async function createSpreadsheet(drive, name, parentFolderId) {
  const f = await drive.files.create({
    requestBody: {
      name,
      mimeType: 'application/vnd.google-apps.spreadsheet',
      parents: [parentFolderId],
    },
    fields: 'id',
    supportsAllDrives: true,
  });
  return f.data.id;
}

/**
 * Idempotent: returns the existing spreadsheet of `name` directly under
 * `parentFolderId` if one exists, else creates one. Use this instead of
 * createSpreadsheet whenever the caller might re-run after a partial
 * failure (e.g. migrate-user.js).
 *
 * The lookup is by exact name + parent + non-trashed; we don't try to
 * disambiguate when multiple matches exist — picking the first is the
 * conservative choice (matches getOrCreateFolder behaviour).
 */
async function getOrCreateSpreadsheet(drive, name, parentFolderId) {
  const escapedName = name.replace(/'/g, "\\'");
  const q = `name='${escapedName}' and mimeType='application/vnd.google-apps.spreadsheet' and '${parentFolderId}' in parents and trashed=false`;
  const r = await drive.files.list({
    q,
    fields: 'files(id, name)',
    spaces: 'drive',
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });
  if (r.data.files && r.data.files.length > 0) return r.data.files[0].id;
  return await createSpreadsheet(drive, name, parentFolderId);
}

/**
 * Share a Drive item with `email` at the given role.
 *
 * Idempotent. Strategy: enumerate existing permissions FIRST and look
 * for an existing user-permission for this email; if found, return
 * { alreadyShared: true } without calling create. This is more
 * reliable than catching create errors because Google's duplicate-share
 * error wording varies ("already exists", "already has permission",
 * 403 vs 409, etc).
 *
 * sendNotificationEmail defaults to false because we don't want users
 * spammed with "you've been shared on a folder" mails every time we
 * touch their account; the welcome / migration email handles comms.
 */
async function shareWithUser(drive, fileId, email, role = 'writer', sendNotificationEmail = false) {
  if (!email) throw new Error('shareWithUser: email required');
  const normalized = email.toLowerCase().trim();

  // List-first: enumerate existing permissions, look for matching user share.
  try {
    let pageToken;
    do {
      const r = await drive.permissions.list({
        fileId,
        fields: 'nextPageToken, permissions(id, emailAddress, role, type)',
        pageSize: 100,
        pageToken,
        supportsAllDrives: true,
      });
      pageToken = r.data.nextPageToken;
      for (const p of r.data.permissions || []) {
        if (p.type === 'user' && p.emailAddress && p.emailAddress.toLowerCase() === normalized) {
          return { created: false, alreadyShared: true, permissionId: p.id, existingRole: p.role };
        }
      }
    } while (pageToken);
  } catch (listErr) {
    // If listing fails (e.g. lack of permission to view permissions), fall through and attempt the create.
  }

  try {
    const result = await drive.permissions.create({
      fileId,
      requestBody: { role, type: 'user', emailAddress: email },
      sendNotificationEmail,
      supportsAllDrives: true,
    });
    return { created: true, permissionId: result.data.id };
  } catch (e) {
    // Belt-and-braces: if create fails with anything that looks like a duplicate, swallow it.
    const msg = e?.response?.data?.error?.message || e?.message || '';
    if (
      /already exists|already has|duplicate|conflict|cannotShareTeamDriveTopFolderWithUserOrGroup/i.test(msg) ||
      e?.code === 409
    ) {
      return { created: false, alreadyShared: true };
    }
    throw e;
  }
}

/** Tab + header definitions kept in sync with sheets-sync.js column lists. */
const STANDARD_TABS = [
  { title: 'Entries',   range: 'A1:T1',  headers: ['id','date','pId','pName','pType','svc','pts','uPrice','aoType','aoAmt','aoPatients','gross','comm','commAmt','entity','invSt','invNo','adhocAddr','color','createdAt'] },
  { title: 'Invoices',  range: 'A1:AC1', headers: ['num','date','practice','practiceName','practiceAddr','period','entity','entName','entAddr','entPhone','bankName','bankAccName','bankAcc','bankSort','amount','gross','commRate','svcs','addons','airTotal','logoType','payTerms','footerMsg','companyNo','isAdhoc','driveLink','paidStatus','paidDate','createdAt'] },
  { title: 'Practices', range: 'A1:R1',  headers: ['id','short','name','type','paymentMethod','addr','email','comm','services','days','rate','air','active','color','paidHours','ptsPerHour','paymentDueDay','createdAt'] },
  { title: 'Settings',  range: 'A1:C1',  headers: ['key','value','updatedAt'] },
  { title: 'Log',       range: 'A1:G1',  headers: ['timestamp','action','dataType','recordId','changes','previousData','newData'] },
  { title: 'Trash',     range: 'A1:C1',  headers: ['deletedAt','dataType','originalData'] },
];

/**
 * Make sure the spreadsheet has all the BooksIQ tabs with header rows.
 * Idempotent — safe on a freshly created sheet (renames Sheet1 -> Entries)
 * AND safe on a sheet that already has some/all tabs.
 *
 * Returns a map { tabTitle: { existed: bool } } so callers can decide
 * whether to seed initial data.
 */
async function ensureSheetSchema(sheets, sheetId) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId: sheetId });
  const existing = new Map(meta.data.sheets.map(s => [s.properties.title, s.properties.sheetId]));

  const requests = [];
  for (const tab of STANDARD_TABS) {
    if (existing.has(tab.title)) continue;
    if (tab.title === 'Entries' && existing.has('Sheet1')) {
      requests.push({
        updateSheetProperties: {
          properties: { sheetId: existing.get('Sheet1'), title: 'Entries' },
          fields: 'title',
        },
      });
    } else {
      requests.push({ addSheet: { properties: { title: tab.title } } });
    }
  }
  if (requests.length > 0) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: sheetId,
      requestBody: { requests },
    });
  }

  // Always (re)write the header rows. Overwriting a header with itself is a no-op.
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: sheetId,
    requestBody: {
      valueInputOption: 'RAW',
      data: STANDARD_TABS.map(tab => ({
        range: `${tab.title}!${tab.range}`,
        values: [tab.headers],
      })),
    },
  });

  const result = {};
  for (const tab of STANDARD_TABS) {
    result[tab.title] = { existed: existing.has(tab.title) };
  }
  return result;
}

/**
 * Read all data rows from each STANDARD tab (skipping header row 1) on
 * `srcSheetId` and append them to the matching tab on `dstSheetId`.
 *
 * Pass `{ clearFirst: true }` to make the operation IDEMPOTENT: each
 * destination tab's rows 2:end are cleared before the append, so a
 * mid-step crash followed by a re-run will not produce duplicate rows.
 * Use this whenever the destination is a sheet we own and where only
 * mirrored data should live (i.e. always, in our migration / backfill
 * paths). Default false preserves the original append-only semantics
 * for any future caller that wants strict appends.
 *
 * Returns { Entries: { rowsCopied: N, cleared: bool }, ... }.
 */
async function copyAllTabData(sheets, srcSheetId, dstSheetId, options = {}) {
  const { clearFirst = false } = options;
  const result = {};
  for (const tab of STANDARD_TABS) {
    let values = [];
    try {
      const r = await sheets.spreadsheets.values.get({
        spreadsheetId: srcSheetId,
        range: `${tab.title}!A:ZZ`,
      });
      values = r.data.values || [];
    } catch (e) {
      // Tab may not exist on src — that's OK, just zero rows
      result[tab.title] = { rowsCopied: 0, skipped: true, reason: e.message };
      continue;
    }
    let cleared = false;
    if (clearFirst) {
      try {
        await sheets.spreadsheets.values.clear({
          spreadsheetId: dstSheetId,
          range: `${tab.title}!A2:ZZ`,
        });
        cleared = true;
      } catch (e) {
        // If the dest tab doesn't exist the upstream caller should have
        // run ensureSheetSchema first; surface the error rather than swallow.
        result[tab.title] = { rowsCopied: 0, cleared: false, error: `clear failed: ${e.message}` };
        continue;
      }
    }
    const dataRows = values.slice(1); // strip header
    if (dataRows.length === 0) {
      result[tab.title] = { rowsCopied: 0, cleared };
      continue;
    }
    await sheets.spreadsheets.values.append({
      spreadsheetId: dstSheetId,
      range: `${tab.title}!A:ZZ`,
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: dataRows },
    });
    result[tab.title] = { rowsCopied: dataRows.length, cleared };
  }
  return result;
}

/**
 * Append a row to the MigrationLog tab on the master sheet.
 * Creates the tab on first use. Used by both the API endpoint
 * and the CLI migration scripts.
 *
 * Schema: timestamp | userId | phase | detail(JSON) | actor
 */
let _migrationLogReady = false;
async function _ensureMigrationLogTab(sheets, masterSheetId) {
  if (_migrationLogReady) return;
  try {
    await sheets.spreadsheets.values.get({
      spreadsheetId: masterSheetId,
      range: 'MigrationLog!A1:E1',
    });
    _migrationLogReady = true;
    return;
  } catch (e) {
    // Tab missing — create it.
  }
  try {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: masterSheetId,
      requestBody: {
        requests: [{
          addSheet: {
            properties: { title: 'MigrationLog', gridProperties: { rowCount: 1000, columnCount: 5 } },
          },
        }],
      },
    });
    await sheets.spreadsheets.values.update({
      spreadsheetId: masterSheetId,
      range: 'MigrationLog!A1:E1',
      valueInputOption: 'RAW',
      requestBody: { values: [['timestamp', 'userId', 'phase', 'detail', 'actor']] },
    });
    _migrationLogReady = true;
  } catch (e) {
    if (/already exists/i.test(e?.message || '')) {
      _migrationLogReady = true;
      return;
    }
    throw e;
  }
}

async function logMigrationEvent(sheets, masterSheetId, userId, phase, detail, actor = 'system') {
  await _ensureMigrationLogTab(sheets, masterSheetId);
  await sheets.spreadsheets.values.append({
    spreadsheetId: masterSheetId,
    range: 'MigrationLog!A:E',
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: {
      values: [[
        new Date().toISOString(),
        userId || '',
        phase,
        typeof detail === 'string' ? detail : JSON.stringify(detail),
        actor,
      ]],
    },
  });
}

/**
 * Read a user's Master Sheet row by userId. Returns { rowIndex (1-based), headers, row, asObject }.
 * Returns null if the user is not found.
 */
async function readMasterUserRow(sheets, masterSheetId, userId) {
  const r = await sheets.spreadsheets.values.get({
    spreadsheetId: masterSheetId,
    range: 'Users!A:Q',
  });
  const rows = r.data.values || [];
  if (rows.length <= 1) return null;
  const headers = rows[0];
  const userIdIdx = headers.indexOf('userId');
  for (let i = 1; i < rows.length; i++) {
    if (rows[i][userIdIdx] === userId) {
      const obj = {};
      headers.forEach((h, idx) => { obj[h] = rows[i][idx] || ''; });
      return { rowIndex: i + 1, headers, row: rows[i], asObject: obj };
    }
  }
  return null;
}

/**
 * Update specific cells in a user's Master Sheet row by header name.
 * `updates` is { headerName: value, ... }. Headers not present are skipped.
 * Returns the list of cells actually written.
 */
async function updateMasterUserCells(sheets, masterSheetId, userRowIndex, headers, updates) {
  const writes = [];
  for (const [headerName, value] of Object.entries(updates)) {
    const idx = headers.indexOf(headerName);
    if (idx === -1) continue;
    const colLetter = idx < 26
      ? String.fromCharCode(65 + idx)
      : String.fromCharCode(65 + Math.floor(idx / 26) - 1) + String.fromCharCode(65 + (idx % 26));
    writes.push({
      range: `Users!${colLetter}${userRowIndex}`,
      values: [[value]],
    });
  }
  if (writes.length > 0) {
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: masterSheetId,
      requestBody: { valueInputOption: 'RAW', data: writes },
    });
  }
  return writes;
}

module.exports = {
  getAuthClient,
  getClients,
  getCentralFolderId,
  getHiddenBackupRootId,
  getOrCreateFolder,
  createSpreadsheet,
  getOrCreateSpreadsheet,
  shareWithUser,
  ensureSheetSchema,
  copyAllTabData,
  logMigrationEvent,
  readMasterUserRow,
  updateMasterUserCells,
  STANDARD_TABS,
};
