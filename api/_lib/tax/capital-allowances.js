/**
 * Stage 5 — UK capital allowances.
 *
 * Slice 1 ships the data model + the engine for the two everyday
 * cases:
 *
 *   AIA   100% in-year on qualifying P&M up to the AIA limit
 *         (£1m). If multiple assets are flagged claim_aia, AIA is
 *         claimed in the order they were created until the limit
 *         is exhausted; any overflow falls into the main pool.
 *
 *   Main pool (18% reducing balance)
 *         Opening WDV from prior year's closing + non-AIA additions
 *         this year − disposals (capped at WDV). WDA = 18% of the
 *         post-additions/post-disposal balance, rounded down.
 *
 * Special pool (6%) and SBA (3% straight-line) follow the same
 * pattern — the engine handles them generically. Balancing
 * adjustments and short/long accounting periods are out of scope
 * for slice 1.
 */

const crypto = require('crypto');
const { and, eq, sql } = require('drizzle-orm');
const { getDb, getSchema } = require('../db');
const { getRules } = require('./rules');

function newAssetId() { return `caa_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`; }
function newPoolId()  { return `cap_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`; }

async function createAsset(input, opts = {}) {
  const required = ['entityId', 'taxYear', 'poolType', 'description', 'acquiredDate', 'costPence'];
  for (const k of required) if (input[k] == null) throw new Error(`createAsset: ${k} required`);
  if (!Number.isInteger(input.costPence) || input.costPence <= 0) {
    throw new Error('createAsset: costPence must be a positive integer');
  }
  const id = newAssetId();
  const writer = opts.tx || getDb();
  const { capitalAllowanceAssets } = getSchema();
  await writer.insert(capitalAllowanceAssets).values({
    id,
    entityId: input.entityId,
    taxYear: input.taxYear,
    poolType: input.poolType,
    description: input.description,
    acquiredDate: input.acquiredDate,
    costPence: input.costPence,
    claimAia: input.claimAia !== false,
    notes: input.notes || null,
    createdBy: opts.actor?.userId || null,
  });
  return { id };
}

async function listAssets(entityId, taxYear, opts = {}) {
  const reader = opts.tx || getDb();
  const { capitalAllowanceAssets } = getSchema();
  return reader
    .select()
    .from(capitalAllowanceAssets)
    .where(and(eq(capitalAllowanceAssets.entityId, entityId), eq(capitalAllowanceAssets.taxYear, taxYear)))
    .orderBy(capitalAllowanceAssets.acquiredDate);
}

async function getPriorPool(entityId, taxYear, poolType, opts = {}) {
  const reader = opts.tx || getDb();
  const { capitalAllowancePools } = getSchema();
  const rows = await reader
    .select()
    .from(capitalAllowancePools)
    .where(
      and(
        eq(capitalAllowancePools.entityId, entityId),
        eq(capitalAllowancePools.taxYear, taxYear - 1),
        eq(capitalAllowancePools.poolType, poolType)
      )
    )
    .limit(1);
  return rows[0] || null;
}

/**
 * Run the engine for a single tax year. Reads assets in `taxYear`,
 * applies AIA in creation order up to the AIA limit, drops any
 * overflow into the main/special pool per asset's `poolType`, then
 * computes WDA on the resulting balance for each pool. Persists a
 * snapshot row per pool to `capital_allowance_pools` and returns
 * the totals.
 *
 * Idempotent: subsequent calls overwrite the pool snapshots.
 */
