/**
 * POST /api/admin/import
 *
 * Admin endpoint for importing historical data into a user's sheet.
 * Supports importing entries from CSV/JSON format.
 *
 * Requires admin authentication.
 */

const { google } = require('googleapis');
const {validateSession, isAdmin, findUserById, applyCors, getAuthClient } = require('../_lib/auth');

module.exports = async function handler(req, res) {
  // CORS headers
  applyCors(req, res, 'POST, OPTIONS');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // Validate admin session
    const session = await validateSession(req);
    if (!session) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    if (!isAdmin(session.email)) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const { userId, dataType, data, options = {} } = req.body;

    if (!userId) {
      return res.status(400).json({ error: 'userId is required' });
    }

    if (!dataType) {
      return res.status(400).json({ error: 'dataType is required (entries, invoices, or practices)' });
    }

    if (!data || !Array.isArray(data) || data.length === 0) {
      return res.status(400).json({ error: 'data must be a non-empty array' });
    }

    // Get user's sheet ID
    const user = await findUserById(userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    if (!user.sheetId) {
      return res.status(400).json({ error: 'User does not have a sheet configured' });
    }

    const auth = getAuthClient();
    const sheets = google.sheets({ version: 'v4', auth });

    let imported = 0;
    let skipped = 0;
    let errors = [];

    if (dataType === 'entries') {
      const result = await importEntries(sheets, user.sheetId, data, options);
      imported = result.imported;
      skipped = result.skipped;
      errors = result.errors;

    } else if (dataType === 'invoices') {
      const result = await importInvoices(sheets, user.sheetId, data, options);
      imported = result.imported;
      skipped = result.skipped;
      errors = result.errors;

    } else if (dataType === 'practices') {
      const result = await importPractices(sheets, user.sheetId, data, options);
      imported = result.imported;
      skipped = result.skipped;
      errors = result.errors;

    } else {
      return res.status(400).json({ error: 'Invalid dataType. Must be entries, invoices, or practices' });
    }

    // Log admin action
    const masterSheetId = process.env.MASTER_SHEET_ID;
    if (masterSheetId) {
      await logImportAction(sheets, masterSheetId, session.userId, userId, dataType, {
        total: data.length,
        imported,
        skipped,
        errors: errors.length
      });
    }

    return res.status(200).json({
      success: true,
      summary: {
        total: data.length,
        imported,
        skipped,
        errors: errors.length
      },
      errors: errors.slice(0, 10) // Limit error details in response
    });

  } catch (error) {
    console.error('Admin import error:', error);
    return res.status(500).json({
      error: 'Failed to import data',
      details: error.message
    });
  }
};

/**
 * Import entries to user's sheet
 */
async function importEntries(sheets, sheetId, data, options) {
  const imported = [];
  const skipped = [];
  const errors = [];

  // Expected entry fields
  const entryFields = [
    'id', 'date', 'pId', 'pName', 'pType', 'svc', 'pts', 'uPrice',
    'aoType', 'aoAmt', 'aoPatients', 'gross', 'comm', 'commAmt',
    'entity', 'invSt', 'invNo', 'adhocAddr', 'color', 'createdAt'
  ];

  // Get existing entries to check for duplicates
  let existingIds = new Set();
  if (!options.skipDuplicateCheck) {
    try {
      const existing = await sheets.spreadsheets.values.get({
        spreadsheetId: sheetId,
        range: 'Entries!A:A',
      });
      const rows = existing.data.values || [];
      rows.slice(1).forEach(row => {
        if (row[0]) existingIds.add(row[0]);
      });
    } catch (e) {
      // If sheet doesn't exist or error, continue without duplicate check
    }
  }

  for (let i = 0; i < data.length; i++) {
    const entry = data[i];

    try {
      // Validate required fields
      if (!entry.date || !entry.pId) {
        errors.push({ index: i, error: 'Missing required fields (date, pId)' });
        continue;
      }

      // Generate ID if not provided
      const id = entry.id || `L${Date.now()}${i}`;

      // Check for duplicate
      if (existingIds.has(id)) {
        skipped.push(i);
        continue;
      }

      // Build row in correct order
      const row = entryFields.map(field => {
        if (field === 'id') return id;
        if (field === 'createdAt' && !entry.createdAt) return new Date().toISOString();
        return entry[field] ?? '';
      });

      imported.push(row);
      existingIds.add(id);

    } catch (e) {
      errors.push({ index: i, error: e.message });
    }
  }

  // Batch append imported entries
  if (imported.length > 0) {
    await sheets.spreadsheets.values.append({
      spreadsheetId: sheetId,
      range: 'Entries!A:T',
      valueInputOption: 'RAW',
      requestBody: { values: imported }
    });
  }

  return {
    imported: imported.length,
    skipped: skipped.length,
    errors
  };
}

/**
 * Import invoices to user's sheet
 */
