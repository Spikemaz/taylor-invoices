/**
 * Stage 4 — HMRC AMAP mileage engine.
 *
 * Approved Mileage Allowance Payments — the rates a self-employed
 * person or Ltd-Co director can claim per business mile when using
 * their personal vehicle. Current rates (FY2025+):
 *
 *   Cars/vans   45p/mile for the first 10,000 business miles in the
 *               tax year, 25p/mile thereafter (the "taper").
 *   Motorbikes  24p/mile flat.
 *   Bicycles    20p/mile flat.
 *
 * The taper is applied YTD against the entity's total `mileage_logs`
 * for the same tax year (UK tax year = 6 Apr → 5 Apr).
 *
 * Posting (slice 1): the journal goes
 *   DR  7200 Motor Expenses
 *   CR  2500 Director's Loan       (limited / partnership)
 *   CR  3100 Drawings              (sole trader)
 *
 * The CR side reflects "the business owes the driver these miles".
 * If the entity later reimburses from the bank account, that's a
 * separate Stage 4-future journal (DR 2500/3100, CR 0800).
 */

const crypto = require('crypto');
const { and, eq, sql } = require('drizzle-orm');
const { getDb, getSchema } = require('../db');
const { getAccountByCode } = require('../ledger/accounts');
const { postJournal } = require('../ledger/posting');
const { audit } = require('../audit-log');

// =====================================================================
// Rate table
// =====================================================================

const AMAP_RATES = {
  car: {
    fullRate: 45,        // pence per mile
    taperRate: 25,
    fullThresholdMiles: 10000, // miles per UK tax year
  },
  motorbike: { flatRate: 24 },
  bike: { flatRate: 20 },
};

const TAPER_THRESHOLD_X100 = AMAP_RATES.car.fullThresholdMiles * 100;

// =====================================================================
// Tax-year helpers
// =====================================================================

/**
 * UK tax year: 6 April → 5 April. The "tax year 2025" runs from
 * 2025-04-06 → 2026-04-05. `dateString` is an ISO date (YYYY-MM-DD).
 */
function taxYearFor(dateString) {
  if (!dateString) throw new Error('taxYearFor: dateString required');
  const [yStr, mStr, dStr] = dateString.split('-');
  const y = Number(yStr);
  const m = Number(mStr);
  const d = Number(dStr);
  if (!y || !m || !d) throw new Error(`taxYearFor: invalid date ${dateString}`);
  if (m > 4 || (m === 4 && d >= 6)) return y;
  return y - 1;
}

