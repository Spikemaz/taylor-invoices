// Google Sheets sync endpoint
// Actions: append_entry, append_invoice, update_entry, delete_entry, load_all, etc.
// Supports dual sheets: Self-Employed and Ltd Company

const { google } = require('googleapis');

// Validate required environment variables
function validateEnvVars() {
  const required = ['GOOGLE_SERVICE_ACCOUNT_EMAIL', 'GOOGLE_PRIVATE_KEY', 'GOOGLE_SHEET_ID'];
  const missing = required.filter(key => !process.env[key]);
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}. Please configure these in your Vercel project settings.`);
  }
}

// Initialize Google Sheets client
async function getSheets() {
  validateEnvVars();
  const auth = new google.auth.GoogleAuth({
    credentials: {
      client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    },
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });

  const sheets = google.sheets({ version: 'v4', auth });
  return sheets;
}

// Initialize Google Drive client (for deleting invoice PDFs)
async function getDrive() {
  const auth = new google.auth.GoogleAuth({
    credentials: {
      client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    },
    scopes: ['https://www.googleapis.com/auth/drive'],
  });

  const drive = google.drive({ version: 'v3', auth });
  return drive;
}

// Dual sheet IDs - one for each entity type
const SHEET_IDS = {
  self: process.env.GOOGLE_SHEET_ID,
  ltd: process.env.GOOGLE_SHEET_ID_LTD
};

// Get the correct sheet ID based on entity
function getSheetId(entity) {
  if (entity === 'ltd' && SHEET_IDS.ltd) {
    return SHEET_IDS.ltd;
  }
  return SHEET_IDS.self;
}

// Column mappings
// NOTE: PDF deletion is handled by Apps Script (processTrashTab or onChange trigger)
// because the service account doesn't own the files - Taylor does.
// The Trash tab stores deleted invoice data so Apps Script can process it.
const ENTRY_COLUMNS = ['id', 'date', 'pId', 'pName', 'pType', 'svc', 'pts', 'uPrice', 'aoType', 'aoAmt', 'aoPatients', 'gross', 'comm', 'commAmt', 'entity', 'invSt', 'invNo', 'adhocAddr', 'color', 'createdAt'];
const INVOICE_COLUMNS = ['num', 'date', 'practice', 'practiceName', 'practiceAddr', 'period', 'entity', 'entName', 'entAddr', 'entPhone', 'bankName', 'bankAccName', 'bankAcc', 'bankSort', 'amount', 'gross', 'commRate', 'svcs', 'addons', 'airTotal', 'logoType', 'payTerms', 'footerMsg', 'companyNo', 'isAdhoc', 'driveLink', 'paidStatus', 'paidDate', 'createdAt'];
const PRACTICE_COLUMNS = ['id', 'short', 'name', 'type', 'addr', 'email', 'comm', 'services', 'days', 'rate', 'air', 'active', 'color', 'paidHours', 'ptsPerHour', 'paymentDueDay', 'createdAt'];
const SETTINGS_COLUMNS = ['key', 'value', 'updatedAt'];
const LOG_COLUMNS = ['timestamp', 'action', 'dataType', 'recordId', 'changes', 'previousData', 'newData'];
const TRASH_COLUMNS = ['deletedAt', 'dataType', 'originalData'];

// ===== COLOR CODING =====
// Practice colors matching the app's CSS variables
// Colors are stored as RGB objects for Google Sheets API
const PRACTICE_COLORS = {
  bupa: { bg: { red: 0.91, green: 0.94, blue: 0.996 }, text: { red: 0, green: 0.34, blue: 0.66 } },      // #e8f0fe bg, #0057a8 text
  grove: { bg: { red: 0.91, green: 0.96, blue: 0.91 }, text: { red: 0.18, green: 0.42, blue: 0.31 } },   // #e8f5e9 bg, #2d6a4f text
  adhoc: { bg: { red: 0.996, green: 0.886, blue: 0.886 }, text: { red: 0.937, green: 0.267, blue: 0.267 } }, // #FEE2E2 bg, #EF4444 text
  haddenham: { bg: { red: 0.996, green: 0.886, blue: 0.886 }, text: { red: 0.937, green: 0.267, blue: 0.267 } }, // Same as adhoc - red
  bankhouse: { bg: { red: 0.996, green: 0.886, blue: 0.886 }, text: { red: 0.937, green: 0.267, blue: 0.267 } }, // Same as adhoc - red
  purple: { bg: { red: 0.93, green: 0.89, blue: 0.99 }, text: { red: 0.486, green: 0.227, blue: 0.929 } }, // #ede9fe bg, #7c3aed text
  orange: { bg: { red: 1, green: 0.95, blue: 0.88 }, text: { red: 0.96, green: 0.62, blue: 0.04 } },     // #fff7e0 bg, #f59e0b text
  teal: { bg: { red: 0.8, green: 0.98, blue: 0.96 }, text: { red: 0.08, green: 0.72, blue: 0.65 } },     // #ccfbf1 bg, #14b8a6 text
  // Default colors for new practices
  default: { bg: { red: 0.97, green: 0.97, blue: 0.94 }, text: { red: 0.06, green: 0.06, blue: 0.06 } }  // Light gray bg
};

// Get color scheme for a practice (by ID, type, or custom color name)
function getPracticeColor(pId, pType, customColor) {
  // Check for custom color first (set in practice settings)
  if (customColor && PRACTICE_COLORS[customColor.toLowerCase()]) {
    return PRACTICE_COLORS[customColor.toLowerCase()];
  }
  // Check for known practice IDs
  if (pId && PRACTICE_COLORS[pId.toLowerCase()]) {
    return PRACTICE_COLORS[pId.toLowerCase()];
  }
  // Ad hoc practices get red color
  if (pType === 'adhoc') {
    return PRACTICE_COLORS.adhoc;
  }
  // Default for unknown practices
  return PRACTICE_COLORS.default;
}

// Apply row formatting to a specific row in a sheet
async function applyRowColor(sheets, sheetId, sheetName, rowIndex, colorScheme) {
  try {
    // Get sheet metadata to find the sheet's gid
    const metadata = await sheets.spreadsheets.get({ spreadsheetId: sheetId });
    const sheet = metadata.data.sheets.find(s => s.properties.title === sheetName);
    if (!sheet) return;

    const sheetGid = sheet.properties.sheetId;

    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: sheetId,
      requestBody: {
        requests: [{
          repeatCell: {
            range: {
              sheetId: sheetGid,
              startRowIndex: rowIndex,
              endRowIndex: rowIndex + 1,
              startColumnIndex: 0,
              endColumnIndex: 35 // Cover all columns (A to AI)
            },
            cell: {
              userEnteredFormat: {
                backgroundColor: colorScheme.bg,
                textFormat: {
                  foregroundColor: colorScheme.text
                }
              }
            },
            fields: 'userEnteredFormat(backgroundColor,textFormat.foregroundColor)'
          }
        }]
      }
    });
  } catch (e) {
    console.error('Failed to apply row color:', e.message);
    // Don't fail the main operation if coloring fails
  }
}

// Get the last row index in a sheet (0-indexed)
async function getLastRowIndex(sheets, sheetId, sheetName) {
  try {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetId,
      range: `${sheetName}!A:A`
    });
    return (response.data.values || []).length - 1; // -1 because we want 0-indexed
  } catch (e) {
    return 0;
  }
}

// ===== MOVE TO TRASH =====
// Moves deleted data to the Trash tab for audit/recovery purposes
async function moveToTrash(sheets, sheetId, dataType, originalData) {
  try {
    const row = [
      new Date().toISOString(),          // deletedAt
      dataType,                           // 'entry' or 'invoice'
      JSON.stringify(originalData)        // Full original data as JSON
    ];

    await sheets.spreadsheets.values.append({
      spreadsheetId: sheetId,
      range: 'Trash!A:C',
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [row] }
    });

    // Apply color coding based on practice from original data
    const rowIndex = await getLastRowIndex(sheets, sheetId, 'Trash');
    const pId = originalData.pId || originalData.practice || '';
    const pType = originalData.pType || (originalData.isAdhoc ? 'adhoc' : 'contract');
    const colorScheme = getPracticeColor(pId, pType, originalData.color);
    await applyRowColor(sheets, sheetId, 'Trash', rowIndex, colorScheme);
  } catch (e) {
    console.error('Failed to move to Trash tab:', e.message);
    // Don't fail the main operation if trash fails
  }
}

// ===== AUDIT LOG =====
// Writes to the entity-specific sheet only (log is per-entity)
async function writeLog(sheets, sheetId, logEntry) {
  try {
    const row = [
      new Date().toISOString(),
      logEntry.action,       // CREATE, UPDATE, DELETE
      logEntry.dataType,     // entry, invoice, practice, settings
      logEntry.recordId,     // ID of the record
      logEntry.changes || '',      // What changed (for updates)
      logEntry.previousData ? JSON.stringify(logEntry.previousData) : '',
      logEntry.newData ? JSON.stringify(logEntry.newData) : ''
    ];

    await sheets.spreadsheets.values.append({
      spreadsheetId: sheetId,
      range: 'Log!A:G',
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [row] }
    });

    // Apply color coding based on practice from log data
    const rowIndex = await getLastRowIndex(sheets, sheetId, 'Log');
    const data = logEntry.newData || logEntry.previousData || {};
    const pId = data.pId || data.practice || '';
    const pType = data.pType || (data.isAdhoc ? 'adhoc' : 'contract');
    if (pId || pType) {
      const colorScheme = getPracticeColor(pId, pType, data.color);
      await applyRowColor(sheets, sheetId, 'Log', rowIndex, colorScheme);
    }
  } catch (e) {
    console.error('Failed to write audit log:', e.message);
    // Don't fail the main operation if logging fails
  }
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { action, data, entity } = req.body;

  try {
    const sheets = await getSheets();
    const sheetId = getSheetId(entity);

    switch (action) {
      case 'append_entry': return await appendEntry(sheets, sheetId, data, res);
      case 'append_invoice': return await appendInvoice(sheets, sheetId, data, res);
      case 'update_entry': return await updateEntry(sheets, sheetId, data, res);
      case 'batch_update_entries': return await batchUpdateEntries(sheets, sheetId, data, res);
      case 'delete_entry': return await deleteEntry(sheets, sheetId, data, res);
      case 'load_all': return await loadAll(sheets, sheetId, res);
      case 'update_invoice': return await updateInvoice(sheets, sheetId, data, res);
      case 'update_invoice_status': return await updateInvoiceStatus(sheets, sheetId, data, res);
      case 'delete_invoice': return await deleteInvoice(sheets, sheetId, data, res);
      case 'sync_entries': return await syncEntries(sheets, sheetId, data, res);
      case 'sync_invoices': return await syncInvoices(sheets, sheetId, data, res);
      case 'sync_practices': return await syncPractices(sheets, sheetId, data, res);
      case 'load_practices': return await loadPractices(sheets, sheetId, res);
      case 'sync_settings': return await syncSettings(sheets, sheetId, data, res);
      case 'load_settings': return await loadSettings(sheets, sheetId, res);
      case 'get_dashboard': return await getDashboard(sheets, sheetId, res);
      case 'rename_sheet': return await renameSheet(sheets, sheetId, data, res);
      case 'setup_log_tab': return await setupLogTab(sheets, sheetId, res);
      case 'setup_tabs': return await setupAllTabs(sheets, res);
      case 'trigger_pdf_regeneration': return await triggerPdfRegeneration(sheets, sheetId, data, res);
      case 'queue_pdf_deletion': return await queuePdfDeletion(sheets, sheetId, data, res);
      default: return res.status(400).json({ error: `Unknown action: ${action}` });
    }
  } catch (error) {
    console.error('Sheets API error:', error);
    return res.status(500).json({
      error: 'Sheets API error',
      message: error.message,
      details: error.response?.data?.error?.message || null
    });
  }
};

// ===== ENTRIES =====
async function appendEntry(sheets, sheetId, entry, res) {
  const row = ENTRY_COLUMNS.map(col => {
    if (col === 'createdAt') return new Date().toISOString();
    const val = entry[col];
    if (val === null || val === undefined) return '';
    if (typeof val === 'object') return JSON.stringify(val);
    return val;
  });

  await sheets.spreadsheets.values.append({
    spreadsheetId: sheetId,
    range: 'Entries!A:T',
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [row] }
  });

  // Apply color coding based on practice
  const rowIndex = await getLastRowIndex(sheets, sheetId, 'Entries');
  const colorScheme = getPracticeColor(entry.pId, entry.pType, entry.color);
  await applyRowColor(sheets, sheetId, 'Entries', rowIndex, colorScheme);

  // Log the creation
  await writeLog(sheets, sheetId, {
    action: 'CREATE',
    dataType: 'entry',
    recordId: entry.id,
    changes: `New entry: ${entry.pName} - ${entry.svc} - ${entry.pts} pts - £${entry.gross}`,
    newData: entry
  });

  return res.status(200).json({ success: true, message: 'Entry appended', id: entry.id });
}

async function updateEntry(sheets, sheetId, { id, updates }, res) {
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: 'Entries!A:T',
  });

  const rows = response.data.values || [];
  const rowIndex = rows.findIndex(row => row[0] === id);

  if (rowIndex === -1) {
    return res.status(404).json({ error: 'Entry not found', id });
  }

  const currentRow = rows[rowIndex];
  // Convert current row to object for logging
  const previousData = {};
  ENTRY_COLUMNS.forEach((col, i) => { previousData[col] = currentRow[i] || ''; });

  const updatedRow = ENTRY_COLUMNS.map((col, i) => {
    if (updates.hasOwnProperty(col)) {
      const val = updates[col];
      if (val === null || val === undefined) return '';
      if (typeof val === 'object') return JSON.stringify(val);
      return val;
    }
    return currentRow[i] || '';
  });

  await sheets.spreadsheets.values.update({
    spreadsheetId: sheetId,
    range: `Entries!A${rowIndex + 1}:T${rowIndex + 1}`,
    valueInputOption: 'RAW',
    requestBody: { values: [updatedRow] }
  });

  // Log the update with before/after data
  const changedFields = Object.keys(updates).filter(k => updates[k] !== previousData[k]).join(', ');
  await writeLog(sheets, sheetId, {
    action: 'UPDATE',
    dataType: 'entry',
    recordId: id,
    changes: `Updated fields: ${changedFields}`,
    previousData: previousData,
    newData: updates
  });

  return res.status(200).json({ success: true, message: 'Entry updated', id });
}

// Batch update multiple entries at once (reduces API calls from N*2 to 2)
async function batchUpdateEntries(sheets, sheetId, { entries }, res) {
  if (!entries || !entries.length) {
    return res.status(400).json({ error: 'No entries provided' });
  }

  // Single read to get all rows
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: 'Entries!A:T',
  });

  const rows = response.data.values || [];
  const updateRequests = [];
  const results = [];

  for (const { id, updates } of entries) {
    const rowIndex = rows.findIndex(row => row[0] === id);
    if (rowIndex === -1) {
      results.push({ id, success: false, error: 'not found' });
      continue;
    }

    const currentRow = rows[rowIndex];
    const updatedRow = ENTRY_COLUMNS.map((col, i) => {
      if (updates.hasOwnProperty(col)) {
        const val = updates[col];
        if (val === null || val === undefined) return '';
        if (typeof val === 'object') return JSON.stringify(val);
        return val;
      }
      return currentRow[i] || '';
    });

    updateRequests.push({
      range: `Entries!A${rowIndex + 1}:T${rowIndex + 1}`,
      values: [updatedRow]
    });
    results.push({ id, success: true });
  }

  // Single batch update
  if (updateRequests.length > 0) {
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: sheetId,
      requestBody: {
        valueInputOption: 'RAW',
        data: updateRequests
      }
    });
  }

  return res.status(200).json({
    success: true,
    message: `Updated ${updateRequests.length} entries`,
    results
  });
}

async function deleteEntry(sheets, sheetId, { id }, res) {
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: 'Entries!A:T',
  });

  const rows = response.data.values || [];
  const rowIndex = rows.findIndex(row => row[0] === id);

  if (rowIndex === -1) {
    return res.status(404).json({ error: 'Entry not found', id });
  }

  // Store the data before deletion for the log and trash
  const deletedRow = rows[rowIndex];
  const deletedData = {};
  ENTRY_COLUMNS.forEach((col, i) => { deletedData[col] = deletedRow[i] || ''; });

  // Move to Trash tab before deleting
  await moveToTrash(sheets, sheetId, 'entry', deletedData);

  const sheetMetadata = await sheets.spreadsheets.get({ spreadsheetId: sheetId });
  const entriesSheet = sheetMetadata.data.sheets.find(s => s.properties.title === 'Entries');
  if (!entriesSheet) {
    return res.status(500).json({ error: 'Entries sheet not found' });
  }

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: sheetId,
    requestBody: {
      requests: [{
        deleteDimension: {
          range: {
            sheetId: entriesSheet.properties.sheetId,
            dimension: 'ROWS',
            startIndex: rowIndex,
            endIndex: rowIndex + 1
          }
        }
      }]
    }
  });

  // Log the deletion with full previous data
  await writeLog(sheets, sheetId, {
    action: 'DELETE',
    dataType: 'entry',
    recordId: id,
    changes: `Deleted entry: ${deletedData.pName} - ${deletedData.svc} - ${deletedData.pts} pts - £${deletedData.gross} (moved to Trash)`,
    previousData: deletedData
  });

  return res.status(200).json({ success: true, message: 'Entry moved to Trash', id });
}

async function deleteInvoice(sheets, sheetId, { num, driveLink }, res) {
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: 'Invoices!A:AD',
  });

  const rows = response.data.values || [];
  const rowIndex = rows.findIndex(row => row[0] === num || row[0] === String(num));

  if (rowIndex === -1) {
    return res.status(404).json({ error: 'Invoice not found', num });
  }

  // Store the data before deletion for the log and trash
  const deletedRow = rows[rowIndex];
  const deletedData = {};
  INVOICE_COLUMNS.forEach((col, i) => { deletedData[col] = deletedRow[i] || ''; });

  // Move to Trash tab before deleting
  await moveToTrash(sheets, sheetId, 'invoice', deletedData);

  // Note: PDF will be moved to Trash folder by Apps Script (processTrashTab)
  // which reads the Trash tab. The service account can't move files it doesn't own.
  const driveLinkToDelete = driveLink || deletedData.driveLink;
  if (driveLinkToDelete) {
    console.log('Invoice', num, 'has Drive link - Apps Script will move PDF to Trash:', driveLinkToDelete);
  }

  const sheetMetadata = await sheets.spreadsheets.get({ spreadsheetId: sheetId });
  const invoicesSheet = sheetMetadata.data.sheets.find(s => s.properties.title === 'Invoices');
  if (!invoicesSheet) {
    return res.status(500).json({ error: 'Invoices sheet not found' });
  }

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: sheetId,
    requestBody: {
      requests: [{
        deleteDimension: {
          range: {
            sheetId: invoicesSheet.properties.sheetId,
            dimension: 'ROWS',
            startIndex: rowIndex,
            endIndex: rowIndex + 1
          }
        }
      }]
    }
  });

  // Log the deletion with full previous data
  const hasPdf = !!driveLinkToDelete;
  await writeLog(sheets, sheetId, {
    action: 'DELETE',
    dataType: 'invoice',
    recordId: num,
    changes: `Deleted invoice: #${num} - ${deletedData.practice} - £${deletedData.amount} (moved to Trash tab${hasPdf ? ', PDF pending Apps Script cleanup' : ''})`,
    previousData: deletedData
  });

  return res.status(200).json({
    success: true,
    message: `Invoice #${num} moved to Trash${hasPdf ? ' (PDF will be moved by Apps Script)' : ''}`,
    num,
    hasPdf
  });
}

