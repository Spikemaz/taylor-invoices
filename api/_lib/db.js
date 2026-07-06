/**
 * CommonJS bridge to the TypeScript Drizzle client.
 *
 * JS endpoints should:
 *
 *   const { db, schema, isPostgresEnabled } = require('../_lib/db');
 *
 * The Drizzle layer is compiled to `db/dist/` via `npm run db:build` (called
 * automatically by Vercel's build step). In development, run the build once
 * after schema changes.
 *
 * Stage 0: every call site MUST gate on `isPostgresEnabled()` so we can ship
 * the foundations behind a feature flag (DB_BACKEND=sheets|postgres) without
 * touching live booksiq.app data. Default is `sheets`.
 */

let _client = null;

function loadClient() {
  if (_client) return _client;
  try {
    // eslint-disable-next-line global-require
    _client = require('../../db/dist/client');
  } catch (err) {
    throw new Error(
      "[db] Drizzle client not built. Run 'npm run db:build' from " +
        `artifacts/taylor-invoices first. Underlying error: ${err.message}`
    );
  }
  return _client;
}

/**
 * True when the app is running against Postgres. Defaults to `false`
 * (Sheets-backed). Flip to `true` only after the dual-write window passes.
 *
 * Set DB_BACKEND=postgres in env to enable.
 */
function isPostgresEnabled() {
  const v = (process.env.DB_BACKEND || 'sheets').toLowerCase().trim();
  return v === 'postgres' || v === 'pg';
}

/**
 * True for the dual-write window: writes go to BOTH Sheets and Postgres,
 * reads still come from Sheets. Used during the cutover.
 *
 * Set DB_DUAL_WRITE=1 to enable.
 */
function isDualWriteEnabled() {
  return (
    process.env.DB_DUAL_WRITE === '1' ||
    (process.env.DB_DUAL_WRITE || '').toLowerCase() === 'true'
  );
}

/**
 * True when the IAccountant feature is enabled. IAccountant uses Postgres
 * as a DERIVED read-model (rebuilt on demand from Sheets via idempotent
 * backfill), so it needs DB access without flipping the global
 * DB_BACKEND / DB_DUAL_WRITE cutover flags. Keeping a dedicated flag means
 * enabling IAccountant never changes the live Sheets write path.
 *
 * Set IACCOUNTANT_ENABLED=1 to enable.
 */
function isAccountantEnabled() {
  return (
    process.env.IACCOUNTANT_ENABLED === '1' ||
    (process.env.IACCOUNTANT_ENABLED || '').toLowerCase() === 'true'
  );
}

/**
 * Lazy accessor for the Drizzle db. Throws a clear error if all DB-access
 * flags are off — protects against accidental queries during the
 * Sheets-only window.
 */
function getDb() {
  if (!isPostgresEnabled() && !isDualWriteEnabled() && !isAccountantEnabled()) {
    throw new Error(
      '[db] getDb() called but DB_BACKEND=sheets, DB_DUAL_WRITE is off, and ' +
        'IACCOUNTANT_ENABLED is off. Wrap call sites in the appropriate flag check.'
    );
  }
  return loadClient().db;
}

function getSchema() {
  return loadClient().schema;
}

function getPool() {
  return loadClient().pool;
}

async function dbHealthcheck() {
  if (!isPostgresEnabled() && !isDualWriteEnabled() && !isAccountantEnabled())
    return { ok: false, reason: 'disabled' };
  try {
    const ok = await loadClient().dbHealthcheck();
    return { ok, reason: ok ? 'ok' : 'query_failed' };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

module.exports = {
  loadClient,
  getDb,
  getSchema,
  getPool,
  dbHealthcheck,
  isPostgresEnabled,
  isDualWriteEnabled,
  isAccountantEnabled,
  // Convenience getters that lazy-load
  get db() {
    return getDb();
  },
  get schema() {
    return getSchema();
  },
  get pool() {
    return getPool();
  },
};