function newMileageId() {
  return `mil_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
}

// =====================================================================
// AMAP computation
// =====================================================================

/**
 * Compute the AMAP claim for a single journey, given the YTD miles
 * already logged (in hundredths of a mile) for the SAME tax year +
 * vehicle type. Returns the breakdown so the caller can persist it
 * for audit (full-rate portion, taper-rate portion, total amount).
 *
 *   distanceMilesX100        — this journey, in hundredths of a mile
 *   priorYtdMilesX100        — already-logged miles this tax year
 *   vehicleType              — 'car' | 'motorbike' | 'bike'
 */
function computeAmap(distanceMilesX100, priorYtdMilesX100, vehicleType) {
  if (!Number.isInteger(distanceMilesX100) || distanceMilesX100 <= 0) {
    throw new Error('computeAmap: distanceMilesX100 must be a positive integer');
  }
  if (!Number.isInteger(priorYtdMilesX100) || priorYtdMilesX100 < 0) {
    throw new Error('computeAmap: priorYtdMilesX100 must be a non-negative integer');
  }
  if (vehicleType === 'motorbike') {
    const rate = AMAP_RATES.motorbike.flatRate;
    return {
      vehicleType,
      ratePencePerMile: rate,
      portionAtFullRateMilesX100: distanceMilesX100,
      portionAtTaperRateMilesX100: 0,
      fullRatePencePerMile: rate,
      taperRatePencePerMile: null,
      // Round half-away-from-zero on the *fractional* pence to be safe.
      amountPence: Math.round((distanceMilesX100 * rate) / 100),
    };
  }
  if (vehicleType === 'bike') {
    const rate = AMAP_RATES.bike.flatRate;
    return {
      vehicleType,
      ratePencePerMile: rate,
      portionAtFullRateMilesX100: distanceMilesX100,
      portionAtTaperRateMilesX100: 0,
      fullRatePencePerMile: rate,
      taperRatePencePerMile: null,
      amountPence: Math.round((distanceMilesX100 * rate) / 100),
    };
  }
  if (vehicleType !== 'car') {
    throw new Error(`computeAmap: unknown vehicleType ${vehicleType}`);
  }
  // Car: split the journey across the 10 000-mile taper.
  const remainingFull = Math.max(0, TAPER_THRESHOLD_X100 - priorYtdMilesX100);
  const fullPortion = Math.min(distanceMilesX100, remainingFull);
  const taperPortion = distanceMilesX100 - fullPortion;
  const fullRate = AMAP_RATES.car.fullRate;
  const taperRate = AMAP_RATES.car.taperRate;
  const fullPence = Math.round((fullPortion * fullRate) / 100);
  const taperPence = Math.round((taperPortion * taperRate) / 100);
  return {
    vehicleType,
    // For pure-full-rate journeys we surface the 45p as the headline rate.
    // Mixed journeys default to 45 for the headline (the taper is also
    // captured in the *_taper_* columns for full audit).
    ratePencePerMile: taperPortion > 0 && fullPortion === 0 ? taperRate : fullRate,
    portionAtFullRateMilesX100: fullPortion,
    portionAtTaperRateMilesX100: taperPortion,
    fullRatePencePerMile: fullRate,
    taperRatePencePerMile: taperRate,
    amountPence: fullPence + taperPence,
  };
}

// =====================================================================
// YTD lookup
// =====================================================================

async function priorYtdMilesX100(entityId, taxYear, vehicleType, opts = {}) {
  const db = opts.tx || getDb();
  const { mileageLogs } = getSchema();
  const rows = await db
    .select({
      total: sql`COALESCE(SUM(${mileageLogs.distanceMilesX100}), 0)`.mapWith(Number),
    })
    .from(mileageLogs)
    .where(
      and(
        eq(mileageLogs.entityId, entityId),
        eq(mileageLogs.taxYear, taxYear),
        eq(mileageLogs.vehicleType, vehicleType)
      )
    );
  return rows[0]?.total || 0;
}

// =====================================================================
// Public API
// =====================================================================

/**
 * Pre-compute (no write) what THIS journey would claim. Used by the
 * (future) "preview before save" UI and by the smoke test.
 */
async function previewMileage(input, opts = {}) {
  const { entityId, journeyDate, distanceMilesX100, vehicleType } = input;
  if (!entityId) throw new Error('entityId required');
  if (!journeyDate) throw new Error('journeyDate required');
  if (!vehicleType) throw new Error('vehicleType required');
  const taxYear = taxYearFor(journeyDate);
  const ytd = await priorYtdMilesX100(entityId, taxYear, vehicleType, opts);
  const amap = computeAmap(distanceMilesX100, ytd, vehicleType);
  return { taxYear, priorYtdMilesX100: ytd, ...amap };
}

/**
 * Resolve which credit-side account to use for the "business owes
 * driver" leg, based on the entity type.
 */
async function ownerLiabilityAccount(entityId, tx) {
  const db = tx || getDb();
  const { entities } = getSchema();
  const rows = await db
    .select({ type: entities.type })
    .from(entities)
    .where(eq(entities.id, entityId))
    .limit(1);
  if (!rows[0]) throw new Error(`entity ${entityId} not found`);
  // Ltd / partnership / other → director's loan account (2500).
  // Sole trader → drawings (3100).
  if (rows[0].type === 'sole_trader') {
    return getAccountByCode(entityId, '3100', { tx });
  }
  return getAccountByCode(entityId, '2500', { tx });
}

/**
 * Persist a mileage log AND post the corresponding journal in one
 * transaction. Auto-computes the AMAP breakdown using YTD-to-date.
 */
async function createMileageLog(input, opts = {}) {
  const required = ['entityId', 'journeyDate', 'fromAddress', 'toAddress', 'distanceMilesX100', 'vehicleType'];
  for (const k of required) if (!input[k]) throw new Error(`createMileageLog: ${k} required`);
  const journeyType = input.journeyType || 'business';
  if (journeyType !== 'business') {
    throw new Error('createMileageLog: only business journeys are claimable (Stage 4 slice 1)');
  }
  const db = getDb();
  return db.transaction(async (tx) => {
    const taxYear = taxYearFor(input.journeyDate);
    const ytd = await priorYtdMilesX100(input.entityId, taxYear, input.vehicleType, { tx });
    const amap = computeAmap(input.distanceMilesX100, ytd, input.vehicleType);
    if (amap.amountPence <= 0) {
      throw new Error('createMileageLog: AMAP amount resolved to 0 or negative');
    }
    const motor = await getAccountByCode(input.entityId, '7200', { tx });
    const liability = await ownerLiabilityAccount(input.entityId, tx);
    const id = newMileageId();
    const journey = `${input.fromAddress} → ${input.toAddress}`;
    const description = `Mileage ${(input.distanceMilesX100 / 100).toFixed(2)} mi (${input.vehicleType}) — ${journey}`;
    const j = await postJournal(
      {
        entityId: input.entityId,
        date: input.journeyDate,
        description,
        source: 'expense',
        sourceType: 'mileage',
        sourceId: id,
        currency: 'GBP',
        createdBy: opts.actor?.userId || null,
        lines: [
          { accountId: motor.id,     debit: amap.amountPence, credit: 0,                memo: journey },
          { accountId: liability.id, debit: 0,                credit: amap.amountPence, memo: 'AMAP — owed to driver' },
        ],
      },
      { tx, actor: opts.actor }
    );
    const { mileageLogs } = getSchema();
    await tx.insert(mileageLogs).values({
      id,
      entityId: input.entityId,
      journeyDate: input.journeyDate,
      taxYear,
      fromAddress: input.fromAddress,
      toAddress: input.toAddress,
      distanceMilesX100: input.distanceMilesX100,
      vehicleType: input.vehicleType,
      journeyType,
      ratePencePerMile: amap.ratePencePerMile,
      portionAtFullRateMilesX100: amap.portionAtFullRateMilesX100,
      portionAtTaperRateMilesX100: amap.portionAtTaperRateMilesX100,
      fullRatePencePerMile: amap.fullRatePencePerMile,
      taperRatePencePerMile: amap.taperRatePencePerMile,
      amountPence: amap.amountPence,
      notes: input.notes || null,
      postedJournalId: j.id,
      createdBy: opts.actor?.userId || null,
    });
    await audit(
      {
        action: 'mileage.create',
        actorUserId: opts.actor?.userId || null,
        actorEmail: opts.actor?.email,
        actorRole: opts.actor?.role,
        resourceType: 'mileage_log',
        resourceId: id,
        entityId: input.entityId,
        after: {
          journeyDate: input.journeyDate,
          taxYear,
          distanceMilesX100: input.distanceMilesX100,
          vehicleType: input.vehicleType,
          amountPence: amap.amountPence,
        },
      },
      { tx }
    );
    return { id, journalId: j.id, taxYear, ...amap };
  });
}

async function listMileageLogs(args, opts = {}) {
  const { entityId, taxYear, limit = 200, offset = 0 } = args;
  if (!entityId) throw new Error('entityId required');
  const db = opts.tx || getDb();
  const { mileageLogs } = getSchema();
  const where = taxYear
    ? and(eq(mileageLogs.entityId, entityId), eq(mileageLogs.taxYear, taxYear))
    : eq(mileageLogs.entityId, entityId);
  return db
    .select()
    .from(mileageLogs)
    .where(where)
    .orderBy(sql`${mileageLogs.journeyDate} DESC`)
    .limit(limit)
    .offset(offset);
}

async function ytdMileageSummary(entityId, taxYear, opts = {}) {
  if (!entityId) throw new Error('entityId required');
  if (!taxYear) throw new Error('taxYear required');
  const db = opts.tx || getDb();
  const { mileageLogs } = getSchema();
  const rows = await db
    .select({
      vehicleType: mileageLogs.vehicleType,
      milesX100: sql`COALESCE(SUM(${mileageLogs.distanceMilesX100}), 0)`.mapWith(Number),
      amountPence: sql`COALESCE(SUM(${mileageLogs.amountPence}), 0)`.mapWith(Number),
      journeys: sql`COUNT(*)`.mapWith(Number),
    })
    .from(mileageLogs)
    .where(and(eq(mileageLogs.entityId, entityId), eq(mileageLogs.taxYear, taxYear)))
    .groupBy(mileageLogs.vehicleType);
  return {
    taxYear,
    byVehicle: rows,
    totalAmountPence: rows.reduce((s, r) => s + Number(r.amountPence), 0),
    totalMilesX100: rows.reduce((s, r) => s + Number(r.milesX100), 0),
  };
}

module.exports = {
  AMAP_RATES,
  taxYearFor,
  computeAmap,
  priorYtdMilesX100,
  previewMileage,
  createMileageLog,
  listMileageLogs,
  ytdMileageSummary,
};
