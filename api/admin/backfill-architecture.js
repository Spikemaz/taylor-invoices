/**
 * POST /api/admin/backfill-architecture
 *
 * Bring an existing central-hub user up to the new architecture spec:
 *   1. Share their user-facing sheet+folder back to their email (idempotent).
 *   2. If they don't yet have a real hidden backup (backupSheetId === sheetId),
 *      create one in GOOGLE_DRIVE_HIDDEN_BACKUP_ROOT_ID and copy ALL their
 *      current tab data into it. Update Master Sheet cols L/M to point at
 *      the new hidden IDs.
 *
 * Body:
 *   { userId: string, dryRun?: boolean (default true) }
 *
 * Returns:
 *   { success: true, dryRun, plan: { ... }, applied?: { ... } }
 *
 * Admin only. Idempotent — re-runs are safe; if a hidden backup already
 * exists (cols L/M differ from F/G), it will only repair the share-to-email
 * permission and skip backup creation.
 *
 * This is NOT for migrating Taylor — her data lives in HER drive, not
 * central hub. Use scripts/migration/migrate-user.js for that. This
 * endpoint is for users already on central-hub (e.g. Reo) that need
 * the new share + backup tier added.
 */

const { requireSession, applyCors, logAdminAction } = require('../_lib/auth');
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
} = require('../_lib/drive-architecture');

module.exports = async function handler(req, res) {
  applyCors(req, res, 'POST, OPTIONS');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const session = await requireSession(req, res, { adminOnly: true });
  if (!session) return;

  const { userId, dryRun: dryRunInput } = req.body || {};
  const dryRun = dryRunInput !== false; // default true — opt-in to mutate

  if (!userId) {
    return res.status(400).json({ error: 'userId is required' });
  }

  const masterSheetId = process.env.MASTER_SHEET_ID;
  if (!masterSheetId) {
    return res.status(500).json({ error: 'MASTER_SHEET_ID not configured' });
  }

  try {
    const { sheets, drive } = getClients();

    const userRecord = await readMasterUserRow(sheets, masterSheetId, userId);
    if (!userRecord) {
      return res.status(404).json({ error: `User not found: ${userId}` });
    }

    const u = userRecord.asObject;
    const plan = {
      userId,
      email: u.email,
      name: u.name,
      currentSheetId: u.sheetId,
      currentDriveFolderId: u.driveFolderId,
      currentBackupSheetId: u.backupSheetId,
      currentBackupFolderId: u.backupFolderId,
      actions: [],
    };

    // --- Action 1: share user-facing sheet+folder to email ---
    if (!u.email) {
      plan.actions.push({ type: 'share_user_facing', skipped: true, reason: 'no email on row' });
    } else if (!u.sheetId || !u.driveFolderId) {
      plan.actions.push({ type: 'share_user_facing', skipped: true, reason: 'missing sheetId or driveFolderId' });
    } else {
      plan.actions.push({
        type: 'share_user_facing',
        sheetId: u.sheetId,
        folderId: u.driveFolderId,
        email: u.email,
        role: 'writer',
      });
    }

    // --- Action 2: create real hidden backup if missing ---
    // "Missing" = either the sheet OR the folder backup column is empty
    // or still equal to its user-facing counterpart. Checking only
    // backupSheetId would let through users whose sheet was backed up
    // earlier but whose folder column is still pointing at the user-facing
    // folder (a partial-state we want to repair).
    const hiddenBackupRootId = getHiddenBackupRootId();
    const sheetMissingOrSame = !u.backupSheetId || u.backupSheetId === u.sheetId;
    const folderMissingOrSame = !u.backupFolderId || u.backupFolderId === u.driveFolderId;
    const needsBackup = sheetMissingOrSame || folderMissingOrSame;
    if (needsBackup) {
      if (!hiddenBackupRootId) {
        plan.actions.push({
          type: 'create_hidden_backup',
          skipped: true,
          reason: 'GOOGLE_DRIVE_HIDDEN_BACKUP_ROOT_ID not set — set it then re-run',
        });
      } else if (!u.sheetId || !u.driveFolderId) {
        plan.actions.push({
          type: 'create_hidden_backup',
          skipped: true,
          reason: 'user has no sheetId/driveFolderId to mirror — repair Master row first',
        });
      } else {
        plan.actions.push({
          type: 'create_hidden_backup',
          parentFolderId: hiddenBackupRootId,
          willCopyFromSheetId: u.sheetId,
          willUpdateMasterCells: ['backupSheetId', 'backupFolderId'],
          reason: sheetMissingOrSame && folderMissingOrSame
            ? 'no real hidden backup yet'
            : (sheetMissingOrSame ? 'backupSheetId missing/same as sheetId' : 'backupFolderId missing/same as driveFolderId'),
        });
      }
    } else {
      plan.actions.push({
        type: 'create_hidden_backup',
        skipped: true,
        reason: 'already has distinct backupSheetId AND backupFolderId',
      });
    }

    if (dryRun) {
      await logMigrationEvent(sheets, masterSheetId, userId, 'backfill-dry-run', plan, session.email);
      return res.status(200).json({ success: true, dryRun: true, plan });
    }

    // ---------- EXECUTE ----------
    const applied = { actions: [] };

    for (const act of plan.actions) {
      if (act.skipped) {
        applied.actions.push(act);
        continue;
      }
      if (act.type === 'share_user_facing') {
        const sheetShare = await shareWithUser(drive, act.sheetId, act.email, 'writer', false);
        const folderShare = await shareWithUser(drive, act.folderId, act.email, 'writer', false);
        applied.actions.push({
          type: 'share_user_facing',
          sheetShare,
          folderShare,
        });
      } else if (act.type === 'create_hidden_backup') {
        const shortId = userId.slice(0, 8);
        const namePrefix = u.name || u.email || userId;
        const backupSheetId = await createSpreadsheet(
          drive,
          `BooksIQ BACKUP - ${namePrefix} - ${shortId}`,
          act.parentFolderId
        );
        const backupFolderId = await getOrCreateFolder(
          drive,
          `Invoices BACKUP - ${namePrefix} - ${shortId}`,
          act.parentFolderId
        );
        await ensureSheetSchema(sheets, backupSheetId);
        // clearFirst:true makes the copy idempotent — backup sheet is fresh
        // here, but we use clearFirst anyway so a half-failed retry is safe.
        const copyReport = await copyAllTabData(sheets, u.sheetId, backupSheetId, { clearFirst: true });
        await updateMasterUserCells(sheets, masterSheetId, userRecord.rowIndex, userRecord.headers, {
          backupSheetId,
          backupFolderId,
        });
        applied.actions.push({
          type: 'create_hidden_backup',
          backupSheetId,
          backupFolderId,
          copyReport,
        });
      }
    }

    await logMigrationEvent(sheets, masterSheetId, userId, 'backfill-execute', { plan, applied }, session.email);
    await logAdminAction(session.userId, 'backfill_architecture', userId, {
      actions: applied.actions.map(a => ({ type: a.type, skipped: !!a.skipped })),
    });

    return res.status(200).json({ success: true, dryRun: false, plan, applied });

  } catch (err) {
    console.error('[backfill-architecture] error:', err);
    try {
      const { sheets } = getClients();
      await logMigrationEvent(sheets, masterSheetId, userId, 'backfill-error', { message: err.message, stack: err.stack }, session.email);
    } catch (_) { /* swallow */ }
    return res.status(500).json({ error: 'Backfill failed', details: err.message });
  }
};
