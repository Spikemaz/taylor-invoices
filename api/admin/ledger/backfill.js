/**
 * POST /api/admin/ledger/backfill
 *   { entityId, dryRun?: boolean = true, limit?: number, invoices?: Array }
 *
 * Backfill an entity's invoice history into the ledger.
 *
 * If `invoices` is supplied in the body, those are used (useful for
 * validation runs and tests). Otherwise the endpoint reads the entity's
 * Sheets `AllInvoices` tab and parses the rows. Stage 1 deliberately
 * keeps the Sheets reader thin — we lean on `sheets-sync.js` patterns
 * but read directly to avoid coupling the backfill to that handler's
 * response shape.
 *
 * SAFETY:
 *   - Defaults to `dryRun:true`. The caller MUST pass `{dryRun:false}` to
 *     actually post journals. The dry-run output shows exactly what would
 *     be posted (counts, totals, sample).
 *   - Idempotent — re-running is safe.
 */

const { requireSession, applyCors } = require('../../_lib/auth');
const { isPostgresEnabled, isDualWriteEnabled, getDb, getSchema } = require('../../_lib/db');
const { backfillInvoices } = require('../../_lib/ledger/backfill');
const { getMasterSheet } = require('../../_lib/auth');
const { google } = require('googleapis');
const { eq } = require('drizzle-orm');

/**
 * Pull the entity's tenant sheetId from the entities row (or the master
 * sheet if it's not denormalised). For Stage 1 we read it from the
 * entities row's `sheetId` if present, else look up the user's row
 * in the master sheet (slower but correct for legacy users).
 */
async function resolveTenantSheetId(entityId) {
  const db = getDb();
  const { entities, users } = getSchema();
  const entRows = await db
    .select()
    .from(entities)
    .where(eq(entities.id, entityId))
    .limit(1);
  if (!entRows[0]) throw new Error(`entity ${entityId} not found`);
  if (entRows[0].sheetId) return entRows[0].sheetId;

  // Fallback: look up the owning user's sheetId via the master sheet.
  const userRows = await db
    .select()
    .from(users)
    .where(eq(users.id, entRows[0].userId))
    .limit(1);
  if (!userRows[0]) throw new Error(`user ${entRows[0].userId} not found`);
  // The master sheet is the legacy source of truth for user.sheetId.
  // Until cutover, the DB row's sheetId may be null.
  if (userRows[0].sheetId) return userRows[0].sheetId;

  throw new Error(
    `Cannot resolve tenant sheetId for entity ${entityId} — no sheetId on entity or user row.`
  );
}

/**
 * Read invoices from a tenant sheet's `AllInvoices` tab (or fall back to
 * `Invoices`). Returns an array of plain objects keyed by header.
 */
async function readInvoicesFromSheet(tenantSheetId) {
  const auth = await google.auth.getClient({
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const sheets = google.sheets({ version: 'v4', auth });

  // Try AllInvoices first (master format), then Invoices (legacy tenant).
  const ranges = ['AllInvoices!A:AD', 'Invoices!A:AD'];
  let rowsRaw = null;
  let usedRange = null;
  for (const range of ranges) {
    try {
      const r = await sheets.spreadsheets.values.get({
        spreadsheetId: tenantSheetId,
        range,
      });
      if (r.data?.values?.length) {
        rowsRaw = r.data.values;
        usedRange = range;
        break;
      }
    } catch (err) {
      // Ignore "Unable to parse range" type errors (tab doesn't exist).
      if (!String(err.message || '').match(/Unable to parse range|Requested entity was not found/i)) {
        throw err;
      }
    }
  }
  if (!rowsRaw) return { invoices: [], usedRange: null };

  const [header, ...dataRows] = rowsRaw;
  const norm = (h) => String(h || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
  const headers = header.map(norm);
  const invoices = dataRows.map((row) => {
    const obj = {};
    headers.forEach((h, i) => {
      if (h) obj[h] = row[i];
    });
    // Normalise common alias keys for the planner.
    obj.id = obj.id || obj.invoiceid || obj.invoiceno || obj.invoicenumber || obj.number;
    obj.date = obj.date || obj.issuedate || obj.invoicedate;
    obj.total = obj.total || obj.amount || obj.totalamount || obj.gross;
    obj.paidStatus = obj.paidstatus || obj.paid || obj.status;
    obj.paidDate = obj.paiddate || obj.datepaid || obj.paymentdate;
    obj.customerName = obj.customer || obj.customername || obj.client || obj.clientname;
    return obj;
  });
  return { invoices, usedRange };
}

module.exports = async function handler(req, res) {
  applyCors(req, res, 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const session = await requireSession(req, res);
  if (!session) return;
  if (session.role !== 'admin') return res.status(403).json({ error: 'Admin only' });

  if (!isPostgresEnabled() && !isDualWriteEnabled()) {
    return res.status(409).json({
      error: 'Ledger writes are inactive — set DB_BACKEND=postgres or DB_DUAL_WRITE=1.',
    });
  }

  const body = req.body || {};
  const entityId = body.entityId;
  if (!entityId) return res.status(400).json({ error: 'entityId required' });
  // Default to dry-run for safety. Caller must pass {dryRun:false} to commit.
  const dryRun = body.dryRun !== false;
  const limit = typeof body.limit === 'number' ? body.limit : undefined;

  let invoices = body.invoices;
  let source = 'request';
  let sheetRange = null;
  if (!Array.isArray(invoices)) {
    try {
      const tenantSheetId = await resolveTenantSheetId(entityId);
      const r = await readInvoicesFromSheet(tenantSheetId);
      invoices = r.invoices;
      sheetRange = r.usedRange;
      source = `sheet:${tenantSheetId}`;
    } catch (err) {
      console.error('[admin/ledger/backfill] failed to read sheet:', err);
      return res.status(500).json({ error: `Failed to read tenant sheet: ${err.message}` });
    }
  }

  try {
    const actor = {
      userId: session.userId,
      email: session.email,
      role: session.role,
      ip: req.headers['x-forwarded-for'] || req.socket?.remoteAddress,
      userAgent: req.headers['user-agent'],
      requestId: req.headers['x-request-id'] || null,
    };
    const result = await backfillInvoices(
      { entityId, invoices },
      { dryRun, limit, actor }
    );
    return res.status(200).json({
      ok: true,
      source,
      sheetRange,
      ...result,
    });
  } catch (err) {
    console.error('[admin/ledger/backfill] failed:', err);
    return res.status(500).json({ error: err.message });
  }
};