// Queue a PDF for deletion via Trash tab (Apps Script will process it)
// Used when editing invoices - old PDF needs to be replaced
async function queuePdfDeletion(sheets, sheetId, { num, driveLink, reason }, res) {
  if (!driveLink) {
    return res.status(200).json({ success: true, message: 'No PDF to delete' });
  }

  // Add to Trash tab as pdf_replacement type so Apps Script knows to move the old PDF
  const trashData = {
    num,
    driveLink,
    reason: reason || 'invoice_edit'
  };

  await moveToTrash(sheets, sheetId, 'pdf_replacement', trashData);

  // Log the action
  await writeLog(sheets, sheetId, {
    action: 'PDF_REPLACE',
    dataType: 'invoice',
    recordId: num,
    changes: `Old PDF queued for deletion: ${driveLink} (reason: ${reason || 'invoice_edit'})`
  });

  return res.status(200).json({
    success: true,
    message: `PDF queued for deletion (Apps Script will move to Trash)`,
    num
  });
}

async function syncEntries(sheets, sheetId, { entries }, res) {
  if (!entries || !entries.length) {
    return res.status(200).json({ success: true, message: 'No entries to sync', count: 0 });
  }

  const rows = entries.map(entry =>
    ENTRY_COLUMNS.map(col => {
      if (col === 'createdAt') return entry.createdAt || new Date().toISOString();
      const val = entry[col];
      if (val === null || val === undefined) return '';
      if (typeof val === 'object') return JSON.stringify(val);
      return val;
    })
  );

  await sheets.spreadsheets.values.clear({
    spreadsheetId: sheetId,
    range: 'Entries!A2:T',
  });

  if (rows.length > 0) {
    // Use update with explicit range starting at A2 to avoid header issues
    await sheets.spreadsheets.values.update({
      spreadsheetId: sheetId,
      range: `Entries!A2:T${rows.length + 1}`,
      valueInputOption: 'RAW',
      requestBody: { values: rows }
    });
  }

  return res.status(200).json({ success: true, message: 'Entries synced', count: rows.length });
}

