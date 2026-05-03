/**
 * Stage 6 — UK PAYE payroll engine (single-director Ltd Co).
 *
 * Slice 1 ships:
 *   - employee CRUD (slim — just enough to drive a payroll run)
 *   - per-period PAYE / employee NI / employer NI computation using
 *     the current FY24/25 rates (8% / 2% Class 1 primary, 13.8%
 *     secondary, £12,570 / £50,270 / £9,100 thresholds)
 *   - cumulative PAYE method using a standard tax code
 *     (e.g. '1257L' → £12,570 free pay, spread evenly across the year)
 *   - posts the payroll journal: DR Director's Salary + Employer's NI
 *     CR PAYE/NI Liability + Bank
 *   - emits an FPS-shaped JSON payload (RTI submission is out of scope
 *     for slice 1 — Stage 7 / MTD adds the live HMRC POST)
 *
 * The engine is single-director only: NI categories above 'A' (married
 * women, deferred, apprentices), week-1/month-1 codes, K codes, and
 * student-loan deductions are deferred to slice 2.
 */

const crypto = require('crypto');
const { and, asc, eq, sql } = require('drizzle-orm');
const { getDb, getSchema } = require('../db');
const { getRules } = require('./rules');
const { taxYearFor } = require('./years');
const { getAccountByCode } = require('../ledger/accounts');
const { postJournal } = require('../ledger/posting');

function newEmpId() { return `emp_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`; }
function newRunId() { return `pay_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`; }

const PERIODS_PER_YEAR = { monthly: 12, fortnightly: 26, weekly: 52, four_weekly: 13 };

/**
 * Parse a UK PAYE tax code into an annual personal-allowance amount
 * in pence. Slice 1 supports the standard 'NNNNL' shape only; codes
 * starting 'K' (negative allowance) or with M1/W1 suffixes throw.
 */
function paFromTaxCode(taxCode) {
  if (!taxCode) throw new Error('paFromTaxCode: taxCode required');
  const upper = taxCode.toUpperCase().trim();
  if (upper.endsWith('M1') || upper.endsWith('W1') || upper.endsWith(' X')) {
    throw new Error(`paFromTaxCode: week-1/month-1 codes not supported in slice 1 (${taxCode})`);
  }
  if (upper.startsWith('K')) {
    throw new Error(`paFromTaxCode: K codes not supported in slice 1 (${taxCode})`);
  }
  if (upper === 'BR')   return 0;
  if (upper === 'D0')   return 0;
  if (upper === 'D1')   return 0;
  if (upper === 'NT')   return Number.MAX_SAFE_INTEGER;
  // Standard 'NNNNL' or 'NNNN[LMNT]' — the digits encode allowance / 10.
  const match = upper.match(/^(\d{1,5})[A-Z]?$/);
  if (!match) throw new Error(`paFromTaxCode: cannot parse ${taxCode}`);
  return Number(match[1]) * 10 * 100; // pounds × 100 = pence
}

// =====================================================================
// CRUD
// =====================================================================

async function createEmployee(input, opts = {}) {
  const required = ['entityId', 'name', 'startDate'];
  for (const k of required) if (input[k] == null) throw new Error(`createEmployee: ${k} required`);
  const id = newEmpId();
  const writer = opts.tx || getDb();
  const { payrollEmployees } = getSchema();
  await writer.insert(payrollEmployees).values({
    id,
    entityId: input.entityId,
    name: input.name,
    niNumber: input.niNumber || null,
    taxCode: input.taxCode || '1257L',
    payFrequency: input.payFrequency || 'monthly',
    annualSalaryPence: input.annualSalaryPence || 0,
    isDirector: input.isDirector === true,
    startDate: input.startDate,
  });
  return { id };
}

async function listEmployees(entityId, opts = {}) {
  const reader = opts.tx || getDb();
  const { payrollEmployees } = getSchema();
  return reader
    .select()
    .from(payrollEmployees)
    .where(and(eq(payrollEmployees.entityId, entityId), eq(payrollEmployees.archived, false)));
}

async function getEmployee(employeeId, opts = {}) {
  const reader = opts.tx || getDb();
  const { payrollEmployees } = getSchema();
  const rows = await reader.select().from(payrollEmployees).where(eq(payrollEmployees.id, employeeId)).limit(1);
  if (!rows[0]) throw new Error('employee not found');
  return rows[0];
}

// =====================================================================
// Per-period calculators (pure)
// =====================================================================

/**
 * Cumulative PAYE for one period.
 *
 *   ytdPaye_target = tax(ytdGross − YTD_freePay) using rules.incomeTaxBands
 *   thisPeriodPaye = ytdPaye_target − ytdPayePriorPeriods
 *
 * Free pay accumulates linearly across the year in proportion to
 * `periodNumber / periodsPerYear`. PAYE never goes negative — if the
 * target falls below what's already been deducted (e.g. salary cut),
 * the period's PAYE is clamped to 0; the surplus carries forward
 * implicitly via the next period's YTD comparison.
 */
