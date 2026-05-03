# Google Apps Script — DEPRECATED

**Status:** Deprecated as of May 2026. Kept for historical reference only.

## What this directory used to be

`InvoicePDFGenerator.gs` is a per-user Google Apps Script that ran inside
each user's Google Sheet (Self-Employed and Ltd Company). It polled the
`Invoices` and `Trash` tabs and:

1. Generated and uploaded an invoice PDF whenever a row was added with
   no `driveLink` set (it called the Vercel `/api/generate-pdf` endpoint
   and uploaded the result to Drive).
2. Moved old PDFs to a `Trash` subfolder when an invoice was deleted or
   re-edited (because the service account did not own those files and
   could not move them itself).

This was the only practical way to do PDF cleanup before the central-hub
migration — service-account-owned files in user-owned Drive folders are
asymmetric, and Apps Script ran as the user so it had the permissions
the API server lacked.

## Why it's deprecated

The May 2026 migration moves every user onto a central-hub architecture
where the service account owns BOTH the user-facing folder (shared back
to the user as editor) and a hidden backup folder. With service-account
ownership the API server can:

- Upload PDFs directly via `api/drive-upload.js` (with per-user backup
  mirror — see `mirrorFailures` field on the response).
- Trash old PDFs server-side via `drive.files.update({ trashed: true })`
  in `api/sheets-sync.js` `deleteInvoice` / `queuePdfDeletion`.

No Apps Script side-channel needed. Every PDF lifecycle event is driven
by the API, atomic with the corresponding Sheets write, and visible in
server logs / the `Log` tab.

## What you should do

- **Do not install or re-enable** `InvoicePDFGenerator.gs` for any new
  user. Migrated users will see PDFs duplicated and old PDFs will not
  get cleaned up correctly.
- **Existing users on the legacy script** keep working until they're
  migrated. The server still emits cleared `driveLink` / `Trash` tab
  rows for those users. After their `migrate-user.js` run completes the
  `apps-script-disable.md` runbook walks them through removing triggers.
- **Migration of Taylor's account** is tracked in
  `docs/migration/README.md`. The code-side retirement (this file +
  the server-side server-trash path in `sheets-sync.js`) ships ahead of
  Taylor's actual data migration; her live account flips over the moment
  she re-signs-in after the migration runbook completes.

## File index

| File | Status | Notes |
| --- | --- | --- |
| `InvoicePDFGenerator.gs` | DEPRECATED | Reference only; do not deploy |

If you're reading this and considering "but my user still needs PDF
generation via Apps Script" — the answer is `migrate-user.js`. Run it
against their Master Sheet row and the rest follows automatically.
