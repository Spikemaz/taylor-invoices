// Google Drive folder initialization endpoint
// Pre-creates folder structure for both entities: Self-Employed and Ltd Company

const { google } = require('googleapis');
const { applyCors, requireSession, getAuthClient } = require('./_lib/auth');

async function getDrive() {
  const auth = getAuthClient();
  const drive = google.drive({ version: 'v3', auth });
  return drive;
}

const ROOT_FOLDER_ID = process.env.GOOGLE_DRIVE_FOLDER_ID;

module.exports = async (req, res) => {
  applyCors(req, res, 'POST, OPTIONS');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Drive folder bootstrap is an admin-only setup operation. It mints the
  // Entity/Invoices/<year>/<month>/ tree under the global ROOT_FOLDER_ID
  // — exposing this without auth would let anyone fabricate folder
  // structures inside our shared drive.
  const session = await requireSession(req, res, { adminOnly: true });
  if (!session) return;

  try {
    const drive = await getDrive();
    const currentYear = new Date().getFullYear().toString();
    const months = ['January', 'February', 'March', 'April', 'May', 'June',
                    'July', 'August', 'September', 'October', 'November', 'December'];

    const results = {
      'Self-Employed': { created: false, folders: [] },
      'Ltd Company': { created: false, folders: [] }
    };

    // Create folder structure for both entities
    for (const entityName of ['Self-Employed', 'Ltd Company']) {
      // Get or create Entity folder
      const entityFolderId = await getOrCreateFolder(drive, entityName, ROOT_FOLDER_ID);
      results[entityName].entityFolderId = entityFolderId;

      // Get or create Invoices folder inside Entity
      const invoicesFolderId = await getOrCreateFolder(drive, 'Invoices', entityFolderId);
      results[entityName].invoicesFolderId = invoicesFolderId;

      // Get or create Year folder inside Invoices (current year)
      const yearFolderId = await getOrCreateFolder(drive, currentYear, invoicesFolderId);
      results[entityName].yearFolderId = yearFolderId;
      results[entityName].folders.push(`${entityName}/Invoices/${currentYear}`);

      // Create all 12 month folders
      for (const month of months) {
        await getOrCreateFolder(drive, month, yearFolderId);
        results[entityName].folders.push(`${entityName}/Invoices/${currentYear}/${month}`);
      }

      results[entityName].created = true;
    }

    return res.status(200).json({
      success: true,
      message: 'Folder structure initialized for both entities',
      year: currentYear,
      results
    });

  } catch (error) {
    console.error('Drive init error:', error);
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
    spaces: 'drive',
    supportsAllDrives: true,
    includeItemsFromAllDrives: true
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
    fields: 'id',
    supportsAllDrives: true
  });

  return folder.data.id;
}