function computePeriodPAYE({
  ytdGrossPence,
  ytdPayePriorPence,
  taxCode,
  periodNumber,
  periodsPerYear,
  rules,
}) {
  const annualPA = paFromTaxCode(taxCode);
  const periodsCovered = Math.max(1, Math.min(periodsPerYear, periodNumber));
  // Free pay to-date: spread the PA evenly across the year, rounded
  // up to the nearest pence in the worker's favour.
  const ytdFreePayPence = Math.ceil((annualPA * periodsCovered) / periodsPerYear);
  const taxableYtdPence = Math.max(0, ytdGrossPence - ytdFreePayPence);
  // Walk the bands (cumulative thresholds in TAXABLE-income space).
  const bands = [...rules.incomeTaxBands].sort((a, b) => a.thresholdPence - b.thresholdPence);
  let totalTax = 0;
  for (let i = 0; i < bands.length; i += 1) {
    const lo = bands[i].thresholdPence;
    const hi = i + 1 < bands.length ? bands[i + 1].thresholdPence : Infinity;
    if (taxableYtdPence <= lo) break;
    const portion = Math.min(taxableYtdPence, hi) - lo;
    if (portion <= 0) continue;
    totalTax += Math.round((portion * bands[i].rate) / 100);
  }
  const ytdPayeTarget = totalTax;
  const periodPaye = Math.max(0, ytdPayeTarget - ytdPayePriorPence);
  return { periodPayePence: periodPaye, ytdPayeTargetPence: ytdPayeTarget };
}

/**
 * Per-period employee NI (Class 1 primary). Non-cumulative —
 * each period stands on its own. Thresholds in the rules are
 * annual; we prorate by `periodsPerYear`.
 */
function computeEmployeeNI({ grossPence, periodsPerYear, rules }) {
  const pt = Math.floor(rules.niEePrimaryThresholdPence / periodsPerYear);
  const uel = Math.floor(rules.niEeUelPence / periodsPerYear);
  if (grossPence <= pt) return { eeNiPence: 0 };
  const mainPortion = Math.min(grossPence, uel) - pt;
  const upperPortion = Math.max(0, grossPence - uel);
  const main = Math.round((mainPortion * rules.niEeMainRate) / 100);
  const upper = Math.round((upperPortion * rules.niEeUpperRate) / 100);
  return { eeNiPence: main + upper };
}

/**
 * Per-period employer NI (Class 1 secondary). Same prorate model.
 * Slice 1 doesn't apply Employment Allowance — single-director Ltd
 * companies are explicitly excluded from EA, which is our user shape.
 */
function computeEmployerNI({ grossPence, periodsPerYear, rules }) {
  const st = Math.floor(rules.niErSecondaryThresholdPence / periodsPerYear);
  if (grossPence <= st) return { erNiPence: 0 };
  const erNi = Math.round(((grossPence - st) * rules.niErRate) / 100);
  return { erNiPence: erNi };
}

// =====================================================================
// runPayroll — stage the period, compute, post the journal, persist run
// =====================================================================

