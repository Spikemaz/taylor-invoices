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
  // Check for deleted invoices (REMOVE_ROW or when row count decreases)
  if (e && e.changeType === 'REMOVE_ROW') {
    checkForDeletedInvoices();
  }

  // Check for new invoices on EDIT or INSERT_ROW
  if (e && e.changeType && (e.changeType === 'EDIT' || e.changeType === 'INSERT_ROW')) {
    checkForNewInvoices();
  }

  // Always update the stored invoice links after any change
  storeInvoiceDriveLinks();
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
 * Delete a file from Google Drive using its URL
 * @param {string} driveLink - The Drive URL (e.g., https://drive.google.com/file/d/FILE_ID/view)
 * @param {string} invoiceNum - The invoice number (for logging)
 */
function deleteDriveFileFromLink(driveLink, invoiceNum) {
  if (!driveLink) {
    Logger.log('No Drive link for invoice ' + invoiceNum);
    return;
  }

  try {
    // Extract file ID from Drive URL
    // URLs look like: https://drive.google.com/file/d/FILE_ID/view
    // or: https://drive.google.com/open?id=FILE_ID
    let fileId = null;
    const fileMatch = driveLink.match(/\/d\/([a-zA-Z0-9_-]+)/);
    const idMatch = driveLink.match(/[?&]id=([a-zA-Z0-9_-]+)/);
    fileId = fileMatch ? fileMatch[1] : (idMatch ? idMatch[1] : null);

    if (fileId) {
      const file = DriveApp.getFileById(fileId);
      const fileName = file.getName();
      file.setTrashed(true); // Move to trash (safer than permanent delete)
      Logger.log('✓ Deleted Drive PDF: ' + fileName + ' (Invoice ' + invoiceNum + ')');
    } else {
      Logger.log('Could not extract file ID from: ' + driveLink);
    }
  } catch (e) {
    Logger.log('Failed to delete Drive file for invoice ' + invoiceNum + ': ' + e.message);
  }
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
    airTotal: parseFloat(inv.airTotal) || 0,
    logoType: inv.logoType || inv.entity || 'self',
    payTerms: inv.payTerms,
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

  // Year folder inside Invoices
  const date = inv.date ? new Date(inv.date) : new Date();
  const year = date.getFullYear().toString();
  let yearFolder = getSubfolder(invoicesFolder, year);
  if (!yearFolder) yearFolder = invoicesFolder.createFolder(year);

  // Month folder inside Year
  const month = Utilities.formatDate(date, 'Europe/London', 'MMMM');
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
