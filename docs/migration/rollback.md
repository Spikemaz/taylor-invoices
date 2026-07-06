# BooksIQ — Migration rollback procedure

This document covers reverting a single user back to their
pre-migration state. The procedure is destructive on the **new**
central-hub assets (they're abandoned but not deleted) and restores
the **old** archived assets back to active use.

Use this only if `verify-migration.js` failed in a way that can't be
resolved by re-running the migration (which is normally the better
fix — most failures are partial state and resume cleanly).

## Pre-requisites

1. The user's `.local/migration/migrate-<userId>.json` state file (or
   you'll have to reconstruct from the MigrationLog tab manually).
2. Admin access to the Master Sheet.
3. The MigrationLog tab on the Master Sheet, specifically the
   `snapshot-pre` row for this user — the `detail` column contains the
   full pre-migration row including the OLD `sheetId`, `driveFolderId`,
   `backupSheetId`, `backupFolderId`.

## Steps

### 1. Pause the user

Open the Master Sheet → Users tab → set the user's `status` cell to
`suspended`. This prevents them from logging in and writing while you
restore.

### 2. Find the OLD IDs

Open the Master Sheet → MigrationLog tab. Find the most recent row
where `userId` matches and `phase` = `snapshot-pre`. Parse the JSON in
the `detail` column. Note these four values from `masterRowSnapshot`:

- `sheetId`
- `driveFolderId`
- `backupSheetId`
- `backupFolderId`

### 3. Restore the Master Sheet row

In the Users tab, edit the user's row:

- Set column **F** (`sheetId`) back to the OLD value
- Set column **G** (`driveFolderId`) back to the OLD value
- Set column **L** (`backupSheetId`) back to the OLD value
- Set column **M** (`backupFolderId`) back to the OLD value

### 4. Un-archive the old sheet + folder

Open the user's `migrate-<userId>.json` state file and find the entry
under `completed.archive_old_assets.result`. It contains
`oldSheetName` and `oldFolderName` — the names BEFORE the archive
prefix was added.

In Drive:

- Find the file named `[ARCHIVED YYYY-MM-DD] <oldSheetName>` →
  rename it back to `<oldSheetName>`
- Find the folder named `[ARCHIVED YYYY-MM-DD] <oldFolderName>` →
  rename it back to `<oldFolderName>`

### 5. (Optional) Park the new central-hub assets

The migration created new central-hub sheet + folder + hidden backup
sheet + hidden backup folder. They are now orphaned from the user's
row. You can either:

- **Leave them** — harmless, costs ~zero storage. Useful as a
  reference if you want to investigate why the migration failed.
- **Rename them** with an `[ABANDONED YYYY-MM-DD] ` prefix so it's
  obvious they should not be touched.
- **Trash them** — only do this if you're certain you understand why
  the migration failed and won't need to investigate further.

### 6. Re-enable the user's Apps Script

If the user (Taylor) had already disabled their Apps Script triggers
after step 7 of the runbook, ask them to re-enable them: open
script.google.com → BooksIQ Invoice PDF Generator → Triggers →
re-add the triggers that were there before. The `.gs` file in the
repo (`google-apps-script/InvoicePDFGenerator.gs`) is the canonical
source.

If she had not yet disabled them at the time of failure, no action
needed — the triggers are still running.

### 7. Re-activate the user

In the Master Sheet Users tab → set the user's `status` cell back to
`active`. They can now log in and resume work against the OLD setup.

### 8. Log the rollback

In the Master Sheet MigrationLog tab, append a row manually:

| timestamp | userId | phase | detail | actor |
|---|---|---|---|---|
| `<ISO now>` | `<userId>` | `rollback` | `{"reason": "...", "rollbackBy": "<your name>"}` | `<your email>` |

This keeps the audit trail intact.

## After rollback

- The migration state file is now stale. Either delete it or rename
  it (e.g. `migrate-<userId>.json.failed-<date>`) so a future
  `migrate-user.js --execute` doesn't try to skip already-rolled-back
  steps.
- Investigate the root cause before attempting again.
- The pre-migration snapshot copies (`[PRE-MIGRATION SNAPSHOT ...]`)
  are still in the central Drive folder. Keep them for at least 30
  days as a defence-in-depth fallback.

## Retention window

> If no issues are found in the **30 days** following a successful
> migration, the archived old sheets and the pre-migration snapshot
> sheets can be moved to Drive trash. Do not delete them sooner.
