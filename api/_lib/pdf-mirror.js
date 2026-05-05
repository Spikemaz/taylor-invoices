/**
 * Shared helpers for locating an invoice's mirror PDF in the per-user
 * hidden backup folder.
 *
 * The functions here used to live in api/sheets-sync.js as private
 * helpers; they were extracted so the migration backfill script
 * (`scripts/migration/backfill-pdf-mirrors.js`) and any future
 * tooling can reuse the EXACT same lookup logic. Behaviour is
 * intentionally unchanged from the original implementations — this
 * module is purely a relocation.
 *
 * The lookup must stay aligned with the upload path written by
 * `api/drive-upload.js`:
 *   <backupFolder>/<Entity>/Invoices/<Year>/<Month>/[Ad Hoc/]<fileName>
 * where Entity is "Ltd Company" for logoType==='ltd' and
 * "Self-Employed" otherwise, Year/Month come from invoice.period
 * (preferred — matches upload time) or invoice.date (fallback), and
 * fileName comes from inferInvoiceFileName().
 */

// Month names that the upload tree uses (English, full word).
// MUST match drive-upload.js / parsePeriodForFolder on the frontend.
const FOLDER_MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/**
 * Extract a Drive file ID from a webViewLink-style URL.
 * Recognises /file/d/<id>/, ?id=<id>, and bare IDs.
 * Returns null if nothing parseable is found.
 */
function extractDriveFileId(link) {
  if (!link) return null;
  const s = String(link);
  let m = s.match(/\/file\/d\/([a-zA-Z0-9_-]{10,})/);
  if (m) return m[1];
  m = s.match(/[?&]id=([a-zA-Z0-9_-]{10,})/);
  if (m) return m[1];
  if (/^[a-zA-Z0-9_-]{10,}$/.test(s)) return s;
  return null;
}

/**
 * Given an invoice row, return { year, month } as the strings the
 * upload path tree uses ("2025", "March"). Prefers invoice.period
 * (matches the folder the upload code created); falls back to
 * invoice.date. Returns null if neither yields a usable date.
 */
function deriveYearMonthForFolder(invoice) {
  const period = invoice && invoice.period;
  if (period) {
    for (const m of FOLDER_MONTH_NAMES) {
      if (period.includes(m)) {
        const yearMatch = period.match(/\d{4}/);
        return {
          year: yearMatch ? yearMatch[0] : String(new Date().getFullYear()),
          month: m,
        };
      }
    }
    const dateMatch = period.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (dateMatch) {
      const d = new Date(parseInt(dateMatch[3], 10), parseInt(dateMatch[2], 10) - 1, parseInt(dateMatch[1], 10));
      if (!isNaN(d.getTime())) {
        return { year: String(d.getFullYear()), month: d.toLocaleString('en-GB', { month: 'long' }) };
      }
    }
  }
  const dateStr = invoice && invoice.date;
  if (dateStr) {
    const d = new Date(dateStr);
    if (!isNaN(d.getTime())) {
      return { year: String(d.getFullYear()), month: d.toLocaleString('en-GB', { month: 'long' }) };
    }
  }
  return null;
}

/**
 * generate-pdf.js builds: `<PREFIX> Invoice-<num>.pdf` where prefix is
 * HTCS for ltd, TAYLOR otherwise. Stay aligned with that for mirror
 * lookup AND for backfill copies (so a future delete can find them).
 */
function inferInvoiceFileName(invoiceRow) {
  const prefix = invoiceRow && invoiceRow.logoType === 'ltd' ? 'HTCS' : 'TAYLOR';
  return `${prefix} Invoice-${invoiceRow.num}.pdf`;
}

/**
 * Look up a single non-trashed sub-folder by exact name under parentId.
 * Returns the folder ID or null if not found.
 */
async function findFolderByName(drive, name, parentId) {
  const escapedName = String(name).replace(/'/g, "\\'");
  const r = await drive.files.list({
    q: `name='${escapedName}' and mimeType='application/vnd.google-apps.folder' and '${parentId}' in parents and trashed=false`,
    fields: 'files(id)',
    spaces: 'drive',
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });
  return (r.data.files && r.data.files[0]) ? r.data.files[0].id : null;
}

/**
 * Reconstruct the path drive-upload.js wrote the mirror to and look
 * the file up by name. Returns the mirror file ID, or null if any
 * folder in the chain (or the file itself) is missing.
 *
 * `invoice` must expose at least { logoType, period|date, num,
 * isAdhoc }. fileName is the expected mirror file name (usually the
 * result of inferInvoiceFileName(invoice)).
 */
async function findMirrorPdfId(drive, backupFolderId, fileName, invoice) {
  const entityName = (invoice && invoice.logoType === 'ltd') ? 'Ltd Company' : 'Self-Employed';
  const ym = deriveYearMonthForFolder(invoice);
  if (!ym) return null;
  const { year, month } = ym;
  let folderId = backupFolderId;
  for (const step of [entityName, 'Invoices', year, month]) {
    folderId = await findFolderByName(drive, step, folderId);
    if (!folderId) return null;
  }
  const isAdhoc = invoice.isAdhoc === true || invoice.isAdhoc === 'TRUE' || invoice.isAdhoc === 'true';
  if (isAdhoc) {
    folderId = await findFolderByName(drive, 'Ad Hoc', folderId);
    if (!folderId) return null;
  }
  const escapedName = String(fileName).replace(/'/g, "\\'");
  const r = await drive.files.list({
    q: `name='${escapedName}' and '${folderId}' in parents and trashed=false`,
    fields: 'files(id)',
    spaces: 'drive',
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });
  return (r.data.files && r.data.files[0]) ? r.data.files[0].id : null;
}

module.exports = {
  FOLDER_MONTH_NAMES,
  extractDriveFileId,
  deriveYearMonthForFolder,
  inferInvoiceFileName,
  findFolderByName,
  findMirrorPdfId,
};
