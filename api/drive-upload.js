// Google Drive upload endpoint
// Uploads PDFs to organized folder structure: Entity/Invoices/Year/Month/
//
// Mirroring strategy (May 2026, post-central-hub migration):
//   - Primary upload always goes into the user's user-facing folder
//     (session.driveFolderId). This is what's shared with the user.
//   - If the user has been migrated to the central-hub architecture they
//     also have a hidden backup folder (session.backupFolderId) that the
//     service account owns and the user CANNOT see. We mirror the PDF
//     into that folder using the same Entity/Invoices/Year/Month tree.
//   - Mirror failures NEVER block the primary upload. They surface as a
//     `mirrorFailures` array on the response so the client can warn or
//     retry without losing the user-facing PDF.
//   - Legacy users who have not been migrated fall back to the older
//     central BACKUP_FOLDER_ID (env var) keyed by user name. This path
//     exists only so deployments don't lose backup coverage during the
//     migration window — once everyone is migrated it can be deleted.

const { google } = require('googleapis');
const { Readable } = require('stream');

// Validate required environment variables
function validateEnvVars() {
  const required = ['GOOGLE_SERVICE_ACCOUNT_EMAIL', 'GOOGLE_PRIVATE_KEY', 'GOOGLE_DRIVE_FOLDER_ID'];
  const missing = required.filter(key => !process.env[key]);
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}. Please configure these in your Vercel project settings.`);
  }
}

// Initialize Google Drive client
async function getDrive() {
  validateEnvVars();
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
const DRIVE_OWNER_EMAIL = process.env.GOOGLE_DRIVE_OWNER_EMAIL; // Email to transfer ownership to
const LEGACY_BACKUP_FOLDER_ID = process.env.GOOGLE_DRIVE_BACKUP_FOLDER_ID; // Pre-migration central backup; fallback only

const { applyCors, requireSession, auditAdminOverride } = require('./_lib/auth');

module.exports = async (req, res) => {
  applyCors(req, res, 'POST, OPTIONS');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Require a valid, non-suspended session. The legacy single-user
  // fallback (uploading into ROOT_FOLDER_ID with no auth) is gone — every
  // upload must be tied to a known user so the file lands in their folder
  // and the audit trail is complete.
  const session = await requireSession(req, res);
  if (!session) return;

  const { fileName, pdfBase64, entity, year, month, isAdhoc } = req.body;

  if (!fileName || !pdfBase64) {
    return res.status(400).json({ error: 'Missing required fields: fileName, pdfBase64' });
  }

  const userId = session.userId;
  const userName = session.name;

  // Admin impersonation: check for override headers (folder + per-user backup folder)
  let userFolderId = session.driveFolderId || ROOT_FOLDER_ID;
  let userBackupFolderId = session.backupFolderId || '';
  if (session.role === 'admin') {
    const overrideFolderId = req.headers['x-override-drive-folder-id'];
    if (overrideFolderId) {
      console.log('[drive-upload] Admin override: using driveFolderId', overrideFolderId);
      userFolderId = overrideFolderId;
      // Audit every override-driven upload — admin is writing into someone
      // else's Drive folder so we want a per-file paper trail.
      await auditAdminOverride(session, req, 'drive_upload', { fileName, entity, year, month });
    }
    const overrideBackupFolderId = req.headers['x-override-backup-folder-id'];
    if (overrideBackupFolderId) {
      console.log('[drive-upload] Admin override: using backupFolderId', overrideBackupFolderId);
      userBackupFolderId = overrideBackupFolderId;
    }
  }

  const mirrorFailures = [];

  try {
    const drive = await getDrive();

    // Create folder structure: Entity/Invoices/Year/Month/ (or Entity/Invoices/Year/Month/Ad Hoc/ for adhoc)
    const entityFolderName = entity === 'ltd' ? 'Ltd Company' : 'Self-Employed';
    const yearStr = year || new Date().getFullYear().toString();
    const monthStr = month || new Date().toLocaleString('en-GB', { month: 'long' });

    // ===== PRIMARY UPLOAD (user-facing folder) =====
    // Failures here ARE fatal — without a primary upload the user has no PDF.
    const targetFolderId = await buildInvoiceFolderTree(
      drive, userFolderId, entityFolderName, yearStr, monthStr, isAdhoc
    );
    const folderPath = invoicePathLabel(entityFolderName, yearStr, monthStr, isAdhoc);

    // Convert base64 to buffer
    const pdfBuffer = Buffer.from(pdfBase64, 'base64');

    // Upload the PDF
    const fileMetadata = {
      name: fileName,
      parents: [targetFolderId],
      mimeType: 'application/pdf'
    };

    const media = {
      mimeType: 'application/pdf',
      body: Readable.from(pdfBuffer)
    };

    const file = await drive.files.create({
      requestBody: fileMetadata,
      media: media,
      fields: 'id, name, webViewLink, webContentLink',
      supportsAllDrives: true
    });

    // Transfer ownership to the Drive owner (so file uses their quota, not service account's)
    if (DRIVE_OWNER_EMAIL) {
      try {
        await drive.permissions.create({
          fileId: file.data.id,
          requestBody: {
            role: 'owner',
            type: 'user',
            emailAddress: DRIVE_OWNER_EMAIL
          },
          transferOwnership: true,
          supportsAllDrives: true
        });
      } catch (transferErr) {
        console.log('Ownership transfer failed (may already be owned):', transferErr.message);
      }
    }

    // Make the file viewable by anyone with the link
    await drive.permissions.create({
      fileId: file.data.id,
      requestBody: {
        role: 'reader',
        type: 'anyone'
      },
      supportsAllDrives: true
    });

    // Get updated file info with sharing links
    const updatedFile = await drive.files.get({
      fileId: file.data.id,
      fields: 'id, name, webViewLink, webContentLink',
      supportsAllDrives: true
    });

    // ===== MIRROR INTO HIDDEN BACKUP (per-user, post-migration) =====
    // We prefer the per-user hidden backup folder. Each migrated user has
    // their own one and the service account owns it, so the mirror is a
    // true "user can't accidentally nuke this" backup.
    let backupFileId = null;
    if (userBackupFolderId) {
      try {
        const mirrorParent = await buildInvoiceFolderTree(
          drive, userBackupFolderId, entityFolderName, yearStr, monthStr, isAdhoc
        );
        // Use copy() rather than re-uploading the base64 — saves bandwidth
        // and keeps the two PDFs byte-identical (copy() preserves content).
        const backupFile = await drive.files.copy({
          fileId: updatedFile.data.id,
          requestBody: { name: fileName, parents: [mirrorParent] },
          supportsAllDrives: true,
          fields: 'id'
        });
        backupFileId = backupFile.data.id;
        console.log(`[drive-upload] Mirrored to per-user backup: ${userName}/${folderPath}/${fileName} -> ${backupFileId}`);
      } catch (mirrorErr) {
        // Mirror failure must NOT fail the primary upload. Log + surface.
        console.error('[drive-upload] Per-user mirror failed:', mirrorErr.message);
        mirrorFailures.push({
          tier: 'per-user-backup',
          backupFolderId: userBackupFolderId,
          message: mirrorErr.message,
        });
      }
    } else if (LEGACY_BACKUP_FOLDER_ID) {
      // Legacy fallback: copy into the central pre-migration backup tier
      // keyed by username. This path exists only until every user is
      // migrated; once they have a session.backupFolderId, the per-user
      // tier above is used instead.
      try {
        const backupUserFolderId = await getOrCreateFolder(drive, userName, LEGACY_BACKUP_FOLDER_ID);
        const backupYearFolderId = await getOrCreateFolder(drive, yearStr, backupUserFolderId);
        const backupMonthFolderId = await getOrCreateFolder(drive, monthStr, backupYearFolderId);

        const backupFile = await drive.files.copy({
          fileId: updatedFile.data.id,
          requestBody: { name: fileName, parents: [backupMonthFolderId] },
          supportsAllDrives: true,
          fields: 'id'
        });
        backupFileId = backupFile.data.id;
        console.log(`[drive-upload] Mirrored to legacy central backup: ${userName}/${yearStr}/${monthStr}/${fileName}`);
      } catch (backupErr) {
        console.error('[drive-upload] Legacy central mirror failed:', backupErr.message);
        mirrorFailures.push({
          tier: 'legacy-central-backup',
          backupFolderId: LEGACY_BACKUP_FOLDER_ID,
          message: backupErr.message,
        });
      }
    }
    // No backup tier configured at all — user is pre-migration AND no env
    // var set. Not an error; just no backup coverage. We do NOT push to
    // mirrorFailures because there is nothing to fail.

    return res.status(200).json({
      success: true,
      message: 'PDF uploaded successfully',
      fileId: updatedFile.data.id,
      fileName: updatedFile.data.name,
      webViewLink: updatedFile.data.webViewLink,
      webContentLink: updatedFile.data.webContentLink,
      folderPath: folderPath,
      backupFileId: backupFileId,
      backupTier: userBackupFolderId ? 'per-user' : (LEGACY_BACKUP_FOLDER_ID ? 'legacy-central' : 'none'),
      mirrorFailures, // [] when everything succeeded
    });

  } catch (error) {
    console.error('Drive API error:', error);
    return res.status(500).json({
      error: 'Drive API error',
      message: error.message,
      details: error.response?.data?.error?.message || null,
      // Surface mirrorFailures even on primary failure so debugging has
      // the full picture (rare but possible if mirror succeeded before
      // primary's link/perm step blew up).
      mirrorFailures,
    });
  }
};

// Build the Entity/Invoices/Year/Month/[Ad Hoc/] tree under a parent folder.
// All getOrCreateFolder calls are idempotent so this is safe to call repeatedly
// for both the primary user-facing tier and the hidden backup tier.
async function buildInvoiceFolderTree(drive, parentFolderId, entityFolderName, yearStr, monthStr, isAdhoc) {
  const entityFolderId = await getOrCreateFolder(drive, entityFolderName, parentFolderId);
  const invoicesFolderId = await getOrCreateFolder(drive, 'Invoices', entityFolderId);
  const yearFolderId = await getOrCreateFolder(drive, yearStr, invoicesFolderId);
  const monthFolderId = await getOrCreateFolder(drive, monthStr, yearFolderId);
  if (isAdhoc) {
    return await getOrCreateFolder(drive, 'Ad Hoc', monthFolderId);
  }
  return monthFolderId;
}

function invoicePathLabel(entityFolderName, yearStr, monthStr, isAdhoc) {
  let p = `${entityFolderName}/Invoices/${yearStr}/${monthStr}`;
  if (isAdhoc) p += '/Ad Hoc';
  return p;
}

// Helper function to get or create a folder
async function getOrCreateFolder(drive, folderName, parentId) {
  // Search for existing folder - escape single quotes in folder name
  const escapedName = folderName.replace(/'/g, "\\'");
  const query = `name='${escapedName}' and mimeType='application/vnd.google-apps.folder' and '${parentId}' in parents and trashed=false`;

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
