/**
 * Stage 7 slice 1 — VAT engine.
 *
 *   registerForVAT       — store registration + scheme + cash-basis flag
 *   captureLineVat       — record per-line VAT against an existing journal line
 *   computeReturn        — boxes 1..9 for a period under standard / FRS / cash
 *   submitReturn         — finalise + lock the period via stub MTD client
 *   getThresholdState    — rolling-12-month turnover vs £90k threshold
 *   listObligations      — read open obligations (synced or synth)
 *   syncObligations      — pull from MTD client (stubbed)
 *
 * All amounts are integer pence. Out-of-scope lines are simply not
 * captured.
 */

const crypto = require('crypto');
const { and, eq, gte, lte, sql, desc, inArray, isNull, lt } = require('drizzle-orm');
const { getDb, getSchema } = require('../db');
const { audit } = require('../audit-log');
const mtdClient = require('./mtd-vat-client');

function newId(prefix) {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
}

function toNum(x) {
  if (x === null || x === undefined) return 0;
  if (typeof x === 'number') return x;
  if (typeof x === 'bigint') return Number(x);
  const n = Number(x);
  return Number.isFinite(n) ? n : 0;
}

function pickRate(box, ratePct) {
  // Pence-precise VAT split: net + vat = gross, where vat = round(gross * r / (100+r))
  // and net = gross - vat. Required so the audit ties out exactly.
  return ratePct;
}

/**
 * Split a gross pence amount into { net, vat } at a given rate.
 * Used by callers that pass gross-of-VAT amounts (the typical case
 * for bank lines and receipts).
 */
function splitGrossPence(grossPence, ratePct) {
  const r = Number(ratePct);
  if (!Number.isFinite(r) || r < 0) throw new Error('vat: invalid rate');
  if (r === 0) return { netPence: grossPence, vatPence: 0 };
  const vatPence = Math.round((grossPence * r) / (100 + r));
  return { netPence: grossPence - vatPence, vatPence };
}

/**
 * Compute VAT off a NET amount (used when the source supplies net).
 */
function vatFromNetPence(netPence, ratePct) {
  const r = Number(ratePct);
  if (!Number.isFinite(r) || r < 0) throw new Error('vat: invalid rate');
  return Math.round((netPence * r) / 100);
}

// =====================================================================
// Registrations
// =====================================================================

async function registerForVAT(input, opts = {}) {
  const {
    entityId,
    vatNumber,
    scheme = 'standard',
    cashAccounting = false,
    flatRateScheme = null,
    registrationDate,
    notes,
  } = input;
  if (!entityId) throw new Error('registerForVAT: entityId required');
  if (!vatNumber) throw new Error('registerForVAT: vatNumber required');
  if (!registrationDate) throw new Error('registerForVAT: registrationDate required');
  if (!['standard', 'flat_rate', 'cash'].includes(scheme)) {
    throw new Error(`registerForVAT: invalid scheme ${scheme}`);
  }
  if (scheme === 'flat_rate') {
    if (!flatRateScheme || typeof flatRateScheme.ratePct !== 'number') {
      throw new Error('registerForVAT: flat_rate scheme requires flatRateScheme.ratePct');
    }
  }
  const db = opts.tx || getDb();
  const { vatRegistrations } = getSchema();
  const id = newId('vatreg');
  const now = new Date();
  await db.insert(vatRegistrations).values({
    id,
    entityId,
    vatNumber,
    scheme,
    cashAccounting: scheme === 'cash' ? true : !!cashAccounting,
    flatRateScheme,
    registrationDate,
    notes: notes || null,
    createdAt: now,
    updatedAt: now,
  });
  await audit(
    {
      action: 'vat.register',
      actorUserId: opts.actor?.userId || null,
      actorEmail: opts.actor?.email,
      actorRole: opts.actor?.role,
      resourceType: 'vat_registration',
      resourceId: id,
      entityId,
      after: { vatNumber, scheme, registrationDate, cashAccounting: scheme === 'cash' || !!cashAccounting },
    },
    { tx: opts.tx }
  );
  return { id };
}

