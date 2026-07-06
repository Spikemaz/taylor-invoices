/**
 * GET /api/cron/run-jobs
 *
 * Vercel Cron entry point. Drains pending jobs (up to 10 per tick).
 *
 * Cron schedule lives in `vercel.json`. Authentication: Vercel signs cron
 * requests with a header `x-vercel-cron-signature`; we additionally accept
 * a shared `CRON_SECRET` bearer token so we can hit it manually for ops.
 *
 * Stage 0: ships the runner, no handlers wired yet (sheet_export handler is
 * registered as a stub). Real handlers land in Stages 2/4/7.
 */

const { drain, isQueueActive } = require('../_lib/jobs');

// ---------- Stub handlers (real ones land in later stages) ----------
require('../_lib/jobs-handlers/sheet-export');

module.exports = async function handler(req, res) {
  // Accept GET and POST so manual ops can curl with -X POST too
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!isAuthorized(req)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (!isQueueActive()) {
    return res.status(200).json({
      ok: true,
      skipped: 'jobs queue inactive (set DB_BACKEND=postgres or DB_DUAL_WRITE=1)',
    });
  }

  const t0 = Date.now();
  try {
    const result = await drain({ maxJobs: 10 });
    return res.status(200).json({
      ok: true,
      durationMs: Date.now() - t0,
      ...result,
    });
  } catch (err) {
    console.error('[cron/run-jobs] failed:', err);
    return res.status(500).json({
      ok: false,
      error: err.message,
      durationMs: Date.now() - t0,
    });
  }
};

function isAuthorized(req) {
  // Vercel Cron sends `Authorization: Bearer ${CRON_SECRET}` automatically
  // when CRON_SECRET is set as an env var. We require it as the SOLE auth
  // mechanism — header presence checks (e.g. `x-vercel-cron-signature`) are
  // spoofable by any caller, and query-string secrets (`?secret=`) leak via
  // proxy access logs.
  //
  // Doc: https://vercel.com/docs/cron-jobs/manage-cron-jobs#securing-cron-jobs
  const secret = process.env.CRON_SECRET;
  if (!secret) return false; // fail-closed: no secret = no access

  const auth = req.headers.authorization || '';
  // Constant-time compare to defeat timing attacks.
  return constantTimeEqual(auth, `Bearer ${secret}`);
}

function constantTimeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i += 1) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}