// ===== INVOICES =====
async function appendInvoice(sheets, sheetId, invoice, res) {
  const row = INVOICE_COLUMNS.map(col => {
    if (col === 'createdAt') return new Date().toISOString();
    const val = invoice[col];
    if (val === null || val === undefined) return '';
    if (typeof val === 'object') return JSON.stringify(val);
    return val;
  });

  await sheets.spreadsheets.values.append({
    spreadsheetId: sheetId,
    range: 'Invoices!A:AD',
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [row] }
  });

  // Apply color coding based on practice
  const rowIndex = await getLastRowIndex(sheets, sheetId, 'Invoices');
  // Use pId if available, otherwise try to match practice name to known practices
  let practiceId = invoice.pId || '';
  if (!practiceId && invoice.practice) {
    const practiceLower = invoice.practice.toLowerCase();
    if (practiceLower.includes('bupa')) practiceId = 'bupa';
    else if (practiceLower.includes('grove')) practiceId = 'grove';
    else if (practiceLower.includes('haddenham')) practiceId = 'haddenham';
    else if (practiceLower.includes('bankhouse') || practiceLower.includes('bank house')) practiceId = 'bankhouse';
  }
  const isAdhoc = invoice.isAdhoc === true || invoice.isAdhoc === 'true';
  const colorScheme = getPracticeColor(practiceId, isAdhoc ? 'adhoc' : 'contract', invoice.logoType);
  await applyRowColor(sheets, sheetId, 'Invoices', rowIndex, colorScheme);

  // Log the invoice creation
  await writeLog(sheets, sheetId, {
    action: 'CREATE',
    dataType: 'invoice',
    recordId: invoice.num,
    changes: `New invoice #${invoice.num}: ${invoice.practiceName || invoice.practice} - £${invoice.amount}`,
    newData: invoice
  });

  return res.status(200).json({ success: true, message: 'Invoice appended', num: invoice.num });
}

