/**
 * Taylor Invoice PDF Generator - Google Apps Script
 *
 * SETUP INSTRUCTIONS:
 * 1. Open your Google Sheet (Self-Employed sheet)
 * 2. Click Extensions > Apps Script
 * 3. Delete any code in the editor
 * 4. Paste this entire script
 * 5. Click the disk icon to save
 * 6. Run "setupTrigger" function once
 * 7. Authorize when prompted
 * 8. Repeat for Ltd Company sheet
 *
 * PDFs will be generated automatically when a new invoice row is added
 */

// Configuration - UPDATE THIS with your Vercel URL
const VERCEL_API_URL = 'https://taylor-invoices.vercel.app';
const INVOICE_FOLDER_NAME = 'Taylor Invoices';
const INVOICES_TAB_NAME = 'Invoices';
const TRASH_FOLDER_NAME = 'Trash';

/**
 * Setup trigger - Run this ONCE
 * Uses onChange trigger which fires for BOTH manual and programmatic edits
 * Also tracks invoice rows to detect deletions
 */
function setupTrigger() {
  // Remove existing triggers
  const triggers = ScriptApp.getProjectTriggers();
  triggers.forEach(trigger => ScriptApp.deleteTrigger(trigger));

  // Create onChange trigger - fires when spreadsheet content changes (including API edits)
  ScriptApp.newTrigger('onSheetChange')
    .forSpreadsheet(SpreadsheetApp.getActive())
    .onChange()
    .create();

  // Store current invoice Drive links for deletion tracking
  storeInvoiceDriveLinks();

  SpreadsheetApp.getUi().alert('Setup complete!\n\nPDFs will be generated automatically when new invoices are added.\nPDFs will be deleted from Drive when invoice rows are deleted.');
}

/**
 * Store current invoice Drive links in script properties for deletion tracking
 */
function storeInvoiceDriveLinks() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(INVOICES_TAB_NAME);
  if (!sheet) return;

  const data = sheet.getDataRange().getValues();
  if (data.length < 2) return;

  const headers = data[0];
  const numCol = headers.indexOf('num');
  const driveLinkCol = headers.indexOf('driveLink');

  if (numCol === -1 || driveLinkCol === -1) return;

  const invoiceLinks = {};
  for (let i = 1; i < data.length; i++) {
    const invoiceNum = data[i][numCol];
    const driveLink = data[i][driveLinkCol];
    if (invoiceNum && driveLink) {
      invoiceLinks[invoiceNum] = driveLink;
    }
  }

  PropertiesService.getScriptProperties().setProperty('invoiceLinks', JSON.stringify(invoiceLinks));
  Logger.log('Stored ' + Object.keys(invoiceLinks).length + ' invoice Drive links for tracking');
}

/**
 * onChange handler - fires for ALL changes including API/service account edits
 * This is an "installable trigger" which has more permissions than simple triggers
 */
function onSheetChange(e) {
  const changeType = e ? e.changeType : 'UNKNOWN';
  Logger.log('=== onSheetChange triggered ===');
  Logger.log('  changeType: ' + changeType);
  Logger.log('  source: ' + (e && e.source ? e.source.getName() : 'unknown'));

  // ALWAYS check for deleted invoices on ANY change
  // API deletions via batchUpdate may fire as 'OTHER' or different changeType
  checkForDeletedInvoices();

  // ALWAYS process Trash tab to move PDFs to Trash folder
  // This catches deletions made by the Vercel API
  try {
    processTrashTab();
  } catch (trashErr) {
    Logger.log('Error processing Trash tab: ' + trashErr.message);
  }

  // Check for new invoices on EDIT, INSERT_ROW, or OTHER (API changes)
  if (changeType === 'EDIT' || changeType === 'INSERT_ROW' || changeType === 'OTHER') {
    checkForNewInvoices();
  }

  // Always update the stored invoice links after any change
  storeInvoiceDriveLinks();

  Logger.log('=== onSheetChange complete ===');
}

/**
 * Check for deleted invoices and delete their PDFs from Google Drive
 * Compares stored invoice links with current sheet data
 */
