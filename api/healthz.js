/**
 * GET /api/healthz
 *
 * Liveness probe. Returns 200 + tiny payload, no auth.
 *
 * Optional ?deep=1 query param triggers a Postgres healthcheck (only when
 * DB_BACKEND=postgres or DB_DUAL_WRITE is on). Kept off by default so the
 * shallow probe stays sub-millisecond and cheap to hit at high frequency.
 */

const { dbHealthcheck, isPostgresEnabled, isDualWriteEnabled } = require('./_lib/db');

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const payload = {
    ok: true,
    service: 'taylor-invoices',
    timestamp: new Date().toISOString(),
    dbBackend: process.env.DB_BACKEND || 'sheets',
    dualWrite: isDualWriteEnabled(),
  };

  if (req.query?.deep === '1' && (isPostgresEnabled() || isDualWriteEnabled())) {
    try {
      const r = await dbHealthcheck();
      payload.db = r;
      if (!r.ok) payload.ok = false;
    } catch (err) {
      payload.db = { ok: false, reason: err.message };
      payload.ok = false;
    }
  }

  res.status(payload.ok ? 200 : 503).json(payload);
};
