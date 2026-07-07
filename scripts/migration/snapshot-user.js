#!/usr/bin/env node
/**
 * Pre-migration snapshot: copy every sheet referenced from the user's
 * Master row into a service-account-owned spreadsheet named
 *   `[PRE-MIGRATION SNAPSHOT YYYY-MM-DD] <original name>`
 * parked in the central Drive folder, AND record the user's full
 * pre-migration Master row to the MigrationLog tab.
 *
 * Defaults to --dry-run. Pass --execute to actually create snapshots.
 *
 * Usage:
 *   node scripts/migration/snapshot-user.js --user-id=<UUID>            # dry run
 *   node scripts/migration/snapshot-user.js --user-id=<UUID> --execute  # do it
 *
 * Idempotent: writes per-user state to .local/migration/snapshot-<userId>.json,
 * skips snapshots already taken on a previous run. Pass --force to re-snapshot.
 */

const {
  log, parseArgs, assertEnv, loadState, saveState, stateFilePathFor, dateStamp, nowIso,
} = require('./_lib');
const {
  getClients, getCentralFolderId, readMasterUserRow, logMigrationEvent,
} = require('../../api/_lib/drive-architecture');

async function main() {
  const args = parseArgs();
  if (!args.userId) {
    console.error('ERROR: --user-id=<UUID> is required');
    process.exit(2);
  }
  assertEnv('GOOGLE_SERVICE_ACCOUNT_EMAIL', 'GOOGLE_PRIVATE_KEY', 'MASTER_SHEET_ID', 'GOOGLE_DRIVE_FOLDER_ID');

  const masterSheetId = process.env.MASTER_SHEET_ID;
  const centralFolderId = getCentralFolderId();
  const { sheets, drive } = getClients();

  const userRecord = await readMasterUserRow(sheets, masterSheetId, args.userId);
  if (!userRecord) {
    console.error(`ERROR: user ${args.userId} not found in Master Sheet`);
    process.exit(3);
  }
  const u = userRecord.asObject;
  log('info', `Snapshotting ${u.name} <${u.email}>`);

  const statePath = stateFilePathFor(args.userId, 'snapshot');
  const state = loadState(statePath) || { userId: args.userId, snapshots: {}, masterRowSnapshot: null };

  const sheetsToSnapshot = [];
  if (u.sheetId) sheetsToSnapshot.push({ key: 'userFacing', sourceId: u.sheetId, label: 'user-facing' });
  if (u.backupSheetId && u.backupSheetId !== u.sheetId) {
    sheetsToSnapshot.push({ key: 'hiddenBackup', sourceId: u.backupSheetId, label: 'hidden-backup' });
  }

  if (sheetsToSnapshot.length === 0) {
    console.error('No sheetId on user row — nothing to snapshot.');
    process.exit(4);
  }

  const stamp = dateStamp();
  const plan = {
    userId: args.userId,
    masterRowSnapshot: { ...u, _rowIndex: userRecord.rowIndex },
    snapshots: sheetsToSnapshot.map(s => ({
      key: s.key,
      sourceSheetId: s.sourceId,
      label: s.label,
      newName: `[PRE-MIGRATION SNAPSHOT ${stamp}] ${u.name} ${s.label}`,
      destParentFolderId: centralFolderId,
      alreadyDone: !!(state.snapshots[s.key] && !args.force),
      existingSnapshotId: state.snapshots[s.key]?.snapshotId || null,
    })),
  };

  console.log('\n=== PLAN ===');
  console.log(`Target user:        ${u.name} <${u.email}> (rowIndex ${userRecord.rowIndex})`);
  console.log(`Mode:               ${args.dryRun ? 'DRY RUN (no writes)' : 'EXECUTE'}`);
  console.log(`Will snapshot ${plan.snapshots.length} sheet(s):`);
  for (const s of plan.snapshots) {
    console.log(`  [${s.alreadyDone ? 'SKIP-EXISTS' : 'COPY'}] ${s.label}: ${s.sourceSheetId} -> "${s.newName}"`);
    if (s.alreadyDone) console.log(`     existing snapshot id: ${s.existingSnapshotId}`);
  }
  console.log(`Will append a row to Master Sheet MigrationLog (phase=snapshot-pre).\n`);

  if (args.dryRun) {
    log('info', 'Dry run — no changes written. Re-run with --execute to apply.');
    process.exit(0);
  }

  // Execute
  for (const s of plan.snapshots) {
    if (s.alreadyDone) {
      log('info', `[SKIP] ${s.label} already snapshotted as ${s.existingSnapshotId}`);
      continue;
    }
    log('info', `Copying ${s.label} sheet ${s.sourceSheetId} -> "${s.newName}"`);
    try {
      const copyRes = await drive.files.copy({
        fileId: s.sourceSheetId,
        requestBody: {
          name: s.newName,
          parents: [centralFolderId],
        },
        supportsAllDrives: true,
        fields: 'id,name',
      });
      state.snapshots[s.key] = {
        snapshotId: copyRes.data.id,
        snapshotName: copyRes.data.name,
        sourceSheetId: s.sourceSheetId,
        createdAt: nowIso(),
      };
      saveState(statePath, state);
      log('info', `  -> snapshot id: ${copyRes.data.id}`);
    } catch (e) {
      log('error', `Snapshot of ${s.label} FAILED: ${e.message}`);
      throw e;
    }
  }

  // Record the master row snapshot to the state file (for rollback) and to MigrationLog
  state.masterRowSnapshot = plan.masterRowSnapshot;
  state.snapshotCompletedAt = nowIso();
  saveState(statePath, state);

  await logMigrationEvent(
    sheets,
    masterSheetId,
    args.userId,
    'snapshot-pre',
    {
      masterRowSnapshot: plan.masterRowSnapshot,
      snapshots: state.snapshots,
    },
    'cli'
  );

  console.log('\n=== DONE ===');
  console.log(`State file: ${statePath}`);
  console.log('Master Sheet MigrationLog updated.');
  console.log('You can now safely run migrate-user.js.\n');
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
