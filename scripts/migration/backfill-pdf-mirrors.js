#!/usr/bin/env node
/**
 * Backfill PDF mirrors for a single user.
 *
 * Every NEW invoice generated after the May-2026 central-hub migration
 * is automatically mirrored from the user-facing Drive folder into the
 * per-user hidden backup folder by api/drive-upload.js. Invoices
 * generated BEFORE that change (or before this user was migrated) only
 * exist in the user-facing folder — if the user accidentally trashes
 * one, there is no second copy to restore from.
 *
 * This script walks the user's Invoices tab, asks pdf-mirror's
 * findMirrorPdfId for each row, and copies any primary PDF that has
 * no matching mirror into the backup tree at the same
 *   <backupFolder>/<Entity>/Invoices/<Year>/<Month>/[Ad Hoc/]<fileName>
 * path that drive-upload.js would have written. The copy is performed
 * by the service account so the mirror is owned by the SA (matching
 * what new uploads produce).
 *
 * READ-ONLY by default. Pass --execute to actually create copies.
 *
 * IDEMPOTENT. Per-user state is persisted to
 *   .local/migration/backfill-pdf-mirrors-<userId>.json
 * and every successfully mirrored invoice is recorded so a re-run after
 * a partial failure resumes from where it stopped without re-checking
 * already-mirrored invoices in Drive (cheaper + faster).
 *
 * Usage:
 *   node scripts/migration/backfill-pdf-mirrors.js --user-id=<UUID>             # dry run
 *   node scripts/migration/backfill-pdf-mirrors.js --user-id=<UUID> --execute   # do it
 *
 * Required env: GOOGLE_SERVICE_ACCOUNT_EMAIL, GOOGLE_PRIVATE_KEY,
 *               MASTER_SHEET_ID
 *
 * Exit codes:
 *   0  all-green (everything either mirrored or already had a mirror)
 *   1  one or more invoices failed to mirror — rerun after investigating
 *   2  bad CLI args
 *   3  user not found in Master Sheet
 *   4  user has no real hidden backup folder (run backfill-architecture first)
 */

const {
  log, parseArgs, assertEnv, loadState, saveState, stateFilePathFor, nowIso,
} = require('./_lib');
const {
  getClients, readMasterUserRow, getOrCreateFolder, logMigrationEvent,
} = require('../../api/_lib/drive-architecture');
const {
  extractDriveFileId, deriveYearMonthForFolder, inferInvoiceFileName, findMirrorPdfId,
} = require('../../api/_lib/pdf-mirror');

