#!/usr/bin/env node
/**
 * Full migration of a legacy user (currently: Taylor) onto the
 * central-hub + hidden-backup architecture.
 *
 * IDEMPOTENT. Per-user state is persisted to
 *   .local/migration/migrate-<userId>.json
 * and every step checks that state before doing anything. Re-running
 * after a partial failure resumes from where it stopped.
 *
 * Defaults to --dry-run. Pass --execute to actually mutate Drive / Sheets.
 *
 * Usage:
 *   node scripts/migration/migrate-user.js --user-id=<UUID>            # dry run
 *   node scripts/migration/migrate-user.js --user-id=<UUID> --execute  # do it
 *
 * Required env: GOOGLE_SERVICE_ACCOUNT_EMAIL, GOOGLE_PRIVATE_KEY,
 *               MASTER_SHEET_ID, GOOGLE_DRIVE_FOLDER_ID,
 *               GOOGLE_DRIVE_HIDDEN_BACKUP_ROOT_ID
 *
 * Order of operations (each step gates on a state flag):
 *   1.  preflight                     — verify env, load Master row + snapshot state
 *   2.  create_user_facing_sheet      — fresh sheet in central, schema set
 *   3.  create_user_facing_folder     — fresh folder in central
 *   4.  create_hidden_backup_sheet    — fresh sheet in hidden root, schema set
 *   5.  create_hidden_backup_folder   — fresh folder in hidden root
 *   6.  copy_data_to_user_facing      — copy all tab rows from old sheet
 *   7.  copy_pdfs_to_user_facing      — copy every PDF, build old->new ID map
 *   8.  rewrite_invoice_drivelinks    — Invoices tab rewrites with new IDs
 *   9.  mirror_to_hidden_backup       — copy data + PDFs into hidden tier
 *   10. share_user_facing_to_email    — share new sheet+folder back to user
 *   11. update_master_sheet_row       — flip F/G/L/M to new IDs
 *   12. archive_old_assets            — rename old sheet+folder with [ARCHIVED YYYY-MM-DD]
 *   13. mark_complete                 — write migrate-complete to MigrationLog
 */

const path = require('path');
const {
  log, parseArgs, assertEnv, loadState, saveState, stateFilePathFor, dateStamp, nowIso,
} = require('./_lib');
const {
  getClients, getCentralFolderId, getHiddenBackupRootId,
  createSpreadsheet, getOrCreateFolder, shareWithUser,
  ensureSheetSchema, copyAllTabData,
  logMigrationEvent, readMasterUserRow, updateMasterUserCells,
} = require('../../api/_lib/drive-architecture');

