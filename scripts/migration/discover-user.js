#!/usr/bin/env node
/**
 * Discovery: read EVERYTHING about a user's existing Drive + Sheets state
 * and write a manifest JSON the operator can review.
 *
 * READ-ONLY. Touches no Drive write APIs and writes nothing to the
 * Master Sheet. Safe to run as many times as you like.
 *
 * Usage:
 *   node scripts/migration/discover-user.js --user-id=<UUID>
 *   node scripts/migration/discover-user.js --user-id=<UUID> --output=./taylor-discovery.json
 *
 * Output (default): .local/migration/discover-<userId>.json
 *
 * The manifest contains:
 *   - the user's Master Sheet row + column meaning
 *   - every tab on user's sheet: row count, sample first 5 + last 5 rows, header row
 *   - every PDF in the user's Drive folder (recursive): id, name, parent path, byte size, owners, mimeType
 *   - the same for the backupSheetId/backupFolderId if different
 *   - the current ownership of every sheet (so we know who'd need to grant transfer)
 */

const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const {
  log, parseArgs, assertEnv, saveState, stateFilePathFor, nowIso,
} = require('./_lib');
const {
  getClients, readMasterUserRow, STANDARD_TABS,
} = require('../../api/_lib/drive-architecture');

async function main() {
  const args = parseArgs();
  if (!args.userId) {
    console.error('ERROR: --user-id=<UUID> is required');
    process.exit(2);
  }
  assertEnv('GOOGLE_SERVICE_ACCOUNT_EMAIL', 'GOOGLE_PRIVATE_KEY', 'MASTER_SHEET_ID');

  const masterSheetId = process.env.MASTER_SHEET_ID;
  const { sheets, drive } = getClients();

  log('info', `Discovering user ${args.userId}...`);

  const userRecord = await readMasterUserRow(sheets, masterSheetId, args.userId);
  if (!userRecord) {
    console.error(`ERROR: user ${args.userId} not found in Master Sheet`);
    process.exit(3);
  }

  const u = userRecord.asObject;
  log('info', `User: ${u.name} <${u.email}>`);
  log('info', `Sheet: ${u.sheetId || '(none)'}, Folder: ${u.driveFolderId || '(none)'}`);
  log('info', `Backup: sheet ${u.backupSheetId || '(none)'}, folder ${u.backupFolderId || '(none)'}`);

  const manifest = {
    discoveredAt: nowIso(),
    masterSheetId,
    user: {
      rowIndex: userRecord.rowIndex,
      ...u,
    },
    backupIsDistinct: u.backupSheetId && u.backupSheetId !== u.sheetId,
    sheets: {},
    folders: {},
  };

  // Inspect user-facing sheet
  if (u.sheetId) {
    manifest.sheets.userFacing = await inspectSheet(sheets, drive, u.sheetId);
  }
  if (u.backupSheetId && u.backupSheetId !== u.sheetId) {
    manifest.sheets.hiddenBackup = await inspectSheet(sheets, drive, u.backupSheetId);
  }

  // Inspect user-facing folder (recursive listing)
  if (u.driveFolderId) {
    log('info', `Listing folder ${u.driveFolderId} recursively...`);
    manifest.folders.userFacing = await listFolderRecursive(drive, u.driveFolderId);
    log('info', `  found ${manifest.folders.userFacing.fileCount} files in ${manifest.folders.userFacing.folderCount} folders`);
  }
  if (u.backupFolderId && u.backupFolderId !== u.driveFolderId) {
    log('info', `Listing backup folder ${u.backupFolderId} recursively...`);
    manifest.folders.hiddenBackup = await listFolderRecursive(drive, u.backupFolderId);
    log('info', `  found ${manifest.folders.hiddenBackup.fileCount} files in ${manifest.folders.hiddenBackup.folderCount} folders`);
  }

  const outPath = args.output || stateFilePathFor(args.userId, 'discover');
  saveState(outPath, manifest);
  log('info', `Manifest written to ${outPath}`);

  // Print a concise human-readable summary too
  console.log('\n=== SUMMARY ===');
  console.log(`Name:              ${u.name}`);
  console.log(`Email:             ${u.email}`);
  console.log(`Status / Role:     ${u.status} / ${u.role}`);
  console.log(`User-facing sheet: ${u.sheetId || '(none)'}`);
  console.log(`User-facing folder:${u.driveFolderId || '(none)'}`);
  console.log(`Hidden backup:     sheet=${u.backupSheetId || '(none)'} folder=${u.backupFolderId || '(none)'}`);
  console.log(`Backup distinct?   ${manifest.backupIsDistinct ? 'YES (already on new architecture)' : 'NO (still legacy / pre-upgrade)'}`);
  if (manifest.sheets.userFacing) {
    console.log('\nUser-facing sheet tabs:');
    for (const [tabName, info] of Object.entries(manifest.sheets.userFacing.tabs)) {
      console.log(`  ${tabName.padEnd(12)} ${info.rowCount} rows`);
    }
    console.log(`Owner(s) of user-facing sheet: ${manifest.sheets.userFacing.ownerEmails.join(', ') || '(unknown)'}`);
  }
  if (manifest.folders.userFacing) {
    console.log(`\nUser-facing folder: ${manifest.folders.userFacing.fileCount} files in ${manifest.folders.userFacing.folderCount} folders`);
  }
  console.log('\nReview the full manifest at:');
  console.log(`  ${outPath}\n`);
}

