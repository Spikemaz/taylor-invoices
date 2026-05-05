/**
 * Apply pending Drizzle migrations.
 *
 * Run via:  pnpm --filter taylor-invoices run db:migrate
 *  or:      npm run db:migrate     (from artifacts/taylor-invoices)
 *
 * Production policy: migrations are run MANUALLY by the operator with
 * `DATABASE_URL` pointing at the prod (Neon) instance, *before* flipping
 * `DB_BACKEND=postgres` or `DB_DUAL_WRITE=1` on Vercel. They are NOT run
 * from `vercel-build` on purpose — auto-migrating during deploy makes the
 * cutover atomicity hard to reason about and would force a schema change
 * to coincide with a code change. Migrations are committed under
 * `db/migrations/` and are immutable once applied.
 *
 * See `STAGE_0_PROGRESS.md` for the full cutover playbook.
 */

import 'dotenv/config';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    // eslint-disable-next-line no-console
    console.error('DATABASE_URL is not set');
    process.exit(1);
  }

  const useSsl =
    process.env.PGSSL === '1' ||
    /sslmode=require/.test(url) ||
    /\.neon\.tech/.test(url);

  const pool = new Pool({
    connectionString: url,
    max: 1,
    ssl: useSsl ? { rejectUnauthorized: false } : undefined,
  });

  const db = drizzle(pool);

  // eslint-disable-next-line no-console
  console.log('[db/migrate] applying migrations from ./db/migrations …');
  await migrate(db, { migrationsFolder: './db/migrations' });
  // eslint-disable-next-line no-console
  console.log('[db/migrate] done.');

  await pool.end();
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[db/migrate] failed:', err);
  process.exit(1);
});