async function main() {
  const args = parseArgs();
  if (!args.userId) {
    console.error('ERROR: --user-id=<UUID> is required');
    process.exit(2);
  }
  assertEnv(
    'GOOGLE_SERVICE_ACCOUNT_EMAIL', 'GOOGLE_PRIVATE_KEY',
    'MASTER_SHEET_ID', 'GOOGLE_DRIVE_FOLDER_ID',
    'GOOGLE_DRIVE_HIDDEN_BACKUP_ROOT_ID'
  );

  const masterSheetId = process.env.MASTER_SHEET_ID;
  const centralFolderId = getCentralFolderId();
  const hiddenBackupRootId = getHiddenBackupRootId();
  const { sheets, drive } = getClients();

  const userRecord = await readMasterUserRow(sheets, masterSheetId, args.userId);
  if (!userRecord) {
    console.error(`ERROR: user ${args.userId} not found in Master Sheet`);
    process.exit(3);
  }
  const u = userRecord.asObject;

  // Require a snapshot to exist before proceeding (operator MUST run snapshot-user.js first)
  const snapshotPath = stateFilePathFor(args.userId, 'snapshot');
  const snapshotState = loadState(snapshotPath);
  if (!snapshotState || !snapshotState.snapshotCompletedAt) {
    console.error('\nERROR: No completed snapshot found for this user.');
    console.error(`Expected state file: ${snapshotPath}`);
    console.error('Run scripts/migration/snapshot-user.js --user-id=' + args.userId + ' --execute first.\n');
    process.exit(5);
  }

  const statePath = stateFilePathFor(args.userId, 'migrate');
  const state = loadState(statePath) || {
    userId: args.userId,
    startedAt: nowIso(),
    completed: {},   // step -> { at, ...details }
    pdfMap: {},      // oldFileId -> newFileId
    pdfMapBackup: {},// oldFileId -> newBackupFileId
    folderMap: {},   // oldFolderId -> newFolderIdInUserFacing
    folderMapBackup: {},
  };

  console.log('\n=== MIGRATION PLAN ===');
  console.log(`Target user:           ${u.name} <${u.email}> (rowIndex ${userRecord.rowIndex})`);
  console.log(`Mode:                  ${args.dryRun ? 'DRY RUN (no writes)' : 'EXECUTE'}`);
  console.log(`From (legacy) sheet:   ${u.sheetId}`);
  console.log(`From (legacy) folder:  ${u.driveFolderId}`);
  console.log(`Central hub folder:    ${centralFolderId}`);
  console.log(`Hidden backup root:    ${hiddenBackupRootId}`);
  console.log(`Snapshot state file:   ${snapshotPath}`);
  console.log(`Migration state file:  ${statePath}`);
  if (Object.keys(state.completed).length > 0) {
    console.log(`Resuming after step(s): ${Object.keys(state.completed).join(', ')}`);
  }
  console.log('');

  // For dry run, just print what we *would* do and exit
  if (args.dryRun) {
    await dryRunReport(sheets, drive, u, state);
    return;
  }

  // ===== EXECUTE STEPS =====
  // Preflight captures the OLD sheet/folder IDs into state. ALL subsequent
  // steps that read "the source" must use these — NOT u.sheetId / u.driveFolderId
  // — because step 11 flips the Master row to NEW IDs, and a process-restart
  // resume after step 11 would then re-read u.sheetId as the NEW id and
  // accidentally archive the wrong assets in step 12.
  const preflight = await runStep(state, statePath, 'preflight', async () => {
    log('info', 'Preflight: confirming source readability and capturing old IDs');
    await sheets.spreadsheets.get({ spreadsheetId: u.sheetId });
    await drive.files.get({ fileId: u.driveFolderId, fields: 'id,name', supportsAllDrives: true });
    return {
      oldSheetId: u.sheetId,
      oldFolderId: u.driveFolderId,
      oldName: u.name,
      oldEmail: u.email,
      capturedAt: nowIso(),
    };
  });
  const oldSheetId = preflight.oldSheetId;
  const oldFolderId = preflight.oldFolderId;

  const shortId = args.userId.slice(0, 8);
  const newSheetName = `BooksIQ - ${u.name} - ${shortId}`;
  const newFolderName = `Invoices - ${u.name} - ${shortId}`;
  const backupSheetName = `BooksIQ BACKUP - ${u.name} - ${shortId}`;
  const backupFolderName = `Invoices BACKUP - ${u.name} - ${shortId}`;

  const newSheetId = await runStep(state, statePath, 'create_user_facing_sheet', async () => {
    const id = await createSpreadsheet(drive, newSheetName, centralFolderId);
    await ensureSheetSchema(sheets, id);
    log('info', `Created user-facing sheet ${id}`);
    return id;
  });

  const newFolderId = await runStep(state, statePath, 'create_user_facing_folder', async () => {
    const id = await getOrCreateFolder(drive, newFolderName, centralFolderId);
    log('info', `Created user-facing folder ${id}`);
    return id;
  });

  const backupSheetId = await runStep(state, statePath, 'create_hidden_backup_sheet', async () => {
    const id = await createSpreadsheet(drive, backupSheetName, hiddenBackupRootId);
    await ensureSheetSchema(sheets, id);
    log('info', `Created hidden backup sheet ${id}`);
    return id;
  });

  const backupFolderId = await runStep(state, statePath, 'create_hidden_backup_folder', async () => {
    const id = await getOrCreateFolder(drive, backupFolderName, hiddenBackupRootId);
    log('info', `Created hidden backup folder ${id}`);
    return id;
  });

  // The persist callback lets recursiveCopyFolder save state after EACH
  // file copy, so a mid-step crash + resume skips already-copied files
  // (they're recorded in pdfMap before the crash).
  const persist = () => saveState(statePath, state);

  await runStep(state, statePath, 'copy_data_to_user_facing', async () => {
    log('info', `Copying tab data from ${oldSheetId} -> ${newSheetId} (clear-then-append for idempotency)`);
    return await copyAllTabData(sheets, oldSheetId, newSheetId, { clearFirst: true });
  });

  await runStep(state, statePath, 'copy_pdfs_to_user_facing', async () => {
    log('info', `Recursively copying PDFs from ${oldFolderId} -> ${newFolderId}`);
    return await recursiveCopyFolder(drive, oldFolderId, newFolderId, state.pdfMap, state.folderMap, persist);
  });

  await runStep(state, statePath, 'rewrite_invoice_drivelinks', async () => {
    log('info', `Rewriting Invoices.driveLink based on ${Object.keys(state.pdfMap).length} mapped PDFs`);
    return await rewriteInvoiceDriveLinks(sheets, newSheetId, state.pdfMap);
  });

  await runStep(state, statePath, 'mirror_to_hidden_backup', async () => {
    log('info', `Mirroring tab data ${oldSheetId} -> ${backupSheetId} (hidden backup, clear-then-append)`);
    const tabResult = await copyAllTabData(sheets, oldSheetId, backupSheetId, { clearFirst: true });
    log('info', `Recursively copying PDFs ${oldFolderId} -> ${backupFolderId} (hidden backup)`);
    const fileResult = await recursiveCopyFolder(drive, oldFolderId, backupFolderId, state.pdfMapBackup, state.folderMapBackup, persist);
    // Also rewrite the driveLinks in the backup sheet using the BACKUP map
    const backupRewrite = await rewriteInvoiceDriveLinks(sheets, backupSheetId, state.pdfMapBackup);
    return { tabResult, fileResult, backupRewrite };
  });

  await runStep(state, statePath, 'share_user_facing_to_email', async () => {
    if (!u.email) return { skipped: true, reason: 'no email on row' };
    const sheetShare = await shareWithUser(drive, newSheetId, u.email, 'writer', false);
    const folderShare = await shareWithUser(drive, newFolderId, u.email, 'writer', false);
    log('info', `Shared user-facing sheet+folder with ${u.email}`);
    return { sheetShare, folderShare };
  });

  await runStep(state, statePath, 'update_master_sheet_row', async () => {
    const updates = {
      sheetId: newSheetId,
      driveFolderId: newFolderId,
      backupSheetId,
      backupFolderId,
    };
    await updateMasterUserCells(sheets, masterSheetId, userRecord.rowIndex, userRecord.headers, updates);
    log('info', `Master Sheet row ${userRecord.rowIndex} updated to new IDs`);
    return updates;
  });

  await runStep(state, statePath, 'archive_old_assets', async () => {
    const stamp = dateStamp();
    // IMPORTANT: use oldSheetId/oldFolderId from preflight, NOT u.sheetId
    // (which may now point at the new central-hub IDs after step 11).
    const oldSheetMeta = await drive.files.get({ fileId: oldSheetId, fields: 'name', supportsAllDrives: true });
    const oldFolderMeta = await drive.files.get({ fileId: oldFolderId, fields: 'name', supportsAllDrives: true });

    const sheetCurName = oldSheetMeta.data.name;
    const folderCurName = oldFolderMeta.data.name;
    const sheetOriginalName = stripArchivePrefix(sheetCurName);
    const folderOriginalName = stripArchivePrefix(folderCurName);

    const result = {
      oldSheetName: sheetOriginalName,
      oldFolderName: folderOriginalName,
      archivedSheetName: sheetCurName,
      archivedFolderName: folderCurName,
      sheetAlreadyArchived: sheetCurName !== sheetOriginalName,
      folderAlreadyArchived: folderCurName !== folderOriginalName,
    };

    if (sheetCurName === sheetOriginalName) {
      const target = `[ARCHIVED ${stamp}] ${sheetOriginalName}`;
      await drive.files.update({
        fileId: oldSheetId, requestBody: { name: target }, supportsAllDrives: true,
      });
      result.archivedSheetName = target;
      log('info', `Renamed legacy sheet -> "${target}"`);
    } else {
      log('info', `Legacy sheet already archived as "${sheetCurName}", skipping rename`);
    }

    if (folderCurName === folderOriginalName) {
      const target = `[ARCHIVED ${stamp}] ${folderOriginalName}`;
      await drive.files.update({
        fileId: oldFolderId, requestBody: { name: target }, supportsAllDrives: true,
      });
      result.archivedFolderName = target;
      log('info', `Renamed legacy folder -> "${target}"`);
    } else {
      log('info', `Legacy folder already archived as "${folderCurName}", skipping rename`);
    }

    return result;
  });

  await runStep(state, statePath, 'mark_complete', async () => {
    state.completedAt = nowIso();
    saveState(statePath, state);
    await logMigrationEvent(
      sheets, masterSheetId, args.userId, 'migrate-complete',
      {
        newSheetId, newFolderId, backupSheetId, backupFolderId,
        // Use preflight-captured IDs — u.sheetId / u.driveFolderId may
        // be the NEW central-hub IDs at this point if the run was
        // resumed AFTER step 11 (update_master_sheet_row).
        oldSheetId, oldFolderId,
        pdfsCopied: Object.keys(state.pdfMap).length,
      },
      'cli'
    );
    return { completedAt: state.completedAt };
  });

  console.log('\n=== MIGRATION COMPLETE ===');
  console.log(`User:                ${u.name} <${u.email}>`);
  console.log(`New user-facing:     sheet=${newSheetId} folder=${newFolderId}`);
  console.log(`New hidden backup:   sheet=${backupSheetId} folder=${backupFolderId}`);
  console.log(`PDFs copied:         ${Object.keys(state.pdfMap).length}`);
  console.log(`State file:          ${statePath}\n`);
  console.log('Next: run scripts/migration/verify-migration.js --user-id=' + args.userId);
}