function checkForDeletedInvoices() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(100)) {
    Logger.log('Another execution is in progress, skipping deletion check...');
    return;
  }

  try {
    // Get previously stored invoice links
    const storedJson = PropertiesService.getScriptProperties().getProperty('invoiceLinks');
    if (!storedJson) return;

    const storedLinks = JSON.parse(storedJson);

    // Get current invoice numbers from sheet
    const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(INVOICES_TAB_NAME);
    if (!sheet) return;

    const data = sheet.getDataRange().getValues();
    const headers = data[0];
    const numCol = headers.indexOf('num');

    if (numCol === -1) return;

    const currentInvoiceNums = new Set();
    for (let i = 1; i < data.length; i++) {
      const invoiceNum = data[i][numCol];
      if (invoiceNum) currentInvoiceNums.add(String(invoiceNum));
    }

    // Find deleted invoices (in stored but not in current)
    Object.keys(storedLinks).forEach(invoiceNum => {
      if (!currentInvoiceNums.has(invoiceNum)) {
        const driveLink = storedLinks[invoiceNum];
        Logger.log('Invoice ' + invoiceNum + ' was deleted. Attempting to delete Drive PDF...');
        deleteDriveFileFromLink(driveLink, invoiceNum);
      }
    });

  } finally {
    lock.releaseLock();
  }
}

/**
 * Move a file from Google Drive to the Trash folder (not Google's built-in trash)
 * @param {string} driveLink - The Drive URL (e.g., https://drive.google.com/file/d/FILE_ID/view)
 * @param {string} invoiceNum - The invoice number (for logging)
 * @returns {boolean} true if successful, false if failed
 */
function deleteDriveFileFromLink(driveLink, invoiceNum) {
  if (!driveLink) {
    Logger.log('No Drive link for invoice ' + invoiceNum);
    return false;
  }

  Logger.log('deleteDriveFileFromLink called for invoice ' + invoiceNum);
  Logger.log('  driveLink: ' + driveLink);

  try {
    // Extract file ID from Drive URL
    // URLs look like: https://drive.google.com/file/d/FILE_ID/view
    // or: https://drive.google.com/open?id=FILE_ID
    // or: https://drive.google.com/file/d/FILE_ID/view?usp=drivesdk
    let fileId = null;
    const fileMatch = driveLink.match(/\/d\/([a-zA-Z0-9_-]+)/);
    const idMatch = driveLink.match(/[?&]id=([a-zA-Z0-9_-]+)/);
    fileId = fileMatch ? fileMatch[1] : (idMatch ? idMatch[1] : null);

    Logger.log('  Extracted fileId: ' + fileId);

    if (fileId) {
      const file = DriveApp.getFileById(fileId);
      const fileName = file.getName();
      Logger.log('  Found file: ' + fileName);

      // Get or create Trash folder inside Taylor Invoices
      const trashFolder = getOrCreateTrashFolder();
      Logger.log('  Trash folder: ' + trashFolder.getName() + ' (' + trashFolder.getId() + ')');

      // Move file to Trash folder instead of Google's trash
      file.moveTo(trashFolder);
      Logger.log('✓ SUCCESS: Moved "' + fileName + '" to Trash folder (Invoice ' + invoiceNum + ')');
      return true;
    } else {
      Logger.log('✗ FAILED: Could not extract file ID from: ' + driveLink);
      return false;
    }
  } catch (e) {
    Logger.log('✗ ERROR moving Drive file for invoice ' + invoiceNum + ': ' + e.message);
    Logger.log('  Stack: ' + e.stack);
    return false;
  }
}

/**
 * Get or create the Trash folder inside Taylor Invoices
 * Structure: Taylor Invoices / Trash
 */
function getOrCreateTrashFolder() {
  // Get root folder: Taylor Invoices
  let rootFolder;
  const rootFolders = DriveApp.getFoldersByName(INVOICE_FOLDER_NAME);
  if (rootFolders.hasNext()) {
    rootFolder = rootFolders.next();
  } else {
    rootFolder = DriveApp.createFolder(INVOICE_FOLDER_NAME);
  }

  // Get or create Trash folder inside root
  let trashFolder = getSubfolder(rootFolder, TRASH_FOLDER_NAME);
  if (!trashFolder) {
    trashFolder = rootFolder.createFolder(TRASH_FOLDER_NAME);
  }

  return trashFolder;
}

