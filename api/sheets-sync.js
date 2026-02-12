// Google Sheets sync endpoint
// Actions: append_entry, append_invoice, update_entry, delete_entry, load_all, etc.

const { google } = require('googleapis');

// Initialize Google Sheets client
async function getSheets() {
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

const SHEET_ID = process.env.GOOGLE_SHEET_ID;

// Column mappings for Entries sheet
const ENTRY_COLUMNS = ['id', 'date', 'pId', 'pName', 'pType', 'svc', 'pts', 'uPrice', 'aoType', 'aoAmt', 'aoPatients', 'gross', 'comm', 'commAmt', 'entity', 'invSt', 'invNo', 'adhocAddr', 'createdAt'];

// Column mappings for Invoices sheet
const INVOICE_COLUMNS = ['num', 'date', 'practice', 'practiceName', 'practiceAddr', 'period', 'entity', 'entName', 'entAddr', 'entPhone', 'bankName', 'bankAccName', 'bankAcc', 'bankSort', 'amount', 'gross', 'commRate', 'svcs', 'airTotal', 'logoType', 'payTerms', 'isAdhoc', 'driveLink', 'createdAt'];

module.exports = async (req, res) => {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { action, data } = req.body;

  try {
    const sheets = await getSheets();

    switch (action) {
      case 'append_entry':
        return await appendEntry(sheets, data, res);

      case 'append_invoice':
        return await appendInvoice(sheets, data, res);

      case 'update_entry':
        return await updateEntry(sheets, data, res);

      case 'delete_entry':
        return await deleteEntry(sheets, data, res);

      case 'load_all':
        return await loadAll(sheets, res);

      case 'update_invoice':
        return await updateInvoice(sheets, data, res);

      case 'sync_entries':
        return await syncEntries(sheets, data, res);

      case 'sync_invoices':
        return await syncInvoices(sheets, data, res);

      default:
        return res.status(400).json({ error: `Unknown action: ${action}` });
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

// Append a new entry to Entries sheet
async function appendEntry(sheets, entry, res) {
  const row = ENTRY_COLUMNS.map(col => {
    if (col === 'createdAt') return new Date().toISOString();
    const val = entry[col];
    if (val === null || val === undefined) return '';
    if (typeof val === 'object') return JSON.stringify(val);
    return val;
  });

  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: 'Entries!A:S',
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [row] }
  });

  return res.status(200).json({ success: true, message: 'Entry appended', id: entry.id });
}

// Append a new invoice to Invoices sheet
async function appendInvoice(sheets, invoice, res) {
  const row = INVOICE_COLUMNS.map(col => {
    if (col === 'createdAt') return new Date().toISOString();
    const val = invoice[col];
    if (val === null || val === undefined) return '';
    if (typeof val === 'object') return JSON.stringify(val);
    return val;
  });

  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: 'Invoices!A:X',
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [row] }
  });

  return res.status(200).json({ success: true, message: 'Invoice appended', num: invoice.num });
}

// Update an existing entry
async function updateEntry(sheets, { id, updates }, res) {
  // First, find the row with this ID
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: 'Entries!A:S',
  });

  const rows = response.data.values || [];
  const rowIndex = rows.findIndex(row => row[0] === id);

  if (rowIndex === -1) {
    return res.status(404).json({ error: 'Entry not found', id });
  }

  // Update the row with new values
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

  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `Entries!A${rowIndex + 1}:S${rowIndex + 1}`,
    valueInputOption: 'RAW',
    requestBody: { values: [updatedRow] }
  });

  return res.status(200).json({ success: true, message: 'Entry updated', id });
}

// Delete an entry
async function deleteEntry(sheets, { id }, res) {
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: 'Entries!A:S',
  });

  const rows = response.data.values || [];
  const rowIndex = rows.findIndex(row => row[0] === id);

  if (rowIndex === -1) {
    return res.status(404).json({ error: 'Entry not found', id });
  }

  // Get sheet ID for Entries
  const sheetMetadata = await sheets.spreadsheets.get({
    spreadsheetId: SHEET_ID,
  });

  const entriesSheet = sheetMetadata.data.sheets.find(s => s.properties.title === 'Entries');
  if (!entriesSheet) {
    return res.status(500).json({ error: 'Entries sheet not found' });
  }

  // Delete the row
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SHEET_ID,
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

  return res.status(200).json({ success: true, message: 'Entry deleted', id });
}

// Load all data from sheets
async function loadAll(sheets, res) {
  const [entriesRes, invoicesRes] = await Promise.all([
    sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: 'Entries!A:S',
    }),
    sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: 'Invoices!A:X',
    })
  ]);

  const entriesRows = entriesRes.data.values || [];
  const invoicesRows = invoicesRes.data.values || [];

  // Convert rows to objects (skip header row if present)
  const entries = entriesRows
    .filter(row => row[0] && row[0] !== 'id')
    .map(row => {
      const obj = {};
      ENTRY_COLUMNS.forEach((col, i) => {
        let val = row[i];
        // Parse numbers
        if (['pts', 'uPrice', 'aoAmt', 'aoPatients', 'gross', 'comm', 'commAmt'].includes(col)) {
          val = parseFloat(val) || 0;
        }
        // Parse JSON objects
        if (col === 'svcs' && val) {
          try { val = JSON.parse(val); } catch(e) {}
        }
        obj[col] = val || (col === 'pts' ? 0 : '');
      });
      return obj;
    });

  const invoices = invoicesRows
    .filter(row => row[0] && row[0] !== 'num')
    .map(row => {
      const obj = {};
      INVOICE_COLUMNS.forEach((col, i) => {
        let val = row[i];
        // Parse numbers
        if (['amount', 'gross', 'airTotal'].includes(col)) {
          val = parseFloat(val) || 0;
        }
        // Parse booleans
        if (col === 'isAdhoc') {
          val = val === 'true' || val === true;
        }
        // Parse JSON objects
        if (col === 'svcs' && val) {
          try { val = JSON.parse(val); } catch(e) {}
        }
        obj[col] = val || '';
      });
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

// Update an invoice (e.g., add drive link)
async function updateInvoice(sheets, { num, updates }, res) {
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: 'Invoices!A:X',
  });

  const rows = response.data.values || [];
  const rowIndex = rows.findIndex(row => row[0] === num || row[0] === String(num));

  if (rowIndex === -1) {
    return res.status(404).json({ error: 'Invoice not found', num });
  }

  const currentRow = rows[rowIndex];
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
    spreadsheetId: SHEET_ID,
    range: `Invoices!A${rowIndex + 1}:X${rowIndex + 1}`,
    valueInputOption: 'RAW',
    requestBody: { values: [updatedRow] }
  });

  return res.status(200).json({ success: true, message: 'Invoice updated', num });
}

// Bulk sync entries (for initial migration)
async function syncEntries(sheets, { entries }, res) {
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

  // Clear existing data (except header) and write new
  await sheets.spreadsheets.values.clear({
    spreadsheetId: SHEET_ID,
    range: 'Entries!A2:S',
  });

  if (rows.length > 0) {
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: 'Entries!A:S',
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: rows }
    });
  }

  return res.status(200).json({ success: true, message: 'Entries synced', count: rows.length });
}

// Bulk sync invoices (for initial migration)
async function syncInvoices(sheets, { invoices }, res) {
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
    spreadsheetId: SHEET_ID,
    range: 'Invoices!A2:X',
  });

  if (rows.length > 0) {
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: 'Invoices!A:X',
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: rows }
    });
  }

  return res.status(200).json({ success: true, message: 'Invoices synced', count: rows.length });
}