async function inspectSheet(sheets, drive, sheetId) {
  const out = { sheetId, tabs: {}, ownerEmails: [], error: null };
  try {
    // Get tab metadata
    const meta = await sheets.spreadsheets.get({ spreadsheetId: sheetId });
    const tabTitles = meta.data.sheets.map(s => s.properties.title);
    out.allTabTitles = tabTitles;

    // For each STANDARD tab, count rows + grab samples
    for (const tab of STANDARD_TABS) {
      if (!tabTitles.includes(tab.title)) {
        out.tabs[tab.title] = { exists: false, rowCount: 0 };
        continue;
      }
      try {
        const r = await sheets.spreadsheets.values.get({
          spreadsheetId: sheetId,
          range: `${tab.title}!A:ZZ`,
        });
        const values = r.data.values || [];
        const dataRows = values.slice(1);
        out.tabs[tab.title] = {
          exists: true,
          headerRow: values[0] || [],
          rowCount: dataRows.length,
          first5: dataRows.slice(0, 5),
          last5: dataRows.slice(-5),
        };
      } catch (e) {
        out.tabs[tab.title] = { exists: true, error: e.message };
      }
    }

    // Drive ownership
    const file = await drive.files.get({
      fileId: sheetId,
      fields: 'id,name,owners(emailAddress,displayName),permissions(emailAddress,role,type),size,modifiedTime',
      supportsAllDrives: true,
    });
    out.fileMeta = {
      name: file.data.name,
      modifiedTime: file.data.modifiedTime,
      size: file.data.size,
    };
    out.ownerEmails = (file.data.owners || []).map(o => o.emailAddress);
    out.permissions = file.data.permissions || [];
  } catch (e) {
    out.error = e.message;
  }
  return out;
}

/**
 * Recursively list the contents of a Drive folder.
 * Returns { folderId, files: [...], folders: [...], fileCount, folderCount }.
 * Each file entry has: id, name, parentPath, mimeType, size, modifiedTime, owners
 */
async function listFolderRecursive(drive, rootFolderId) {
  const result = {
    rootFolderId,
    files: [],
    folders: [],
    fileCount: 0,
    folderCount: 0,
    error: null,
  };
  try {
    const queue = [{ id: rootFolderId, path: '' }];
    while (queue.length > 0) {
      const current = queue.shift();
      let pageToken;
      do {
        const r = await drive.files.list({
          q: `'${current.id}' in parents and trashed=false`,
          fields: 'nextPageToken, files(id, name, mimeType, size, modifiedTime, owners(emailAddress))',
          pageSize: 1000,
          pageToken,
          spaces: 'drive',
          supportsAllDrives: true,
          includeItemsFromAllDrives: true,
        });
        pageToken = r.data.nextPageToken;
        for (const f of r.data.files || []) {
          const childPath = current.path ? `${current.path}/${f.name}` : f.name;
          if (f.mimeType === 'application/vnd.google-apps.folder') {
            result.folders.push({ id: f.id, name: f.name, parentPath: current.path, fullPath: childPath });
            result.folderCount++;
            queue.push({ id: f.id, path: childPath });
          } else {
            result.files.push({
              id: f.id,
              name: f.name,
              mimeType: f.mimeType,
              size: f.size ? Number(f.size) : null,
              modifiedTime: f.modifiedTime,
              parentPath: current.path,
              fullPath: childPath,
              ownerEmails: (f.owners || []).map(o => o.emailAddress),
            });
            result.fileCount++;
          }
        }
      } while (pageToken);
    }
  } catch (e) {
    result.error = e.message;
  }
  return result;
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