/**
 * Manual function to check and delete orphaned Drive PDFs
 * Run this to clean up PDFs for invoices that no longer exist in the sheet
 */
function cleanupOrphanedPDFs() {
  checkForDeletedInvoices();
  SpreadsheetApp.getUi().alert('Cleanup complete! Check the execution log for details.');
}

/**
 * Process the Trash tab and move any PDFs to the Trash folder
 * This catches any deletions that the onChange trigger missed
 * Run manually or schedule with a time-driven trigger
 */
function processTrashTab() {
  Logger.log('=== processTrashTab() starting ===');

  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Trash');
  if (!sheet) {
    Logger.log('No Trash tab found - nothing to process');
    return 0;
  }

  const data = sheet.getDataRange().getValues();
  Logger.log('Trash tab has ' + data.length + ' rows (including header)');

  if (data.length < 2) {
    Logger.log('No items in Trash tab (only header or empty)');
    return 0;
  }

  const headers = data[0];
  Logger.log('Trash tab headers: ' + JSON.stringify(headers));

  // Find column indexes - handle both old format and new format
  // Old: deletedAt, dataType, originalData
  // New: deletedAt, dataType, originalData, processed
  let dataTypeCol = headers.indexOf('dataType');
  let originalDataCol = headers.indexOf('originalData');
  let processedCol = headers.indexOf('processed');

  // If headers not found by name, use fixed positions (fallback)
  if (dataTypeCol === -1) dataTypeCol = 1;  // Column B
  if (originalDataCol === -1) originalDataCol = 2;  // Column C

  Logger.log('Column indexes - dataType: ' + dataTypeCol + ', originalData: ' + originalDataCol + ', processed: ' + processedCol);

  // Add 'processed' column header if it doesn't exist
  if (processedCol === -1) {
    // Add header to column D
    processedCol = 3;
    sheet.getRange(1, processedCol + 1).setValue('processed');
    Logger.log('Added "processed" column header at column D');
  }

  let processedCount = 0;
  let skippedCount = 0;
  let errorCount = 0;

  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    const dataType = row[dataTypeCol];
    const originalDataJson = row[originalDataCol];
    const alreadyProcessed = row[processedCol];

    Logger.log('Row ' + (i+1) + ': dataType=' + dataType + ', processed=' + alreadyProcessed);

    // Skip if already processed
    if (alreadyProcessed === true || alreadyProcessed === 'TRUE' || alreadyProcessed === 'true') {
      Logger.log('  Skipping - already processed');
      skippedCount++;
      continue;
    }

    if (dataType === 'invoice' && originalDataJson) {
      try {
        const originalData = JSON.parse(originalDataJson);
        Logger.log('  Invoice #' + originalData.num + ', driveLink: ' + (originalData.driveLink ? 'present' : 'missing'));

        if (originalData.driveLink) {
          Logger.log('  Attempting to move PDF to Trash folder...');
          const success = deleteDriveFileFromLink(originalData.driveLink, originalData.num);

          // Mark as processed regardless of success (to avoid retry loops)
          sheet.getRange(i + 1, processedCol + 1).setValue(true);
          Logger.log('  Marked as processed');

          if (success !== false) {
            processedCount++;
          }
        } else {
          // No driveLink - mark as processed anyway
          sheet.getRange(i + 1, processedCol + 1).setValue(true);
          Logger.log('  No driveLink - marked as processed');
        }
      } catch (e) {
        Logger.log('  ERROR parsing/processing: ' + e.message);
        errorCount++;
        // Mark as processed to avoid infinite retry
        sheet.getRange(i + 1, processedCol + 1).setValue('error: ' + e.message);
      }
    } else if (dataType === 'entry') {
      // Entries don't have Drive files - just mark as processed
      sheet.getRange(i + 1, processedCol + 1).setValue(true);
      Logger.log('  Entry type - marked as processed (no Drive file)');
    } else if (dataType === 'pdf_replacement' && originalDataJson) {
      // PDF replacement - move old PDF to Trash folder before regeneration
      try {
        const originalData = JSON.parse(originalDataJson);
        Logger.log('  PDF replacement for Invoice #' + originalData.num + ', driveLink: ' + (originalData.driveLink ? 'present' : 'missing'));
        Logger.log('  Reason: ' + (originalData.reason || 'unknown'));

        if (originalData.driveLink) {
          Logger.log('  Moving old PDF to Trash folder...');
          const success = deleteDriveFileFromLink(originalData.driveLink, originalData.num);

          sheet.getRange(i + 1, processedCol + 1).setValue(true);
          Logger.log('  Marked as processed');

          if (success !== false) {
            processedCount++;
          }
        } else {
          sheet.getRange(i + 1, processedCol + 1).setValue(true);
          Logger.log('  No driveLink - marked as processed');
        }
      } catch (e) {
        Logger.log('  ERROR processing pdf_replacement: ' + e.message);
        errorCount++;
        sheet.getRange(i + 1, processedCol + 1).setValue('error: ' + e.message);
      }
    }
  }

  Logger.log('=== processTrashTab() complete ===');
  Logger.log('Processed: ' + processedCount + ', Skipped: ' + skippedCount + ', Errors: ' + errorCount);
  return processedCount;
}

