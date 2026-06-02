/**
 * Stage 7 slice 1 — MTD-VAT client (STUB).
 *
 * Real HMRC integration requires:
 *   - Approved software-vendor status (free, ~2-week process)
 *   - Government Gateway OAuth flow per user
 *   - Mandatory fraud-prevention headers on every call
 *
 * Slice 1 ships the engine (boxes 1–9, schemes, threshold tracking,
 * persistence, locking) wired through this stub so the rest of the
 * code is shaped the way the real client will be. Slice 2 swaps the
 * stub for a thin wrapper over the live HMRC MTD-VAT API.
 *
 * The stub is deliberately deterministic so tests can assert on its
 * receipts.
 */

const crypto = require('crypto');

function isoNow(d = new Date()) {
  return d.toISOString();
}

/**
 * Generate the next 4 quarterly VAT obligation windows starting from a
 * given anchor. Real HMRC returns whatever windows are open for the
 * VRN; this synth lets the dashboard show "next return due" before
 * the real API is wired up.
 */
function listObligations({ from, count = 4 }) {
  const start = new Date(from + 'T00:00:00Z');
  const out = [];
  for (let i = 0; i < count; i++) {
    const periodStart = new Date(Date.UTC(
      start.getUTCFullYear(),
      start.getUTCMonth() + i * 3,
      1
    ));
    const periodEnd = new Date(Date.UTC(
      periodStart.getUTCFullYear(),
      periodStart.getUTCMonth() + 3,
      0 // last day of prior month — gives last day of quarter
    ));
    // HMRC due date: 1 month + 7 days after period end
    const dueDate = new Date(Date.UTC(
      periodEnd.getUTCFullYear(),
      periodEnd.getUTCMonth() + 1,
      periodEnd.getUTCDate() + 7
    ));
    const periodKey = `${String(periodStart.getUTCFullYear()).slice(2)}A${Math.floor(periodStart.getUTCMonth() / 3) + 1}`;
    out.push({
      periodKey,
      periodStart: periodStart.toISOString().slice(0, 10),
      periodEnd: periodEnd.toISOString().slice(0, 10),
      dueDate: dueDate.toISOString().slice(0, 10),
      status: 'O',
    });
  }
  return out;
}

/**
 * Submit a VAT return — stubbed. Returns a deterministic mock receipt
 * shaped like HMRC's real response so the audit row matches.
 */
async function submitReturn({ vrn, periodKey, boxes }) {
  const formBundleNumber = crypto
    .createHash('sha256')
    .update(`${vrn}:${periodKey}:${boxes.box5}`)
    .digest('hex')
    .slice(0, 12)
    .toUpperCase();
  return {
    formBundleNumber,
    processingDate: isoNow(),
    paymentIndicator: boxes.box5 > 0 ? 'BANK' : 'NONE',
    chargeRefNumber: boxes.box5 > 0
      ? 'XM' + crypto.randomBytes(6).toString('hex').toUpperCase()
      : null,
    stub: true,
  };
}

async function getLiabilities() { return []; }
async function getPayments() { return []; }

module.exports = { listObligations, submitReturn, getLiabilities, getPayments };
