#!/usr/bin/env node
/**
 * Post-migration verification: compare old vs new for a migrated user.
 *
 * READ-ONLY. Safe to run any time.
 *
 * Usage:
 *   node scripts/migration/verify-migration.js --user-id=<UUID>
 *
 * Reads the migrate-<userId>.json state file to find the old + new IDs,
 * then:
 *   - row-counts each STANDARD tab on old + new + backup; flags mismatches
 *   - file-counts the PDFs in old folder vs new folder vs backup folder; flags mismatches
 *   - samples 5 random invoice rows: confirms `driveLink` resolves to a Drive file
 *   - prints a green/red summary
 *
 * Exit code 0 on all-green, 1 on any failure (so it can gate a CI/script).
 */

const {
  log, parseArgs, assertEnv, loadState, stateFilePathFor,
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

  const userRecord = await readMasterUserRow(sheets, masterSheetId, args.userId);
  if (!userRecord) {
    console.error(`ERROR: user ${args.userId} not found in Master Sheet`);
    process.exit(3);
  }
  const u = userRecord.asObject;

  const migrateState = loadState(stateFilePathFor(args.userId, 'migrate'));
  const snapshotState = loadState(stateFilePathFor(args.userId, 'snapshot'));

  if (!migrateState || !migrateState.completedAt) {
    console.error('ERROR: migrate state file missing or migration not complete');
    console.error('Path: ' + stateFilePathFor(args.userId, 'migrate'));
    process.exit(4);
  }
  if (!snapshotState || !snapshotState.masterRowSnapshot) {
    console.error('ERROR: snapshot state file missing — cannot determine old IDs to compare');
    console.error('Path: ' + stateFilePathFor(args.userId, 'snapshot'));
    process.exit(5);
  }

  const oldRow = snapshotState.masterRowSnapshot;
  const oldSheetId = oldRow.sheetId;
  const oldFolderId = oldRow.driveFolderId;
  const newSheetId = u.sheetId;
  const newFolderId = u.driveFolderId;
  const backupSheetId = u.backupSheetId;
  const backupFolderId = u.backupFolderId;

  console.log('\n=== VERIFICATION ===');
  console.log(`User:               ${u.name} <${u.email}>`);
  console.log(`OLD sheet/folder:   ${oldSheetId} / ${oldFolderId}`);
  console.log(`NEW sheet/folder:   ${newSheetId} / ${newFolderId}`);
  console.log(`BACKUP sheet/folder:${backupSheetId} / ${backupFolderId}`);
  console.log('');

  const results = [];

  // ---- Tab row-count comparison ----
  for (const tab of STANDARD_TABS) {
    const [oldN, newN, backupN] = await Promise.all([
      countTabRows(sheets, oldSheetId, tab.title),
      countTabRows(sheets, newSheetId, tab.title),
      backupSheetId ? countTabRows(sheets, backupSheetId, tab.title) : Promise.resolve(null),
    ]);
    const ok = oldN === newN && (backupN === null || backupN === newN);
    results.push({ check: `tab ${tab.title}`, old: oldN, new: newN, backup: backupN, ok });
  }

  // ---- PDF file-count comparison ----
  const oldFiles = await countFilesRecursive(drive, oldFolderId);
  const newFiles = await countFilesRecursive(drive, newFolderId);
  const backupFiles = backupFolderId ? await countFilesRecursive(drive, backupFolderId) : null;
  results.push({
    check: 'PDF file count',
    old: oldFiles,
    new: newFiles,
    backup: backupFiles,
    ok: oldFiles === newFiles && (backupFiles === null || backupFiles === newFiles),
  });

  // ---- Sample invoice driveLinks resolve ----
  const linkCheck = await sampleInvoiceLinkCheck(sheets, drive, newSheetId, 5);
  results.push({
    check: 'Sample invoice driveLinks resolve (5)',
    detail: linkCheck.summary,
    ok: linkCheck.allOk,
  });

  // ---- Master row points at new IDs ----
  results.push({
    check: 'Master row sheetId/driveFolderId updated',
    old: `was ${oldSheetId} / ${oldFolderId}`,
    new: `now ${newSheetId} / ${newFolderId}`,
    ok: newSheetId !== oldSheetId && newFolderId !== oldFolderId,
  });

  // ---- Backup distinct from user-facing ----
  results.push({
    check: 'Backup sheet+folder distinct from user-facing',
    detail: `backupSheetId=${backupSheetId} vs sheetId=${newSheetId}`,
    ok: backupSheetId && backupSheetId !== newSheetId && backupFolderId && backupFolderId !== newFolderId,
  });

  // ---- Print results ----
  console.log('Results:');
  let allGreen = true;
  for (const r of results) {
    const tag = r.ok ? 'PASS' : 'FAIL';
    if (!r.ok) allGreen = false;
    const detail = (r.detail !== undefined)
      ? r.detail
      : `old=${r.old} new=${r.new}${r.backup !== undefined ? ` backup=${r.backup}` : ''}`;
    console.log(`  [${tag}] ${r.check.padEnd(48)} ${detail}`);
  }

  console.log('');
  console.log(allGreen ? '*** ALL CHECKS PASSED ***' : '*** ONE OR MORE CHECKS FAILED — review above ***');
  console.log('');

  process.exit(allGreen ? 0 : 1);
}

