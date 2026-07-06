/**
 * Reusable, side-effect-free reader for a tenant's invoices from their
 * Google Sheet. Extracted from sheets-sync.js's loadAll() so the
 * IAccountant read-model can pull invoices without going through the
 * Sheets write/sync endpoint. sheets-sync.js is intentionally left
 * unchanged.
 *
 * Returns plain invoice objects in the same shape loadAll() produces.
 */

// Canonical per-user "Invoices" tab column order (mirror of
// INVOICE_COLUMNS in sheets-sync.js). Used as a fallback only when the
// sheet has no header row.
const INVOICE_COLUMNS = [
  'num', 'date', 'practice', 'practiceName', 'practiceAddr', 'period',
  'entity', 'entName', 'entAddr', 'entPhone', 'bankName', 'bankAccName',
  'bankAcc', 'bankSort', 'amount', 'gross', 'commRate', 'svcs', 'addons',
  'airTotal', 'logoType', 'payTerms', 'footerMsg', 'companyNo', 'isAdhoc',
  'driveLink', 'paidStatus', 'paidDate', 'createdAt',
];

const NUMERIC_COLS = new Set(['amount', 'gross', 'airTotal']);
const JSON_COLS = new Set(['svcs', 'addons']);

/**
 * Read and parse the invoices from a tenant sheet.
 *
 * @param {object} args
 * @param {object} args.sheets   authed googleapis sheets client
 * @param {string} args.sheetId  the tenant's spreadsheet id
 * @returns {Promise<Array<object>>}
 */
async function readInvoicesFromTenantSheet({ sheets, sheetId }) {
  if (!sheets) throw new Error('readInvoicesFromTenantSheet: sheets client required');
  if (!sheetId) throw new Error('readInvoicesFromTenantSheet: sheetId required');

  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: 'Invoices!A:AD',
  });
  const rows = resp.data.values || [];
  if (rows.length === 0) return [];

  // Use the sheet's own header row when present; otherwise canonical order.
  const headers = rows[0] && rows[0][0] && rows[0][0] !== '' ? rows[0] : INVOICE_COLUMNS;

  return rows
    .filter((row, idx) => idx > 0 && row[0] && row[0] !== 'num')
    .map((row) => {
      // Sheets API omits trailing empty cells; pad so indices line up.
      while (row.length < headers.length) row.push('');
      const obj = {};
      headers.forEach((col, i) => {
        if (!col) return;
        let val = row[i];
        if (NUMERIC_COLS.has(col)) {
          val = parseFloat(val) || 0;
        } else if (col === 'isAdhoc') {
          val = val === 'true' || val === true;
        } else if (JSON_COLS.has(col) && val) {
          try {
            val = JSON.parse(val);
          } catch (_e) {
            /* keep raw string */
          }
        }
        obj[col] = val === undefined || val === null ? '' : val;
      });
      return obj;
    });
}

module.exports = { readInvoicesFromTenantSheet, INVOICE_COLUMNS };
