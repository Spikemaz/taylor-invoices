// PDF generation endpoint
// Generates invoice PDF using jsPDF, uploads to Drive, updates Sheets

const { jsPDF } = require('jspdf');
const LOGOS = require('./logos');

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

  const inv = req.body;

  if (!inv || !inv.num) {
    return res.status(400).json({ error: 'Invalid invoice data' });
  }

  try {
    // Create PDF document (A4 size)
    const doc = new jsPDF({
      orientation: 'portrait',
      unit: 'pt',
      format: 'a4'
    });

    const W = 595; // A4 width in points
    const H = 842; // A4 height in points
    const PAGE_BOTTOM = H - 120; // Leave space for footer
    const TABLE_TOP = 80; // Where table starts on continuation pages
    let y = 40;
    let pageNum = 1;

    // Helper function to check if we need a new page and add table header
    function checkPageBreak(neededSpace) {
      if (y + neededSpace > PAGE_BOTTOM) {
        // Add page number to current page footer
        doc.setFontSize(9);
        doc.setTextColor(156, 163, 175);
        doc.text('Page ' + pageNum, W / 2, H - 30, { align: 'center' });
        // Add new page
        doc.addPage();
        pageNum++;
        y = TABLE_TOP;
        // Re-draw table header on new page
        doc.setFillColor(27, 67, 50);
        doc.rect(40, y, W - 80, 22, 'F');
        doc.setFontSize(9);
        doc.setFont('helvetica', 'bold');
        doc.setTextColor(255, 255, 255);
        doc.text('Date', 50, y + 15);
        doc.text('Service', 140, y + 15);
        doc.text('Price', 320, y + 15);
        doc.text('Qty', 410, y + 15, { align: 'right' });
        doc.text('Subtotal', W - 50, y + 15, { align: 'right' });
        y += 30;
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(10);
        return true;
      }
      return false;
    }

    // Set default font
    doc.setFont('helvetica');

    // Determine logo: use provided logoBase64, or look up by logoType, default to self
    const logoData = inv.logoBase64 || LOGOS[inv.logoType] || LOGOS.self;

    // Add logo (top left)
    if (logoData) {
      try {
        // Logo at top left, 180x180 points for maximum readability
        doc.addImage(logoData, 'PNG', 40, y, 180, 180);
      } catch (logoErr) {
        console.error('Logo error:', logoErr);
      }
    }

    // Header - entity name (right aligned)
    doc.setFontSize(16);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(26, 26, 26);
    doc.text(inv.entName || '', W - 40, y + 10, { align: 'right' });

    // Entity address (right aligned, below entity name)
    doc.setFontSize(10);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(107, 114, 128);
    const addrLines = (inv.entAddr || '').split('\n');
    let addrY = y + 26;
    addrLines.forEach((line, i) => {
      doc.text(line, W - 40, addrY + i * 12, { align: 'right' });
    });
    // Phone and email below address with proper spacing
    let contactY = addrY + addrLines.length * 12;
    if (inv.entPhone) {
      doc.text(inv.entPhone, W - 40, contactY, { align: 'right' });
      contactY += 12;
    }
    if (inv.entEmail) {
      doc.text(inv.entEmail, W - 40, contactY, { align: 'right' });
    }

    // INVOICE title (starts below logo area - logo is 180pt tall starting at y=40)
    doc.setTextColor(45, 106, 79); // Primary green
    doc.setFontSize(22);
    doc.setFont('helvetica', 'bold');
    doc.text('INVOICE', 40, 240);

    // Green line (below INVOICE title)
    doc.setFillColor(27, 67, 50); // Dark green
    doc.rect(40, 248, W - 80, 3, 'F');

    // Bill To section
    y = 270;
    doc.setFontSize(10);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(107, 114, 128);
    doc.text('BILL TO:', 40, y);

    doc.setFontSize(12);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(26, 26, 26);
    doc.text(inv.practiceName || inv.practice || '', 40, y + 16);

    doc.setFontSize(10);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(107, 114, 128);
    const pAddr = (inv.practiceAddr || '').split('\n');
    pAddr.forEach((line, i) => {
      doc.text(line, 40, y + 30 + i * 13);
    });

    // Invoice details (right side)
    doc.setFontSize(10);
    doc.setTextColor(107, 114, 128);
    doc.text('Invoice No:  ' + inv.num, W - 40, y, { align: 'right' });
    doc.text('Date:  ' + formatDate(inv.date), W - 40, y + 14, { align: 'right' });
    doc.text('Period:  ' + (inv.period || ''), W - 40, y + 28, { align: 'right' });
    doc.text('Entity:  ' + (inv.entity || ''), W - 40, y + 42, { align: 'right' });

    // Table header - 5 columns: Date, Service, Price, Qty, Subtotal
    y = 370;
    doc.setFillColor(27, 67, 50);
    doc.rect(40, y, W - 80, 22, 'F');
    doc.setFontSize(9);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(255, 255, 255);
    doc.text('Date', 50, y + 15);
    doc.text('Service', 140, y + 15);
    doc.text('Price', 320, y + 15);
    doc.text('Qty', 410, y + 15, { align: 'right' });
    doc.text('Subtotal', W - 50, y + 15, { align: 'right' });
    y += 30;

    // Table rows - sort by date then service name
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(10);
    const svcs = inv.svcs || {};
    const svcKeys = Object.keys(svcs).sort((a, b) => {
      const svcA = svcs[a];
      const svcB = svcs[b];
      // Sort by date first, then by service name
      if (svcA.date && svcB.date) {
        const dateCompare = svcA.date.localeCompare(svcB.date);
        if (dateCompare !== 0) return dateCompare;
      }
      return (svcA.name || '').localeCompare(svcB.name || '');
    });

    svcKeys.forEach((key) => {
      checkPageBreak(22);
      const s = svcs[key];
      doc.setTextColor(26, 26, 26);

      // Format date for display (short format: "10 Feb")
      const dateStr = s.date ? formatShortDate(s.date) : '';
      doc.text(dateStr, 50, y + 4);

      doc.text(s.name || '', 140, y + 4);
      doc.text('\u00a3' + (s.price || 0).toFixed(2), 320, y + 4);
      doc.text(String(s.pts || 0), 410, y + 4, { align: 'right' });
      doc.text('\u00a3' + (s.total || 0).toFixed(2), W - 50, y + 4, { align: 'right' });

      // Row separator line
      doc.setDrawColor(229, 231, 235);
      doc.setLineWidth(1);
      doc.line(40, y + 10, W - 40, y + 10);
      y += 22;
    });

    // Add-ons (each date is a separate line)
    const addons = inv.addons || {};
    const addonKeys = Object.keys(addons).sort((a, b) => {
      const addonA = addons[a];
      const addonB = addons[b];
      if (addonA.date && addonB.date) {
        return addonA.date.localeCompare(addonB.date);
      }
      return 0;
    });

    addonKeys.forEach((key) => {
      checkPageBreak(22);
      const addon = addons[key];
      doc.setTextColor(26, 26, 26);
      // Handle new format {date, type, pts, price, total}
      if (typeof addon === 'object' && addon.pts !== undefined) {
        const addonDateStr = addon.date ? formatShortDate(addon.date) : '';
        doc.text(addonDateStr, 50, y + 4);
        doc.text((addon.type || key) + ' Add-on', 140, y + 4);
        doc.text('\u00a3' + (addon.price || 0).toFixed(2), 320, y + 4);
        doc.text(String(addon.pts || 0), 410, y + 4, { align: 'right' });
        doc.text('\u00a3' + (addon.total || 0).toFixed(2), W - 50, y + 4, { align: 'right' });
      } else {
        // Old format: addon is just the total amount (no date)
        doc.text('', 50, y + 4);
        doc.text(key + ' Add-on', 140, y + 4);
        doc.text('\u00a3' + (addon || 0).toFixed(2), W - 50, y + 4, { align: 'right' });
      }
      doc.setDrawColor(229, 231, 235);
      doc.line(40, y + 10, W - 40, y + 10);
      y += 22;
    });
    // Fallback for old invoices without addons object
    if (Object.keys(addons).length === 0 && inv.airTotal > 0) {
      checkPageBreak(22);
      doc.setTextColor(26, 26, 26);
      doc.text('', 50, y + 4);
      doc.text('Airflow Add-on', 140, y + 4);
      doc.text('\u00a3' + inv.airTotal.toFixed(2), W - 50, y + 4, { align: 'right' });
      doc.setDrawColor(229, 231, 235);
      doc.line(40, y + 10, W - 40, y + 10);
      y += 22;
    }

    // Check if we need a new page for totals section (need ~200pt for totals + bank details)
    if (y + 200 > PAGE_BOTTOM) {
      doc.setFontSize(9);
      doc.setTextColor(156, 163, 175);
      doc.text('Page ' + pageNum, W / 2, H - 30, { align: 'center' });
      doc.addPage();
      pageNum++;
      y = TABLE_TOP;
    }

    // Totals section
    y += 10;
    doc.setDrawColor(229, 231, 235);
    doc.line(280, y, W - 40, y);
    y += 14;

    doc.setTextColor(26, 26, 26);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11);
    doc.text('Gross Total', 300, y);
    doc.text('\u00a3' + (inv.gross || 0).toFixed(2), W - 50, y, { align: 'right' });
    y += 18;

    // Commission (for contract invoices)
    if (!inv.isAdhoc) {
      doc.setFont('helvetica', 'normal');
      doc.setTextColor(107, 114, 128);
      doc.text('Profit Share ' + (inv.commRate || '0') + '%', 300, y);
      y += 22;
    }

    // Balance due line
    doc.setFillColor(27, 67, 50);
    doc.rect(280, y - 4, W - 320, 2, 'F');
    y += 10;

    doc.setTextColor(27, 67, 50);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(14);
    doc.text('Balance Due', 300, y);
    doc.text('\u00a3' + (inv.amount || 0).toFixed(2), W - 50, y, { align: 'right' });

    // Bank details section - check if we need a new page
    // Only need ~150pt for payment details section
    if (y + 150 > PAGE_BOTTOM) {
      doc.setFontSize(9);
      doc.setTextColor(156, 163, 175);
      doc.text('Page ' + pageNum, W / 2, H - 30, { align: 'center' });
      doc.addPage();
      pageNum++;
      y = TABLE_TOP;
    } else {
      // Just add spacing after Balance Due, don't force to position 600
      y += 40;
    }

    doc.setDrawColor(229, 231, 235);
    doc.line(40, y, W - 40, y);
    y += 16;

    doc.setTextColor(107, 114, 128);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(10);
    doc.text('PAYMENT DETAILS', 40, y);
    y += 16;

    doc.setFont('helvetica', 'normal');
    doc.text('Bank: ' + (inv.bankName || ''), 40, y);
    y += 13;
    doc.text('Account Name: ' + (inv.bankAccName || ''), 40, y);
    y += 13;
    doc.text('Account Number: ' + (inv.bankAcc || ''), 40, y);
    y += 13;
    doc.text('Sort Code: ' + (inv.bankSort || ''), 40, y);
    y += 20;

    // Payment terms
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(26, 26, 26);
    doc.text('Payment Terms: Payment is due within ' + (inv.payTerms || '5 working days') + ' of the invoice date.', 40, y);
    y += 14;

    doc.setFont('helvetica', 'normal');
    doc.setTextColor(107, 114, 128);
    doc.text('Please ensure the invoice reference (' + inv.num + ') is quoted with payment.', 40, y);
    y += 18;
    doc.text(inv.footerMsg || 'Thank you for your continued support.', 40, y);

    // Footer on last page
    doc.setDrawColor(229, 231, 235);
    doc.line(40, H - 50, W - 40, H - 50);
    doc.setFontSize(9);
    doc.setTextColor(156, 163, 175);
    doc.text(inv.entName + ' | Invoice ' + inv.num, W / 2, H - 32, { align: 'center' });
    // Add company number for Ltd invoices
    if (inv.companyNo) {
      doc.text('Company No: ' + inv.companyNo, W / 2, H - 20, { align: 'center' });
    }
    if (pageNum > 1) {
      doc.text('Page ' + pageNum, W / 2, H - 8, { align: 'center' });
    }

    // Get PDF as base64
    const pdfBase64 = doc.output('datauristring').split(',')[1];

    // Determine filename prefix based on entity
    const entityPrefix = inv.logoType === 'ltd' ? 'HTCS' : 'TAYLOR';
    const fileName = entityPrefix + ' Invoice-' + inv.num + '.pdf';

    // Return PDF data for client-side download and Drive upload
    return res.status(200).json({
      success: true,
      invoiceNumber: inv.num,
      pdfBase64: pdfBase64,
      fileName: fileName
    });

  } catch (error) {
    console.error('PDF generation error:', error);
    return res.status(500).json({
      error: 'PDF generation error',
      message: error.message
    });
  }
};

// Helper function to format date (full format with year)
function formatDate(dateStr) {
  if (!dateStr) return '';
  try {
    const date = new Date(dateStr);
    return date.toLocaleDateString('en-GB', {
      day: 'numeric',
      month: 'short',
      year: 'numeric'
    });
  } catch (e) {
    return dateStr;
  }
}

// Helper function to format a single date for PDF display (short format: "10 Feb")
function formatShortDate(dateStr) {
  if (!dateStr) return '';
  try {
    const d = new Date(dateStr);
    return d.getDate() + ' ' + d.toLocaleString('en-GB', { month: 'short' });
  } catch (e) {
    return dateStr;
  }
}
