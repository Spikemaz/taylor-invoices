# BooksIQ — Taylor migration & central-hub backfill runbook

This folder documents the operator-driven migration of Taylor from her
legacy "files-in-her-Drive + Apps Script" setup onto the central-hub +
hidden-backup architecture, and the related backfill of any other
existing user (currently Reo) onto the same architecture.

> Read this whole file before running any command. Several steps are
> destructive on the prod environment and require explicit operator
> confirmation.

## TL;DR — happy path for Taylor

```bash
# 0. PRE-REQS — set these once in Vercel + .env (see "Environment" below)
GOOGLE_DRIVE_HIDDEN_BACKUP_ROOT_ID=<folder id>

# 1. Read everything we know about Taylor's existing setup (read-only)
node scripts/migration/discover-user.js --user-id=<taylor-uuid>

# 2. Snapshot her current sheets (creates [PRE-MIGRATION SNAPSHOT ...] copies)
node scripts/migration/snapshot-user.js --user-id=<taylor-uuid>            # dry run first
node scripts/migration/snapshot-user.js --user-id=<taylor-uuid> --execute  # do it

# 3. Tell Taylor: "don't add entries for the next ~30 minutes"
#    Then run the migration.
node scripts/migration/migrate-user.js --user-id=<taylor-uuid>            # dry run
node scripts/migration/migrate-user.js --user-id=<taylor-uuid> --execute  # do it

# 4. Verify
node scripts/migration/verify-migration.js --user-id=<taylor-uuid>

# 5. Once verify is all green, hand Taylor `apps-script-disable.md`.
```

If any step fails part-way, fix the underlying issue and re-run the
same command — every step is idempotent and skips work it has already
completed (state lives in `.local/migration/migrate-<userId>.json`).

## Environment

All scripts read `artifacts/taylor-invoices/.env` (same as the dev server).
Required variables:

| Variable | Used by | Purpose |
|---|---|---|
| `GOOGLE_SERVICE_ACCOUNT_EMAIL` | all scripts | service account that performs Drive/Sheets API calls |
| `GOOGLE_PRIVATE_KEY` | all scripts | service account key (with literal `\n` escapes is fine) |
| `MASTER_SHEET_ID` | all scripts | central Users / MigrationLog spreadsheet |
| `GOOGLE_DRIVE_FOLDER_ID` | snapshot, migrate | central-hub root (operator-owned Drive) |
| `GOOGLE_DRIVE_HIDDEN_BACKUP_ROOT_ID` | migrate, backfill | **NEW** — hidden backup root the user CANNOT see |

The hidden backup root is a brand-new folder you create in operator
Drive and DO NOT share with any user. Standard recommendation: create
a folder named `BooksIQ HIDDEN BACKUPS` at the root of operator Drive
(or in a separate operator account if you want true second-account
durability — see "Open decisions" in the task plan).

## Scripts

All scripts live in `artifacts/taylor-invoices/scripts/migration/`. Run
them from inside `artifacts/taylor-invoices/` (or from anywhere — they
load `.env` themselves).

### `discover-user.js`

```bash
node scripts/migration/discover-user.js --user-id=<UUID>
node scripts/migration/discover-user.js --user-id=<UUID> --output=./out.json
```

**READ-ONLY.** Walks the user's Master Sheet row, both their referenced
sheets (user-facing + backup), and recursively their Drive folders,
then writes a JSON manifest. Use this to confirm what's about to be
migrated, and to keep an audit record of the pre-migration state.

Default output: `.local/migration/discover-<userId>.json`.

### `snapshot-user.js`

```bash
node scripts/migration/snapshot-user.js --user-id=<UUID>             # dry run
node scripts/migration/snapshot-user.js --user-id=<UUID> --execute   # execute
```

Creates `[PRE-MIGRATION SNAPSHOT YYYY-MM-DD] <user> ...` copies of the
user's current sheets in the central Drive folder, parked under the
service account so they survive even if the user revokes their drive
access. Also appends the user's **current Master Sheet row** to the
`MigrationLog` tab as the rollback record.

Idempotent — once a snapshot exists in the state file, re-runs skip
unless `--force` is passed.

State: `.local/migration/snapshot-<userId>.json` — must exist before
`migrate-user.js` will run.

### `migrate-user.js`

```bash
node scripts/migration/migrate-user.js --user-id=<UUID>             # dry run
node scripts/migration/migrate-user.js --user-id=<UUID> --execute   # execute
```

The main event. Performs the migration in 13 ordered steps; each step
is gated by the state file so re-runs after a partial failure resume
cleanly. Refuses to start if the snapshot has not been completed.