async function getActiveRegistration(entityId, opts = {}) {
  const db = opts.tx || getDb();
  const { vatRegistrations } = getSchema();
  const rows = await db
    .select()
    .from(vatRegistrations)
    .where(and(eq(vatRegistrations.entityId, entityId), eq(vatRegistrations.archived, false)))
    .orderBy(desc(vatRegistrations.registrationDate))
    .limit(1);
  return rows[0] || null;
}

// =====================================================================
// Per-line VAT capture
// =====================================================================

/**
 * Persist VAT metadata for a journal line. Idempotent on
 * journalLineId — repeat calls overwrite (uniqueIndex enforces this).
 *
 * Either pass `grossPence` (we split) or `netPence` (we compute VAT)
 * or both `netPence`+`vatPence` (we trust them).
 */
async function captureLineVat(input, opts = {}) {
  const {
    journalLineId,
    entityId,
    side,
    vatRatePct,
    netPence,
    vatPence,
    grossPence,
  } = input;
  if (!journalLineId) throw new Error('captureLineVat: journalLineId required');
  if (!entityId) throw new Error('captureLineVat: entityId required');
  if (!['output', 'input', 'eu_acquisition', 'eu_dispatch'].includes(side)) {
    throw new Error(`captureLineVat: invalid side ${side}`);
  }
  let net = netPence;
  let vat = vatPence;
  if (net == null && grossPence != null) {
    const split = splitGrossPence(grossPence, vatRatePct);
    net = split.netPence;
    vat = split.vatPence;
  } else if (net != null && vat == null) {
    vat = vatFromNetPence(net, vatRatePct);
  }
  if (net == null || vat == null) {
    throw new Error('captureLineVat: provide netPence+vatPence, netPence, or grossPence');
  }
  const gross = (grossPence != null) ? grossPence : net + vat;
  const db = opts.tx || getDb();
  const { journalLineVat } = getSchema();
  // Drizzle's onConflict for our flavour: delete then insert is simplest
  // and safe under the uniqueIndex.
  await db.delete(journalLineVat).where(eq(journalLineVat.journalLineId, journalLineId));
  await db.insert(journalLineVat).values({
    journalLineId,
    entityId,
    side,
    vatRatePct: String(vatRatePct), // numeric column
    netPence: net,
    vatPence: vat,
    grossPence: gross,
  });
  return { ok: true, netPence: net, vatPence: vat, grossPence: gross };
}

// =====================================================================
// Return computation
// =====================================================================

/**
 * Empty box pack. All values pence; box5 may be negative (HMRC owes
 * the trader). We send unsigned amounts to HMRC but keep sign in our
 * row for clarity.
 */
function emptyBoxes() {
  return {
    box1_outputVatPence: 0,
    box2_acquisitionsVatPence: 0,
    box3_totalVatDuePence: 0,
    box4_inputVatPence: 0,
    box5_netVatPayablePence: 0,
    box6_totalSalesExVatPence: 0,
    box7_totalPurchasesExVatPence: 0,
    box8_totalSuppliesEuExVatPence: 0,
    box9_totalAcquisitionsEuExVatPence: 0,
  };
}

async function fetchPeriodLines({ entityId, periodStart, periodEnd, lockedFilter = 'unlocked' }, tx) {
  const db = tx || getDb();
  const { journalLineVat, journalLines, journals } = getSchema();
  const conds = [
    eq(journalLineVat.entityId, entityId),
    gte(journalLines.date, periodStart),
    lte(journalLines.date, periodEnd),
  ];
  if (lockedFilter === 'unlocked') {
    conds.push(isNull(journalLineVat.lockedByReturnId));
  }
  const rows = await db
    .select({
      id: journalLineVat.id,
      journalLineId: journalLineVat.journalLineId,
      side: journalLineVat.side,
      vatRatePct: journalLineVat.vatRatePct,
      netPence: journalLineVat.netPence,
      vatPence: journalLineVat.vatPence,
      grossPence: journalLineVat.grossPence,
      lineDate: journalLines.date,
      journalId: journalLines.journalId,
      sourceId: journals.sourceId,
      source: journals.source,
    })
    .from(journalLineVat)
    .innerJoin(journalLines, eq(journalLines.id, journalLineVat.journalLineId))
    .innerJoin(journals, eq(journals.id, journalLines.journalId))
    .where(and(...conds));
  return rows;
}

