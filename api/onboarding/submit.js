/**
 * POST /api/onboarding/submit
 *
 * Process new user onboarding form submission.
 * Creates user's Google Sheet, populates with settings/practices, adds to Master Sheet.
 *
 * Body: { user, entityType, selfEmployed, ltdCompany, practices }
 * Returns: { success: true, userId } or { error: string }
 */

const { google } = require('googleapis');
const crypto = require('crypto');

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
    const { user, entityType, selfEmployed, ltdCompany, practices } = req.body;

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
      range: 'Users!A:J',
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

    // Create new Google Sheet for user (copy from template or create fresh)
    const newSheet = await drive.files.create({
      requestBody: {
        name: `BooksIQ - ${user.name}`,
        mimeType: 'application/vnd.google-apps.spreadsheet',
      },
      fields: 'id',
    });

    const userSheetId = newSheet.data.id;

    // Set up sheet tabs
    await setupUserSheet(sheets, userSheetId, { user, entityType, selfEmployed, ltdCompany, practices });

    // Create Drive folder for user's invoices
    const newFolder = await drive.files.create({
      requestBody: {
        name: `BooksIQ Invoices - ${user.name}`,
        mimeType: 'application/vnd.google-apps.folder',
      },
      fields: 'id',
    });

    const userFolderId = newFolder.data.id;

    // Determine entity type string
    let entType = 'self';
    if (entityType.self && entityType.ltd) entType = 'both';
    else if (entityType.ltd) entType = 'ltd';

    // Add user to Master Sheet
    const userRow = [
      userId,                           // userId
      email,                            // email
      user.name,                        // name
      'active',                         // status
      'user',                           // role
      userSheetId,                      // sheetId
      userFolderId,                     // driveFolderId
      entType,                          // entityType
      new Date().toISOString(),         // createdAt
      ''                                // lastLogin
    ];

    await sheets.spreadsheets.values.append({
      spreadsheetId: masterSheetId,
      range: 'Users!A:J',
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: [userRow]
      }
    });

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
