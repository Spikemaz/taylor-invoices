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
 * PDFs will be generated ONLY when a new invoice row is added
 */

// Configuration - UPDATE THIS with your Vercel URL
const VERCEL_API_URL = 'https://taylor-invoices.vercel.app';
const INVOICE_FOLDER_NAME = 'Taylor Invoices';
const INVOICES_TAB_NAME = 'Invoices';

/**
 * Setup trigger - Run this ONCE
 */
function setupTrigger() {
  // Remove existing triggers
  const triggers = ScriptApp.getProjectTriggers();
  triggers.forEach(trigger => ScriptApp.deleteTrigger(trigger));

  // Create onEdit trigger (fires when sheet is edited)
  ScriptApp.newTrigger('onSheetEdit')
    .forSpreadsheet(SpreadsheetApp.getActiveSpreadsheet())
    .onEdit()
    .create();

  SpreadsheetApp.getUi().alert('Setup complete!\n\nPDFs will be generated automatically when new invoices are added.');
}

/**
 * Triggered on any edit - checks if new invoice row was added
 */
function onSheetEdit(e) {
  try {
    // Check if edit was on Invoices sheet
    const sheet = e.source.getActiveSheet();
    if (sheet.getName() !== INVOICES_TAB_NAME) return;

    // Get the edited range
    const range = e.range;
    const row = range.getRow();

    // Skip header row
    if (row <= 1) return;

    // Check if this is a new row (column A has value but driveLink is empty)
    const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    const numCol = headers.indexOf('num');
    const driveLinkCol = headers.indexOf('driveLink');

    if (numCol === -1 || driveLinkCol === -1) return;

    const invoiceNum = sheet.getRange(row, numCol + 1).getValue();
    const driveLink = sheet.getRange(row, driveLinkCol + 1).getValue();

    // Only generate if invoice number exists and no driveLink yet
    if (invoiceNum && !driveLink) {
      // Get full row data
      const rowData = sheet.getRange(row, 1, 1, headers.length).getValues()[0];

      // Generate PDF
      const pdfUrl = generatePDFFromVercel(rowData, headers);

      if (pdfUrl) {
        sheet.getRange(row, driveLinkCol + 1).setValue(pdfUrl);
        Logger.log('Generated PDF for invoice ' + invoiceNum);
      }
    }
  } catch (err) {
    Logger.log('onSheetEdit error: ' + err.message);
  }
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
 * Get or create folder structure: Taylor Invoices / Entity / Year / Month
 */
function getOrCreateInvoiceFolder(inv) {
  // Root folder
  let rootFolder;
  const rootFolders = DriveApp.getFoldersByName(INVOICE_FOLDER_NAME);
  if (rootFolders.hasNext()) {
    rootFolder = rootFolders.next();
  } else {
    rootFolder = DriveApp.createFolder(INVOICE_FOLDER_NAME);
  }

  // Entity folder
  const entityName = (inv.entity === 'ltd' || inv.logoType === 'ltd') ? 'Ltd Company' : 'Self-Employed';
  let entityFolder = getSubfolder(rootFolder, entityName);
  if (!entityFolder) entityFolder = rootFolder.createFolder(entityName);

  // Year folder
  const date = inv.date ? new Date(inv.date) : new Date();
  const year = date.getFullYear().toString();
  let yearFolder = getSubfolder(entityFolder, year);
  if (!yearFolder) yearFolder = entityFolder.createFolder(year);

  // Month folder
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