function applyStandard(boxes, lines) {
  for (const l of lines) {
    const net = toNum(l.netPence);
    const vat = toNum(l.vatPence);
    switch (l.side) {
      case 'output':
        boxes.box1_outputVatPence += vat;
        boxes.box6_totalSalesExVatPence += net;
        break;
      case 'input':
        boxes.box4_inputVatPence += vat;
        boxes.box7_totalPurchasesExVatPence += net;
        break;
      case 'eu_acquisition':
        boxes.box2_acquisitionsVatPence += vat;
        boxes.box9_totalAcquisitionsEuExVatPence += net;
        // Reverse-charge: also reclaimable in box 4 + reflected in box 7
        boxes.box4_inputVatPence += vat;
        boxes.box7_totalPurchasesExVatPence += net;
        break;
      case 'eu_dispatch':
        boxes.box8_totalSuppliesEuExVatPence += net;
        boxes.box6_totalSalesExVatPence += net;
        break;
    }
  }
}

function applyFlatRate(boxes, lines, frsRatePct) {
  // FRS: box1 = grossSales × FRS%; box4 = 0 (capital purchases ≥ £2k
  // are out of scope for slice 1); box6 = grossSales (NOT net, per
  // HMRC FRS guidance). Inputs still tracked in box7 informationally.
  let grossSales = 0;
  for (const l of lines) {
    const net = toNum(l.netPence);
    const gross = toNum(l.grossPence);
    if (l.side === 'output') {
      grossSales += gross;
    } else if (l.side === 'input') {
      boxes.box7_totalPurchasesExVatPence += net;
    } else if (l.side === 'eu_dispatch') {
      grossSales += gross;
      boxes.box8_totalSuppliesEuExVatPence += net;
    } else if (l.side === 'eu_acquisition') {
      // FRS users still account for EU reverse charge outside FRS
      const vat = toNum(l.vatPence);
      boxes.box2_acquisitionsVatPence += vat;
      boxes.box9_totalAcquisitionsEuExVatPence += net;
      boxes.box4_inputVatPence += vat;
      boxes.box7_totalPurchasesExVatPence += net;
    }
  }
  boxes.box1_outputVatPence += Math.round((grossSales * frsRatePct) / 100);
  boxes.box6_totalSalesExVatPence += grossSales;
}

async function applyCashBasis(boxes, lines, { entityId, periodStart, periodEnd }, tx) {
  // Cash basis (slice 1):
  //   - Output VAT only counted for sale journals whose `sourceId`
  //     (invoice ID) has a matching `invoice_payment` journal dated
  //     in the return period.
  //   - Input VAT counted as posted (postExpense already debits bank,
  //     so it's effectively cash-basis already).
  const db = tx || getDb();
  const { journals, journalLines } = getSchema();
  const saleSourceIds = lines
    .filter((l) => l.side === 'output' && l.source === 'invoice' && l.sourceId)
    .map((l) => l.sourceId);
  let paidIds = new Set();
  if (saleSourceIds.length > 0) {
    const paidRows = await db
      .select({ sourceId: journals.sourceId })
      .from(journals)
      .where(
        and(
          eq(journals.entityId, entityId),
          eq(journals.source, 'invoice_payment'),
          inArray(journals.sourceId, saleSourceIds),
          gte(journals.date, periodStart),
          lte(journals.date, periodEnd)
        )
      );
    paidIds = new Set(paidRows.map((r) => r.sourceId));
  }
  for (const l of lines) {
    const net = toNum(l.netPence);
    const vat = toNum(l.vatPence);
    if (l.side === 'output') {
      // Cash basis: skip output VAT until customer pays
      if (l.source !== 'invoice' || !l.sourceId || !paidIds.has(l.sourceId)) {
        continue;
      }
      boxes.box1_outputVatPence += vat;
      boxes.box6_totalSalesExVatPence += net;
    } else if (l.side === 'input') {
      boxes.box4_inputVatPence += vat;
      boxes.box7_totalPurchasesExVatPence += net;
    } else if (l.side === 'eu_acquisition') {
      boxes.box2_acquisitionsVatPence += vat;
      boxes.box9_totalAcquisitionsEuExVatPence += net;
      boxes.box4_inputVatPence += vat;
      boxes.box7_totalPurchasesExVatPence += net;
    } else if (l.side === 'eu_dispatch') {
      boxes.box8_totalSuppliesEuExVatPence += net;
      boxes.box6_totalSalesExVatPence += net;
    }
  }
}

