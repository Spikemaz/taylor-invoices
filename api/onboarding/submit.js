/**
 * POST /api/onboarding/submit
 *
 * Process new user onboarding form submission.
 * Creates DUAL sheets for each user:
 *   1. Master backup sheet (service account owned, never shared, persists forever)
 *   2. User-facing sheet (shared with user's email for viewing/editing)
 * Also creates Drive folders and adds user to Master Sheet.
 *
 * Body: { user, entityType, selfEmployed, ltdCompany, practices }
 * Returns: { success: true, userId } or { error: string }
 */

const { google } = require('googleapis');
const crypto = require('crypto');

// Central backup folder for master backup sheets (service account owned)
// This folder contains all user backup sheets - users never see this
const MASTER_BACKUP_FOLDER_ID = process.env.MASTER_BACKUP_FOLDER_ID;

// Get auth client
function getAuthClient() {
  return new google.auth.GoogleAuth({
    credentials: {
      client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      private_key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    },
    scopes: [
      'https://www.googleapis.com/auth/spreadsheets',
      'https://www.googleapis.com/auth/drive'
    ],
  });
}

module.exports = async function handler(req, res) {
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

  try {
    const { user, entityType, selfEmployed, ltdCompany, practices, consentedAt } = req.body;

    // Validate required fields
    if (!user?.name || !user?.email || !user?.phone || !user?.address) {
      return res.status(400).json({ error: 'Missing required user fields' });
    }

    if (!entityType?.self && !entityType?.ltd) {
      return res.status(400).json({ error: 'At least one business type is required' });
    }

    const email = user.email.toLowerCase().trim();

    // Check if user already exists
    const auth = getAuthClient();
    const sheets = google.sheets({ version: 'v4', auth });
    const drive = google.drive({ version: 'v3', auth });

    const masterSheetId = process.env.MASTER_SHEET_ID;
    if (!masterSheetId) {
      console.error('MASTER_SHEET_ID not configured');
      return res.status(500).json({ error: 'Server configuration error' });
    }

    // Check for existing user
    const usersResponse = await sheets.spreadsheets.values.get({
      spreadsheetId: masterSheetId,
      range: 'Users!A:K',
    });

    const rows = usersResponse.data.values || [];
    if (rows.length > 1) {
      const headers = rows[0];
      const emailIdx = headers.indexOf('email');
      for (let i = 1; i < rows.length; i++) {
        if (rows[i][emailIdx]?.toLowerCase() === email) {
          return res.status(400).json({ error: 'An account with this email already exists' });
        }
      }
    }

    // Generate unique user ID
    const userId = crypto.randomUUID();

    console.log(`[Onboarding] Creating dual sheets for user: ${user.name} (${email})`);

    // ========== CREATE DUAL SHEETS ==========
    // 1. Master backup sheet (service account owned, never shared)
    // 2. User-facing sheet (shared with user's email)

    // --- MASTER BACKUP SHEET ---
    // This sheet stays in the central backup folder, owned by service account
    // Users never see or access this - it's our permanent backup
    const backupSheetRequest = {
      requestBody: {
        name: `[BACKUP] ${user.name} - ${userId.slice(0, 8)}`,
        mimeType: 'application/vnd.google-apps.spreadsheet',
      },
      fields: 'id',
    };

    // If backup folder is configured, put it there
    if (MASTER_BACKUP_FOLDER_ID) {
      backupSheetRequest.requestBody.parents = [MASTER_BACKUP_FOLDER_ID];
    }

    const backupSheet = await drive.files.create(backupSheetRequest);
    const backupSheetId = backupSheet.data.id;
    console.log(`[Onboarding] Created backup sheet: ${backupSheetId}`);

    // --- USER-FACING SHEET ---
    // This sheet is what the user sees - shared with their email
    const userSheet = await drive.files.create({
      requestBody: {
        name: `BooksIQ - ${user.name}`,
        mimeType: 'application/vnd.google-apps.spreadsheet',
      },
      fields: 'id',
    });
    const userSheetId = userSheet.data.id;
    console.log(`[Onboarding] Created user sheet: ${userSheetId}`);

    // Share user-facing sheet with the user's email (writer access)
    try {
      await drive.permissions.create({
        fileId: userSheetId,
        requestBody: {
          type: 'user',
          role: 'writer',
          emailAddress: email,
        },
        sendNotificationEmail: false, // Don't spam them with sharing emails
      });
      console.log(`[Onboarding] Shared user sheet with: ${email}`);
    } catch (shareError) {
      console.error(`[Onboarding] Warning: Could not share sheet with ${email}:`, shareError.message);
      // Continue anyway - admin can manually share if needed
    }

    // Set up BOTH sheets with identical structure
    await Promise.all([
      setupUserSheet(sheets, backupSheetId, { user, entityType, selfEmployed, ltdCompany, practices }),
      setupUserSheet(sheets, userSheetId, { user, entityType, selfEmployed, ltdCompany, practices })
    ]);
    console.log(`[Onboarding] Initialized both sheets with tabs and data`);

    // ========== CREATE DUAL DRIVE FOLDERS ==========
    // 1. Master backup folder for invoices (service account owned)
    // 2. User-facing folder (shared with user's email)

    // --- BACKUP INVOICE FOLDER ---
    const backupFolderRequest = {
      requestBody: {
        name: `[BACKUP] Invoices - ${user.name}`,
        mimeType: 'application/vnd.google-apps.folder',
      },
      fields: 'id',
    };

    if (MASTER_BACKUP_FOLDER_ID) {
      backupFolderRequest.requestBody.parents = [MASTER_BACKUP_FOLDER_ID];
    }

    const backupFolder = await drive.files.create(backupFolderRequest);
    const backupFolderId = backupFolder.data.id;
    console.log(`[Onboarding] Created backup folder: ${backupFolderId}`);

    // --- USER-FACING INVOICE FOLDER ---
    const userFolder = await drive.files.create({
      requestBody: {
        name: `BooksIQ Invoices - ${user.name}`,
        mimeType: 'application/vnd.google-apps.folder',
      },
      fields: 'id',
    });
    const userFolderId = userFolder.data.id;
    console.log(`[Onboarding] Created user folder: ${userFolderId}`);

    // Share user-facing folder with the user's email (writer access)
    try {
      await drive.permissions.create({
        fileId: userFolderId,
        requestBody: {
          type: 'user',
          role: 'writer',
          emailAddress: email,
        },
        sendNotificationEmail: false,
      });
      console.log(`[Onboarding] Shared user folder with: ${email}`);
    } catch (shareError) {
      console.error(`[Onboarding] Warning: Could not share folder with ${email}:`, shareError.message);
    }

    // Determine entity type string
    let entType = 'self';
    if (entityType.self && entityType.ltd) entType = 'both';
    else if (entityType.ltd) entType = 'ltd';

    // Add user to Master Sheet with DUAL sheet/folder references
    // Columns: userId, email, name, status, role, sheetId (user-facing), driveFolderId (user-facing),
    //          entityType, createdAt, lastLogin, consentedAt, backupSheetId, backupFolderId
    const userRow = [
      userId,                           // A: userId
      email,                            // B: email
      user.name,                        // C: name
      'active',                         // D: status
      'user',                           // E: role
      userSheetId,                      // F: sheetId (user-facing - this is what the app uses)
      userFolderId,                     // G: driveFolderId (user-facing - this is where user's PDFs go)
      entType,                          // H: entityType
      new Date().toISOString(),         // I: createdAt
      '',                               // J: lastLogin
      consentedAt || new Date().toISOString(),  // K: consentedAt
      backupSheetId,                    // L: backupSheetId (master backup - service account owned)
      backupFolderId                    // M: backupFolderId (master backup - service account owned)
    ];

    await sheets.spreadsheets.values.append({
      spreadsheetId: masterSheetId,
      range: 'Users!A:M',
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: [userRow]
      }
    });
    console.log(`[Onboarding] Added user to Master Sheet with dual sheet/folder references`);

    // Send welcome email with magic link
    if (process.env.RESEND_API_KEY) {
      // Generate magic link token
      const { generateToken, storeMagicLink } = require('../_lib/auth');
      const token = generateToken();
      await storeMagicLink(email, token);

      const baseUrl = process.env.APP_URL || `https://${req.headers.host}`;
      const magicLink = `${baseUrl}/api/auth/verify?token=${token}`;

      await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          from: process.env.EMAIL_FROM || 'BooksIQ <noreply@booksiq.app>',
          to: email,
          subject: 'Welcome to BooksIQ - Your Account is Ready!',
          html: `
            <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 500px; margin: 0 auto; padding: 20px;">
              <h2 style="color: #2d6a4f; margin-bottom: 24px;">Welcome to BooksIQ!</h2>
              <p style="color: #1a1a1a; font-size: 16px; line-height: 1.5;">
                Hi ${user.name},
              </p>
              <p style="color: #1a1a1a; font-size: 16px; line-height: 1.5;">
                Your BooksIQ account has been created successfully. Click the button below to sign in and start using the app.
              </p>
              <a href="${magicLink}"
                 style="display: inline-block; background: #2d6a4f; color: white; padding: 14px 28px; text-decoration: none; border-radius: 8px; font-weight: 600; margin: 24px 0;">
                Sign In to BooksIQ
              </a>
              <p style="color: #6b7280; font-size: 14px; line-height: 1.5;">
                This link will expire in 15 minutes. You can always request a new one from the login page.
              </p>
              <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 24px 0;">
              <p style="color: #9ca3af; font-size: 12px;">
                BooksIQ - Invoice Management for Healthcare Professionals
              </p>
            </div>
          `
        })
      });
    }

    return res.status(200).json({
      success: true,
      userId,
      message: 'Account created successfully'
    });

  } catch (error) {
    console.error('Onboarding error:', error);
    return res.status(500).json({
      error: 'Failed to create account',
      details: error.message
    });
  }
};

