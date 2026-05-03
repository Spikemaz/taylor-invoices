/**
 * GET /api/healthz
 *
 * Lightweight liveness probe for uptime monitoring. Always returns 200 with a
 * tiny JSON payload — no auth, no database, no Drive calls. Safe to hit at
 * high frequency without burning quota.
 */
module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  res.status(200).json({
    ok: true,
    service: 'taylor-invoices',
    timestamp: new Date().toISOString(),
  });
};