/**
 * Compute the boxes 1–9 for a period. Pure read; does not persist or
 * lock anything. Slice-1 schemes: standard, flat_rate, cash.
 */
async function computeReturn(input, opts = {}) {
  const { entityId, periodStart, periodEnd } = input;
  if (!entityId || !periodStart || !periodEnd) {
    throw new Error('computeReturn: entityId + periodStart + periodEnd required');
  }
  const reg = await getActiveRegistration(entityId, opts);
  const scheme = input.scheme || reg?.scheme || 'standard';
  const cashBasis = input.cashBasis ?? !!reg?.cashAccounting ?? false;
  const lines = await fetchPeriodLines(
    { entityId, periodStart, periodEnd, lockedFilter: 'unlocked' },
    opts.tx
  );
  const boxes = emptyBoxes();
  if (scheme === 'flat_rate') {
    const frs = reg?.flatRateScheme || input.flatRateScheme;
    if (!frs?.ratePct) throw new Error('computeReturn: flat-rate scheme but no ratePct');
    applyFlatRate(boxes, lines, Number(frs.ratePct));
  } else if (scheme === 'cash' || cashBasis) {
    await applyCashBasis(boxes, lines, { entityId, periodStart, periodEnd }, opts.tx);
  } else {
    applyStandard(boxes, lines);
  }
  boxes.box3_totalVatDuePence =
    boxes.box1_outputVatPence + boxes.box2_acquisitionsVatPence;
  boxes.box5_netVatPayablePence =
    boxes.box3_totalVatDuePence - boxes.box4_inputVatPence;
  return {
    scheme,
    cashBasis,
    periodStart,
    periodEnd,
    boxes,
    lineCount: lines.length,
    registration: reg
      ? { id: reg.id, vatNumber: reg.vatNumber, scheme: reg.scheme }
      : null,
  };
}

// =====================================================================
// Submit + lock
// =====================================================================