async function updateInvoice(sheets, sheetId, { num, updates }, res) {
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: 'Invoices!A:AD',
  });

  const rows = response.data.values || [];
  const rowIndex = rows.findIndex(row => row[0] === num || row[0] === String(num));

  if (rowIndex === -1) {
    return res.status(404).json({ error: 'Invoice not found', num });
  }

  const currentRow = rows[rowIndex];
  // Convert current row to object for logging
  const previousData = {};
  INVOICE_COLUMNS.forEach((col, i) => { previousData[col] = currentRow[i] || ''; });

  const updatedRow = INVOICE_COLUMNS.map((col, i) => {
    if (updates.hasOwnProperty(col)) {
      const val = updates[col];
      if (val === null || val === undefined) return '';
      if (typeof val === 'object') return JSON.stringify(val);
      return val;
    }
    return currentRow[i] || '';
  });

  await sheets.spreadsheets.values.update({
    spreadsheetId: sheetId,
    range: `Invoices!A${rowIndex + 1}:AA${rowIndex + 1}`,
    valueInputOption: 'RAW',
    requestBody: { values: [updatedRow] }
  });

  // Log the update
  const changedFields = Object.keys(updates).filter(k => updates[k] !== previousData[k]).join(', ');
  await writeLog(sheets, sheetId, {
    action: 'UPDATE',
    dataType: 'invoice',
    recordId: num,
    changes: `Updated fields: ${changedFields}`,
    previousData: previousData,
    newData: updates
  });

  return res.status(200).json({ success: true, message: 'Invoice updated', num });
}