/**
 * Setup a time-driven trigger to process the Trash tab every hour
 * This catches any deletions the onChange trigger missed
 */
function setupTrashProcessor() {
  // Remove existing trash processor triggers
  const triggers = ScriptApp.getProjectTriggers();
  triggers.forEach(trigger => {
    if (trigger.getHandlerFunction() === 'processTrashTab') {
      ScriptApp.deleteTrigger(trigger);
    }
  });

  // Create hourly trigger
  ScriptApp.newTrigger('processTrashTab')
    .timeBased()
    .everyHours(1)
    .create();

  SpreadsheetApp.getUi().alert('Trash processor scheduled to run hourly.\n\nThis will move any deleted invoice PDFs to the Trash folder in Google Drive.');
}

/**
 * Check for invoices without PDFs and generate them
 * Called by onChange trigger when new rows are added
 * Uses Script Lock to prevent duplicate PDFs from concurrent trigger executions
 */
function checkForNewInvoices() {
  // Use script lock to prevent concurrent executions (prevents duplicate PDFs)
  const lock = LockService.getScriptLock();

  // Try to acquire lock - if another execution is running, skip this one
  if (!lock.tryLock(100)) {
    Logger.log('Another execution is in progress, skipping...');
    return;
  }

  try {
    const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(INVOICES_TAB_NAME);
    if (!sheet) return;

    const data = sheet.getDataRange().getValues();
    if (data.length < 2) return;

    const headers = data[0];
    const numCol = headers.indexOf('num');
    const driveLinkCol = headers.indexOf('driveLink');

    if (numCol === -1 || driveLinkCol === -1) return;

    // Find first invoice without driveLink (process one at a time to avoid timeout)
    for (let i = 1; i < data.length; i++) {
      const row = data[i];
      const invoiceNum = row[numCol];
      const driveLink = row[driveLinkCol];

      if (invoiceNum && !driveLink) {
        // Double-check by re-reading the cell (in case another process just wrote it)
        const currentLink = sheet.getRange(i + 1, driveLinkCol + 1).getValue();
        if (currentLink) {
          Logger.log('Invoice ' + invoiceNum + ' already has driveLink (race condition avoided)');
          continue;
        }

        try {
          Logger.log('Generating PDF for invoice: ' + invoiceNum);
          const pdfUrl = generatePDFFromVercel(row, headers);
          if (pdfUrl) {
            sheet.getRange(i + 1, driveLinkCol + 1).setValue(pdfUrl);
            Logger.log('PDF generated: ' + pdfUrl);
          }
        } catch (err) {
          Logger.log('Error generating PDF for ' + invoiceNum + ': ' + err.message);
        }
        // Only process ONE invoice per run to avoid timeout
        return;
      }
    }
  } finally {
    // Always release the lock
    lock.releaseLock();
  }
}

