// Google Sheets sync endpoint
// Actions: append_entry, append_invoice, update_entry, delete_entry, load_all, etc.
// Supports dual sheets: Self-Employed and Ltd Company

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
const ENTRY_COLUMNS = ['id', 'date', 'pId', 'pName', 'pType', 'svc', 'pts', 'uPrice', 'aoType', 'aoAmt', 'aoPatients', 'gross', 'comm', 'commAmt', 'entity', 'invSt', 'invNo', 'adhocAddr', 'createdAt'];
const INVOICE_COLUMNS = ['num', 'date', 'practice', 'practiceName', 'practiceAddr', 'period', 'entity', 'entName', 'entAddr', 'entPhone', 'bankName', 'bankAccName', 'bankAcc', 'bankSort', 'amount', 'gross', 'commRate', 'svcs', 'airTotal', 'logoType', 'payTerms', 'isAdhoc', 'driveLink', 'createdAt'];
const PRACTICE_COLUMNS = ['id', 'short', 'name', 'type', 'addr', 'comm', 'services', 'createdAt'];
const SETTINGS_COLUMNS = ['key', 'value', 'updatedAt'];
const LOG_COLUMNS = ['timestamp', 'action', 'dataType', 'recordId', 'changes', 'previousData', 'newData'];

// ===== AUDIT LOG =====
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
      case 'delete_entry': return await deleteEntry(sheets, sheetId, data, res);
      case 'load_all': return await loadAll(sheets, sheetId, res);
      case 'update_invoice': return await updateInvoice(sheets, sheetId, data, res);
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
    range: 'Entries!A:S',
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [row] }
  });

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
    range: 'Entries!A:S',
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
    range: `Entries!A${rowIndex + 1}:S${rowIndex + 1}`,
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

async function deleteEntry(sheets, sheetId, { id }, res) {
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: 'Entries!A:S',
  });

  const rows = response.data.values || [];
  const rowIndex = rows.findIndex(row => row[0] === id);

  if (rowIndex === -1) {
    return res.status(404).json({ error: 'Entry not found', id });
  }

  // Store the data before deletion for the log
  const deletedRow = rows[rowIndex];
  const deletedData = {};
  ENTRY_COLUMNS.forEach((col, i) => { deletedData[col] = deletedRow[i] || ''; });

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
    changes: `Deleted entry: ${deletedData.pName} - ${deletedData.svc} - ${deletedData.pts} pts - £${deletedData.gross}`,
    previousData: deletedData
  });

  return res.status(200).json({ success: true, message: 'Entry deleted', id });
}

async function deleteInvoice(sheets, sheetId, { num }, res) {
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: 'Invoices!A:X',
  });

  const rows = response.data.values || [];
  const rowIndex = rows.findIndex(row => row[0] === num || row[0] === String(num));

  if (rowIndex === -1) {
    return res.status(404).json({ error: 'Invoice not found', num });
  }

  // Store the data before deletion for the log
  const deletedRow = rows[rowIndex];
  const deletedData = {};
  INVOICE_COLUMNS.forEach((col, i) => { deletedData[col] = deletedRow[i] || ''; });

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
  await writeLog(sheets, sheetId, {
    action: 'DELETE',
    dataType: 'invoice',
    recordId: num,
    changes: `Deleted invoice: #${num} - ${deletedData.practice} - £${deletedData.amount}`,
    previousData: deletedData
  });

  return res.status(200).json({ success: true, message: 'Invoice deleted', num });
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
    range: 'Entries!A2:S',
  });

  if (rows.length > 0) {
    await sheets.spreadsheets.values.append({
      spreadsheetId: sheetId,
      range: 'Entries!A:S',
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
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
    range: 'Invoices!A:X',
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [row] }
  });

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
    range: 'Invoices!A:X',
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
    range: `Invoices!A${rowIndex + 1}:X${rowIndex + 1}`,
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
    range: 'Invoices!A2:X',
  });

  if (rows.length > 0) {
    await sheets.spreadsheets.values.append({
      spreadsheetId: sheetId,
      range: 'Invoices!A:X',
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: rows }
    });
  }

  return res.status(200).json({ success: true, message: 'Invoices synced', count: rows.length });
}

// ===== LOAD ALL =====
async function loadAll(sheets, sheetId, res) {
  const [entriesRes, invoicesRes] = await Promise.all([
    sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range: 'Entries!A:S' }),
    sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range: 'Invoices!A:X' })
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

  const invoices = invoicesRows
    .filter(row => row[0] && row[0] !== 'num')
    .map(row => {
      const obj = {};
      INVOICE_COLUMNS.forEach((col, i) => {
        let val = row[i];
        if (['amount', 'gross', 'airTotal'].includes(col)) {
          val = parseFloat(val) || 0;
        }
        if (col === 'isAdhoc') {
          val = val === 'true' || val === true;
        }
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

// ===== PRACTICES =====
async function syncPractices(sheets, sheetId, { practices }, res) {
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

  await sheets.spreadsheets.values.clear({
    spreadsheetId: sheetId,
    range: 'Practices!A2:H',
  });

  if (rows.length > 0) {
    await sheets.spreadsheets.values.append({
      spreadsheetId: sheetId,
      range: 'Practices!A:H',
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: rows }
    });
  }

  return res.status(200).json({ success: true, message: 'Practices synced', count: rows.length });
}

async function loadPractices(sheets, sheetId, res) {
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: 'Practices!A:H',
  });

  const rows = response.data.values || [];
  const practices = rows
    .filter(row => row[0] && row[0] !== 'id')
    .map(row => {
      const obj = {};
      PRACTICE_COLUMNS.forEach((col, i) => {
        let val = row[i];
        if (col === 'comm') val = parseFloat(val) || 0;
        if (col === 'services' && val) {
          try { val = JSON.parse(val); } catch(e) {}
        }
        obj[col] = val || '';
      });
      return obj;
    });

  return res.status(200).json({ success: true, practices, count: practices.length });
}

// ===== SETTINGS =====
async function syncSettings(sheets, sheetId, { settings }, res) {
  if (!settings || Object.keys(settings).length === 0) {
    return res.status(200).json({ success: true, message: 'No settings to sync', count: 0 });
  }

  const rows = Object.entries(settings).map(([key, value]) => [
    key,
    typeof value === 'object' ? JSON.stringify(value) : String(value),
    new Date().toISOString()
  ]);

  await sheets.spreadsheets.values.clear({
    spreadsheetId: sheetId,
    range: 'Settings!A2:C',
  });

  if (rows.length > 0) {
    await sheets.spreadsheets.values.append({
      spreadsheetId: sheetId,
      range: 'Settings!A:C',
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: rows }
    });
  }

  return res.status(200).json({ success: true, message: 'Settings synced', count: rows.length });
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
    sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range: 'Entries!A:S' }),
    sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range: 'Invoices!A:X' })
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