// Update invoice payment status (paid/unpaid)
async function updateInvoiceStatus(sheets, sheetId, { num, paidStatus, paidDate }, res) {
  try {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetId,
      range: 'Invoices!A:AE',
    });

    const rows = response.data.values || [];
    let headers = rows[0] || [...INVOICE_COLUMNS];
    const rowIndex = rows.findIndex((row, i) => i > 0 && (row[0] === num || row[0] === String(num)));

    if (rowIndex === -1) {
      return res.status(404).json({ error: 'Invoice not found', num });
    }

    // Find column indices for paidStatus and paidDate
    let paidStatusIdx = headers.indexOf('paidStatus');
    let paidDateIdx = headers.indexOf('paidDate');

    // If columns don't exist in header, add them
    if (paidStatusIdx === -1 || paidDateIdx === -1) {
      if (paidStatusIdx === -1) {
        headers.push('paidStatus');
        paidStatusIdx = headers.length - 1;
      }
      if (paidDateIdx === -1) {
        headers.push('paidDate');
        paidDateIdx = headers.length - 1;
      }

      await sheets.spreadsheets.values.update({
        spreadsheetId: sheetId,
        range: 'Invoices!A1',
        valueInputOption: 'RAW',
        requestBody: { values: [headers] }
      });
    }

    // Update the row with payment status
    const currentRow = [...rows[rowIndex]];

    // Ensure row has enough columns
    while (currentRow.length <= Math.max(paidStatusIdx, paidDateIdx)) {
      currentRow.push('');
    }

    currentRow[paidStatusIdx] = paidStatus || '';
    currentRow[paidDateIdx] = paidDate || '';

    await sheets.spreadsheets.values.update({
      spreadsheetId: sheetId,
      range: `Invoices!A${rowIndex + 1}`,
      valueInputOption: 'RAW',
      requestBody: { values: [currentRow] }
    });

    // Log the status change
    await writeLog(sheets, sheetId, {
      action: 'UPDATE',
      dataType: 'invoice',
      recordId: num,
      changes: `Payment status: ${paidStatus}${paidDate ? ' on ' + paidDate : ''}`,
      previousData: {},
      newData: { paidStatus, paidDate }
    });

    return res.status(200).json({ success: true, message: 'Invoice status updated', num, paidStatus });
  } catch (error) {
    console.error('updateInvoiceStatus error:', error);
    return res.status(500).json({ error: 'Failed to update invoice status', message: error.message });
  }
}

// Trigger PDF regeneration by clearing driveLink and setting needsRegeneration flag
// Apps Script will detect this on next onChange trigger and regenerate the PDF
async function triggerPdfRegeneration(sheets, sheetId, { num }, res) {
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: 'Invoices!A:AD',
  });

  const rows = response.data.values || [];
  const headers = rows[0] || INVOICE_COLUMNS;
  const rowIndex = rows.findIndex(row => row[0] === num || row[0] === String(num));

  if (rowIndex === -1) {
    return res.status(404).json({ error: 'Invoice not found', num });
  }

  // Find the driveLink column index
  const driveLinkCol = headers.indexOf('driveLink');
  if (driveLinkCol === -1) {
    return res.status(500).json({ error: 'driveLink column not found' });
  }

  // Store old driveLink for moving to trash
  const oldDriveLink = rows[rowIndex][driveLinkCol];

  // Clear driveLink to trigger Apps Script regeneration
  // Apps Script's checkForNewInvoices() looks for invoices without driveLink
  const currentRow = rows[rowIndex];
  currentRow[driveLinkCol] = '';  // Clear driveLink

  await sheets.spreadsheets.values.update({
    spreadsheetId: sheetId,
    range: `Invoices!A${rowIndex + 1}:AA${rowIndex + 1}`,
    valueInputOption: 'RAW',
    requestBody: { values: [currentRow] }
  });

  // Log the regeneration trigger
  await writeLog(sheets, sheetId, {
    action: 'UPDATE',
    dataType: 'invoice',
    recordId: num,
    changes: `PDF regeneration triggered - cleared driveLink${oldDriveLink ? ' (old PDF will be moved to Trash by Apps Script)' : ''}`,
    previousData: { driveLink: oldDriveLink },
    newData: { driveLink: '', needsRegeneration: true }
  });

  // If there was an old PDF, move it to the Trash tab so Apps Script can move it to Trash folder
  if (oldDriveLink) {
    try {
      await moveToTrash(sheets, sheetId, 'pdf_replacement', {
        num: num,
        driveLink: oldDriveLink,
        reason: 'PDF regeneration - entry edited'
      });
    } catch (e) {
      console.log('Failed to move old PDF to trash:', e.message);
      // Continue anyway - Apps Script will handle cleanup
    }
  }

  return res.status(200).json({
    success: true,
    message: `PDF regeneration triggered for invoice #${num}`,
    num,
    oldDriveLink: oldDriveLink || null
  });
}

async function syncInvoices(sheets, sheetId, { invoices }, res) {
  if (!invoices || !invoices.length) {
    return res.status(200).json({ success: true, message: 'No invoices to sync', count: 0 });
  }

  const rows = invoices.map(invoice =>
    INVOICE_COLUMNS.map(col => {
      if (col === 'createdAt') return invoice.createdAt || new Date().toISOString();
      const val = invoice[col];
      if (val === null || val === undefined) return '';
      if (typeof val === 'object') return JSON.stringify(val);
      return val;
    })
  );

  await sheets.spreadsheets.values.clear({
    spreadsheetId: sheetId,
    range: 'Invoices!A2:AA',
  });

  if (rows.length > 0) {
    // Use update with explicit range starting at A2 to avoid header issues
    await sheets.spreadsheets.values.update({
      spreadsheetId: sheetId,
      range: `Invoices!A2:AA${rows.length + 1}`,
      valueInputOption: 'RAW',
      requestBody: { values: rows }
    });
  }

  return res.status(200).json({ success: true, message: 'Invoices synced', count: rows.length });
}

// ===== LOAD ALL =====
async function loadAll(sheets, sheetId, res) {
  const [entriesRes, invoicesRes] = await Promise.all([
    sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range: 'Entries!A:T' }),
    sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range: 'Invoices!A:AD' })  // Extended to include paidStatus, paidDate
  ]);

  const entriesRows = entriesRes.data.values || [];
  const invoicesRows = invoicesRes.data.values || [];

  const entries = entriesRows
    .filter(row => row[0] && row[0] !== 'id')
    .map(row => {
      const obj = {};
      ENTRY_COLUMNS.forEach((col, i) => {
        let val = row[i];
        if (['pts', 'uPrice', 'aoAmt', 'aoPatients', 'gross', 'comm', 'commAmt'].includes(col)) {
          val = parseFloat(val) || 0;
        }
        if (col === 'svcs' && val) {
          try { val = JSON.parse(val); } catch(e) {}
        }
        obj[col] = val || (col === 'pts' ? 0 : '');
      });
      return obj;
    });

  // Get headers from first row to map columns dynamically
  const invoiceHeaders = invoicesRows[0] || INVOICE_COLUMNS;

  // Debug: Log header info for paidStatus
  const paidStatusIdx = invoiceHeaders.indexOf('paidStatus');
  const paidDateIdx = invoiceHeaders.indexOf('paidDate');
  console.log('[loadAll] Invoice headers count:', invoiceHeaders.length);
  console.log('[loadAll] paidStatus at index:', paidStatusIdx, 'paidDate at index:', paidDateIdx);

  const invoices = invoicesRows
    .filter((row, idx) => idx > 0 && row[0] && row[0] !== 'num')
    .map(row => {
      const obj = {};
      // Pad row to match header length (Google Sheets API omits trailing empty cells)
      while (row.length < invoiceHeaders.length) {
        row.push('');
      }
      invoiceHeaders.forEach((col, i) => {
        if (!col) return; // Skip empty header columns
        let val = row[i];
        if (['amount', 'gross', 'airTotal'].includes(col)) {
          val = parseFloat(val) || 0;
        }
        if (col === 'isAdhoc') {
          val = val === 'true' || val === true;
        }
        if ((col === 'svcs' || col === 'addons') && val) {
          try { val = JSON.parse(val); } catch(e) {}
        }
        obj[col] = val || '';
      });
      // Debug: Log paidStatus for each invoice
      console.log('[loadAll] Invoice', obj.num, 'row length:', row.length, 'paidStatus:', obj.paidStatus || '(empty)', 'paidDate:', obj.paidDate || '(empty)');
      return obj;
    });

  return res.status(200).json({
    success: true,
    entries,
    invoices,
    entriesCount: entries.length,
    invoicesCount: invoices.length
  });
}