async function runPayroll(input, opts = {}) {
  const required = ['entityId', 'employeeId', 'payDate', 'periodNumber', 'grossPence'];
  for (const k of required) if (input[k] == null) throw new Error(`runPayroll: ${k} required`);
  const { entityId, employeeId, payDate, periodNumber, grossPence } = input;
  if (!Number.isInteger(grossPence) || grossPence < 0) {
    throw new Error('runPayroll: grossPence must be a non-negative integer');
  }
  const taxYear = input.taxYear ?? taxYearFor(payDate);
  const region = input.region || 'rUK';
  const rules = await getRules(taxYear, region);
  const employee = await getEmployee(employeeId);
  if (employee.entityId !== entityId) {
    throw new Error('runPayroll: employee belongs to a different entity');
  }
  const periodsPerYear = PERIODS_PER_YEAR[employee.payFrequency];
  if (!periodsPerYear) throw new Error(`unsupported pay frequency ${employee.payFrequency}`);
  if (periodNumber < 1 || periodNumber > periodsPerYear) {
    throw new Error(`periodNumber ${periodNumber} out of range 1..${periodsPerYear}`);
  }

  const db = getDb();
  return db.transaction(async (tx) => {
    const { payrollRuns } = getSchema();
    // Sum YTD prior periods (period < periodNumber, same tax year).
    const priorRows = await tx
      .select({
        ytdGross: sql`COALESCE(SUM(${payrollRuns.grossPence}), 0)`.mapWith(Number),
        ytdPaye:  sql`COALESCE(SUM(${payrollRuns.payePence}), 0)`.mapWith(Number),
        ytdEeNi:  sql`COALESCE(SUM(${payrollRuns.eeNiPence}), 0)`.mapWith(Number),
      })
      .from(payrollRuns)
      .where(
        and(
          eq(payrollRuns.employeeId, employeeId),
          eq(payrollRuns.taxYear, taxYear),
          sql`${payrollRuns.periodNumber} < ${periodNumber}`,
          sql`${payrollRuns.status} <> 'reversed'`
        )
      );
    const ytdPriorGross = priorRows[0].ytdGross || 0;
    const ytdPriorPaye  = priorRows[0].ytdPaye  || 0;
    const ytdPriorEeNi  = priorRows[0].ytdEeNi  || 0;

    const newYtdGross = ytdPriorGross + grossPence;
    const { periodPayePence } = computePeriodPAYE({
      ytdGrossPence: newYtdGross,
      ytdPayePriorPence: ytdPriorPaye,
      taxCode: employee.taxCode,
      periodNumber,
      periodsPerYear,
      rules,
    });
    const { eeNiPence } = computeEmployeeNI({ grossPence, periodsPerYear, rules });
    const { erNiPence } = computeEmployerNI({ grossPence, periodsPerYear, rules });
    const netPence = grossPence - periodPayePence - eeNiPence;

    // Post the payroll journal:
    //   DR 7110 Director's Salary    grossPence
    //   DR 7150 Employer's NI         erNiPence
    //   CR 2210 PAYE/NI Liability    (periodPaye + eeNi + erNi)
    //   CR 0800 Bank                 netPence
    const [salaryAcc, erNiAcc, payeLiab, bank] = await Promise.all([
      getAccountByCode(entityId, '7110'),
      getAccountByCode(entityId, '7150'),
      getAccountByCode(entityId, '2210'),
      getAccountByCode(entityId, '0800'),
    ]);
    if (!salaryAcc || !erNiAcc || !payeLiab || !bank) {
      throw new Error('runPayroll: missing required Ltd CoA accounts (7110/7150/2210/0800)');
    }
    const journalLines = [
      { accountId: salaryAcc.id, debit: grossPence, credit: 0 },
      { accountId: erNiAcc.id,   debit: erNiPence,  credit: 0 },
      { accountId: payeLiab.id,  debit: 0,          credit: periodPayePence + eeNiPence + erNiPence },
      { accountId: bank.id,      debit: 0,          credit: netPence },
    ];
    const journal = await postJournal({
      entityId,
      date: payDate,
      description: `Payroll: ${employee.name} period ${periodNumber}`,
      source: 'payroll',
      sourceType: 'stage6',
      lines: journalLines,
      tx,
    });

    const fpsPayload = {
      hmrcOfficeNumber: null,
      payeRef: null,
      employee: {
        name: employee.name,
        niNumber: employee.niNumber,
        taxCode: employee.taxCode,
      },
      paymentDate: payDate,
      taxYear,
      periodNumber,
      grossPence,
      payePence: periodPayePence,
      eeNiPence,
      erNiPence,
      netPence,
      ytdGrossPence: newYtdGross,
      ytdPayePence: ytdPriorPaye + periodPayePence,
      ytdEeNiPence: ytdPriorEeNi + eeNiPence,
    };

    const id = newRunId();
    await tx.insert(payrollRuns).values({
      id,
      entityId,
      employeeId,
      taxYear,
      periodNumber,
      payDate,
      grossPence,
      payePence: periodPayePence,
      eeNiPence,
      erNiPence,
      netPence,
      ytdGrossPence: newYtdGross,
      ytdPayePence: ytdPriorPaye + periodPayePence,
      ytdEeNiPence: ytdPriorEeNi + eeNiPence,
      fpsPayload,
      status: 'posted',
      journalId: journal.id,
      createdBy: opts.actor?.userId || null,
    });

    return {
      id,
      journalId: journal.id,
      grossPence,
      payePence: periodPayePence,
      eeNiPence,
      erNiPence,
      netPence,
      ytdGrossPence: newYtdGross,
      fpsPayload,
    };
  });
}

async function listRuns(entityId, taxYear, opts = {}) {
  const reader = opts.tx || getDb();
  const { payrollRuns } = getSchema();
  return reader
    .select()
    .from(payrollRuns)
    .where(and(eq(payrollRuns.entityId, entityId), eq(payrollRuns.taxYear, taxYear)))
    .orderBy(asc(payrollRuns.payDate));
}

module.exports = {
  paFromTaxCode,
  computePeriodPAYE,
  computeEmployeeNI,
  computeEmployerNI,
  createEmployee,
  listEmployees,
  getEmployee,
  runPayroll,
  listRuns,
};
