/**
 * /api/admin/reports — Stage 8 admin façade for reports, year-end and
 * accountant access.
 *
 *   GET  ?kind=trial_balance&entityId=...&asOfDate=...
 *   GET  ?kind=profit_and_loss&entityId=...&from=...&to=...&compare=1
 *   GET  ?kind=balance_sheet&entityId=...&asOfDate=...
 *   GET  ?kind=cash_flow&entityId=...&from=...&to=...
 *   GET  ?kind=aged_debtors&entityId=...&asOfDate=...
 *   GET  ?kind=aged_creditors&entityId=...&asOfDate=...
 *   GET  ?kind=vat_detail&entityId=...&periodStart=...&periodEnd=...
 *   GET  ?kind=directors_report&entityId=...&from=...&to=...
 *   GET  ?kind=snapshots&entityId=...&snapshotKind=...
 *   GET  ?kind=checklist&entityId=...&fiscalYear=...
 *   GET  ?kind=accountant_access&clientUserId=...
 *
 *   POST { kind:'export_csv', reportKind, ...args }
 *   POST { kind:'checklist_create', entityId, fiscalYear, periodId? }
 *   POST { kind:'checklist_tick', entityId, fiscalYear, stepId, done }
 *   POST { kind:'year_end_lock', entityId, fiscalYear, periodLabel?, periodStart, periodEnd, allowSkipped? }
 *   POST { kind:'invite_accountant', clientUserId, email, scope }
 *   POST { kind:'accept_invite', token, accountantUserId }
 *   POST { kind:'revoke_access', id }
 *
 * Admin-only, gated behind DB_BACKEND=postgres or DB_DUAL_WRITE=1.
 */

const { requireSession, applyCors } = require('../_lib/auth');
const { isPostgresEnabled, isDualWriteEnabled } = require('../_lib/db');
const ledgerReports = require('../_lib/ledger/reports');
const { agedDebtors, agedCreditors } = require('../_lib/reports/aged');
const { cashFlow } = require('../_lib/reports/cash-flow');
const { comparePeriods } = require('../_lib/reports/comparison');
const { vatDetail } = require('../_lib/reports/vat-detail');
const { directorsReport } = require('../_lib/reports/directors-report');
const { listSnapshots } = require('../_lib/reports/snapshots');
const { toCsv } = require('../_lib/reports/csv');
const yearEnd = require('../_lib/year-end/checklist');
const accountants = require('../_lib/accountants/access');

