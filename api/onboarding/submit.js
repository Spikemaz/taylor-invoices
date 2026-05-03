/**
 * POST /api/onboarding/submit
 *
 * Process new user onboarding form submission.
 * Creates FOUR things for each user:
 *   1. User-facing sheet  (in central hub, shared to user email as editor)
 *   2. User-facing folder (in central hub, shared to user email as editor — PDFs land here)
 *   3. Hidden backup sheet  (in hidden backup root, NEVER shared with user)
 *   4. Hidden backup folder (in hidden backup root, NEVER shared with user)
 *
 * If GOOGLE_DRIVE_HIDDEN_BACKUP_ROOT_ID is unset we fall back to backupSheetId=sheetId
 * and log a warning. The admin/backfill-architecture endpoint can sweep those
 * users into real backups later once the env var is configured.
 *
 * Body: { user, entityType, selfEmployed, ltdCompany, practices }
 * Returns: { success: true, userId } or { error: string }
 */

const crypto = require('crypto');
const { applyCors } = require('../_lib/auth');
const {
  getClients,
  getCentralFolderId,
  getHiddenBackupRootId,
  createSpreadsheet,
  getOrCreateFolder,
  shareWithUser,
  ensureSheetSchema,
} = require('../_lib/drive-architecture');

module.exports = async function handler(req, res) {
  applyCors(req, res, 'POST, OPTIONS');

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

    const masterSheetId = process.env.MASTER_SHEET_ID;
    if (!masterSheetId) {
      console.error('MASTER_SHEET_ID not configured');
      return res.status(500).json({ error: 'Server configuration error' });
    }

    let centralFolderId;
    try {
      centralFolderId = getCentralFolderId();
    } catch (e) {
      console.error('Onboarding env error:', e.message);
      return res.status(500).json({ error: 'Server configuration error: central Drive folder not set' });
    }
    const hiddenBackupRootId = getHiddenBackupRootId();
    if (!hiddenBackupRootId) {
      console.warn('[Onboarding] GOOGLE_DRIVE_HIDDEN_BACKUP_ROOT_ID is not set — new user will get backupSheetId=sheetId. Run admin/backfill-architecture once the env var is configured.');
    }

    const { sheets, drive } = getClients();

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
    const shortId = userId.slice(0, 8);

    console.log(`[Onboarding] Creating sheet+folder for user: ${user.name} (${email}) inside central hub`);

    // ========== USER-FACING (central hub, shared to email) ==========
    const userSheetId = await createSpreadsheet(
      drive,
      `BooksIQ - ${user.name} - ${shortId}`,
      centralFolderId
    );
    console.log(`[Onboarding] Created user-facing sheet: ${userSheetId}`);

    const userFolderId = await getOrCreateFolder(
      drive,
      `Invoices - ${user.name} - ${shortId}`,
      centralFolderId
    );
    console.log(`[Onboarding] Created user-facing folder: ${userFolderId}`);

    // Schema first, then onboarding-specific seed data
    await ensureSheetSchema(sheets, userSheetId);
    await seedOnboardingData(sheets, userSheetId, { user, entityType, selfEmployed, ltdCompany, practices });
    console.log(`[Onboarding] Initialized user-facing sheet with tabs and data`);

    // Share user-facing sheet+folder back to the user as editor.
    // Failure here is non-fatal — we'd rather have a working account
    // (admin can re-share via backfill-architecture) than fail onboarding.
    try {
      const shareResultsSheet = await shareWithUser(drive, userSheetId, email, 'writer', false);
      const shareResultsFolder = await shareWithUser(drive, userFolderId, email, 'writer', false);
      console.log(`[Onboarding] Shared user-facing sheet (${shareResultsSheet.created ? 'new' : 'existing'}) and folder (${shareResultsFolder.created ? 'new' : 'existing'}) with ${email}`);
    } catch (shareErr) {
      console.error(`[Onboarding] WARNING: failed to share user-facing items with ${email}:`, shareErr.message);
    }

    // ========== HIDDEN BACKUP (separate parent, NEVER shared) ==========
    let backupSheetId = userSheetId;
    let backupFolderId = userFolderId;
    if (hiddenBackupRootId) {
      try {
        backupSheetId = await createSpreadsheet(
          drive,
          `BooksIQ BACKUP - ${user.name} - ${shortId}`,
          hiddenBackupRootId
        );
        backupFolderId = await getOrCreateFolder(
          drive,
          `Invoices BACKUP - ${user.name} - ${shortId}`,
          hiddenBackupRootId
        );
        await ensureSheetSchema(sheets, backupSheetId);
        // Seed the backup with the same initial onboarding data so it's a true mirror from day 1
        await seedOnboardingData(sheets, backupSheetId, { user, entityType, selfEmployed, ltdCompany, practices });
        console.log(`[Onboarding] Created hidden backup sheet ${backupSheetId} and folder ${backupFolderId}`);
      } catch (backupErr) {
        console.error('[Onboarding] WARNING: hidden backup creation failed, falling back to backupSheetId=sheetId:', backupErr.message);
        backupSheetId = userSheetId;
        backupFolderId = userFolderId;
      }
    }

    // Determine entity type string
    let entType = 'self';
    if (entityType.self && entityType.ltd) entType = 'both';
    else if (entityType.ltd) entType = 'ltd';

    // Add user to Master Sheet — F/G hold user-facing IDs, L/M hold REAL hidden backup IDs
    const userRow = [
      userId,                           // A: userId
      email,                            // B: email
      user.name,                        // C: name (full display name)
      'active',                         // D: status
      'user',                           // E: role
      userSheetId,                      // F: sheetId (user-facing)
      userFolderId,                     // G: driveFolderId (user-facing)
      entType,                          // H: entityType
      new Date().toISOString(),         // I: createdAt
      '',                               // J: lastLogin
      consentedAt || new Date().toISOString(),  // K: consentedAt
      backupSheetId,                    // L: backupSheetId (REAL hidden backup if env set)
      backupFolderId,                   // M: backupFolderId (REAL hidden backup if env set)
      user.firstName || '',             // N: firstName
      user.middleNames || '',           // O: middleNames
      user.surname || '',               // P: surname
      user.phone || ''                  // Q: phone
    ];

    await sheets.spreadsheets.values.append({
      spreadsheetId: masterSheetId,
      range: 'Users!A:Q',
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: [userRow]
      }
    });
    console.log(`[Onboarding] Added user to Master Sheet (backup ${backupSheetId === userSheetId ? 'fallback=same' : 'real'})`);

    // Send welcome email with magic link
    if (process.env.RESEND_API_KEY) {
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
 * Seed practices and entity settings into a freshly initialised sheet.
 * Assumes ensureSheetSchema() has already created the tabs + headers.
 *
 * Used by both the user-facing sheet and the hidden-backup sheet so they
 * start as identical mirrors. Safe to call on a sheet that has data
 * already, but will append duplicates — only intended for fresh sheets.
 */
async function seedOnboardingData(sheets, sheetId, data) {
  const { user, entityType, selfEmployed, ltdCompany, practices } = data;
  const now = new Date().toISOString();

  // Practices
  if (practices && practices.length > 0) {
    const practiceRows = practices.map((p) => {
      const practiceId = p.short.toLowerCase().replace(/[^a-z0-9]/g, '');
      const paymentMethod = p.paymentMethod || (p.type === 'adhoc' ? 'perpatient' : 'commission');
      return [
        practiceId,
        p.short,
        p.name,
        p.type,
        paymentMethod,
        p.address,
        '',
        paymentMethod === 'commission' ? p.commission : 0,
        JSON.stringify(p.services || {}),
        JSON.stringify(p.days || []),
        paymentMethod === 'perpatient' ? p.rate : 0,
        9,
        true,
        '',
        '{}',
        2,
        15,
        now,
      ];
    });
    await sheets.spreadsheets.values.append({
      spreadsheetId: sheetId,
      range: 'Practices!A:R',
      valueInputOption: 'RAW',
      requestBody: { values: practiceRows },
    });
  }

  // Entity settings
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
      sort: selfEmployed.sort,
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
      companyNo: ltdCompany.companyNo,
    };
  }

  const settingsRows = [
    ['entities', JSON.stringify(entities), now],
    ['payTerms', '10 working days', now],
    ['invoiceFooter', 'Thank you for your continued support.', now],
    ['dayMap', '{}', now],
    ['nextInvSelf', '1', now],
    ['nextInvLtd', '1', now],
  ];

  await sheets.spreadsheets.values.append({
    spreadsheetId: sheetId,
    range: 'Settings!A:C',
    valueInputOption: 'RAW',
    requestBody: { values: settingsRows },
  });
}