/**
 * Legacy onEdit handler - kept for manual edits but main trigger is time-based
 */
function onSheetEdit(e) {
  // Time-based trigger (checkForNewInvoices) handles PDF generation
  // This is kept as backup for manual sheet edits
}

/**
 * Generate PDF using Vercel API and save to Drive
 */
function generatePDFFromVercel(rowData, headers) {
  // Build invoice object from row
  const inv = {};
  headers.forEach((header, i) => {
    inv[header] = rowData[i] || '';
  });

  // Parse JSON fields
  if (inv.svcs && typeof inv.svcs === 'string') {
    try { inv.svcs = JSON.parse(inv.svcs); } catch(e) { inv.svcs = {}; }
  }

  // Parse addons JSON if it exists
  if (inv.addons && typeof inv.addons === 'string') {
    try { inv.addons = JSON.parse(inv.addons); } catch(e) { inv.addons = {}; }
  }

  // Get logo base64 (we need to fetch this or store it)
  // For now, we'll let Vercel handle the logo via logoType
  const payload = {
    num: inv.num,
    date: inv.date,
    practice: inv.practice,
    practiceName: inv.practiceName,
    practiceAddr: inv.practiceAddr,
    period: inv.period,
    entity: inv.entity,
    entName: inv.entName,
    entAddr: inv.entAddr,
    entPhone: inv.entPhone,
    bankName: inv.bankName,
    bankAccName: inv.bankAccName,
    bankAcc: inv.bankAcc,
    bankSort: inv.bankSort,
    amount: parseFloat(inv.amount) || 0,
    gross: parseFloat(inv.gross) || 0,
    commRate: parseFloat(inv.commRate) || 0,
    svcs: inv.svcs,
    addons: inv.addons || {},
    airTotal: parseFloat(inv.airTotal) || 0,
    logoType: inv.logoType || inv.entity || 'self',
    payTerms: inv.payTerms,
    footerMsg: inv.footerMsg || 'Thank you for your continued support.',
    companyNo: inv.companyNo || '',
    isAdhoc: inv.isAdhoc
  };

  // Call Vercel API to generate PDF
  const options = {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };

  const response = UrlFetchApp.fetch(VERCEL_API_URL + '/api/generate-pdf', options);
  const result = JSON.parse(response.getContentText());

  if (!result.success || !result.pdfBase64) {
    Logger.log('PDF generation failed: ' + JSON.stringify(result));
    return null;
  }

  // Decode base64 PDF
  const pdfBytes = Utilities.base64Decode(result.pdfBase64);
  const pdfBlob = Utilities.newBlob(pdfBytes, 'application/pdf', result.fileName);

  // Get or create folder structure
  const folder = getOrCreateInvoiceFolder(inv);

  // Save PDF to folder
  const pdfFile = folder.createFile(pdfBlob);
  pdfFile.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);

  return pdfFile.getUrl();
}

/**
 * Get or create folder structure:
 * Taylor Invoices / Self-Employed (or Ltd Company) / Invoices / 2026 / February / [Ad Hoc/]
 * Uses the invoice PERIOD (not date) to determine folder - so Feb entries go to Feb folder even if invoiced in March
 */