// ===== PRACTICES =====
// Syncs practices to BOTH sheets (practices are shared across entities)
async function syncPractices(sheets, sheetId, { practices }, res) {
  console.log('[syncPractices] Received practices:', practices ? practices.length : 'null/undefined');
  if (practices && practices.length > 0) {
    console.log('[syncPractices] Practice types:', practices.map(p => `${p.id}:${p.type}`).join(', '));
  }

  if (!practices || !practices.length) {
    return res.status(200).json({ success: true, message: 'No practices to sync', count: 0 });
  }

  const rows = practices.map(p =>
    PRACTICE_COLUMNS.map(col => {
      if (col === 'createdAt') return p.createdAt || new Date().toISOString();
      const val = p[col];
      if (val === null || val === undefined) return '';
      if (typeof val === 'object') return JSON.stringify(val);
      return val;
    })
  );

  console.log('[syncPractices] Built', rows.length, 'rows');
  console.log('[syncPractices] Row IDs:', rows.map(r => r[0]).join(', '));

  // Helper to sync to a single sheet and apply colors
  async function syncToSheet(targetSheetId) {
    // Clear all data from row 1 onwards (including header to fix column structure)
    await sheets.spreadsheets.values.clear({
      spreadsheetId: targetSheetId,
      range: 'Practices!A1:Q100',
    });

    // Clear formatting for rows 2-100 to remove any leftover colored rows
    try {
      const metadata = await sheets.spreadsheets.get({ spreadsheetId: targetSheetId });
      const sheet = metadata.data.sheets.find(s => s.properties.title === 'Practices');
      if (sheet) {
        await sheets.spreadsheets.batchUpdate({
          spreadsheetId: targetSheetId,
          requestBody: {
            requests: [{
              repeatCell: {
                range: {
                  sheetId: sheet.properties.sheetId,
                  startRowIndex: 1, // Row 2 (0-indexed)
                  endRowIndex: 100,
                  startColumnIndex: 0,
                  endColumnIndex: 17  // Columns A-Q (17 columns)
                },
                cell: {
                  userEnteredFormat: {
                    backgroundColor: { red: 1, green: 1, blue: 1 } // White
                  }
                },
                fields: 'userEnteredFormat.backgroundColor'
              }
            }]
          }
        });
      }
    } catch (e) {
      console.log('Could not clear formatting:', e.message);
    }

    // Always write header row first with current column structure
    await sheets.spreadsheets.values.update({
      spreadsheetId: targetSheetId,
      range: 'Practices!A1:Q1',
      valueInputOption: 'RAW',
      requestBody: { values: [PRACTICE_COLUMNS] }
    });

    if (rows.length > 0) {
      // Write data rows starting at A2
      await sheets.spreadsheets.values.update({
        spreadsheetId: targetSheetId,
        range: `Practices!A2:Q${rows.length + 1}`,
        valueInputOption: 'RAW',
        requestBody: { values: rows }
      });

      // Apply color coding to each practice row
      for (let i = 0; i < practices.length; i++) {
        const p = practices[i];
        const colorScheme = getPracticeColor(p.id, p.type, p.color);
        await applyRowColor(sheets, targetSheetId, 'Practices', i + 1, colorScheme); // +1 for header row
      }
    }
  }

  // Sync to both sheets in parallel
  const syncPromises = [syncToSheet(SHEET_IDS.self)];
  if (SHEET_IDS.ltd && SHEET_IDS.ltd !== SHEET_IDS.self) {
    syncPromises.push(syncToSheet(SHEET_IDS.ltd));
  }

  await Promise.all(syncPromises);

  return res.status(200).json({ success: true, message: 'Practices synced to both sheets', count: rows.length });
}

async function loadPractices(sheets, sheetId, res) {
  console.log('[loadPractices] Loading from sheet:', sheetId);
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: 'Practices!A:Q',
  });

  const rows = response.data.values || [];
  console.log('[loadPractices] Raw rows count:', rows.length);
  console.log('[loadPractices] Raw rows (first 5):', JSON.stringify(rows.slice(0, 5)));

  // Get header row to determine column positions dynamically
  // This handles column order changes gracefully
  const headerRow = rows[0] || [];
  console.log('[loadPractices] Header row:', headerRow);

  const practices = rows
    .filter(row => row[0] && row[0] !== 'id')
    .map(row => {
      const obj = {};
      // Map each header to its value in this row
      headerRow.forEach((colName, i) => {
        let val = row[i];
        if (['comm', 'rate', 'air', 'ptsPerHour', 'paymentDueDay'].includes(colName)) val = parseFloat(val) || 0;
        if (colName === 'active') val = val === '' ? true : (val === 'true' || val === true);
        if ((colName === 'services' || colName === 'days' || colName === 'paidHours') && val) {
          try { val = JSON.parse(val); } catch(e) {}
        }
        obj[colName] = val !== undefined ? val : '';
      });
      return obj;
    });

  console.log('[loadPractices] Parsed practices:', practices.map(p => ({ id: p.id, type: p.type, name: p.name, services: typeof p.services })));
  return res.status(200).json({ success: true, practices, count: practices.length });
}

// ===== SETTINGS =====
// Settings are split: entity-specific (nextInv only) vs shared (dayMap, ahPrac, payTerms, entities, defComm, etc.)
// Shared settings are mirrored to both sheets so both entities have access to all configurations
const SHARED_SETTINGS_KEYS = ['dayMap', 'ahPrac', 'payTerms', 'invoiceFooter', 'entities', 'defComm'];
const ENTITY_SPECIFIC_KEYS = ['nextInv'];