// Invoice column order on the user-facing sheet (kept in sync with
// INVOICE_COLUMNS in api/sheets-sync.js / STANDARD_TABS in
// drive-architecture.js). Used to turn a raw row[] into an object.
const INVOICE_COLUMNS = [
  'num', 'date', 'practice', 'practiceName', 'practiceAddr', 'period',
  'entity', 'entName', 'entAddr', 'entPhone', 'bankName', 'bankAccName',
  'bankAcc', 'bankSort', 'amount', 'gross', 'commRate', 'svcs', 'addons',
  'airTotal', 'logoType', 'payTerms', 'footerMsg', 'companyNo', 'isAdhoc',
  'driveLink', 'paidStatus', 'paidDate', 'createdAt',
];

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

  // The user must already have a real hidden backup distinct from their
  // user-facing folder. If they don't, the operator needs to run
  // /api/admin/backfill-architecture (or migrate-user.js) first to
  // provision one — this script intentionally does NOT create the
  // backup folder, so it can't accidentally split a user across two
  // different backup roots.
  if (!u.sheetId || !u.driveFolderId) {
    console.error(`ERROR: user ${args.userId} has no sheetId/driveFolderId — Master row incomplete`);
    process.exit(4);
  }
  if (!u.backupFolderId || u.backupFolderId === u.driveFolderId) {
    console.error(`ERROR: user ${args.userId} has no real hidden backup folder.`);
    console.error('       Run /api/admin/backfill-architecture for this user first, then re-run.');
    process.exit(4);
  }

  const statePath = stateFilePathFor(args.userId, 'backfill-pdf-mirrors');
  const state = loadState(statePath) || {
    userId: args.userId,
    startedAt: nowIso(),
    sheetId: u.sheetId,
    backupFolderId: u.backupFolderId,
    mirrored: {},   // invoiceNum -> { mirrorFileId, at }
    failed: {},     // invoiceNum -> { stage, message, at }
    skipped: {},    // invoiceNum -> { reason, at }   (no driveLink, etc.)
  };

  console.log('\n=== PDF MIRROR BACKFILL ===');
  console.log(`User:                   ${u.name} <${u.email}> (rowIndex ${userRecord.rowIndex})`);
  console.log(`Mode:                   ${args.dryRun ? 'DRY RUN (no writes)' : 'EXECUTE'}`);
  console.log(`User-facing sheet:      ${u.sheetId}`);
  console.log(`User-facing folder:     ${u.driveFolderId}`);
  console.log(`Hidden backup folder:   ${u.backupFolderId}`);
  console.log(`State file:             ${statePath}`);
  if (Object.keys(state.mirrored).length > 0 || Object.keys(state.failed).length > 0) {
    console.log(`Resuming: already mirrored=${Object.keys(state.mirrored).length}, prior failures=${Object.keys(state.failed).length}`);
  }
  console.log('');

  // ---- Read Invoices tab from user-facing sheet ----
  const invR = await sheets.spreadsheets.values.get({
    spreadsheetId: u.sheetId,
    range: 'Invoices!A:AC',
  });
  const rows = invR.data.values || [];
  if (rows.length <= 1) {
    console.log('No invoices on this user. Nothing to do.\n');
    return;
  }
  const headers = rows[0];
  // Use the sheet's actual headers if present (lets us tolerate column
  // re-ordering); otherwise fall back to the canonical INVOICE_COLUMNS.
  const colNames = headers.length >= INVOICE_COLUMNS.length ? headers : INVOICE_COLUMNS;

  const invoices = [];
  for (let i = 1; i < rows.length; i++) {
    const obj = {};
    colNames.forEach((c, idx) => { obj[c] = rows[i][idx] || ''; });
    obj._rowIndex = i + 1;
    invoices.push(obj);
  }

  // ---- Per-invoice classification ----
  const summary = {
    total: invoices.length,
    noLink: 0,            // no driveLink in row — nothing to mirror
    unparseableLink: 0,   // driveLink present but couldn't extract file ID
    unparseableDate: 0,   // can't derive year/month folder — won't know where to put it
    alreadyMirrored: 0,   // mirror already exists in the backup tree
    cachedMirrored: 0,    // state file says we already did this one
    needsCopy: 0,         // would copy (dry run) / will copy (execute)
    copied: 0,            // actually copied this run
    raceMirrored: 0,      // mirror appeared between inspection and copy
    failed: 0,            // copy attempt errored
  };

  const plan = [];   // { invoice, primaryFileId, fileName, year, month, entityFolderName, isAdhoc }

  console.log('--- PER-INVOICE INSPECTION ---');
  for (let idx = 0; idx < invoices.length; idx++) {
    const inv = invoices[idx];
    const num = inv.num || `(row ${inv._rowIndex})`;
    const tag = `[${idx + 1}/${invoices.length}] #${num}`;

    // Cached idempotency: if we've previously mirrored this in a prior run,
    // trust the state file and skip the Drive lookups entirely.
    if (state.mirrored[num]) {
      summary.cachedMirrored++;
      console.log(`  ${tag}  CACHED_MIRRORED  (mirrorFileId=${state.mirrored[num].mirrorFileId})`);
      continue;
    }

    if (!inv.driveLink) {
      summary.noLink++;
      console.log(`  ${tag}  SKIP             (no driveLink)`);
      // Skip records are NOT cached: a future re-run after the user
      // (re)generates a PDF should re-evaluate the row, not silently
      // skip it. State is only persisted for actually-mirrored copies.
      continue;
    }
    const primaryFileId = extractDriveFileId(inv.driveLink);
    if (!primaryFileId) {
      summary.unparseableLink++;
      console.log(`  ${tag}  SKIP             (unparseable driveLink: ${inv.driveLink})`);
      continue;
    }
    const ym = deriveYearMonthForFolder(inv);
    if (!ym) {
      summary.unparseableDate++;
      console.log(`  ${tag}  SKIP             (cannot derive year/month from period="${inv.period}" date="${inv.date}")`);
      continue;
    }
    const fileName = inferInvoiceFileName(inv);

    // Drive lookup: does a mirror already exist?
    let existingMirrorId = null;
    try {
      existingMirrorId = await findMirrorPdfId(drive, u.backupFolderId, fileName, inv);
    } catch (e) {
      summary.failed++;
      console.log(`  ${tag}  FAILED           (lookup: ${e.message})`);
      // Lookup failures ARE recorded so a re-run can target them.
      // We persist immediately below for execute mode; dry-run keeps
      // it in-memory only (see "Persist state" comment further down).
      state.failed[num] = { stage: 'findMirror', message: e.message, at: nowIso() };
      continue;
    }
    if (existingMirrorId) {
      summary.alreadyMirrored++;
      console.log(`  ${tag}  ALREADY_MIRRORED (mirrorFileId=${existingMirrorId})`);
      state.mirrored[num] = { mirrorFileId: existingMirrorId, at: nowIso(), preexisting: true };
      if (state.failed[num]) delete state.failed[num];
      continue;
    }

    summary.needsCopy++;
    const entityFolderName = inv.logoType === 'ltd' ? 'Ltd Company' : 'Self-Employed';
    const isAdhoc = inv.isAdhoc === true || inv.isAdhoc === 'TRUE' || inv.isAdhoc === 'true';
    const path = `${entityFolderName}/Invoices/${ym.year}/${ym.month}${isAdhoc ? '/Ad Hoc' : ''}/${fileName}`;
    console.log(`  ${tag}  WOULD_COPY       (${path}, primaryFileId=${primaryFileId})`);
    plan.push({
      invoice: inv,
      primaryFileId,
      fileName,
      year: ym.year,
      month: ym.month,
      entityFolderName,
      isAdhoc,
    });
  }

  // Persist state. Only do this in --execute mode so a dry-run leaves
  // no on-disk artefacts (matches the "no writes performed" promise).
  // In execute mode, state was also being saved after each successful
  // copy below for crash-resume; this initial save captures the
  // already-mirrored ALREADY_MIRRORED rows so they're cached for next run.
  if (!args.dryRun) {
    saveState(statePath, state);
  }

  console.log('\n--- SUMMARY (pre-copy) ---');
  console.log(`  Total invoices:         ${summary.total}`);
  console.log(`  Already mirrored (Drive): ${summary.alreadyMirrored}`);
  console.log(`  Already mirrored (cache): ${summary.cachedMirrored}`);
  console.log(`  No driveLink:           ${summary.noLink}`);
  console.log(`  Unparseable driveLink:  ${summary.unparseableLink}`);
  console.log(`  Unparseable date:       ${summary.unparseableDate}`);
  console.log(`  Lookup failures:        ${summary.failed}`);
  console.log(`  Need to copy:           ${summary.needsCopy}`);
  console.log('');

  if (args.dryRun) {
    // Per-invoice WOULD_COPY lines were already printed above — see the
    // PER-INVOICE INSPECTION section. No extra truncation here.
    console.log('Dry run — no writes performed and no state file saved.');
    console.log('Re-run with --execute to copy and persist progress.\n');
    process.exit(summary.failed > 0 ? 1 : 0);
  }

  if (plan.length === 0) {
    console.log('Nothing to do — every invoice already has a mirror (or no PDF to mirror).\n');
    try {
      await logMigrationEvent(
        sheets, masterSheetId, args.userId, 'backfill-pdf-mirrors',
        {
          backupFolderId: u.backupFolderId,
          copied: 0, failed: 0,
          alreadyMirrored: summary.alreadyMirrored + summary.cachedMirrored,
          skipped: summary.noLink + summary.unparseableLink + summary.unparseableDate,
          totalInvoices: summary.total,
          noop: true,
        },
        'cli'
      );
    } catch (e) {
      log('warn', `Failed to write MigrationLog event: ${e.message}`);
    }
    process.exit(summary.failed > 0 ? 1 : 0);
  }

  // ---- EXECUTE ----
  // Sequential to stay well under Drive API per-user write limits and
  // to keep the per-row failure log understandable. The script is
  // resumable so a slow run can be safely killed and continued.
  let i = 0;
  for (const p of plan) {
    i++;
    const { invoice, primaryFileId, fileName, year, month, entityFolderName, isAdhoc } = p;
    const num = invoice.num || `(row ${invoice._rowIndex})`;
    try {
      // Build (or reuse) the destination folder tree. getOrCreateFolder
      // is idempotent so a re-run after a crash just walks back through
      // the existing folders without creating duplicates.
      let destFolder = u.backupFolderId;
      for (const step of [entityFolderName, 'Invoices', year, month]) {
        destFolder = await getOrCreateFolder(drive, step, destFolder);
      }
      if (isAdhoc) {
        destFolder = await getOrCreateFolder(drive, 'Ad Hoc', destFolder);
      }

      // Race-safety: another path (a NEW upload, a parallel run of this
      // script, the user re-uploading) may have created the mirror
      // between inspection and now. Re-check before copying so we don't
      // produce a duplicate file in the backup tree.
      const racyMirror = await findMirrorPdfId(drive, u.backupFolderId, fileName, invoice);
      const tag = `[${i}/${plan.length}] #${num}`;
      if (racyMirror) {
        state.mirrored[num] = { mirrorFileId: racyMirror, at: nowIso(), preexisting: true };
        if (state.failed[num]) delete state.failed[num];
        saveState(statePath, state);
        summary.raceMirrored++;
        console.log(`  ${tag}  RACE_MIRRORED    (mirror appeared since inspection — recorded existing id ${racyMirror})`);
        continue;
      }

      const copyRes = await drive.files.copy({
        fileId: primaryFileId,
        requestBody: { name: fileName, parents: [destFolder] },
        supportsAllDrives: true,
        fields: 'id',
      });
      const mirrorFileId = copyRes.data.id;
      state.mirrored[num] = { mirrorFileId, at: nowIso(), copiedThisRun: true };
      if (state.failed[num]) delete state.failed[num];
      summary.copied++;
      saveState(statePath, state);
      console.log(`  ${tag}  COPIED           (mirrorFileId=${mirrorFileId}, ${entityFolderName}/${year}/${month}${isAdhoc ? '/Ad Hoc' : ''}/${fileName})`);
    } catch (e) {
      state.failed[num] = { stage: 'copy', message: e.message, at: nowIso(), primaryFileId };
      summary.failed++;
      saveState(statePath, state);
      console.log(`  [${i}/${plan.length}] #${num}  FAILED           (copy: ${e.message})`);
    }
  }

  // raceMirrored entries discovered during execute were copied by some
  // other path between inspection and copy — fold them into the
  // already-mirrored total so the final summary matches reality on
  // disk rather than the pre-copy plan.
  const totalAlreadyMirrored =
    summary.alreadyMirrored + summary.cachedMirrored + summary.raceMirrored;

  console.log('\n--- FINAL SUMMARY ---');
  console.log(`  Copied this run:        ${summary.copied}`);
  console.log(`  Race-mirrored:          ${summary.raceMirrored}`);
  console.log(`  Failed this run:        ${summary.failed}`);
  console.log(`  Already mirrored:       ${totalAlreadyMirrored}`);
  console.log(`  Skipped (no PDF/date):  ${summary.noLink + summary.unparseableLink + summary.unparseableDate}`);
  console.log(`  State file:             ${statePath}`);

  // Audit log — keep a permanent record on the Master Sheet.
  try {
    await logMigrationEvent(
      sheets, masterSheetId, args.userId, 'backfill-pdf-mirrors',
      {
        backupFolderId: u.backupFolderId,
        copied: summary.copied,
        raceMirrored: summary.raceMirrored,
        failed: summary.failed,
        alreadyMirrored: totalAlreadyMirrored,
        skipped: summary.noLink + summary.unparseableLink + summary.unparseableDate,
        totalInvoices: summary.total,
      },
      'cli'
    );
  } catch (e) {
    log('warn', `Failed to write MigrationLog event: ${e.message}`);
  }

  if (summary.failed > 0) {
    console.log('\nOne or more invoices failed to mirror. Inspect the state file');
    console.log('above and re-run the script — successfully mirrored rows are');
    console.log('cached and will be skipped on the next run.\n');
    process.exit(1);
  }
  console.log('\nDone — every invoice is now mirrored (or has nothing to mirror).\n');
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
