// Google Drive upload endpoint
// Uploads PDFs to organized folder structure: Entity/Year/Month/

const { google } = require('googleapis');
const { Readable } = require('stream');

// Initialize Google Drive client
async function getDrive() {
  const auth = new google.auth.GoogleAuth({
    credentials: {
      client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    },
    scopes: ['https://www.googleapis.com/auth/drive'],
  });

  const drive = google.drive({ version: 'v3', auth });
  return drive;
}

const ROOT_FOLDER_ID = process.env.GOOGLE_DRIVE_FOLDER_ID;

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

  const { fileName, pdfBase64, entity, year, month } = req.body;

  if (!fileName || !pdfBase64) {
    return res.status(400).json({ error: 'Missing required fields: fileName, pdfBase64' });
  }

  try {
    const drive = await getDrive();

    // Create folder structure: Entity/Invoices/Year/Month/
    const entityFolderName = entity === 'ltd' ? 'Ltd Company' : 'Self-Employed';
    const yearStr = year || new Date().getFullYear().toString();
    const monthStr = month || new Date().toLocaleString('en-GB', { month: 'long' });

    // Get or create Entity folder
    const entityFolderId = await getOrCreateFolder(drive, entityFolderName, ROOT_FOLDER_ID);

    // Get or create Invoices folder inside Entity
    const invoicesFolderId = await getOrCreateFolder(drive, 'Invoices', entityFolderId);

    // Get or create Year folder inside Invoices
    const yearFolderId = await getOrCreateFolder(drive, yearStr, invoicesFolderId);

    // Get or create Month folder inside Year
    const monthFolderId = await getOrCreateFolder(drive, monthStr, yearFolderId);

    // Convert base64 to buffer
    const pdfBuffer = Buffer.from(pdfBase64, 'base64');

    // Upload the PDF
    const fileMetadata = {
      name: fileName,
      parents: [monthFolderId],
      mimeType: 'application/pdf'
    };

    const media = {
      mimeType: 'application/pdf',
      body: Readable.from(pdfBuffer)
    };

    const file = await drive.files.create({
      requestBody: fileMetadata,
      media: media,
      fields: 'id, name, webViewLink, webContentLink'
    });

    // Make the file viewable by anyone with the link
    await drive.permissions.create({
      fileId: file.data.id,
      requestBody: {
        role: 'reader',
        type: 'anyone'
      }
    });

    // Get updated file info with sharing links
    const updatedFile = await drive.files.get({
      fileId: file.data.id,
      fields: 'id, name, webViewLink, webContentLink'
    });

    return res.status(200).json({
      success: true,
      message: 'PDF uploaded successfully',
      fileId: updatedFile.data.id,
      fileName: updatedFile.data.name,
      webViewLink: updatedFile.data.webViewLink,
      webContentLink: updatedFile.data.webContentLink,
      folderPath: `${entityFolderName}/Invoices/${yearStr}/${monthStr}`
    });

  } catch (error) {
    console.error('Drive API error:', error);
    return res.status(500).json({
      error: 'Drive API error',
      message: error.message,
      details: error.response?.data?.error?.message || null
    });
  }
};

// Helper function to get or create a folder
async function getOrCreateFolder(drive, folderName, parentId) {
  // Search for existing folder
  const query = `name='${folderName}' and mimeType='application/vnd.google-apps.folder' and '${parentId}' in parents and trashed=false`;

  const response = await drive.files.list({
    q: query,
    fields: 'files(id, name)',
    spaces: 'drive'
  });

  if (response.data.files && response.data.files.length > 0) {
    // Folder exists, return its ID
    return response.data.files[0].id;
  }

  // Create new folder
  const fileMetadata = {
    name: folderName,
    mimeType: 'application/vnd.google-apps.folder',
    parents: [parentId]
  };

  const folder = await drive.files.create({
    requestBody: fileMetadata,
    fields: 'id'
  });

  return folder.data.id;
}