async function syncSettings(sheets, sheetId, { settings, entity }, res) {
  if (!settings || Object.keys(settings).length === 0) {
    return res.status(200).json({ success: true, message: 'No settings to sync', count: 0 });
  }

  // Separate entity-specific vs shared settings
  const entitySpecificSettings = {};
  const sharedSettings = {};

  Object.entries(settings).forEach(([key, value]) => {
    if (ENTITY_SPECIFIC_KEYS.includes(key)) {
      entitySpecificSettings[key] = value;
    } else if (SHARED_SETTINGS_KEYS.includes(key)) {
      sharedSettings[key] = value;
    } else {
      // Default to entity-specific for unknown keys
      entitySpecificSettings[key] = value;
    }
  });

  // Helper to build rows from settings object
  const buildRows = (settingsObj) => Object.entries(settingsObj).map(([key, value]) => [
    key,
    typeof value === 'object' ? JSON.stringify(value) : String(value),
    new Date().toISOString()
  ]);

  // Helper to sync settings to a sheet (merge, don't replace all)
  async function syncToSheet(targetSheetId, settingsToSync) {
    if (Object.keys(settingsToSync).length === 0) return;

    // First, load existing settings
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: targetSheetId,
      range: 'Settings!A:C',
    });

    const existingRows = response.data.values || [];
    const existingSettings = {};
    existingRows
      .filter(row => row[0] && row[0] !== 'key')
      .forEach(row => {
        existingSettings[row[0]] = row[1];
      });

    // Merge new settings into existing
    Object.entries(settingsToSync).forEach(([key, value]) => {
      existingSettings[key] = typeof value === 'object' ? JSON.stringify(value) : String(value);
    });

    // Write back all settings
    const rows = Object.entries(existingSettings).map(([key, value]) => [
      key,
      value,
      new Date().toISOString()
    ]);

    // Clear data rows (not header)
    await sheets.spreadsheets.values.clear({
      spreadsheetId: targetSheetId,
      range: 'Settings!A2:C',
    });

    if (rows.length > 0) {
      // Use update with explicit range starting at A2 to avoid header issues
      await sheets.spreadsheets.values.update({
        spreadsheetId: targetSheetId,
        range: `Settings!A2:C${rows.length + 1}`,
        valueInputOption: 'RAW',
        requestBody: { values: rows }
      });
    }
  }

  // Determine which sheet we're syncing to
  const isSelfSheet = sheetId === SHEET_IDS.self;
  const isLtdSheet = sheetId === SHEET_IDS.ltd;
  const otherSheetId = isSelfSheet ? SHEET_IDS.ltd : SHEET_IDS.self;

  // Sync to the CURRENT entity's sheet: entity-specific + shared settings together
  const currentSheetSettings = { ...entitySpecificSettings, ...sharedSettings };
  if (Object.keys(currentSheetSettings).length > 0) {
    await syncToSheet(sheetId, currentSheetSettings);
  }

  // Sync shared settings ONLY to the OTHER sheet (if different)
  if (Object.keys(sharedSettings).length > 0 && otherSheetId && otherSheetId !== sheetId) {
    await syncToSheet(otherSheetId, sharedSettings);
  }

  return res.status(200).json({
    success: true,
    message: 'Settings synced',
    entitySpecificCount: Object.keys(entitySpecificSettings).length,
    sharedCount: Object.keys(sharedSettings).length
  });
}

async function loadSettings(sheets, sheetId, res) {
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: 'Settings!A:C',
  });

  const rows = response.data.values || [];
  const settings = {};
  rows
    .filter(row => row[0] && row[0] !== 'key')
    .forEach(row => {
      let val = row[1];
      try { val = JSON.parse(val); } catch(e) {}
      settings[row[0]] = val;
    });

  return res.status(200).json({ success: true, settings });
}

// ===== DASHBOARD =====
async function getDashboard(sheets, sheetId, res) {
  const [entriesRes, invoicesRes] = await Promise.all([
    sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range: 'Entries!A:T' }),
    sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range: 'Invoices!A:AD' })
  ]);

  const entriesRows = entriesRes.data.values || [];
  const invoicesRows = invoicesRes.data.values || [];

  // Parse entries
  const entries = entriesRows
    .filter(row => row[0] && row[0] !== 'id')
    .map(row => ({
      date: row[1],
      pName: row[3],
      gross: parseFloat(row[11]) || 0,
      commAmt: parseFloat(row[13]) || 0
    }));

  // Parse invoices
  const invoices = invoicesRows
    .filter(row => row[0] && row[0] !== 'num')
    .map(row => ({
      num: row[0],
      date: row[1],
      practice: row[2],
      amount: parseFloat(row[14]) || 0,
      gross: parseFloat(row[15]) || 0
    }));

  const now = new Date();
  const currentYear = now.getFullYear();
  const currentMonth = now.getMonth();
  const currentWeekStart = new Date(now);
  currentWeekStart.setDate(now.getDate() - now.getDay());
  currentWeekStart.setHours(0, 0, 0, 0);

  // Calculate totals
  let weeklyGross = 0, weeklyComm = 0, weeklyEntries = 0;
  let monthlyGross = 0, monthlyComm = 0, monthlyEntries = 0;
  let ytdGross = 0, ytdComm = 0, ytdEntries = 0;
  const practiceBreakdown = {};

  entries.forEach(e => {
    const d = new Date(e.date);
    if (isNaN(d.getTime())) return;

    // YTD
    if (d.getFullYear() === currentYear) {
      ytdGross += e.gross;
      ytdComm += e.commAmt;
      ytdEntries++;
    }

    // Monthly
    if (d.getFullYear() === currentYear && d.getMonth() === currentMonth) {
      monthlyGross += e.gross;
      monthlyComm += e.commAmt;
      monthlyEntries++;
    }

    // Weekly
    if (d >= currentWeekStart) {
      weeklyGross += e.gross;
      weeklyComm += e.commAmt;
      weeklyEntries++;
    }

    // Practice breakdown (YTD)
    if (d.getFullYear() === currentYear) {
      if (!practiceBreakdown[e.pName]) {
        practiceBreakdown[e.pName] = { gross: 0, comm: 0, entries: 0 };
      }
      practiceBreakdown[e.pName].gross += e.gross;
      practiceBreakdown[e.pName].comm += e.commAmt;
      practiceBreakdown[e.pName].entries++;
    }
  });

  // Invoice totals
  let weeklyInvoiced = 0, monthlyInvoiced = 0, ytdInvoiced = 0;
  invoices.forEach(inv => {
    const d = new Date(inv.date);
    if (isNaN(d.getTime())) return;

    if (d.getFullYear() === currentYear) ytdInvoiced += inv.amount;
    if (d.getFullYear() === currentYear && d.getMonth() === currentMonth) monthlyInvoiced += inv.amount;
    if (d >= currentWeekStart) weeklyInvoiced += inv.amount;
  });

  // Update Dashboard sheet
  const dashboardData = [
    ['Metric', 'Weekly', 'Monthly', 'YTD'],
    ['Gross Revenue', weeklyGross.toFixed(2), monthlyGross.toFixed(2), ytdGross.toFixed(2)],
    ['Commission Earned', weeklyComm.toFixed(2), monthlyComm.toFixed(2), ytdComm.toFixed(2)],
    ['Amount Invoiced', weeklyInvoiced.toFixed(2), monthlyInvoiced.toFixed(2), ytdInvoiced.toFixed(2)],
    ['Patient Entries', weeklyEntries, monthlyEntries, ytdEntries],
    ['Total Invoices', '', '', invoices.length],
    [],
    ['Practice Breakdown (YTD)', 'Gross', 'Commission', 'Entries'],
    ...Object.entries(practiceBreakdown).map(([name, data]) => [
      name, data.gross.toFixed(2), data.comm.toFixed(2), data.entries
    ])
  ];

  await sheets.spreadsheets.values.update({
    spreadsheetId: sheetId,
    range: 'Dashboard!A1:D50',
    valueInputOption: 'RAW',
    requestBody: { values: dashboardData }
  });

  return res.status(200).json({
    success: true,
    dashboard: {
      weekly: { gross: weeklyGross, commission: weeklyComm, invoiced: weeklyInvoiced, entries: weeklyEntries },
      monthly: { gross: monthlyGross, commission: monthlyComm, invoiced: monthlyInvoiced, entries: monthlyEntries },
      ytd: { gross: ytdGross, commission: ytdComm, invoiced: ytdInvoiced, entries: ytdEntries },
      practiceBreakdown,
      totalInvoices: invoices.length
    }
  });
}

