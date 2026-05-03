/**
 * /api/admin/tax-sa — Stage 5 admin façade for Self Assessment.
 *
 *   GET  ?kind=rules&taxYear=2025&region=rUK
 *   GET  ?kind=profit&entityId=...&taxYear=2025
 *   GET  ?kind=sa103&entityId=...&taxYear=2025[&region=...]
 *   GET  ?kind=allowances&entityId=...&taxYear=2025
 *   GET  ?kind=tax_year&entityId=...&taxYear=2025
 *
 *   POST { kind:'rules.seed' }
 *   POST { kind:'rules.set', taxYear, region, ruleSet }
 *   POST { kind:'tax_year.open', entityId, taxYear, region }
 *   POST { kind:'tax_year.lock', entityId, taxYear }
 *   POST { kind:'account.taxTreatment', entityId, accountCode, taxTreatment }
 *   POST { kind:'asset.create', entityId, taxYear, poolType, description, acquiredDate, costPence, claimAia }
 *   POST { kind:'allowances.compute', entityId, taxYear }
 *   POST { kind:'whatif', entityId, taxYear, overrides }
 */

const { eq, and } = require('drizzle-orm');
const { requireSession, applyCors } = require('../_lib/auth');
const { isPostgresEnabled, isDualWriteEnabled, getDb, getSchema } = require('../_lib/db');
const rulesLib = require('../_lib/tax/rules');
const yearsLib = require('../_lib/tax/years');
const profitLib = require('../_lib/tax/profit');
const capLib = require('../_lib/tax/capital-allowances');
const sa103Lib = require('../_lib/tax/sa103');

module.exports = async function handler(req, res) {
  applyCors(req, res, 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  const session = await requireSession(req, res);
  if (!session) return;
  if (session.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  if (!isPostgresEnabled() && !isDualWriteEnabled()) {
    return res.status(409).json({ error: 'Stage 5 requires DB_BACKEND=postgres or DB_DUAL_WRITE=1' });
  }
  const actor = {
    userId: session.userId,
    email: session.email,
    role: session.role,
    ip: req.headers['x-forwarded-for'] || req.socket?.remoteAddress,
  };
  try {
    if (req.method === 'GET') {
      const { kind, entityId, taxYear, region } = req.query || {};
      const ty = taxYear ? Number(taxYear) : null;
      switch (kind) {
        case 'rules':
          if (!ty) return res.status(400).json({ error: 'taxYear required' });
          return res.status(200).json({ ok: true, ruleSet: await rulesLib.getRules(ty, region || 'rUK') });
        case 'profit':
          if (!entityId || !ty) return res.status(400).json({ error: 'entityId + taxYear required' });
          return res.status(200).json({ ok: true, ...(await profitLib.computeTradingProfit(entityId, ty)) });
        case 'sa103':
          if (!entityId || !ty) return res.status(400).json({ error: 'entityId + taxYear required' });
          return res.status(200).json({ ok: true, ...(await sa103Lib.computeSA103(entityId, ty, { region })) });
        case 'allowances':
          if (!entityId || !ty) return res.status(400).json({ error: 'entityId + taxYear required' });
          return res.status(200).json({ ok: true, assets: await capLib.listAssets(entityId, ty) });
        case 'tax_year':
          if (!entityId || !ty) return res.status(400).json({ error: 'entityId + taxYear required' });
          return res.status(200).json({ ok: true, taxYear: await yearsLib.ensureTaxYear(entityId, ty, { region }) });
        default:
          return res.status(400).json({ error: 'unknown kind' });
      }
    }
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    const body = req.body || {};
    switch (body.kind) {
      case 'rules.seed':
        return res.status(200).json({ ok: true, ...(await rulesLib.seedDefaultRules()) });
      case 'rules.set':
        return res.status(200).json({ ok: true, ...(await rulesLib.setRules(body.taxYear, body.region, body.ruleSet, { notes: body.notes })) });
      case 'tax_year.open':
        return res.status(200).json({ ok: true, taxYear: await yearsLib.ensureTaxYear(body.entityId, body.taxYear, { region: body.region }) });
      case 'tax_year.lock':
        return res.status(200).json({ ok: true, ...(await yearsLib.lockTaxYear(body.entityId, body.taxYear, { actor })) });
      case 'account.taxTreatment': {
        const { entityId: eid, accountCode, taxTreatment } = body;
        if (!eid || !accountCode) return res.status(400).json({ error: 'entityId + accountCode required' });
        const { accounts } = getSchema();
        await getDb()
          .update(accounts)
          .set({ taxTreatment: taxTreatment || null, updatedAt: new Date() })
          .where(and(eq(accounts.entityId, eid), eq(accounts.code, accountCode)));
        return res.status(200).json({ ok: true });
      }
      case 'asset.create':
        return res.status(200).json({ ok: true, ...(await capLib.createAsset(body, { actor })) });
      case 'allowances.compute':
        return res.status(200).json({ ok: true, ...(await capLib.computeAllowancesForYear(body.entityId, body.taxYear, { region: body.region })) });
      case 'whatif':
        return res.status(200).json({ ok: true, ...(await sa103Lib.whatIf(body.entityId, body.taxYear, body.overrides || {}, body.options || {})) });
      default:
        return res.status(400).json({ error: 'unknown kind' });
    }
  } catch (err) {
    console.error('[admin/tax-sa]', err);
    return res.status(500).json({ error: err.message });
  }
};
