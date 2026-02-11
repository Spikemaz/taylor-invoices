// PDF generation endpoint
// Generates invoice PDF using jsPDF, uploads to Drive, updates Sheets

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

  const invoiceData = req.body;

  // TODO: Implement jsPDF generation
  // 1. Generate PDF matching original layout
  // 2. Upload to Google Drive via drive-upload
  // 3. Update Google Sheets with invoice record and Drive link
  // 4. Return PDF binary for download

  return res.status(200).json({
    success: true,
    message: 'Stub: PDF generation received',
    invoiceNumber: invoiceData.num
  });
};
