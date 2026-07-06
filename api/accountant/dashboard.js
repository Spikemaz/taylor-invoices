/**
 * GET /api/accountant/dashboard — IAccountant read-model reporting.
 *
 * Read-only. Reports whatever is currently in the Postgres read-model
 * (rebuilt by POST /api/accountant/refresh). For the current UK tax year
 * it returns, per entity:
 *   - profit & loss, balance sheet, trial balance
 *   - a tax estimate: income tax + NI for sole traders; corporation tax
 *     for limited companies
 *   - journal count + last-activity timestamp (a lightweight "last sync")
 *
 * Tenant isolation: entity ids are always resolved from the session, never
 * accepted from the client. Behind IACCOUNTANT_ENABLED.
 */

const { applyCors, requireSession } = require('../_lib/auth');
const { isAccountantEnabled, getDb, getSchema } = require('../_lib/db');
const { ensureAccountantUserAndEntities } = require('../_lib/accountants/provision');
const { profitAndLoss, balanceSheet, trialBalance } = require('../_lib/ledger/reports');
const { getRules } = require('../_lib/tax/rules');
const { taxYearFor, taxYearRange } = require('../_lib/tax/years');
const {
  computePersonalAllowance,
  computeIncomeTax,
  computeNI,
} = require('../_lib/tax/income-tax');
const { computeCT } = require('../_lib/tax/corporation-tax');
const { inArray, sql } = require('drizzle-orm');

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Income tax + NI for a sole trader, estimated from trading profit alone.
 * Phase 1 has no other income sources, so the personal-allowance taper and
 * band thresholds are applied to trading profit only — flagged in
 * `assumptions` so the UI can be honest about it.
 */
function estimateSoleTrader(netProfitPence, rules) {
  const profit = Math.max(0, netProfitPence);
  const personalAllowancePence = computePersonalAllowance(profit, rules);
  const taxablePence = Math.max(0, profit - personalAllowancePence);
  const it = computeIncomeTax(taxablePence, rules);
  const ni = computeNI(profit, rules);
  return {
    kind: 'sole_trader',
    profitPence: netProfitPence,
    personalAllowancePence,
    taxablePence,
    incomeTaxPence: it.taxPence,
    incomeTaxBreakdown: it.breakdown,
    niPence: ni.totalPence,
    niBreakdown: ni,
    totalTaxPence: it.taxPence + ni.totalPence,
    assumptions: [
      'Estimate based on trading profit only (no other income).',
      'No payments on account or prior-year adjustments included.',
    ],
  };
}

function estimateLimited(netProfitPence, rules) {
  const ct = computeCT(netProfitPence, 12, rules);
  return {
    kind: 'limited',
    profitPence: netProfitPence,
    corporationTaxPence: ct.ctPence,
    effectiveRatePct: ct.effectiveRatePct,
    breakdown: ct.breakdown,
    totalTaxPence: ct.ctPence,
    assumptions: [
      'Estimate based on a 12-month accounting period.',
      'No salary, dividends, or capital allowances applied yet.',
    ],
  };
}

module.exports = async (req, res) => {
  applyCors(req, res, 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  if (!isAccountantEnabled()) return res.status(404).json({ error: 'Not found' });

  const session = await requireSession(req, res);
  if (!session) return;

  try {
    // Provision (idempotent) so entities + charts of accounts always exist,
    // even if the user has never run a refresh.
    const prov = await ensureAccountantUserAndEntities(session);

    const region = 'rUK';
    const taxYear = taxYearFor(todayISO());
    const { startDate, endDate } = taxYearRange(taxYear);
    const rules = await getRules(taxYear, region);

    // Lightweight "last sync": journal count + most recent journal per entity.
    const db = getDb();
    const { journals } = getSchema();
    const entityIds = prov.entities.map((e) => e.id);
    const activityRows = entityIds.length
      ? await db
          .select({
            entityId: journals.entityId,
            count: sql`count(*)::int`,
            last: sql`max(${journals.createdAt})`,
          })
          .from(journals)
          .where(inArray(journals.entityId, entityIds))
          .groupBy(journals.entityId)
      : [];
    const activity = {};
    for (const r of activityRows) {
      activity[r.entityId] = {
        journalCount: Number(r.count) || 0,
        lastActivityAt: r.last ? new Date(r.last).toISOString() : null,
      };
    }

    const entities = [];
    for (const ent of prov.entities) {
      const [pl, bs, tb] = await Promise.all([
        profitAndLoss(ent.id, { from: startDate, to: endDate }),
        balanceSheet(ent.id, endDate),
        trialBalance(ent.id, endDate),
      ]);
      const taxEstimate =
        ent.type === 'limited'
          ? estimateLimited(pl.netProfitPence, rules)
          : estimateSoleTrader(pl.netProfitPence, rules);
      entities.push({
        id: ent.id,
        type: ent.type,
        name: ent.name,
        journalCount: activity[ent.id]?.journalCount || 0,
        lastActivityAt: activity[ent.id]?.lastActivityAt || null,
        profitAndLoss: pl,
        balanceSheet: bs,
        trialBalance: tb,
        taxEstimate,
      });
    }

    return res.status(200).json({
      ok: true,
      userId: session.userId,
      region,
      taxYear,
      period: { from: startDate, to: endDate },
      generatedAt: new Date().toISOString(),
      entities,
    });
  } catch (err) {
    console.error('[accountant/dashboard] error:', err);
    if (!res.headersSent) {
      return res
        .status(500)
        .json({ error: 'Dashboard failed', detail: String(err.message || err) });
    }
  }
};
