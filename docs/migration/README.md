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

## Backfill old PDFs into the hidden backup (`backfill-pdf-mirrors.js`)

Every NEW invoice generated after the central-hub migration shipped is
automatically mirrored from the user-facing folder into the per-user
hidden backup folder by `api/drive-upload.js`. Invoices generated
BEFORE that change (or before this user was migrated) only exist in
the user-facing folder — if the user accidentally trashes one, there
is no second copy to restore from. This script catches them up by
copying any invoice PDF that has no matching mirror into the same
`<Entity>/Invoices/<Year>/<Month>/[Ad Hoc/]<fileName>` path the upload
code would have produced, owned by the service account.

```bash
# Dry run — lists invoices that need mirroring, copies nothing.
node scripts/migration/backfill-pdf-mirrors.js --user-id=<UUID>

# Execute — actually copies. Default is always dry-run; you must pass --execute.
node scripts/migration/backfill-pdf-mirrors.js --user-id=<UUID> --execute
```

Pre-requisite: the user must already have a real hidden backup folder
(i.e. `backupFolderId` differs from `driveFolderId` in their Master
row). For users still missing one, run `migrate-user.js` (legacy
single-Drive users like Taylor) or `/api/admin/backfill-architecture`
(existing central-hub users) FIRST, then run this script.

What it does, per invoice:
- skip if no `driveLink` (nothing to mirror)
- skip if the `driveLink` can't be parsed
- skip if `period`/`date` can't be turned into a year+month folder name
- look up the mirror in the backup tree using the same logic as the
  delete path (`api/_lib/pdf-mirror.findMirrorPdfId`)
- if missing, `drive.files.copy` the primary into the mirror tree

Output is a per-invoice success/skip/fail line plus a final summary
counting copied / failed / already-mirrored / skipped invoices. The
script exits 0 on all-green and 1 if any invoice failed to mirror.

**Idempotent.** In `--execute` mode, per-user state lives in
`.local/migration/backfill-pdf-mirrors-<userId>.json`. Successfully
mirrored invoices are cached there so a re-run after a partial
failure skips them without re-querying Drive. There is also a
race-safety re-check immediately before each copy: if a NEW upload
(or a parallel run) created the mirror in the meantime, this script
records the existing id rather than producing a duplicate.

Dry-run mode does NOT write a state file — it prints a per-invoice
classification (`ALREADY_MIRRORED` / `CACHED_MIRRORED` / `SKIP` /
`WOULD_COPY` / `FAILED`) for every row in the user's Invoices tab
and exits, so an operator can audit the full plan before committing.

In `--execute` mode (including no-op runs where every invoice was
already mirrored), a summary row is appended to the Master Sheet's
`MigrationLog` tab with phase `backfill-pdf-mirrors` for an audit
record of the run. Dry-runs do NOT write to MigrationLog.

If you suspect the local state cache is stale (for example after
manually deleting mirrors, or moving a user's backup folder), delete
`.local/migration/backfill-pdf-mirrors-<userId>.json` before re-running
so every row is re-checked against Drive.

### Running across all migrated users

There is no batch driver script — operator runs the per-user script
in a shell loop so each user's progress, state file, and audit log
entry stay independent. Suggested loop:

```bash
# 1. Pull the list of migrated users: open the Master Sheet's Users
#    tab and copy the userIds (column A) whose backupFolderId column
#    (L) is non-empty AND differs from driveFolderId column (G).
#    These are the users with a real hidden backup; anyone else needs
#    /api/admin/backfill-architecture run for them first.

# 2. Dry-run every one of them, capturing the output for review:
mkdir -p .local/migration/backfill-pdf-mirrors-runs
for uid in <uuid-1> <uuid-2> <uuid-3>; do
  node scripts/migration/backfill-pdf-mirrors.js --user-id="$uid" \
    > ".local/migration/backfill-pdf-mirrors-runs/dryrun-$uid.log" 2>&1
done

# 3. Skim the dry-run logs (grep "Need to copy" and "FAILED").
grep -E "User-facing sheet|Need to copy|Failed|FAILED" \
  .local/migration/backfill-pdf-mirrors-runs/dryrun-*.log

# 4. Execute. Repeat per user — re-runs are idempotent, so retrying a
#    user after a transient failure is safe.
for uid in <uuid-1> <uuid-2> <uuid-3>; do
  node scripts/migration/backfill-pdf-mirrors.js --user-id="$uid" --execute \
    > ".local/migration/backfill-pdf-mirrors-runs/exec-$uid.log" 2>&1 \
    || echo "FAILED: $uid (see exec-$uid.log)"
done

# 5. Cross-check: any failures recorded in the per-user state file?
grep -l '"failed":{[^}]' .local/migration/backfill-pdf-mirrors-*.json || \
  echo "No failed invoices recorded across any user."
```

Run the executes during low-traffic hours — Drive's per-user write
quota is shared with the live app, and a long copy run can slow new
PDF uploads down. The script is sequential per user for the same
reason; do NOT parallelise the per-user invocations against the same
Google project.

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
