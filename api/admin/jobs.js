/**
 * GET  /api/admin/jobs        — list recent jobs
 * POST /api/admin/jobs        — { action: 'enqueue' | 'retry' | 'kill', ... }
 *
 * Admin-only. Stage 0 surface for the queue. Real handler payloads land in
 * later stages.
 */

const { requireSession, applyCors } = require('../_lib/auth');
const { getDb, getSchema } = require('../_lib/db');
const { enqueue, stats, isQueueActive } = require('../_lib/jobs');
const { audit } = require('../_lib/audit-log');
const { sql, desc, and, eq, inArray } = require('drizzle-orm');

module.exports = async function handler(req, res) {
  applyCors(req, res, 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const session = await requireSession(req, res);
  if (!session) return;
  if (session.role !== 'admin') return res.status(403).json({ error: 'Admin only' });

  if (!isQueueActive()) {
    return res.status(200).json({
      ok: true,
      backend: process.env.DB_BACKEND || 'sheets',
      message: 'Jobs queue is inactive (set DB_BACKEND=postgres or DB_DUAL_WRITE=1)',
      rows: [],
      stats: { enabled: false },
    });
  }

  try {
    if (req.method === 'GET') return await list(req, res);
    if (req.method === 'POST') return await act(req, res, session);
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('[admin/jobs] failed:', err);
    return res.status(500).json({ error: err.message });
  }
};

async function list(req, res) {
  const db = getDb();
  const { jobs } = getSchema();
  const limit = Math.max(1, Math.min(200, parseInt(req.query?.limit, 10) || 50));
  const states = parseStates(req.query?.state);

  const rows = await db
    .select()
    .from(jobs)
    .where(states ? inArray(jobs.state, states) : undefined)
    .orderBy(desc(jobs.id))
    .limit(limit);

  const summary = await stats();
  // Defensive: even though schema uses mode:'number', some columns (counts
  // returned by aggregates, future bigint cols) might still arrive as
  // BigInt. Stringify-with-fallback prevents JSON.stringify from throwing.
  return res.status(200).json(jsonSafe({ ok: true, rows, stats: summary, limit }));
}

async function act(req, res, session) {
  const { action, kind, payload, jobId } = req.body || {};
  const actorMeta = {
    actorUserId: session.userId,
    actorEmail: session.email,
    actorRole: session.role,
    ip: req.headers['x-forwarded-for'] || req.socket?.remoteAddress,
    userAgent: req.headers['user-agent'],
  };

  if (action === 'enqueue') {
    if (!kind) return res.status(400).json({ error: 'kind required' });
    const r = await enqueue(kind, payload || {}, { userId: session.userId });
    await audit({
      ...actorMeta,
      action: 'admin.jobs.enqueue',
      resourceType: 'job',
      resourceId: r ? String(r.id) : null,
      after: { kind, payload: payload || {} },
    });
    return res.status(200).json({ ok: true, enqueued: r });
  }
  if (action === 'retry') {
    if (!jobId) return res.status(400).json({ error: 'jobId required' });
    const db = getDb();
    const before = await db.execute(sql`
      SELECT id, kind, state, attempts, last_error FROM jobs WHERE id = ${jobId}
    `);
    await db.execute(sql`
      UPDATE jobs SET state='pending', scheduled_for=NOW(), attempts=0, last_error=NULL, updated_at=NOW()
      WHERE id = ${jobId};
    `);
    await audit({
      ...actorMeta,
      action: 'admin.jobs.retry',
      resourceType: 'job',
      resourceId: String(jobId),
      before: before.rows?.[0] || null,
      after: { state: 'pending', attempts: 0 },
    });
    return res.status(200).json({ ok: true, jobId });
  }
  if (action === 'kill') {
    if (!jobId) return res.status(400).json({ error: 'jobId required' });
    const db = getDb();
    const before = await db.execute(sql`
      SELECT id, kind, state, attempts, last_error FROM jobs WHERE id = ${jobId}
    `);
    await db.execute(sql`
      UPDATE jobs SET state='dead', finished_at=NOW(), last_error='killed by admin', updated_at=NOW()
      WHERE id = ${jobId};
    `);
    await audit({
      ...actorMeta,
      action: 'admin.jobs.kill',
      resourceType: 'job',
      resourceId: String(jobId),
      before: before.rows?.[0] || null,
      after: { state: 'dead', last_error: 'killed by admin' },
    });
    return res.status(200).json({ ok: true, jobId });
  }
  return res.status(400).json({ error: 'unknown action' });
}

function parseStates(raw) {
  if (!raw) return null;
  const allowed = new Set(['pending', 'running', 'done', 'failed', 'dead']);
  const list = String(raw).split(',').map((s) => s.trim()).filter((s) => allowed.has(s));
  return list.length ? list : null;
}

// Walk an object/array and convert BigInt → string so res.json doesn't throw.
function jsonSafe(value) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (typeof value === 'object' && !(value instanceof Date)) {
    const out = {};
    for (const k of Object.keys(value)) out[k] = jsonSafe(value[k]);
    return out;
  }
  return value;
}