/**
 * Set up user's Google Sheet with all required tabs and initial data
 */
async function setupUserSheet(sheets, sheetId, data) {
  const { user, entityType, selfEmployed, ltdCompany, practices } = data;

  // Create all tabs
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: sheetId,
    requestBody: {
      requests: [
        // Rename default Sheet1 to Entries
        { updateSheetProperties: { properties: { sheetId: 0, title: 'Entries' }, fields: 'title' } },
        // Add other tabs
        { addSheet: { properties: { title: 'Invoices' } } },
        { addSheet: { properties: { title: 'Practices' } } },
        { addSheet: { properties: { title: 'Settings' } } },
        { addSheet: { properties: { title: 'Log' } } },
        { addSheet: { properties: { title: 'Trash' } } },
      ]
    }
  });

  // Add headers to Entries tab
  await sheets.spreadsheets.values.update({
    spreadsheetId: sheetId,
    range: 'Entries!A1:T1',
    valueInputOption: 'RAW',
    requestBody: {
      values: [['id', 'date', 'pId', 'pName', 'pType', 'svc', 'pts', 'uPrice', 'aoType', 'aoAmt', 'aoPatients', 'gross', 'comm', 'commAmt', 'entity', 'invSt', 'invNo', 'adhocAddr', 'color', 'createdAt']]
    }
  });

  // Add headers to Invoices tab
  await sheets.spreadsheets.values.update({
    spreadsheetId: sheetId,
    range: 'Invoices!A1:AC1',
    valueInputOption: 'RAW',
    requestBody: {
      values: [['num', 'date', 'practice', 'practiceName', 'practiceAddr', 'period', 'entity', 'entName', 'entAddr', 'entPhone', 'bankName', 'bankAccName', 'bankAcc', 'bankSort', 'amount', 'gross', 'commRate', 'svcs', 'addons', 'airTotal', 'logoType', 'payTerms', 'footerMsg', 'companyNo', 'isAdhoc', 'driveLink', 'paidStatus', 'paidDate', 'createdAt']]
    }
  });

  // Add headers to Practices tab
  await sheets.spreadsheets.values.update({
    spreadsheetId: sheetId,
    range: 'Practices!A1:Q1',
    valueInputOption: 'RAW',
    requestBody: {
      values: [['id', 'short', 'name', 'type', 'addr', 'email', 'comm', 'services', 'days', 'rate', 'air', 'active', 'color', 'paidHours', 'ptsPerHour', 'paymentDueDay', 'createdAt']]
    }
  });

  // Add practices data
  if (practices && practices.length > 0) {
    const practiceRows = practices.map((p, idx) => {
      const practiceId = p.short.toLowerCase().replace(/[^a-z0-9]/g, '');
      return [
        practiceId,                           // id
        p.short,                              // short
        p.name,                               // name
        p.type,                               // type
        p.address,                            // addr
        '',                                   // email
        p.type === 'contract' ? p.commission : 0,  // comm
        JSON.stringify(p.services || {}),     // services
        JSON.stringify(p.days || []),         // days
        p.type === 'adhoc' ? p.rate : 0,      // rate
        9,                                    // air (default)
        true,                                 // active
        '',                                   // color
        '{}',                                 // paidHours
        2,                                    // ptsPerHour
        15,                                   // paymentDueDay
        new Date().toISOString()              // createdAt
      ];
    });

    await sheets.spreadsheets.values.append({
      spreadsheetId: sheetId,
      range: 'Practices!A:Q',
      valueInputOption: 'RAW',
      requestBody: { values: practiceRows }
    });
  }

  // Add headers to Settings tab
  await sheets.spreadsheets.values.update({
    spreadsheetId: sheetId,
    range: 'Settings!A1:C1',
    valueInputOption: 'RAW',
    requestBody: {
      values: [['key', 'value', 'updatedAt']]
    }
  });

  // Add entity settings
  const now = new Date().toISOString();
  const settingsRows = [];

  // Build entities object
  const entities = {};
  if (entityType.self) {
    entities.self = {
      name: selfEmployed.tradingName || user.name,
      addr: user.address,
      phone: user.phone,
      email: user.email,
      bank: selfEmployed.bankName,
      bName: selfEmployed.accName,
      acc: selfEmployed.accNum,
      sort: selfEmployed.sort
    };
  }
  if (entityType.ltd) {
    entities.ltd = {
      name: ltdCompany.companyName,
      addr: ltdCompany.address,
      phone: user.phone,
      email: user.email,
      bank: ltdCompany.bankName,
      bName: ltdCompany.accName,
      acc: ltdCompany.accNum,
      sort: ltdCompany.sort,
      companyNo: ltdCompany.companyNo
    };
  }

  settingsRows.push(['entities', JSON.stringify(entities), now]);
  settingsRows.push(['payTerms', '10 working days', now]);
  settingsRows.push(['invoiceFooter', 'Thank you for your continued support.', now]);
  settingsRows.push(['dayMap', '{}', now]);
  settingsRows.push(['nextInvSelf', '1', now]);
  settingsRows.push(['nextInvLtd', '1', now]);

  await sheets.spreadsheets.values.append({
    spreadsheetId: sheetId,
    range: 'Settings!A:C',
    valueInputOption: 'RAW',
    requestBody: { values: settingsRows }
  });

  // Add headers to Log tab
  await sheets.spreadsheets.values.update({
    spreadsheetId: sheetId,
    range: 'Log!A1:G1',
    valueInputOption: 'RAW',
    requestBody: {
      values: [['timestamp', 'action', 'dataType', 'recordId', 'changes', 'previousData', 'newData']]
    }
  });

  // Add headers to Trash tab
  await sheets.spreadsheets.values.update({
    spreadsheetId: sheetId,
    range: 'Trash!A1:C1',
    valueInputOption: 'RAW',
    requestBody: {
      values: [['deletedAt', 'dataType', 'originalData']]
    }
  });
}