function getOrCreateInvoiceFolder(inv) {
  // Root folder: Taylor Invoices
  let rootFolder;
  const rootFolders = DriveApp.getFoldersByName(INVOICE_FOLDER_NAME);
  if (rootFolders.hasNext()) {
    rootFolder = rootFolders.next();
  } else {
    rootFolder = DriveApp.createFolder(INVOICE_FOLDER_NAME);
  }

  // Entity folder: Self-Employed or Ltd Company
  const entityName = (inv.entity === 'ltd' || inv.logoType === 'ltd') ? 'Ltd Company' : 'Self-Employed';
  let entityFolder = getSubfolder(rootFolder, entityName);
  if (!entityFolder) entityFolder = rootFolder.createFolder(entityName);

  // Invoices folder inside Entity
  let invoicesFolder = getSubfolder(entityFolder, 'Invoices');
  if (!invoicesFolder) invoicesFolder = entityFolder.createFolder('Invoices');

  // Parse period to get year/month (period examples: "February 2026", "11/02/2026", "Week of 11/02/2026")
  const periodInfo = parsePeriodForFolder(inv.period);
  const year = periodInfo.year;
  const month = periodInfo.month;

  Logger.log('Folder path: ' + entityName + '/Invoices/' + year + '/' + month + (inv.isAdhoc ? '/Ad Hoc' : ''));

  let yearFolder = getSubfolder(invoicesFolder, year);
  if (!yearFolder) yearFolder = invoicesFolder.createFolder(year);

  let monthFolder = getSubfolder(yearFolder, month);
  if (!monthFolder) monthFolder = yearFolder.createFolder(month);

  // Ad Hoc subfolder if needed
  if (inv.isAdhoc === true || inv.isAdhoc === 'true' || inv.isAdhoc === 'TRUE') {
    let adhocFolder = getSubfolder(monthFolder, 'Ad Hoc');
    if (!adhocFolder) adhocFolder = monthFolder.createFolder('Ad Hoc');
    return adhocFolder;
  }

  return monthFolder;
}

/**
 * Parse invoice period to extract year/month for folder structure
 * Handles: "February 2026", "11/02/2026", "Week of 11/02/2026", "01/02/2026 - 15/02/2026"
 */
function parsePeriodForFolder(period) {
  const now = new Date();
  const fallback = {
    year: now.getFullYear().toString(),
    month: Utilities.formatDate(now, 'Europe/London', 'MMMM')
  };

  if (!period) return fallback;

  // Try "Month Year" format (e.g., "February 2026")
  const monthNames = ['January', 'February', 'March', 'April', 'May', 'June',
                      'July', 'August', 'September', 'October', 'November', 'December'];
  for (const m of monthNames) {
    if (period.indexOf(m) !== -1) {
      const yearMatch = period.match(/\d{4}/);
      return {
        year: yearMatch ? yearMatch[0] : now.getFullYear().toString(),
        month: m
      };
    }
  }

  // Try DD/MM/YYYY format - extract first date found
  const dateMatch = period.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (dateMatch) {
    const d = new Date(parseInt(dateMatch[3]), parseInt(dateMatch[2]) - 1, parseInt(dateMatch[1]));
    return {
      year: d.getFullYear().toString(),
      month: Utilities.formatDate(d, 'Europe/London', 'MMMM')
    };
  }

  // Fallback to today
  return fallback;
}

/**
 * Get subfolder by name
 */
function getSubfolder(parent, name) {
  const folders = parent.getFoldersByName(name);
  return folders.hasNext() ? folders.next() : null;
}

/**
 * Manual test - generate PDF for the latest invoice
 */
function testGenerateLatest() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(INVOICES_TAB_NAME);
  if (!sheet) {
    SpreadsheetApp.getUi().alert('No Invoices sheet found!');
    return;
  }

  const data = sheet.getDataRange().getValues();
  if (data.length < 2) {
    SpreadsheetApp.getUi().alert('No invoices found!');
    return;
  }

  const headers = data[0];
  const lastRow = data[data.length - 1];
  const driveLinkCol = headers.indexOf('driveLink');
  const numCol = headers.indexOf('num');

  const invoiceNum = lastRow[numCol];

  SpreadsheetApp.getUi().alert('Generating PDF for invoice ' + invoiceNum + '...');

  const url = generatePDFFromVercel(lastRow, headers);

  if (url && driveLinkCol !== -1) {
    sheet.getRange(data.length, driveLinkCol + 1).setValue(url);
    SpreadsheetApp.getUi().alert('PDF generated!\n\n' + url);
  } else {
    SpreadsheetApp.getUi().alert('Failed to generate PDF. Check the logs.');
  }
}

/**
 * DIAGNOSTIC TEST - Run this to see exactly where the problem is
 */