async function importInvoices(sheets, sheetId, data, options) {
  const imported = [];
  const skipped = [];
  const errors = [];

  // Invoice fields (matching Invoices tab headers)
  const invoiceFields = [
    'num', 'date', 'practice', 'practiceName', 'practiceAddr', 'period',
    'entity', 'entName', 'entAddr', 'entPhone', 'bankName', 'bankAccName',
    'bankAcc', 'bankSort', 'amount', 'gross', 'commRate', 'svcs', 'addons',
    'airTotal', 'logoType', 'payTerms', 'footerMsg', 'companyNo', 'isAdhoc',
    'driveLink', 'paidStatus', 'paidDate', 'createdAt'
  ];

  // Get existing invoices to check for duplicates
  let existingNums = new Set();
  if (!options.skipDuplicateCheck) {
    try {
      const existing = await sheets.spreadsheets.values.get({
        spreadsheetId: sheetId,
        range: 'Invoices!A:A',
      });
      const rows = existing.data.values || [];
      rows.slice(1).forEach(row => {
        if (row[0]) existingNums.add(row[0]);
      });
    } catch (e) {
      // Continue without duplicate check
    }
  }

  for (let i = 0; i < data.length; i++) {
    const invoice = data[i];

    try {
      // Validate required fields
      if (!invoice.num || !invoice.date) {
        errors.push({ index: i, error: 'Missing required fields (num, date)' });
        continue;
      }

      // Check for duplicate
      if (existingNums.has(invoice.num)) {
        skipped.push(i);
        continue;
      }

      // Build row in correct order
      const row = invoiceFields.map(field => {
        if (field === 'svcs' && typeof invoice.svcs === 'object') {
          return JSON.stringify(invoice.svcs);
        }
        if (field === 'addons' && typeof invoice.addons === 'object') {
          return JSON.stringify(invoice.addons);
        }
        if (field === 'createdAt' && !invoice.createdAt) return new Date().toISOString();
        return invoice[field] ?? '';
      });

      imported.push(row);
      existingNums.add(invoice.num);

    } catch (e) {
      errors.push({ index: i, error: e.message });
    }
  }

  // Batch append imported invoices
  if (imported.length > 0) {
    await sheets.spreadsheets.values.append({
      spreadsheetId: sheetId,
      range: 'Invoices!A:AC',
      valueInputOption: 'RAW',
      requestBody: { values: imported }
    });
  }

  return {
    imported: imported.length,
    skipped: skipped.length,
    errors
  };
}

/**
 * Import practices to user's sheet
 */
async function importPractices(sheets, sheetId, data, options) {
  const imported = [];
  const skipped = [];
  const errors = [];

  // Practice fields (matching Practices tab headers)
  const practiceFields = [
    'id', 'short', 'name', 'type', 'addr', 'email', 'comm', 'services',
    'days', 'rate', 'air', 'active', 'color', 'paidHours', 'ptsPerHour',
    'paymentDueDay', 'createdAt'
  ];

  // Get existing practices to check for duplicates
  let existingIds = new Set();
  if (!options.skipDuplicateCheck) {
    try {
      const existing = await sheets.spreadsheets.values.get({
        spreadsheetId: sheetId,
        range: 'Practices!A:A',
      });
      const rows = existing.data.values || [];
      rows.slice(1).forEach(row => {
        if (row[0]) existingIds.add(row[0]);
      });
    } catch (e) {
      // Continue without duplicate check
    }
  }

  for (let i = 0; i < data.length; i++) {
    const practice = data[i];

    try {
      // Validate required fields
      if (!practice.id || !practice.name) {
        errors.push({ index: i, error: 'Missing required fields (id, name)' });
        continue;
      }

      // Check for duplicate
      if (existingIds.has(practice.id)) {
        if (options.updateExisting) {
          // Update existing practice (would need row index lookup)
          // For now, skip
        }
        skipped.push(i);
        continue;
      }

      // Build row in correct order
      const row = practiceFields.map(field => {
        if (field === 'services' && typeof practice.services === 'object') {
          return JSON.stringify(practice.services);
        }
        if (field === 'days' && Array.isArray(practice.days)) {
          return JSON.stringify(practice.days);
        }
        if (field === 'paidHours' && typeof practice.paidHours === 'object') {
          return JSON.stringify(practice.paidHours);
        }
        if (field === 'active' && practice.active === undefined) return true;
        if (field === 'air' && practice.air === undefined) return 9;
        if (field === 'ptsPerHour' && practice.ptsPerHour === undefined) return 2;
        if (field === 'paymentDueDay' && practice.paymentDueDay === undefined) return 15;
        if (field === 'createdAt' && !practice.createdAt) return new Date().toISOString();
        return practice[field] ?? '';
      });

      imported.push(row);
      existingIds.add(practice.id);

    } catch (e) {
      errors.push({ index: i, error: e.message });
    }
  }

  // Batch append imported practices
  if (imported.length > 0) {
    await sheets.spreadsheets.values.append({
      spreadsheetId: sheetId,
      range: 'Practices!A:Q',
      valueInputOption: 'RAW',
      requestBody: { values: imported }
    });
  }

  return {
    imported: imported.length,
    skipped: skipped.length,
    errors
  };
}

/**
 * Log import action to AdminLog
 */
async function logImportAction(sheets, masterSheetId, adminId, targetUserId, dataType, summary) {
  try {
    await sheets.spreadsheets.values.append({
      spreadsheetId: masterSheetId,
      range: 'AdminLog!A:E',
      valueInputOption: 'RAW',
      requestBody: {
        values: [[
          new Date().toISOString(),
          adminId,
          `import_${dataType}`,
          targetUserId,
          JSON.stringify(summary)
        ]]
      }
    });
  } catch (error) {
    console.error('Failed to log import action:', error);
  }
}
