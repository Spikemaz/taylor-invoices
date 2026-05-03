/**
 * Drizzle client — singleton pool, exported for both TS and CJS callers.
 *
 * Usage from TS:
 *   import { db, schema } from './client';
 *
 * Usage from JS endpoints (after `npm run db:build`):
 *   const { db, schema } = require('../../db/dist/client');
 */

import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema';

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  // We don't throw at import time so that environments without Postgres
  // (e.g. dev with DB_BACKEND=sheets) can still load this module without
  // the process exiting. We throw on first query attempt instead.
  // eslint-disable-next-line no-console
  console.warn(
    '[db/client] DATABASE_URL not set — Postgres calls will fail. ' +
      'Set DB_BACKEND=sheets to bypass.'
  );
}

export const pool = new Pool({
  connectionString: connectionString || undefined,
  // Vercel serverless: connections are short-lived; keep pool small.
  max: Number(process.env.PG_POOL_MAX || 5),
  idleTimeoutMillis: 10_000,
  connectionTimeoutMillis: 10_000,
  // Neon and managed Postgres typically require SSL in prod. The Replit dev
  // database does NOT use SSL, so we only enable it when DATABASE_URL says so
  // (sslmode=require) or PGSSL=1 is set explicitly.
  ssl: shouldUseSsl(connectionString) ? { rejectUnauthorized: false } : undefined,
});

export const db = drizzle(pool, { schema });

export { schema };

/**
 * Health probe — returns true if the pool can run a trivial query.
 * Used by /api/healthz and the ETL pre-flight.
 */
export async function dbHealthcheck(): Promise<boolean> {
  try {
    const r = await pool.query('SELECT 1 as ok');
    return r.rows[0]?.ok === 1;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[db/client] healthcheck failed:', (err as Error).message);
    return false;
  }
}

function shouldUseSsl(url?: string): boolean {
  if (process.env.PGSSL === '1' || process.env.PGSSL === 'true') return true;
  if (process.env.PGSSL === '0' || process.env.PGSSL === 'false') return false;
  if (!url) return false;
  return /sslmode=require/.test(url) || /\.neon\.tech/.test(url);
}
