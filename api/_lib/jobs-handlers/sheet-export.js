/**
 * Job handler: `sheet_export`
 *
 * Stage 0 ships this as a STUB so the registration plumbing is exercised in
 * tests and so the cron runner doesn't bail with "no handler" once we start
 * enqueueing the first sheet_export jobs during the dual-write window.
 *
 * Final behaviour (Stage 0 follow-up): given { userId }, regenerate the
 * user's read-only Google Sheet from authoritative Postgres data so users
 * who liked having a "live" sheet still get one. The sheet becomes a
 * mirror, not the source of truth.
 *
 * Payload shape:
 *   { userId: string, mode: 'full' | 'incremental', since?: ISO8601 }
 */

const { registerHandler } = require('../jobs');

registerHandler('sheet_export', async (job) => {
  const { userId, mode = 'full' } = job.payload || {};
  if (!userId) {
    throw new Error('sheet_export: userId required in payload');
  }

  // TODO(stage-0-followup): implement real export — read entries+invoices+
  // settings from Postgres, write to user's `sheetId` and `backupSheetId`
  // using the existing drive-architecture helpers. For now, this is a
  // structured no-op so we can test the runner end-to-end.
  console.log(
    `[jobs/sheet_export] STUB invoked for user=${userId} mode=${mode}. ` +
      'Implementation lands when ETL cutover ships.'
  );

  return {
    result: {
      stub: true,
      userId,
      mode,
      note: 'sheet_export handler is a stage-0 stub',
    },
  };
});
