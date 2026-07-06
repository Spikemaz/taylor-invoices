/**
 * Background jobs queue (Postgres-backed).
 *
 * Why: Vercel serverless functions are short-lived. We need durable, retryable,
 * deduplicated work for: nightly bank fetches (Stage 2), MTD submissions
 * (Stage 7), OCR receipt extraction (Stage 4), and the Sheet-export mirror
 * (Stage 0 — the user can still download their data as a Google Sheet on
 * demand).
 *
 * The runner is invoked via a Vercel Cron hitting `/api/cron/run-jobs`. Each
 * cron tick:
 *   1. Reaps stale `running` rows (started_at older than staleAfterMs) back
 *      to `pending` so a crashed/timed-out worker doesn't strand a job.
 *   2. Picks the oldest `pending` job whose `scheduled_for <= now()` using
 *      `UPDATE … FOR UPDATE SKIP LOCKED` — multiple concurrent workers safely
 *      claim disjoint rows without fighting. (No advisory lock needed; the
 *      `job_locks` table is provisioned for a possible future per-kind lease
 *      scheme but is unused in Stage 0.)
 *   3. Marks it `running` (atomic UPDATE … RETURNING)
 *   4. Calls the registered handler
 *   5. Marks `done` or schedules a retry with exponential backoff (and
 *      eventually `dead` once `max_attempts` is exhausted).
 *
 * Stage 0 ships the queue + worker; handlers are registered in later stages.
 */

const { getDb, getSchema, isPostgresEnabled, isDualWriteEnabled } = require('./db');

/**
 * Whether queue operations should run. The queue is "active" whenever the
 * Postgres backend is reachable — that's true both when reads/writes have
 * cut over (`DB_BACKEND=postgres`) AND during the dual-write window
 * (`DB_DUAL_WRITE=1`), so the cron worker keeps draining sheet_export and
 * provisioning jobs even before the read cutover.
 */
function isQueueActive() {
  return isPostgresEnabled() || isDualWriteEnabled();
}
const { sql, and, eq, lte, inArray } = require('drizzle-orm');

const HANDLERS = new Map();

/**
 * Register a handler for a given job kind.
 *   registerHandler('sheet_export', async (job) => { ... })
 *
 * Handler should return either:
 *   - undefined  → marked `done`
 *   - { result } → marked `done` with result stored
 *   - { retryAfterMs, error } → reschedules
 *   - throws    → counted as a failure, retried with exponential backoff
 */
function registerHandler(kind, handler) {
  if (typeof handler !== 'function') {
    throw new Error(`[jobs] handler for ${kind} must be a function`);
  }
  HANDLERS.set(kind, handler);
}

function getHandler(kind) {
  return HANDLERS.get(kind);
}

/**
 * Enqueue a job.
 *
 * @param {string} kind
 * @param {object} payload
 * @param {object} [opts]
 * @param {Date|number} [opts.scheduledFor]
 * @param {string} [opts.dedupeKey]      if set, attempts to insert with same key are no-ops
 * @param {string} [opts.userId]
 * @param {string} [opts.entityId]
 * @param {number} [opts.maxAttempts]
 */
async function enqueue(kind, payload, opts = {}) {
  if (!isQueueActive()) {
    throw new Error(
      '[jobs] enqueue called but queue is inactive ' +
        '(set DB_BACKEND=postgres or DB_DUAL_WRITE=1)'
    );
  }
  if (!kind) throw new Error('[jobs] kind is required');
  const db = getDb();
  const { jobs } = getSchema();

  const scheduledFor =
    opts.scheduledFor instanceof Date
      ? opts.scheduledFor
      : typeof opts.scheduledFor === 'number'
        ? new Date(opts.scheduledFor)
        : new Date();

  // Raw SQL because the dedupe is enforced via a PARTIAL unique index
  // (`WHERE dedupe_key IS NOT NULL`). Postgres requires the same WHERE
  // predicate on ON CONFLICT to use the partial index — Drizzle's
  // onConflictDoNothing helper doesn't currently emit that.
  const r = await db.execute(sql`
    INSERT INTO jobs
      (kind, payload, scheduled_for, user_id, entity_id, dedupe_key, max_attempts)
    VALUES
      (${kind},
       ${JSON.stringify(payload || {})}::jsonb,
       ${scheduledFor.toISOString()}::timestamptz,
       ${opts.userId || null},
       ${opts.entityId || null},
       ${opts.dedupeKey || null},
       ${opts.maxAttempts || 5})
    ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING
    RETURNING id;
  `);
  return r.rows?.[0] || null;
}

/**
 * Drain the queue: pick + run jobs until either nothing is ready or we've
 * burned `maxJobs` of them. Designed to be called from the cron endpoint
 * with maxJobs ~10 to stay inside Vercel's 30s function budget.
 */
