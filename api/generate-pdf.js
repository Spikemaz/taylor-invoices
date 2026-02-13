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
    let y = 40;

    // Set default font
    doc.setFont('helvetica');

    // Determine logo: use provided logoBase64, or look up by logoType, default to self
    const logoData = inv.logoBase64 || LOGOS[inv.logoType] || LOGOS.self;

    // Add logo (top left)
    if (logoData) {
      try {
        // Logo at top left, 60x60 points
        doc.addImage(logoData, 'JPEG', 40, y, 60, 60);
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
    // Phone below address with proper spacing
    if (inv.entPhone) {
      doc.text(inv.entPhone, W - 40, addrY + addrLines.length * 12, { align: 'right' });
    }

    // INVOICE title (starts below logo area)
    doc.setTextColor(45, 106, 79); // Primary green
    doc.setFontSize(22);
    doc.setFont('helvetica', 'bold');
    doc.text('INVOICE', 40, 120);

    // Green line (below INVOICE title)
    doc.setFillColor(27, 67, 50); // Dark green
    doc.rect(40, 128, W - 80, 3, 'F');

    // Bill To section
    y = 150;
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

    // Table header
    y = 250;
    doc.setFillColor(27, 67, 50);
    doc.rect(40, y, W - 80, 22, 'F');
    doc.setFontSize(10);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(255, 255, 255);
    doc.text('Service', 50, y + 15);
    doc.text('Price', 260, y + 15);
    doc.text('Qty', 390, y + 15, { align: 'right' });
    doc.text('Subtotal', W - 50, y + 15, { align: 'right' });
    y += 30;

    // Table rows
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(11);
    const svcs = inv.svcs || {};
    const svcKeys = Object.keys(svcs);

    svcKeys.forEach((key) => {
      const s = svcs[key];
      doc.setTextColor(26, 26, 26);
      doc.text(s.name || '', 50, y + 4);
      doc.text('\u00a3' + (s.price || 0).toFixed(2), 260, y + 4);
      doc.text(String(s.pts || 0), 390, y + 4, { align: 'right' });
      doc.text('\u00a3' + (s.total || 0).toFixed(2), W - 50, y + 4, { align: 'right' });

      // Row separator line
      doc.setDrawColor(229, 231, 235);
      doc.setLineWidth(1);
      doc.line(40, y + 10, W - 40, y + 10);
      y += 22;
    });

    // Airflow add-on if present
    if (inv.airTotal > 0) {
      doc.setTextColor(26, 26, 26);
      doc.text('Airflow Add-on', 50, y + 4);
      doc.text('\u00a3' + inv.airTotal.toFixed(2), W - 50, y + 4, { align: 'right' });
      doc.setDrawColor(229, 231, 235);
      doc.line(40, y + 10, W - 40, y + 10);
      y += 22;
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
      doc.text('Commission @ ' + (inv.commRate || '0') + '%', 300, y);
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

    // Bank details section
    y = Math.max(y + 40, 560);
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
    doc.text('Thank you for your continued support.', 40, y);

    // Footer
    doc.setDrawColor(229, 231, 235);
    doc.line(40, H - 50, W - 40, H - 50);
    doc.setFontSize(9);
    doc.setTextColor(156, 163, 175);
    doc.text(inv.entName + ' | Invoice ' + inv.num, W / 2, H - 32, { align: 'center' });
    // Add company number for Ltd invoices
    if (inv.companyNo) {
      doc.text('Company No: ' + inv.companyNo, W / 2, H - 20, { align: 'center' });
    }

    // Get PDF as base64
    const pdfBase64 = doc.output('datauristring').split(',')[1];

    // Return PDF data for client-side download and Drive upload
    return res.status(200).json({
      success: true,
      invoiceNumber: inv.num,
      pdfBase64: pdfBase64,
      fileName: 'Invoice-' + inv.num + '.pdf'
    });

  } catch (error) {
    console.error('PDF generation error:', error);
    return res.status(500).json({
      error: 'PDF generation error',
      message: error.message
    });
  }
};

// Helper function to format date
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
