#!/usr/bin/env node
/**
 * Local CLI runner for the backfill-architecture flow defined in
 * api/admin/backfill-architecture.js. Same actions, no HTTP/admin auth
 * dance — useful when running against multiple users in one shot from a
 * dev shell.
 *
 * Usage:
 *   node scripts/migration/backfill-architecture-cli.js --user-id=<UUID>           # dry run
 *   node scripts/migration/backfill-architecture-cli.js --user-id=<UUID> --execute # apply
 *
 * Reuses the same library helpers as the API endpoint and writes the
 * same MigrationLog entries on the master sheet.
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });

const {
  getClients,
  getHiddenBackupRootId,
  createSpreadsheet,
  getOrCreateFolder,
  shareWithUser,
  ensureSheetSchema,
  copyAllTabData,
  logMigrationEvent,
  readMasterUserRow,
  updateMasterUserCells,
} = require('../../api/_lib/drive-architecture');

function parseArgs(argv) {
  const opts = { userId: null, execute: false };
  for (const a of argv.slice(2)) {
    if (a.startsWith('--user-id=')) opts.userId = a.slice('--user-id='.length);
    else if (a === '--execute') opts.execute = true;
  }
  return opts;
}

async function main() {
  const { userId, execute } = parseArgs(process.argv);
  if (!userId) {
    console.error('Usage: backfill-architecture-cli.js --user-id=<UUID> [--execute]');
    process.exit(2);
  }
  const masterSheetId = process.env.MASTER_SHEET_ID;
  if (!masterSheetId) throw new Error('MASTER_SHEET_ID not set');

  const { sheets, drive } = getClients();
  const userRecord = await readMasterUserRow(sheets, masterSheetId, userId);
  if (!userRecord) {
    console.error(`User not found: ${userId}`);
    process.exit(3);
  }
  const u = userRecord.asObject;
  const hiddenBackupRootId = getHiddenBackupRootId();

  const plan = {
    userId, email: u.email, name: u.name,
    currentSheetId: u.sheetId, currentDriveFolderId: u.driveFolderId,
    currentBackupSheetId: u.backupSheetId, currentBackupFolderId: u.backupFolderId,
    actions: [],
  };

  // Action 1: share user-facing
  if (!u.email) plan.actions.push({ type: 'share_user_facing', skipped: true, reason: 'no email' });
  else if (!u.sheetId || !u.driveFolderId) plan.actions.push({ type: 'share_user_facing', skipped: true, reason: 'missing sheetId/driveFolderId' });
  else plan.actions.push({ type: 'share_user_facing', sheetId: u.sheetId, folderId: u.driveFolderId, email: u.email, role: 'writer' });

  // Action 2: hidden backup
  const sheetMissingOrSame = !u.backupSheetId || u.backupSheetId === u.sheetId;
  const folderMissingOrSame = !u.backupFolderId || u.backupFolderId === u.driveFolderId;
  const needsBackup = sheetMissingOrSame || folderMissingOrSame;
  if (!needsBackup) {
    plan.actions.push({ type: 'create_hidden_backup', skipped: true, reason: 'already has distinct backup IDs' });
  } else if (!hiddenBackupRootId) {
    plan.actions.push({ type: 'create_hidden_backup', skipped: true, reason: 'GOOGLE_DRIVE_HIDDEN_BACKUP_ROOT_ID not set' });
  } else if (!u.sheetId || !u.driveFolderId) {
    plan.actions.push({ type: 'create_hidden_backup', skipped: true, reason: 'missing sheetId/driveFolderId' });
  } else {
    plan.actions.push({ type: 'create_hidden_backup', parentFolderId: hiddenBackupRootId, willCopyFromSheetId: u.sheetId });
  }

  console.log('PLAN:', JSON.stringify(plan, null, 2));
  if (!execute) {
    await logMigrationEvent(sheets, masterSheetId, userId, 'backfill-cli-dry-run', plan, 'cli');
    console.log('(dry run — pass --execute to apply)');
    return;
  }

  const applied = { actions: [] };
  for (const act of plan.actions) {
    if (act.skipped) { applied.actions.push(act); continue; }
    if (act.type === 'share_user_facing') {
      const sheetShare = await shareWithUser(drive, act.sheetId, act.email, 'writer', false);
      const folderShare = await shareWithUser(drive, act.folderId, act.email, 'writer', false);
      applied.actions.push({ type: 'share_user_facing', sheetShare, folderShare });
      console.log('  shared user-facing sheet+folder to', act.email);
    } else if (act.type === 'create_hidden_backup') {
      const shortId = userId.slice(0, 8);
      const namePrefix = u.name || u.email || userId;
      const backupSheetId = await createSpreadsheet(drive, `BooksIQ BACKUP - ${namePrefix} - ${shortId}`, act.parentFolderId);
      const backupFolderId = await getOrCreateFolder(drive, `Invoices BACKUP - ${namePrefix} - ${shortId}`, act.parentFolderId);
      await ensureSheetSchema(sheets, backupSheetId);
      const copyReport = await copyAllTabData(sheets, u.sheetId, backupSheetId, { clearFirst: true });
      await updateMasterUserCells(sheets, masterSheetId, userRecord.rowIndex, userRecord.headers, {
        backupSheetId, backupFolderId,
      });
      applied.actions.push({ type: 'create_hidden_backup', backupSheetId, backupFolderId, copyReport });
      console.log('  created hidden backup:', { backupSheetId, backupFolderId, copyReport });
    }
  }
  await logMigrationEvent(sheets, masterSheetId, userId, 'backfill-cli-execute', { plan, applied }, 'cli');
  console.log('APPLIED:', JSON.stringify(applied, null, 2));
}

main().catch(e => { console.error('FATAL:', e.message, e.stack); process.exit(1); });