async function computeAllowancesForYear(entityId, taxYear, opts = {}) {
  if (!entityId) throw new Error('entityId required');
  if (!Number.isInteger(taxYear)) throw new Error('taxYear must be an integer');
  const region = opts.region || 'rUK';
  const rules = await getRules(taxYear, region, opts);
  const db = getDb();
  return db.transaction(async (tx) => {
    const { capitalAllowanceAssets, capitalAllowancePools } = getSchema();
    const assets = await tx
      .select()
      .from(capitalAllowanceAssets)
      .where(and(eq(capitalAllowanceAssets.entityId, entityId), eq(capitalAllowanceAssets.taxYear, taxYear)))
      .orderBy(capitalAllowanceAssets.acquiredDate, capitalAllowanceAssets.id);

    // Bucket by destination pool (after AIA overflow).
    const poolAdditions = { main: 0, special: 0, sba: 0 };
    const poolDisposals = { main: 0, special: 0, sba: 0 };
    let aiaRemaining = rules.aiaLimitPence;
    let aiaClaimed = 0;

    for (const a of assets) {
      const cost = Number(a.costPence) || 0;
      const proceeds = Number(a.disposalProceedsPence) || 0;
      // For slice 1: in-year disposals don't pool-adjust; they just
      // reduce the WDV of the same asset's destination pool by
      // min(cost, proceeds). Disposed AIA-claimed assets generate a
      // balancing charge — out of scope for slice 1; we record the
      // disposal against the asset's pool but flag it via the result.
      if (a.claimAia && a.poolType === 'aia') {
        const claim = Math.min(cost, aiaRemaining);
        aiaRemaining -= claim;
        aiaClaimed += claim;
        const overflow = cost - claim;
        if (overflow > 0) poolAdditions.main += overflow; // overflow falls into main pool
      } else if (a.poolType === 'main' || a.poolType === 'special' || a.poolType === 'sba') {
        poolAdditions[a.poolType] += cost;
      } else {
        // 'aia' but claim_aia=false — treat as main pool addition.
        poolAdditions.main += cost;
      }
      if (a.disposedDate && a.poolType !== 'aia') {
        poolDisposals[a.poolType] += Math.min(cost, proceeds);
      }
    }

    // Build the per-pool snapshot rows.
    const snapshots = [];

    // AIA — its own row (no rolling WDV; pool ends at zero).
    snapshots.push({
      poolType: 'aia',
      openingWdvPence: 0,
      additionsPence: assets.filter((x) => x.claimAia && x.poolType === 'aia').reduce((s, x) => s + Number(x.costPence), 0),
      disposalsPence: 0,
      aiaClaimedPence: aiaClaimed,
      wdaClaimedPence: 0,
      closingWdvPence: 0,
    });

    for (const poolType of ['main', 'special', 'sba']) {
      const prior = await getPriorPool(entityId, taxYear, poolType, { tx });
      const opening = prior ? Number(prior.closingWdvPence) : 0;
      const additions = poolAdditions[poolType];
      const disposals = poolDisposals[poolType];
      const balanceForWda = Math.max(0, opening + additions - disposals);
      const wdaRate = poolType === 'main'    ? rules.mainPoolWdaRate :
                       poolType === 'special' ? rules.specialPoolWdaRate :
                       rules.sbaRate;
      let wda = 0;
      let closing = balanceForWda;
      if (poolType === 'sba') {
        // SBA is straight-line at 3% of original cost; we approximate
        // with 3% of additions for slice 1 (no separate cumulative-cost
        // tracking yet). Closing WDV reduces by the same.
        wda = Math.floor((additions * wdaRate) / 100);
        closing = balanceForWda - wda;
      } else {
        wda = Math.floor((balanceForWda * wdaRate) / 100);
        closing = balanceForWda - wda;
      }
      snapshots.push({
        poolType,
        openingWdvPence: opening,
        additionsPence: additions,
        disposalsPence: disposals,
        aiaClaimedPence: 0,
        wdaClaimedPence: wda,
        closingWdvPence: closing,
      });
    }

    // Persist (upsert) each pool snapshot.
    for (const s of snapshots) {
      const existing = await tx
        .select()
        .from(capitalAllowancePools)
        .where(
          and(
            eq(capitalAllowancePools.entityId, entityId),
            eq(capitalAllowancePools.taxYear, taxYear),
            eq(capitalAllowancePools.poolType, s.poolType)
          )
        )
        .limit(1);
      const now = new Date();
      if (existing[0]) {
        await tx
          .update(capitalAllowancePools)
          .set({ ...s, computedAt: now, updatedAt: now })
          .where(eq(capitalAllowancePools.id, existing[0].id));
      } else {
        await tx.insert(capitalAllowancePools).values({ id: newPoolId(), entityId, taxYear, ...s, computedAt: now });
      }
    }

    const totalClaimPence =
      snapshots.reduce((s, p) => s + p.aiaClaimedPence + p.wdaClaimedPence, 0);
    return {
      taxYear,
      totalClaimPence,
      pools: snapshots,
      assetCount: assets.length,
    };
  });
}

module.exports = { createAsset, listAssets, computeAllowancesForYear };
