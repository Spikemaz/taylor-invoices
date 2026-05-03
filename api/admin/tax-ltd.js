/**
 * /api/admin/tax-ltd — Stage 6 admin façade for Limited Company tax.
 *
 *   GET ?kind=ct600&entityId=...&periodStart=...&periodEnd=...
 *   GET ?kind=combined_personal&entityId=...&taxYear=2025&salaryPence=...&dividendsPence=...
 *   GET ?kind=director_loan&entityId=...
 *   GET ?kind=ch_reminders&entityId=...
 *   GET ?kind=payroll_runs&entityId=...&taxYear=2025
 *   GET ?kind=dividends&entityId=...
 *
 *   POST { kind:'employee.create', ... }
 *   POST { kind:'payroll.run', entityId, employeeId, payDate, periodNumber, grossPence }
 *   POST { kind:'dividend.declare', entityId, declaredDate, totalAmountPence, ... }
 *   POST { kind:'ch.create', entityId, kind, dueDate, ... }
 *   POST { kind:'ch.filed', entityId, id, completedDate }
 */

const { requireSession, applyCors } = require('../_lib/auth');
const { isPostgresEnabled, isDualWriteEnabled } = require('../_lib/db');
const payroll = require('../_lib/tax/payroll');
const dividends = require('../_lib/tax/dividends');
const dla = require('../_lib/tax/director-loan');
const ct600Lib = require('../_lib/tax/ct600');
const personal = require('../_lib/tax/personal-combined');
const ch = require('../_lib/tax/companies-house');

module.exports = async function handler(req, res) {
  applyCors(req, res, 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  const session = await requireSession(req, res);
  if (!session) return;
  if (session.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  if (!isPostgresEnabled() && !isDualWriteEnabled()) {
    return res.status(409).json({ error: 'Stage 6 requires DB_BACKEND=postgres or DB_DUAL_WRITE=1' });
  }
  const actor = {
    userId: session.userId,
    email: session.email,
    role: session.role,
    ip: req.headers['x-forwarded-for'] || req.socket?.remoteAddress,
  };
  try {
    if (req.method === 'GET') {
      const { kind, entityId, taxYear, periodStart, periodEnd, salaryPence, dividendsPence, region } = req.query || {};
      const ty = taxYear ? Number(taxYear) : null;
      switch (kind) {
        case 'ct600':
          if (!entityId || !periodStart || !periodEnd) return res.status(400).json({ error: 'entityId + periodStart + periodEnd required' });
          return res.status(200).json({ ok: true, ...(await ct600Lib.computeCT600(entityId, periodStart, periodEnd, { region })) });
        case 'combined_personal':
          if (!entityId || !ty || salaryPence == null || dividendsPence == null) return res.status(400).json({ error: 'entityId + taxYear + salaryPence + dividendsPence required' });
          return res.status(200).json({ ok: true, ...(await personal.computeCombinedPersonal({ entityId, taxYear: ty, salaryPence: Number(salaryPence), dividendsPence: Number(dividendsPence), region })) });
        case 'director_loan':
          if (!entityId) return res.status(400).json({ error: 'entityId required' });
          return res.status(200).json({ ok: true, ...(await dla.getStatus(entityId, { taxYear: ty || undefined, region })) });
        case 'ch_reminders':
          if (!entityId) return res.status(400).json({ error: 'entityId required' });
          return res.status(200).json({ ok: true, ...(await ch.getReminderState(entityId)) });
        case 'payroll_runs':
          if (!entityId || !ty) return res.status(400).json({ error: 'entityId + taxYear required' });
          return res.status(200).json({ ok: true, runs: await payroll.listRuns(entityId, ty) });
        case 'dividends':
          if (!entityId) return res.status(400).json({ error: 'entityId required' });
          return res.status(200).json({ ok: true, dividends: await dividends.listDividends(entityId) });
        default:
          return res.status(400).json({ error: 'unknown kind' });
      }
    }
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    const body = req.body || {};
    switch (body.kind) {
      case 'employee.create':
        return res.status(200).json({ ok: true, ...(await payroll.createEmployee(body, { actor })) });
      case 'payroll.run':
        return res.status(200).json({ ok: true, ...(await payroll.runPayroll(body, { actor })) });
      case 'dividend.declare':
        return res.status(200).json({ ok: true, ...(await dividends.declareDividend(body, { actor })) });
      case 'ch.create':
        return res.status(200).json({ ok: true, ...(await ch.createFiling(body, { actor })) });
      case 'ch.filed':
        return res.status(200).json({ ok: true, ...(await ch.markFiled(body.entityId, body.id, body.completedDate, { actor })) });
      default:
        return res.status(400).json({ error: 'unknown kind' });
    }
  } catch (err) {
    console.error('[admin/tax-ltd]', err);
    return res.status(500).json({ error: err.message });
  }
};