function diagnosticTest() {
  const ui = SpreadsheetApp.getUi();
  let results = [];

  // Step 1: Check sheet access
  try {
    const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(INVOICES_TAB_NAME);
    if (sheet) {
      results.push('✓ Sheet "Invoices" found');
      const data = sheet.getDataRange().getValues();
      results.push('✓ Found ' + data.length + ' rows (including header)');

      if (data.length > 1) {
        const headers = data[0];
        results.push('✓ Headers: ' + headers.slice(0, 5).join(', ') + '...');

        const numCol = headers.indexOf('num');
        const driveLinkCol = headers.indexOf('driveLink');
        results.push('  num column: ' + (numCol >= 0 ? 'Found at ' + numCol : 'NOT FOUND'));
        results.push('  driveLink column: ' + (driveLinkCol >= 0 ? 'Found at ' + driveLinkCol : 'NOT FOUND'));
      }
    } else {
      results.push('✗ Sheet "Invoices" NOT FOUND');
    }
  } catch (e) {
    results.push('✗ Sheet error: ' + e.message);
  }

  // Step 2: Test API call
  try {
    results.push('\n--- Testing Vercel API ---');
    const testPayload = { num: 'DIAG-TEST', date: '2026-02-13', practiceName: 'Test', entName: 'Diagnostic', amount: 100, gross: 100 };
    const response = UrlFetchApp.fetch(VERCEL_API_URL + '/api/generate-pdf', {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify(testPayload),
      muteHttpExceptions: true
    });
    const code = response.getResponseCode();
    results.push('✓ API response code: ' + code);

    if (code === 200) {
      const result = JSON.parse(response.getContentText());
      results.push('✓ API success: ' + result.success);
      results.push('✓ PDF base64 length: ' + (result.pdfBase64 ? result.pdfBase64.length : 0));
      results.push('✓ Filename: ' + result.fileName);
    } else {
      results.push('✗ API error: ' + response.getContentText().substring(0, 200));
    }
  } catch (e) {
    results.push('✗ API call failed: ' + e.message);
  }

  // Step 3: Test Drive access
  try {
    results.push('\n--- Testing Drive Access ---');
    const folders = DriveApp.getFoldersByName(INVOICE_FOLDER_NAME);
    if (folders.hasNext()) {
      const folder = folders.next();
      results.push('✓ Found folder: ' + folder.getName());
      results.push('✓ Folder URL: ' + folder.getUrl());
    } else {
      results.push('! Folder "' + INVOICE_FOLDER_NAME + '" not found - will be created on first PDF');
      // Try creating a test folder
      const testFolder = DriveApp.createFolder('_TestFolder_DELETE_ME');
      results.push('✓ Can create folders! Created test folder');
      testFolder.setTrashed(true);
      results.push('✓ Deleted test folder');
    }
  } catch (e) {
    results.push('✗ Drive error: ' + e.message);
  }

  ui.alert('Diagnostic Results', results.join('\n'), ui.ButtonSet.OK);
  Logger.log(results.join('\n'));
}

/**
 * TRASH DIAGNOSTIC - Run this to debug trash functionality
 */