async function submitReturn(input, opts = {}) {
  const {
    entityId,
    periodStart,
    periodEnd,
    periodKey,
    signedByUserId,
  } = input;
  if (!entityId || !periodStart || !periodEnd || !periodKey) {
    throw new Error('submitReturn: entityId + periodStart + periodEnd + periodKey required');
  }
  return getDb().transaction(async (tx) => {
    const reg = await getActiveRegistration(entityId, { tx });
    if (!reg) throw new Error('submitReturn: entity has no active VAT registration');
    const { vatReturns, journalLineVat, journalLines } = getSchema();
    // Reject duplicate submission for the same periodKey.
    const dupe = await tx
      .select({ id: vatReturns.id })
      .from(vatReturns)
      .where(and(eq(vatReturns.entityId, entityId), eq(vatReturns.periodKey, periodKey)))
      .limit(1);
    if (dupe[0]) {
      const err = new Error(
        `submitReturn: a return for periodKey ${periodKey} already exists (id=${dupe[0].id})`
      );
      err.code = 'VAT_RETURN_DUPLICATE';
      throw err;
    }
    const computed = await computeReturn(
      { entityId, periodStart, periodEnd, scheme: reg.scheme, cashBasis: reg.cashAccounting },
      { tx }
    );
    const receipt = await mtdClient.submitReturn({
      vrn: reg.vatNumber,
      periodKey,
      boxes: {
        box1: computed.boxes.box1_outputVatPence,
        box4: computed.boxes.box4_inputVatPence,
        box5: computed.boxes.box5_netVatPayablePence,
      },
    });
    const id = newId('vatret');
    const now = new Date();
    await tx.insert(vatReturns).values({
      id,
      entityId,
      vatRegistrationId: reg.id,
      periodKey,
      periodStart,
      periodEnd,
      schemeAtSubmit: reg.scheme,
      cashBasis: !!reg.cashAccounting,
      boxes: computed.boxes,
      status: 'submitted',
      submittedAt: now,
      hmrcReceipt: receipt,
      signedByUserId: signedByUserId || null,
      signedAt: signedByUserId ? now : null,
      createdAt: now,
      updatedAt: now,
    });
    // Lock all journal_line_vat rows whose journal line falls in the
    // period and which aren't already locked. Uses a sub-select via
    // the SQL builder so we don't fetch + iterate.
    const lineIds = await tx
      .select({ id: journalLineVat.id })
      .from(journalLineVat)
      .innerJoin(journalLines, eq(journalLines.id, journalLineVat.journalLineId))
      .where(
        and(
          eq(journalLineVat.entityId, entityId),
          isNull(journalLineVat.lockedByReturnId),
          gte(journalLines.date, periodStart),
          lte(journalLines.date, periodEnd)
        )
      );
    if (lineIds.length > 0) {
      await tx
        .update(journalLineVat)
        .set({ lockedByReturnId: id })
        .where(inArray(journalLineVat.id, lineIds.map((r) => r.id)));
    }
    // Mark the obligation as fulfilled. If no obligation row exists yet
    // (operator submitted before HMRC sync), upsert one so listObligations
    // shows it as fulfilled and a later syncObligations is a no-op.
    const { vatObligations } = getSchema();
    const dueDate = (() => {
      const d = new Date(`${periodEnd}T00:00:00Z`);
      d.setUTCMonth(d.getUTCMonth() + 1);
      d.setUTCDate(d.getUTCDate() + 7);
      return d.toISOString().slice(0, 10);
    })();
    await tx
      .insert(vatObligations)
      .values({
        id: newId('vatob'),
        entityId,
        periodKey,
        periodStart,
        periodEnd,
        dueDate,
        status: 'fulfilled',
        receivedAt: now,
        syncedAt: now,
        createdAt: now,
      })
      .onConflictDoUpdate({
        target: [vatObligations.entityId, vatObligations.periodKey],
        set: { status: 'fulfilled', receivedAt: now },
      });
    await audit(
      {
        action: 'vat.submit',
        actorUserId: opts.actor?.userId || null,
        actorEmail: opts.actor?.email,
        actorRole: opts.actor?.role,
        resourceType: 'vat_return',
        resourceId: id,
        entityId,
        after: {
          periodKey,
          periodStart,
          periodEnd,
          scheme: reg.scheme,
          cashBasis: !!reg.cashAccounting,
          box5: computed.boxes.box5_netVatPayablePence,
          formBundleNumber: receipt.formBundleNumber,
          lockedLineCount: lineIds.length,
        },
      },
      { tx }
    );
    return {
      id,
      receipt,
      boxes: computed.boxes,
      lockedLineCount: lineIds.length,
    };
  });
}

async function listReturns(entityId, opts = {}) {
  const db = opts.tx || getDb();
  const { vatReturns } = getSchema();
  return db
    .select()
    .from(vatReturns)
    .where(eq(vatReturns.entityId, entityId))
    .orderBy(desc(vatReturns.periodEnd));
}

// =====================================================================
// Threshold tracker
// =====================================================================

/**
 * Rolling-12-month gross sales (output side) ending at `asOfDate`. We
 * use journal_line_vat output rows for VAT-bearing sales and fall
 * back to summing all `invoice` source journals when no VAT data is
 * present (pre-registration usage).
 */
