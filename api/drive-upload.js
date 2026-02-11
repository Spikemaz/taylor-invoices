// Google Drive upload endpoint
// Uploads PDFs to organized folder structure: Entity/Year/Month/

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

  const { fileName, entity, year, month } = req.body;

  // TODO: Implement Google Drive upload
  // Will create folder structure: Entity/Year/Month/
  // Will use googleapis package with service account auth

  return res.status(200).json({
    success: true,
    message: 'Stub: Upload received',
    fileId: 'stub-file-id',
    webViewLink: 'https://drive.google.com/stub',
    webContentLink: 'https://drive.google.com/stub/download'
  });
};
