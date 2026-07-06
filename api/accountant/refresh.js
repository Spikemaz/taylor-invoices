/**
 * POST /api/accountant/refresh — IAccountant read-model refresh.
 *
 * Rebuilds the Postgres double-entry read-model for the logged-in user
 * from their Google Sheet invoices. Google Sheets remains the single source
 * of truth; Postgres is a DERIVED read-model that is fully rebuilt on every
 * refresh (reverse all backfill_v1 journals, then re-import). This means
 * invoice edits AND deletions in Sheets propagate — not just new appends —
 * and the result is deterministic regardless of how often refresh runs.
 *
 * Flow:
 *   1. ensure the user + sole_trader/limited entities + seeded CoA
 *   2. read invoices from the user's sheet (read-only)
 *   3. partition by normalised entity type (unknown → reported, not guessed)
 *   4. per entity: ATOMIC rebuild (advisory-locked reverse + re-import in one tx)
 *   5. return sync diagnostics (incl. unmapped invoices)
 */

const { applyCors, requireSession, getMasterSheet } = require('../_lib/auth');
const { isAccountantEnabled } = require('../_lib/db');
const { ensureAccountantUserAndEntities } = require('../_lib/accountants/provision');
const { readInvoicesFromTenantSheet } = require('../_lib/sheets/invoices-reader');
const { normalizeEntityType, mapInvoiceForBackfill } = require('../_lib/accountants/mapping');
const { rebuildEntityInvoices } = require('../_lib/ledger/backfill');

module.exports = async (req, res) => {
  applyCors(req, res, 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!isAccountantEnabled()) return res.status(404).json({ error: 'Not found' });

  const session = await requireSession(req, res);
  if (!session) return;
  if (!session.sheetId) {
    return res.status(400).json({ error: 'Session has no sheetId; sign out and back in.' });
  }

  try {
    // 1. provision (idempotent): user + entities + charts of accounts.
    const prov = await ensureAccountantUserAndEntities(session);

    // 2. read invoices (read-only) from the user's own sheet.
    const { sheets } = await getMasterSheet();
    const rawInvoices = await readInvoicesFromTenantSheet({ sheets, sheetId: session.sheetId });

    // 3. partition by normalised entity type.
    const byType = { sole_trader: [], limited: [] };
    const unmapped = [];
    for (const row of rawInvoices) {
      const type = normalizeEntityType(row.entity);
      if (!type || !byType[type]) {
        unmapped.push({ num: row.num, entity: row.entity || '(blank)' });
        continue;
      }
      byType[type].push(mapInvoiceForBackfill(row));
    }

    // 4. Rebuild semantics — Postgres is a DERIVED read-model, so each
    //    refresh wipes this entity's prior backfill journals and re-imports
    //    from the CURRENT Sheets state. This keeps Sheets the single source
    //    of truth: invoice edits AND deletions propagate (not just appends),
    //    and same-number invoices across practices stay distinct. The rebuild
    //    is atomic + advisory-locked per entity (see rebuildEntityInvoices),
    //    so concurrent refreshes can't double-post and a mid-rebuild failure
    //    leaves the previous good read-model intact.
    const sync = {};
    for (const ent of prov.entities) {
      const invoices = byType[ent.type] || [];
      const r = await rebuildEntityInvoices(
        { entityId: ent.id, invoices },
        { actor: { userId: session.userId } }
      );
      sync[ent.type] = {
        entityId: ent.id,
        invoicesForEntity: invoices.length,
        reversed: r.reversed,
        eligible: r.eligible,
        posted: r.posted,
        skipped: r.skipped,
        skippedReasons: r.skippedReasons,
        // Full sale-leg income posted for this entity this run (= cumulative,
        // since we rebuild from scratch). Dashboard P&L stays authoritative.
        incomePostedPence: r.incomePostedPence,
      };
    }

    return res.status(200).json({
      ok: true,
      userId: session.userId,
      entities: prov.entities.map((e) => ({ id: e.id, type: e.type, name: e.name })),
      totalInvoicesRead: rawInvoices.length,
      unmappedCount: unmapped.length,
      unmapped: unmapped.slice(0, 25),
      sync,
    });
  } catch (err) {
    console.error('[accountant/refresh] error:', err);
    if (!res.headersSent) {
      return res.status(500).json({ error: 'Refresh failed', detail: String(err.message || err) });
    }
  }
};