async function getThresholdState({ entityId, asOfDate, taxYear = 2025, region = 'rUK' }, opts = {}) {
  if (!entityId) throw new Error('getThresholdState: entityId required');
  const asOf = asOfDate || new Date().toISOString().slice(0, 10);
  // Last 12 calendar months ending at asOf — simple subtraction is
  // good enough for the rolling window:
  const asOfDt = new Date(asOf + 'T00:00:00Z');
  const fromDt = new Date(Date.UTC(
    asOfDt.getUTCFullYear() - 1,
    asOfDt.getUTCMonth(),
    asOfDt.getUTCDate()
  ));
  const fromStr = fromDt.toISOString().slice(0, 10);
  const db = opts.tx || getDb();
  const { journalLineVat, journalLines, journals } = getSchema();
  // Sum gross of output rows in the rolling window.
  const vatRows = await db
    .select({
      grossPence: journalLineVat.grossPence,
    })
    .from(journalLineVat)
    .innerJoin(journalLines, eq(journalLines.id, journalLineVat.journalLineId))
    .where(
      and(
        eq(journalLineVat.entityId, entityId),
        eq(journalLineVat.side, 'output'),
        gte(journalLines.date, fromStr),
        lte(journalLines.date, asOf)
      )
    );
  let rollingTurnoverPence = 0;
  for (const r of vatRows) rollingTurnoverPence += toNum(r.grossPence);
  // If no VAT rows captured (entity not yet tracking), fall back to
  // summing invoice journals — this is what the threshold widget
  // shows pre-registration.
  if (vatRows.length === 0) {
    const fallback = await db
      .select({
        creditPence: journalLines.creditPence,
      })
      .from(journalLines)
      .innerJoin(journals, eq(journals.id, journalLines.journalId))
      .where(
        and(
          eq(journalLines.entityId, entityId),
          eq(journals.source, 'invoice'),
          gte(journalLines.date, fromStr),
          lte(journalLines.date, asOf)
        )
      );
    for (const r of fallback) rollingTurnoverPence += toNum(r.creditPence);
  }
  const { getRules } = require('./rules');
  const rules = await getRules(taxYear, region, opts);
  const threshold = rules.vatRegistrationThresholdPence;
  const dereg = rules.vatDeregistrationThresholdPence;
  const pct = threshold > 0 ? (rollingTurnoverPence * 100) / threshold : 0;
  let status = 'ok';
  if (rollingTurnoverPence >= threshold) status = 'over';
  else if (pct >= 90) status = 'mustRegister';
  else if (pct >= 80) status = 'warn';
  return {
    asOfDate: asOf,
    windowStart: fromStr,
    rollingTurnoverPence,
    thresholdPence: threshold,
    deregistrationThresholdPence: dereg,
    pctOfThreshold: Math.round(pct * 100) / 100,
    status,
  };
}

// =====================================================================
// Obligations (HMRC sync)
// =====================================================================

async function syncObligations({ entityId, from }, opts = {}) {
  if (!entityId) throw new Error('syncObligations: entityId required');
  const reg = await getActiveRegistration(entityId, opts);
  if (!reg) throw new Error('syncObligations: entity has no active VAT registration');
  const fromDate = from || reg.registrationDate;
  const obligations = mtdClient.listObligations({ from: fromDate, count: 4 });
  const db = opts.tx || getDb();
  const { vatObligations } = getSchema();
  let inserted = 0;
  for (const o of obligations) {
    const exists = await db
      .select({ id: vatObligations.id })
      .from(vatObligations)
      .where(and(eq(vatObligations.entityId, entityId), eq(vatObligations.periodKey, o.periodKey)))
      .limit(1);
    if (exists[0]) continue;
    await db.insert(vatObligations).values({
      id: newId('vatob'),
      entityId,
      periodKey: o.periodKey,
      periodStart: o.periodStart,
      periodEnd: o.periodEnd,
      dueDate: o.dueDate,
      status: 'open',
      syncedAt: new Date(),
      createdAt: new Date(),
    });
    inserted++;
  }
  return { obligations, inserted };
}

async function listObligations(entityId, opts = {}) {
  const db = opts.tx || getDb();
  const { vatObligations } = getSchema();
  return db
    .select()
    .from(vatObligations)
    .where(eq(vatObligations.entityId, entityId))
    .orderBy(vatObligations.dueDate);
}

module.exports = {
  // money
  splitGrossPence,
  vatFromNetPence,
  // registration
  registerForVAT,
  getActiveRegistration,
  // capture
  captureLineVat,
  // returns
  computeReturn,
  submitReturn,
  listReturns,
  // threshold
  getThresholdState,
  // obligations
  syncObligations,
  listObligations,
};