module.exports = async function handler(req, res) {
  applyCors(req, res, 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  const session = await requireSession(req, res);
  if (!session) return;
  if (session.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  if (!isPostgresEnabled() && !isDualWriteEnabled()) {
    return res.status(409).json({ error: 'Stage 8 requires DB_BACKEND=postgres or DB_DUAL_WRITE=1' });
  }
  const actor = {
    userId: session.userId,
    email: session.email,
    role: session.role,
    ip: req.headers['x-forwarded-for'] || req.socket?.remoteAddress,
    userAgent: req.headers['user-agent'],
  };
  try {
    if (req.method === 'GET') return await handleGet(req, res);
    if (req.method === 'POST') return await handlePost(req, res, actor);
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('[admin/reports] error:', err);
    return res.status(400).json({ error: String(err.message || err) });
  }
};

async function handleGet(req, res) {
  const q = req.query || {};
  const { kind, entityId } = q;
  switch (kind) {
    case 'trial_balance':
      return res.status(200).json({ ok: true, report: await ledgerReports.trialBalance(entityId, q.asOfDate) });
    case 'profit_and_loss': {
      const args = { entityId, from: q.from, to: q.to };
      const compute = (a) => ledgerReports.profitAndLoss(a.entityId, { from: a.from, to: a.to });
      if (q.compare === '1' || q.compare === 'true') {
        const result = await comparePeriods(compute, args, { pickValue: (r) => r.netProfitPence });
        return res.status(200).json({ ok: true, report: result });
      }
      return res.status(200).json({ ok: true, report: await compute(args) });
    }
    case 'balance_sheet':
      return res.status(200).json({ ok: true, report: await ledgerReports.balanceSheet(entityId, q.asOfDate) });
    case 'cash_flow':
      return res.status(200).json({ ok: true, report: await cashFlow({ entityId, from: q.from, to: q.to }) });
    case 'aged_debtors':
      return res.status(200).json({ ok: true, report: await agedDebtors({ entityId, asOfDate: q.asOfDate }) });
    case 'aged_creditors':
      return res.status(200).json({ ok: true, report: await agedCreditors({ entityId, asOfDate: q.asOfDate }) });
    case 'vat_detail':
      return res.status(200).json({
        ok: true,
        report: await vatDetail({ entityId, periodStart: q.periodStart, periodEnd: q.periodEnd }),
      });
    case 'directors_report':
      return res.status(200).json({ ok: true, report: await directorsReport({ entityId, from: q.from, to: q.to }) });
    case 'snapshots':
      return res.status(200).json({ ok: true, snapshots: await listSnapshots(entityId, { kind: q.snapshotKind }) });
    case 'checklist':
      return res.status(200).json({
        ok: true,
        checklist: await yearEnd.getChecklist(entityId, Number(q.fiscalYear)),
      });
    case 'accountant_access':
      return res.status(200).json({
        ok: true,
        access: await accountants.listAccessForClient(q.clientUserId),
      });
    default:
      return res.status(400).json({ error: `unknown kind: ${kind}` });
  }
}

async function handlePost(req, res, actor) {
  const body = req.body || {};
  switch (body.kind) {
    case 'export_csv': {
      const { reportKind } = body;
      let payload;
      switch (reportKind) {
        case 'profit_and_loss':
          payload = await ledgerReports.profitAndLoss(body.entityId, { from: body.from, to: body.to });
          break;
        case 'balance_sheet':
          payload = await ledgerReports.balanceSheet(body.entityId, body.asOfDate);
          break;
        case 'trial_balance':
          payload = await ledgerReports.trialBalance(body.entityId, body.asOfDate);
          break;
        case 'cash_flow':
          payload = await cashFlow({ entityId: body.entityId, from: body.from, to: body.to });
          break;
        case 'aged_debtors':
          payload = await agedDebtors({ entityId: body.entityId, asOfDate: body.asOfDate });
          break;
        case 'aged_creditors':
          payload = await agedCreditors({ entityId: body.entityId, asOfDate: body.asOfDate });
          break;
        default:
          return res.status(400).json({ error: `unsupported reportKind: ${reportKind}` });
      }
      const csv = toCsv(reportKind, payload);
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="${reportKind}.csv"`);
      return res.status(200).send(csv);
    }
    case 'checklist_create':
      return res.status(200).json({
        ok: true,
        checklist: await yearEnd.createChecklist({
          entityId: body.entityId,
          fiscalYear: body.fiscalYear,
          periodId: body.periodId,
        }),
      });
    case 'checklist_tick':
      return res.status(200).json({
        ok: true,
        checklist: await yearEnd.tickStep({
          entityId: body.entityId,
          fiscalYear: body.fiscalYear,
          stepId: body.stepId,
          done: body.done !== false,
          actor,
        }),
      });
    case 'year_end_lock':
      return res.status(200).json({
        ok: true,
        result: await yearEnd.lockYearEnd({
          entityId: body.entityId,
          fiscalYear: body.fiscalYear,
          periodLabel: body.periodLabel,
          periodStart: body.periodStart,
          periodEnd: body.periodEnd,
          allowSkipped: !!body.allowSkipped,
          actor,
        }),
      });
    case 'invite_accountant':
      return res.status(200).json({
        ok: true,
        ...(await accountants.inviteAccountant({
          clientUserId: body.clientUserId,
          email: body.email,
          scope: body.scope || 'read_only',
          actor,
        })),
      });
    case 'accept_invite':
      return res.status(200).json({
        ok: true,
        access: await accountants.acceptInvite({
          token: body.token,
          accountantUserId: body.accountantUserId,
        }),
      });
    case 'revoke_access':
      return res.status(200).json({
        ok: true,
        access: await accountants.revokeAccess({ id: body.id, actor }),
      });
    default:
      return res.status(400).json({ error: `unknown kind: ${body.kind}` });
  }
}