async function drain({ maxJobs = 10, lockId = 'cron', staleAfterMs = 10 * 60 * 1000 } = {}) {
  if (!isQueueActive()) {
    return { ok: false, reason: 'queue_inactive', processed: 0 };
  }
  // Reap stale `running` jobs first. A worker that crashed or hit a Vercel
  // function timeout (max 30s on hobby, 300s pro) leaves its row in
  // `running` forever otherwise — there's no lease/heartbeat. Anything that
  // started more than `staleAfterMs` ago (default 10 min, well above any
  // function budget) is presumed orphaned: bounce it back to `pending` so
  // the next pickOne() picks it up. attempts is NOT reset, so the existing
  // backoff/dead logic still applies (jobs that genuinely keep crashing
  // hit max_attempts and graduate to `dead`).
  const reaped = await reapStaleRunning(staleAfterMs);
  const processed = [];
  for (let i = 0; i < maxJobs; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const job = await pickOne();
    if (!job) break;
    // eslint-disable-next-line no-await-in-loop
    const r = await runOne(job);
    processed.push({ id: String(job.id), kind: job.kind, ...r });
  }
  return { ok: true, processed, reaped };
}

/**
 * Bounce stale `running` rows back to `pending`. Returns the count.
 * Idempotent — safe to call from every drain().
 */
async function reapStaleRunning(staleAfterMs) {
  const db = getDb();
  const ms = Number.isFinite(staleAfterMs) ? staleAfterMs : 10 * 60 * 1000;
  const r = await db.execute(sql`
    UPDATE jobs
       SET state = 'pending',
           started_at = NULL,
           last_error = COALESCE(last_error, '') ||
             ' [reaped: stale running >' || ${Math.round(ms / 1000)} || 's]',
           updated_at = NOW()
     WHERE state = 'running'
       AND started_at IS NOT NULL
       AND started_at < NOW() - (${ms} || ' milliseconds')::interval
   RETURNING id;
  `);
  return r.rows?.length || 0;
}

/**
 * Atomically claim the next ready job. Uses SKIP LOCKED so multiple workers
 * don't fight for the same row.
 */
async function pickOne() {
  const db = getDb();
  // Raw SQL because Drizzle doesn't have first-class FOR UPDATE SKIP LOCKED yet.
  const r = await db.execute(sql`
    UPDATE jobs
       SET state = 'running',
           started_at = NOW(),
           attempts = attempts + 1,
           updated_at = NOW()
     WHERE id = (
       SELECT id FROM jobs
        WHERE state = 'pending'
          AND scheduled_for <= NOW()
        ORDER BY scheduled_for ASC, id ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
     )
   RETURNING id, kind, payload, attempts, max_attempts, user_id, entity_id;
  `);
  return r.rows?.[0] || null;
}

async function runOne(job) {
  const handler = getHandler(job.kind);
  if (!handler) {
    await markFailed(job, `no handler registered for kind=${job.kind}`, /*dead*/ true);
    return { state: 'dead', reason: 'no_handler' };
  }
  try {
    const out = await handler(job);
    if (out && out.retryAfterMs) {
      await reschedule(job, out.retryAfterMs, out.error || 'handler requested retry');
      return { state: 'pending', retryAfterMs: out.retryAfterMs };
    }
    await markDone(job, out?.result);
    return { state: 'done' };
  } catch (err) {
    const msg = (err && err.message) || String(err);
    if (job.attempts >= job.max_attempts) {
      await markFailed(job, msg, /*dead*/ true);
      return { state: 'dead', error: msg };
    }
    // Exponential backoff: 1m, 5m, 15m, 1h, 6h
    const backoffs = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000, 6 * 60 * 60_000];
    const delay = backoffs[Math.min(job.attempts - 1, backoffs.length - 1)];
    await reschedule(job, delay, msg);
    return { state: 'pending', retryAfterMs: delay, error: msg };
  }
}

async function markDone(job, result) {
  const db = getDb();
  await db.execute(sql`
    UPDATE jobs
       SET state = 'done',
           finished_at = NOW(),
           result = ${result ? JSON.stringify(result) : null}::jsonb,
           updated_at = NOW()
     WHERE id = ${job.id};
  `);
}

async function markFailed(job, error, dead) {
  const db = getDb();
  await db.execute(sql`
    UPDATE jobs
       SET state = ${dead ? 'dead' : 'failed'},
           finished_at = NOW(),
           last_error = ${String(error).slice(0, 4000)},
           updated_at = NOW()
     WHERE id = ${job.id};
  `);
}

async function reschedule(job, delayMs, error) {
  const db = getDb();
  await db.execute(sql`
    UPDATE jobs
       SET state = 'pending',
           scheduled_for = NOW() + (${delayMs}::int * interval '1 millisecond'),
           last_error = ${String(error).slice(0, 4000)},
           updated_at = NOW()
     WHERE id = ${job.id};
  `);
}

/**
 * Stats helper — used by the admin dashboard. Cheap aggregate.
 */
async function stats() {
  if (!isQueueActive()) return { enabled: false };
  const db = getDb();
  const r = await db.execute(sql`
    SELECT state, COUNT(*)::int as n
      FROM jobs
     GROUP BY state;
  `);
  const out = { enabled: true, pending: 0, running: 0, done: 0, failed: 0, dead: 0 };
  for (const row of r.rows || []) out[row.state] = row.n;
  return out;
}

module.exports = {
  registerHandler,
  getHandler,
  enqueue,
  drain,
  pickOne,
  runOne,
  stats,
  isQueueActive,
};