function trashDiagnostic() {
  const ui = SpreadsheetApp.getUi();
  let results = [];

  results.push('=== TRASH DIAGNOSTIC ===\n');

  // Step 1: Check Trash tab
  try {
    const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Trash');
    if (sheet) {
      const data = sheet.getDataRange().getValues();
      results.push('✓ Trash tab found with ' + data.length + ' rows');

      if (data.length > 0) {
        results.push('  Headers: ' + JSON.stringify(data[0]));
      }

      if (data.length > 1) {
        results.push('\n  Recent trash items:');
        for (let i = 1; i < Math.min(data.length, 4); i++) {
          const row = data[i];
          results.push('  Row ' + (i+1) + ': type=' + row[1] + ', processed=' + row[3]);
          // Try to parse originalData to get invoice num
          try {
            const orig = JSON.parse(row[2]);
            results.push('    Invoice: #' + orig.num + ', driveLink: ' + (orig.driveLink ? 'YES' : 'NO'));
          } catch (e) {
            results.push('    Could not parse originalData');
          }
        }
      }
    } else {
      results.push('✗ Trash tab NOT found');
    }
  } catch (e) {
    results.push('✗ Error checking Trash tab: ' + e.message);
  }

  // Step 2: Check Trash folder in Drive
  try {
    results.push('\n--- Checking Drive Trash folder ---');
    const trashFolder = getOrCreateTrashFolder();
    results.push('✓ Trash folder: ' + trashFolder.getName());
    results.push('  URL: ' + trashFolder.getUrl());

    const files = trashFolder.getFiles();
    let fileCount = 0;
    let fileNames = [];
    while (files.hasNext() && fileCount < 5) {
      const file = files.next();
      fileNames.push(file.getName());
      fileCount++;
    }
    results.push('  Files in Trash folder: ' + fileCount + (fileCount >= 5 ? '+' : ''));
    if (fileNames.length > 0) {
      results.push('  Recent: ' + fileNames.join(', '));
    }
  } catch (e) {
    results.push('✗ Error checking Trash folder: ' + e.message);
  }

  // Step 3: Check stored invoice links
  try {
    results.push('\n--- Stored Invoice Links ---');
    const storedJson = PropertiesService.getScriptProperties().getProperty('invoiceLinks');
    if (storedJson) {
      const links = JSON.parse(storedJson);
      const count = Object.keys(links).length;
      results.push('✓ ' + count + ' invoice links stored');
      if (count > 0) {
        const keys = Object.keys(links).slice(0, 3);
        keys.forEach(k => results.push('  #' + k + ': ' + (links[k] ? 'has link' : 'no link')));
      }
    } else {
      results.push('! No invoice links stored (run setupTrigger to initialize)');
    }
  } catch (e) {
    results.push('✗ Error checking stored links: ' + e.message);
  }

  // Step 4: Check triggers
  try {
    results.push('\n--- Triggers ---');
    const triggers = ScriptApp.getProjectTriggers();
    results.push('Total triggers: ' + triggers.length);
    triggers.forEach(t => {
      results.push('  ' + t.getHandlerFunction() + ' (' + t.getEventType() + ')');
    });
    if (triggers.length === 0) {
      results.push('! No triggers - run setupTrigger()');
    }
  } catch (e) {
    results.push('✗ Error checking triggers: ' + e.message);
  }

  ui.alert('Trash Diagnostic Results', results.join('\n'), ui.ButtonSet.OK);
  Logger.log(results.join('\n'));
}

/**
 * Manual test - process trash tab now
 */
function testProcessTrash() {
  const ui = SpreadsheetApp.getUi();
  ui.alert('Processing Trash tab now...\n\nCheck Executions log for details.');

  const count = processTrashTab();

  ui.alert('Done!\n\nProcessed ' + count + ' items.\n\nCheck the Trash folder in Google Drive and the execution log for details.');
}

/**
 * Generate all missing PDFs (manual batch)
 */
function generateAllMissing() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(INVOICES_TAB_NAME);
  const data = sheet.getDataRange().getValues();
  const headers = data[0];

  const numCol = headers.indexOf('num');
  const driveLinkCol = headers.indexOf('driveLink');

  let generated = 0;
  let failed = 0;

  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    const invoiceNum = row[numCol];
    const driveLink = row[driveLinkCol];

    if (invoiceNum && !driveLink) {
      try {
        const pdfUrl = generatePDFFromVercel(row, headers);
        if (pdfUrl) {
          sheet.getRange(i + 1, driveLinkCol + 1).setValue(pdfUrl);
          generated++;
          Logger.log('Generated: ' + invoiceNum);
        } else {
          failed++;
        }
      } catch (err) {
        Logger.log('Error: ' + invoiceNum + ' - ' + err.message);
        failed++;
      }
      // Small delay to avoid rate limiting
      Utilities.sleep(1000);
    }
  }

  SpreadsheetApp.getUi().alert('Done!\n\nGenerated: ' + generated + '\nFailed: ' + failed);
}