/**
 * Wrap a step so that:
 *   - if state.completed[stepName] exists, we return the cached result (idempotent skip)
 *   - otherwise run the fn, persist {at, result} to state, return result
 *
 * On error, state is NOT marked complete and the error is re-thrown so
 * the operator can fix and re-run.
 */
async function runStep(state, statePath, stepName, fn) {
  if (state.completed[stepName]) {
    log('info', `[SKIP] step ${stepName} already complete`);
    return state.completed[stepName].result;
  }
  log('info', `[RUN ] step ${stepName}`);
  try {
    const result = await fn();
    state.completed[stepName] = { at: nowIso(), result };
    saveState(statePath, state);
    return result;
  } catch (e) {
    log('error', `Step ${stepName} FAILED: ${e.message}`);
    state.lastError = { step: stepName, message: e.message, at: nowIso() };
    saveState(statePath, state);
    throw e;
  }
}

/**
 * Recursively copy a folder's contents into a destination folder.
 * For folders, creates a matching folder in dest (idempotent via getOrCreateFolder).
 * For files, copies them and stores the mapping in pdfMap.
 *
 * pdfMap and folderMap are mutated in place. If `persist` (a 0-arg
 * callback) is provided, it is invoked after EACH file copy and
 * EACH new sub-folder mapping so a mid-step crash + resume skips
 * already-copied files (they're recorded in pdfMap before the crash).
 */
