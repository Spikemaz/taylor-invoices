# Stage 0 — Foundations: Progress

Status: **Foundations complete and tested. Live cutover NOT performed.**

`booksiq.app` continues to run on Google Sheets. The Postgres path is built and verified end-to-end against a dev Postgres, but is gated behind `DB_BACKEND=sheets|postgres` (default `sheets`) and an additional `DB_DUAL_WRITE=1` flag for the eventual cutover window.

---

## What shipped this session

### Schema & ORM
- Drizzle ORM in `db/schema.ts` (TS), runtime via `db/dist/` after `npm run db:build`. JS endpoints stay CommonJS as agreed.
- Tables: `users`, `entities`, `magic_links`, `sessions`, `rate_limits`, `audit_log`, `jobs`, `job_locks`. Ledger tables (`accounts`, `transactions`, `transaction_lines`, …) come in Stage 1.
- Baseline migration generated and applied to dev DB: `db/migrations/0000_stage_0_foundations.sql`.

### Runtime helpers
- `api/_lib/db.js` — CommonJS bridge with feature-flag gates (`isPostgresEnabled()`, `isDualWriteEnabled()`).
- `api/_lib/audit-log.js` — best-effort audit writer; falls back to structured stderr when Postgres is off so we still have a tail.
- `api/_lib/jobs.js` — durable queue: `enqueue`, `drain`, `pickOne`, `runOne`, `stats`. Atomic `UPDATE … FOR UPDATE SKIP LOCKED`, exponential-backoff retries, partial-unique dedupe.
- `api/_lib/jobs-handlers/sheet-export.js` — stub handler so `sheet_export` jobs no-op cleanly during the cutover. Real impl lands in the ETL follow-up.

### Endpoints
- `api/cron/run-jobs.js` — Vercel Cron worker (every 5 min, see `vercel.json`). Auth: Vercel cron signature OR `CRON_SECRET` bearer.
- `api/admin/audit.js` — admin-only paginated audit-log viewer.
- `api/admin/jobs.js` — admin-only queue inspector + enqueue/retry/kill actions.
- `api/healthz.js` — now reports `dbBackend`, `dualWrite`, optional `?deep=1` Postgres probe (503 if DB down).
- `api/_lib/onboarding-pg.js` — atomic onboarding (single Drizzle transaction). Wired but NOT yet exposed; replaces the QA-flagged "orphaned Drive folders / unregistered users" failure mode at cutover.

### Build & deploy
- `package.json`: added `db:build`, `db:generate`, `db:migrate`, `db:studio`, `vercel-build` scripts.
- `vercel.json`: added `crons` block, expanded `functions` to `api/**/*.js`, set `buildCommand` to `npm run vercel-build`.

### Verified
End-to-end smoke (`DB_BACKEND=postgres node …`):
- DB healthcheck OK against Replit dev Postgres
- Audit row written to Postgres + stderr line
- Two `sheet_export` jobs enqueued, drained, transitioned to `done` with handler result captured
- Stats: pending 0, done 2

---

## What is NOT done (deliberately, per scoping)

- **Neon provisioning on Vercel.** You sign in, create the project, paste `DATABASE_URL` (and `PGSSL=1`) into Vercel env. We did not do this for you because it's a billing/account decision.
- **ETL of existing user data from Sheets to Postgres.** Stays as a follow-up task — destructive against live data, needs your sign-off and a reconciliation pass against Marcus/Taylor/Reo's books.
- **Repointing live endpoints.** `sheets-sync.js`, `auth/*`, `admin/*`, `onboarding/submit.js` still read/write Sheets exclusively. Postgres path is dead code in prod until flags flip.
- **48-hour dual-write window.** The infrastructure (`isDualWriteEnabled()` gate, audit log, jobs queue) is ready for it.

## Cutover playbook (next session)

1. **Provision Neon** (free tier is fine for now).
2. **Set Vercel env vars** on production:
   - `DATABASE_URL=postgres://…`
   - `PGSSL=1`
   - `CRON_SECRET=<long-random>` (so we can curl `/api/cron/run-jobs` for ad-hoc runs)
   - Leave `DB_BACKEND` UNSET (defaults to `sheets`)
3. **Run migrations against prod DB**: `pnpm --filter taylor-invoices run db:migrate` with prod `DATABASE_URL` exported locally. (One-time.)
4. **Smoke test prod**: `curl https://booksiq.app/api/healthz?deep=1` — should report `db.ok=true`.
5. **Run ETL dry-run** (script lands in follow-up task #11 prep). Reads Sheets, writes to a `_etl_dryrun` schema, diffs against expected counts.
6. **Run real ETL** into public schema. Audit log gets a `system.etl_import` row per user.
7. **Flip `DB_DUAL_WRITE=1`**. Now writes go to both. Reads still come from Sheets. Watch for 48 h.
8. **Compare row counts daily**. If they stay aligned, flip `DB_BACKEND=postgres`. Reads now come from PG. Sheets writes continue (dual-write) for safety.
9. **After 1 week of clean run**, drop `DB_DUAL_WRITE`. Sheets becomes export-only mirror via `sheet_export` job.

## Operational notes

- `audit_log` and `jobs` are append-mostly; expect ~10–100 audit rows per active user per day. Free Neon tier (3 GB) absorbs ~6 months at current scale.
- Cron schedule is every 5 min (`*/5 * * * *`). Adjust to `* * * * *` once we have time-sensitive jobs (MTD submission deadlines).
- The `job_locks` table is created but unused for now — it's the slot for a per-kind lease if we ever want strict single-writer-per-kind semantics. Right now `SKIP LOCKED` plus `dedupe_key` is sufficient.