What it does:

1. **preflight** — confirm source sheet + folder are readable
2. **create_user_facing_sheet** — fresh sheet in central hub, schema set
3. **create_user_facing_folder** — fresh folder in central hub
4. **create_hidden_backup_sheet** — fresh sheet in hidden backup root
5. **create_hidden_backup_folder** — fresh folder in hidden backup root
6. **copy_data_to_user_facing** — copy every row from old sheet's tabs
7. **copy_pdfs_to_user_facing** — recursive PDF copy with old→new ID map
8. **rewrite_invoice_drivelinks** — Invoices.driveLink rewritten to new IDs
9. **mirror_to_hidden_backup** — copy data + PDFs into hidden tier, rewrite backup links
10. **share_user_facing_to_email** — share new sheet+folder with user as editor
11. **update_master_sheet_row** — flip cols F/G/L/M to new IDs
12. **archive_old_assets** — rename old sheet+folder with `[ARCHIVED YYYY-MM-DD] ...`
13. **mark_complete** — write `migrate-complete` row to MigrationLog

State: `.local/migration/migrate-<userId>.json`. Includes the per-step
completion timestamps and the full PDF old→new ID maps (used for
`rewrite_invoice_drivelinks` and for rollback).

**Critical:** old sheets and folders are NEVER deleted by this script.
They are renamed with an `[ARCHIVED YYYY-MM-DD]` prefix so they remain
available as a fallback for at least 30 days.

### `verify-migration.js`

```bash
node scripts/migration/verify-migration.js --user-id=<UUID>
```

**READ-ONLY.** Compares old vs new vs backup:

- row counts per tab match across all three
- PDF file counts match
- 5 random invoice rows have a `driveLink` that resolves
- Master Sheet row points at the new IDs
- Hidden backup IDs are distinct from user-facing IDs

Exits 0 on all-green, 1 on any failure.

After this passes, the operator should manually impersonate the user
via the admin master-override and spot-check a few invoices in the UI.

## Backfill (existing central-hub users like Reo)

For users that are already on central-hub but were created BEFORE the
share-to-email + hidden-backup upgrade, use the admin endpoint instead
of the CLI scripts:

```bash
# Dry run — shows what would happen
curl -X POST https://booksiq.app/api/admin/backfill-architecture \
  -H "Content-Type: application/json" \
  -H "X-Session-Token: <admin session token>" \
  -d '{"userId": "<user-uuid>", "dryRun": true}'

# Execute
curl -X POST https://booksiq.app/api/admin/backfill-architecture \
  -H "Content-Type: application/json" \
  -H "X-Session-Token: <admin session token>" \
  -d '{"userId": "<user-uuid>", "dryRun": false}'
```

The endpoint:
1. Shares the user's existing user-facing sheet+folder back to their email (idempotent — no-op if already shared)
2. If they have no real hidden backup yet (`backupSheetId === sheetId`), creates one in the hidden backup root, copies all current data, updates Master Sheet cols L/M.

Both actions are recorded to the MigrationLog tab and the AdminLog tab.

## State files

Per-user state lives in `.local/migration/` at the repo root. These
files are NOT committed to git. They are essential for resuming
partial migrations and for rollback — back them up if you have any
concerns.

```
.local/migration/
├── discover-<userId>.json    # full manifest from discover step (audit record)
├── snapshot-<userId>.json    # pre-migration master row + snapshot sheet IDs
└── migrate-<userId>.json     # per-step completion + PDF old->new map
```

## Apps Script retirement (Taylor only)

After verify-migration is all green AND the operator has manually
spot-checked Taylor's account in the UI, hand Taylor the
`apps-script-disable.md` doc. Until she disables her triggers, both
the new central-hub PDF generation AND her old Apps Script may run on
the *same invoice number* — the old one targets the archived folder
which she no longer references, so worst case is a duplicate PDF in
an old folder, which is harmless but cosmetic. Disabling her triggers
removes that wart.

## Rollback

See `rollback.md` for the full procedure. TL;DR:

1. Find the user's `migrate-<userId>.json` state file.
2. Find the latest `snapshot-pre` row for that userId in the Master
   Sheet's `MigrationLog` tab — it contains the **old** Master row.
3. Manually edit the user's row in the Users tab back to the old
   sheetId / driveFolderId / backupSheetId / backupFolderId.
4. Rename the `[ARCHIVED ...]` sheet + folder back to their original
   names (the original names are recorded in the migrate state file
   under step `archive_old_assets`).
5. Tell the user not to re-enable Apps Script until you've decided
   what to do next.