async function recursiveCopyFolder(drive, srcFolderId, destFolderId, pdfMap, folderMap, persist) {
  const stats = { foldersCreated: 0, filesCopied: 0, filesSkipped: 0, foldersSkipped: 0 };
  folderMap[srcFolderId] = destFolderId; // root mapping
  if (persist) await persist();
  const queue = [{ srcId: srcFolderId, destId: destFolderId }];
  while (queue.length > 0) {
    const cur = queue.shift();
    let pageToken;
    do {
      const r = await drive.files.list({
        q: `'${cur.srcId}' in parents and trashed=false`,
        fields: 'nextPageToken, files(id, name, mimeType)',
        pageSize: 1000,
        pageToken,
        spaces: 'drive',
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      });
      pageToken = r.data.nextPageToken;
      for (const f of r.data.files || []) {
        if (f.mimeType === 'application/vnd.google-apps.folder') {
          // Folder. Use cached mapping if we've seen this src folder before
          // (e.g. on resume after partial crash) — getOrCreateFolder is
          // idempotent so this is also safe without the cache, but the cache
          // saves an API call per folder per resume.
          let newSubId = folderMap[f.id];
          if (newSubId) {
            stats.foldersSkipped++;
          } else {
            newSubId = await getOrCreateFolder(drive, f.name, cur.destId);
            folderMap[f.id] = newSubId;
            stats.foldersCreated++;
            if (persist) await persist();
          }
          queue.push({ srcId: f.id, destId: newSubId });
        } else {
          // File. Copy unless we've already mapped it (idempotency on resume).
          if (pdfMap[f.id]) {
            stats.filesSkipped++;
            continue;
          }
          try {
            const copyRes = await drive.files.copy({
              fileId: f.id,
              requestBody: { name: f.name, parents: [cur.destId] },
              supportsAllDrives: true,
              fields: 'id',
            });
            pdfMap[f.id] = copyRes.data.id;
            stats.filesCopied++;
            if (persist) await persist();
          } catch (e) {
            log('error', `Failed to copy file ${f.id} (${f.name}): ${e.message}`);
            throw e;
          }
        }
      }
    } while (pageToken);
  }
  return stats;
}