async function countTabRows(sheets, sheetId, tabTitle) {
  try {
    const r = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetId,
      range: `${tabTitle}!A:A`,
    });
    const rows = r.data.values || [];
    return Math.max(0, rows.length - 1); // exclude header
  } catch (e) {
    return -1; // tab missing or unreadable
  }
}

async function countFilesRecursive(drive, folderId) {
  let count = 0;
  const queue = [folderId];
  while (queue.length > 0) {
    const cur = queue.shift();
    let pageToken;
    do {
      const r = await drive.files.list({
        q: `'${cur}' in parents and trashed=false`,
        fields: 'nextPageToken, files(id, mimeType)',
        pageSize: 1000,
        pageToken,
        spaces: 'drive',
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      });
      pageToken = r.data.nextPageToken;
      for (const f of r.data.files || []) {
        if (f.mimeType === 'application/vnd.google-apps.folder') {
          queue.push(f.id);
        } else {
          count++;
        }
      }
    } while (pageToken);
  }
  return count;
}

async function sampleInvoiceLinkCheck(sheets, drive, sheetId, sampleSize = 5) {
  let invoicesRows;
  try {
    const r = await sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range: 'Invoices!A:AC' });
    invoicesRows = r.data.values || [];
  } catch (e) {
    return { allOk: false, summary: `cannot read Invoices tab: ${e.message}` };
  }
  if (invoicesRows.length <= 1) return { allOk: true, summary: 'no invoices to sample' };
  const headers = invoicesRows[0];
  const linkIdx = headers.indexOf('driveLink');
  if (linkIdx === -1) return { allOk: false, summary: 'no driveLink column' };

  // Random sample of rows that actually have a link
  const withLinks = invoicesRows.slice(1).filter(r => r[linkIdx]);
  if (withLinks.length === 0) return { allOk: true, summary: 'no rows have driveLink' };
  const shuffled = withLinks.sort(() => Math.random() - 0.5);
  const sample = shuffled.slice(0, sampleSize);

  let okCount = 0;
  let failed = [];
  for (const row of sample) {
    const link = row[linkIdx];
    const idMatch = link.match(/[-\w]{20,}/);
    const id = idMatch ? idMatch[0] : null;
    if (!id) { failed.push(`unparseable link: ${link}`); continue; }
    try {
      await drive.files.get({ fileId: id, fields: 'id', supportsAllDrives: true });
      okCount++;
    } catch (e) {
      failed.push(`fileId ${id} (link=${link}) inaccessible: ${e.message}`);
    }
  }
  return {
    allOk: failed.length === 0,
    summary: `${okCount}/${sample.length} resolved${failed.length > 0 ? '; failures: ' + failed.join('; ') : ''}`,
  };
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
