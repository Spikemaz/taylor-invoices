/**
 * Stage 8 — Comparison framework.
 *
 * Wraps any report function `compute({ entityId, from, to })` and runs
 * it for the requested period AND a comparable prior period, returning
 * { current, prior, varianceAbsPence, variancePct } on the headline figure.
 *
 * The headline figure is selected by `pickValue(result)`:
 *   - P&L:           result.netProfitPence
 *   - Balance Sheet: result.assets.totalPence
 *   - Cash flow:     result.operating.totalPence
 *   - Aged report:   result.totalPence
 *
 * Prior period defaults to the immediately-preceding window of the
 * same length. Caller can override with `priorFrom`/`priorTo`.
 */

function dayBefore(iso) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

function daysBetween(a, b) {
  const da = new Date(`${a}T00:00:00Z`).getTime();
  const db = new Date(`${b}T00:00:00Z`).getTime();
  return Math.round((db - da) / 86_400_000);
}

function priorWindow(from, to) {
  const len = daysBetween(from, to); // inclusive count off by 1; doesn't matter for "same length back"
  const newTo = dayBefore(from);
  const start = new Date(`${newTo}T00:00:00Z`);
  start.setUTCDate(start.getUTCDate() - len);
  return { from: start.toISOString().slice(0, 10), to: newTo };
}

async function comparePeriods(compute, args, opts = {}) {
  const { from, to } = args;
  if (!from || !to) throw new Error('comparePeriods: from/to required');
  const prior = opts.prior || priorWindow(from, to);
  const [current, priorResult] = await Promise.all([
    compute({ ...args, from, to }),
    compute({ ...args, from: prior.from, to: prior.to }),
  ]);
  const pick = opts.pickValue || ((r) => r.netProfitPence ?? r.totalPence ?? 0);
  const cur = pick(current) || 0;
  const pri = pick(priorResult) || 0;
  const variance = cur - pri;
  const variancePct = pri === 0 ? null : Math.round((variance / Math.abs(pri)) * 10000) / 100;
  return {
    current,
    prior: priorResult,
    headline: {
      currentPence: cur,
      priorPence: pri,
      varianceAbsPence: variance,
      variancePct,
    },
  };
}

module.exports = { comparePeriods, priorWindow };