// ===== RENAME SHEET =====
async function renameSheet(sheets, sheetId, { title }, res) {
  if (!title) {
    return res.status(400).json({ error: 'Missing title' });
  }

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: sheetId,
    requestBody: {
      requests: [{
        updateSpreadsheetProperties: {
          properties: { title },
          fields: 'title'
        }
      }]
    }
  });

  return res.status(200).json({ success: true, message: `Sheet renamed to: ${title}` });
}

// ===== SETUP LOG TAB =====
async function setupLogTab(sheets, sheetId, res) {
  try {
    // First check if Log tab exists, if not create it
    const sheetMetadata = await sheets.spreadsheets.get({ spreadsheetId: sheetId });
    const logSheet = sheetMetadata.data.sheets.find(s => s.properties.title === 'Log');

    if (!logSheet) {
      // Create the Log tab
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: sheetId,
        requestBody: {
          requests: [{
            addSheet: {
              properties: { title: 'Log' }
            }
          }]
        }
      });
    }

    // Add headers
    await sheets.spreadsheets.values.update({
      spreadsheetId: sheetId,
      range: 'Log!A1:G1',
      valueInputOption: 'RAW',
      requestBody: { values: [LOG_COLUMNS] }
    });

    return res.status(200).json({ success: true, message: 'Log tab setup complete' });
  } catch (e) {
    return res.status(500).json({ error: 'Failed to setup Log tab', message: e.message });
  }
}

// ===== SETUP ALL TABS =====
// Ensures all tabs exist with correct headers in both Self and Ltd sheets
async function setupAllTabs(sheets, res) {
  const results = { self: {}, ltd: {} };

  // Define all tabs with their headers
  const TABS = [
    { name: 'Entries', columns: ENTRY_COLUMNS, range: 'A:T' },
    { name: 'Invoices', columns: INVOICE_COLUMNS, range: 'A:AA' },
    { name: 'Practices', columns: PRACTICE_COLUMNS, range: 'A:P' },
    { name: 'Settings', columns: SETTINGS_COLUMNS, range: 'A:C' },
    { name: 'Log', columns: LOG_COLUMNS, range: 'A:G' },
    { name: 'Trash', columns: TRASH_COLUMNS, range: 'A:C' }
  ];

  async function setupSheet(sheetId, sheetName) {
    const tabResults = {};

    for (const tab of TABS) {
      try {
        // Check if tab exists
        const metadata = await sheets.spreadsheets.get({ spreadsheetId: sheetId });
        const existingTab = metadata.data.sheets.find(s => s.properties.title === tab.name);

        if (!existingTab) {
          // Create the tab
          await sheets.spreadsheets.batchUpdate({
            spreadsheetId: sheetId,
            requestBody: {
              requests: [{
                addSheet: {
                  properties: { title: tab.name }
                }
              }]
            }
          });
          tabResults[tab.name] = 'created';
        } else {
          tabResults[tab.name] = 'exists';
        }

        // Check current headers
        const headerResponse = await sheets.spreadsheets.values.get({
          spreadsheetId: sheetId,
          range: `${tab.name}!1:1`,
        });

        const currentHeaders = headerResponse.data.values?.[0] || [];
        const expectedHeaders = tab.columns;

        // Compare headers
        const headersMatch = expectedHeaders.every((col, i) => currentHeaders[i] === col);

        if (!headersMatch || currentHeaders.length !== expectedHeaders.length) {
          // Update headers - handle columns beyond Z (AA, AB, etc.)
          const colCount = expectedHeaders.length;
          let endCol;
          if (colCount <= 26) {
            endCol = String.fromCharCode(64 + colCount);
          } else {
            // For columns beyond Z: AA=27, AB=28, etc.
            const firstLetter = String.fromCharCode(64 + Math.floor((colCount - 1) / 26));
            const secondLetter = String.fromCharCode(64 + ((colCount - 1) % 26) + 1);
            endCol = firstLetter + secondLetter;
          }
          await sheets.spreadsheets.values.update({
            spreadsheetId: sheetId,
            range: `${tab.name}!A1:${endCol}1`,
            valueInputOption: 'RAW',
            requestBody: { values: [expectedHeaders] }
          });
          tabResults[tab.name] = tabResults[tab.name] === 'created' ? 'created+headers' : 'headers_fixed';
        }
      } catch (e) {
        tabResults[tab.name] = `error: ${e.message}`;
      }
    }

    return tabResults;
  }

  // Setup both sheets
  try {
    if (SHEET_IDS.self) {
      results.self = await setupSheet(SHEET_IDS.self, 'Self-Employed');
    }
    if (SHEET_IDS.ltd && SHEET_IDS.ltd !== SHEET_IDS.self) {
      results.ltd = await setupSheet(SHEET_IDS.ltd, 'Ltd Company');
    }

    return res.status(200).json({
      success: true,
      message: 'All tabs setup complete',
      results
    });
  } catch (e) {
    return res.status(500).json({
      error: 'Failed to setup tabs',
      message: e.message,
      results
    });
  }
}
