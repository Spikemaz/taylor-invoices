/**
 * /api/admin/bank/rules
 *
 *   GET                                 → list rules for entityId
 *   POST { action:'create', ... }       → create a rule
 *   POST { action:'update', id, patch } → update a rule
 *   POST { action:'delete', id }        → delete a rule
 *   POST { action:'seed', entityId }    → install UK default rule library
 *   POST { action:'test', entityId,
 *          conditions, windowDays? }    → preview match count against history
 *   POST { action:'apply', bankAccountId,
 *          autoPost?, autoPostThreshold?,
 *          dryRun? }                    → bulk auto-categorise unmatched lines
 */

const { requireSession, applyCors } = require('../../_lib/auth');
const { isPostgresEnabled, isDualWriteEnabled } = require('../../_lib/db');
const {
  createRule,
  listRules,
  updateRule,
  deleteRule,
  seedDefaultRulesForEntity,
  testRuleAgainstHistory,
  applyRulesToUnmatched,
} = require('../../_lib/bank/rules');

module.exports = async function handler(req, res) {
  applyCors(req, res, 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  const session = await requireSession(req, res);
  if (!session) return;
  if (session.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  if (!isPostgresEnabled() && !isDualWriteEnabled()) {
    return res.status(409).json({ error: 'Auto-categorisation requires DB_BACKEND=postgres or DB_DUAL_WRITE=1' });
  }
  const actor = {
    userId: session.userId,
    email: session.email,
    role: session.role,
    ip: req.headers['x-forwarded-for'] || req.socket?.remoteAddress,
    userAgent: req.headers['user-agent'],
  };
  try {
    if (req.method === 'GET') {
      const entityId = req.query?.entityId;
      if (!entityId) return res.status(400).json({ error: 'entityId required' });
      const rows = await listRules(entityId);
      return res.status(200).json({ ok: true, rows });
    }
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    const body = req.body || {};
    switch (body.action) {
      case 'create': {
        const r = await createRule(body, { actor });
        return res.status(200).json({ ok: true, id: r.id });
      }
      case 'update': {
        if (!body.id) return res.status(400).json({ error: 'id required' });
        await updateRule(body.id, body.patch || {}, { actor });
        return res.status(200).json({ ok: true });
      }
      case 'delete': {
        if (!body.id) return res.status(400).json({ error: 'id required' });
        await deleteRule(body.id, { actor });
        return res.status(200).json({ ok: true });
      }
      case 'seed': {
        if (!body.entityId) return res.status(400).json({ error: 'entityId required' });
        const r = await seedDefaultRulesForEntity(body.entityId);
        return res.status(200).json({ ok: true, ...r });
      }
      case 'test': {
        if (!body.entityId) return res.status(400).json({ error: 'entityId required' });
        if (!body.conditions) return res.status(400).json({ error: 'conditions required' });
        const r = await testRuleAgainstHistory(body.entityId, body.conditions, {
          windowDays: body.windowDays,
        });
        return res.status(200).json({ ok: true, ...r });
      }
      case 'apply': {
        if (!body.bankAccountId) return res.status(400).json({ error: 'bankAccountId required' });
        const r = await applyRulesToUnmatched(
          {
            bankAccountId: body.bankAccountId,
            autoPost: !!body.autoPost,
            autoPostThreshold: body.autoPostThreshold || 95,
            dryRun: !!body.dryRun,
            limit: body.limit || 500,
          },
          { actor }
        );
        return res.status(200).json({ ok: true, ...r });
      }
      default:
        return res.status(400).json({ error: 'unknown action' });
    }
  } catch (err) {
    console.error('[admin/bank/rules]', err);
    return res.status(500).json({ error: err.message });
  }
};