/** Strip a leading `[ARCHIVED YYYY-MM-DD] ` prefix, if present. */
function stripArchivePrefix(name) {
  return name.replace(/^\[ARCHIVED \d{4}-\d{2}-\d{2}\] /, '');
}

/**
 * Read the Invoices tab on `sheetId` and rewrite the `driveLink` cell of
 * any row whose link references an old-mapped file id. Returns the count
 * of rewrites performed.
 *
 * We match links containing `/d/<oldId>/` or `?id=<oldId>`. If the column
 * stores something else (a bare ID, a folder URL), we attempt those forms too.
 */
async function rewriteInvoiceDriveLinks(sheets, sheetId, pdfMap) {
  const r = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: 'Invoices!A:AC',
  });
  const rows = r.data.values || [];
  if (rows.length <= 1) return { rewritten: 0, scanned: 0 };
  const headers = rows[0];
  const linkIdx = headers.indexOf('driveLink');
  if (linkIdx === -1) return { rewritten: 0, scanned: 0, error: 'no driveLink column' };

  const updates = [];
  let rewritten = 0;
  for (let i = 1; i < rows.length; i++) {
    const original = rows[i][linkIdx] || '';
    if (!original) continue;
    let updated = original;
    let changed = false;
    for (const [oldId, newId] of Object.entries(pdfMap)) {
      if (updated.includes(oldId)) {
        updated = updated.split(oldId).join(newId);
        changed = true;
      }
    }
    if (changed) {
      const colLetter = numberToColLetter(linkIdx);
      updates.push({
        range: `Invoices!${colLetter}${i + 1}`,
        values: [[updated]],
      });
      rewritten++;
    }
  }
  if (updates.length > 0) {
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: sheetId,
      requestBody: { valueInputOption: 'RAW', data: updates },
    });
  }
  return { rewritten, scanned: rows.length - 1 };
}

function numberToColLetter(idx) {
  let s = '';
  let n = idx;
  while (n >= 0) {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  }
  return s;
}

/**
 * Print a dry-run summary without performing any writes.
 */
async function dryRunReport(sheets, drive, u, state) {
  const stepsTotal = [
    'preflight', 'create_user_facing_sheet', 'create_user_facing_folder',
    'create_hidden_backup_sheet', 'create_hidden_backup_folder',
    'copy_data_to_user_facing', 'copy_pdfs_to_user_facing',
    'rewrite_invoice_drivelinks', 'mirror_to_hidden_backup',
    'share_user_facing_to_email', 'update_master_sheet_row',
    'archive_old_assets', 'mark_complete',
  ];
  const done = stepsTotal.filter(s => state.completed[s]);
  const pending = stepsTotal.filter(s => !state.completed[s]);
  console.log('\nWill execute the following (in order, idempotent):');
  for (const s of stepsTotal) {
    const tag = state.completed[s] ? '[DONE]' : '[TODO]';
    console.log(`  ${tag} ${s}`);
  }
  console.log(`\nProgress so far: ${done.length}/${stepsTotal.length} steps complete.`);

  // Quick sanity check: source readable
  try {
    const meta = await sheets.spreadsheets.get({ spreadsheetId: u.sheetId });
    console.log(`Source sheet "${meta.data.properties.title}" is reachable.`);
  } catch (e) {
    console.log(`!!! Source sheet ${u.sheetId} is NOT reachable: ${e.message}`);
  }
  try {
    const meta = await drive.files.get({ fileId: u.driveFolderId, fields: 'name', supportsAllDrives: true });
    console.log(`Source folder "${meta.data.name}" is reachable.`);
  } catch (e) {
    console.log(`!!! Source folder ${u.driveFolderId} is NOT reachable: ${e.message}`);
  }

  console.log('\nRe-run with --execute to perform the migration.\n');
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
