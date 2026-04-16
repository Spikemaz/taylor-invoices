/**
 * Shared authentication helpers for BooksIQ multi-user system
 */

const { google } = require('googleapis');
const crypto = require('crypto');

// Session token validity (365 days)
const SESSION_EXPIRY_MS = 365 * 24 * 60 * 60 * 1000;

// Magic link validity (15 minutes)
const MAGIC_LINK_EXPIRY_MS = 15 * 60 * 1000;

/**
 * Get authenticated Google Sheets client
 */
function getAuthClient() {
  const auth = new google.auth.GoogleAuth({
    credentials: {
      client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      private_key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    },
    scopes: ['https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/drive'],
  });
  return auth;
}

/**
 * Get Master Sheet instance
 */
async function getMasterSheet() {
  const auth = getAuthClient();
  const sheets = google.sheets({ version: 'v4', auth });
  return { sheets, spreadsheetId: process.env.MASTER_SHEET_ID };
}

/**
 * Find user by email in Master Sheet
 * Now includes backupSheetId and backupFolderId columns (L, M)
 */
async function findUserByEmail(email) {
  const { sheets, spreadsheetId } = await getMasterSheet();

  const response = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: 'Users!A:M',  // Extended to include backupSheetId and backupFolderId
  });

  const rows = response.data.values || [];
  if (rows.length < 2) return null; // No data rows

  const headers = rows[0];
  const emailIdx = headers.indexOf('email');

  for (let i = 1; i < rows.length; i++) {
    if (rows[i][emailIdx]?.toLowerCase() === email.toLowerCase()) {
      const user = {};
      headers.forEach((h, idx) => {
        user[h] = rows[i][idx] || '';
      });
      user._rowIndex = i + 1; // 1-indexed for Sheets
      return user;
    }
  }

  return null;
}

/**
 * Find user by ID in Master Sheet
 * Now includes backupSheetId and backupFolderId columns (L, M)
 */
async function findUserById(userId) {
  const { sheets, spreadsheetId } = await getMasterSheet();

  const response = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: 'Users!A:M',  // Extended to include backupSheetId and backupFolderId
  });

  const rows = response.data.values || [];
  if (rows.length < 2) return null;

  const headers = rows[0];
  const idIdx = headers.indexOf('userId');

  for (let i = 1; i < rows.length; i++) {
    if (rows[i][idIdx] === userId) {
      const user = {};
      headers.forEach((h, idx) => {
        user[h] = rows[i][idx] || '';
      });
      user._rowIndex = i + 1;
      return user;
    }
  }

  return null;
}

/**
 * Generate a secure random token
 */
function generateToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('hex');
}

/**
 * Generate a 6-digit login code
 */
function generateCode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

/**
 * Store magic link token in Master Sheet
 */
async function storeMagicLink(email, token, code = null) {
  const { sheets, spreadsheetId } = await getMasterSheet();

  const now = new Date();
  const expiresAt = new Date(now.getTime() + MAGIC_LINK_EXPIRY_MS);

  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: 'MagicLinks!A:F',
    valueInputOption: 'USER_ENTERED',
    requestBody: {
      values: [[
        token,
        email,
        now.toISOString(),
        expiresAt.toISOString(),
        'false', // used
        code || '' // 6-digit code
      ]]
    }
  });

  return { token, code, expiresAt };
}

/**
 * Validate and consume magic link token or 6-digit code
 */
async function validateMagicLink(token, email = null) {
  const { sheets, spreadsheetId } = await getMasterSheet();

  const response = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: 'MagicLinks!A:F',
  });

  const rows = response.data.values || [];
  if (rows.length < 2) return { valid: false, error: 'Token not found' };

  const headers = rows[0];
  const tokenIdx = headers.indexOf('token');
  const emailIdx = headers.indexOf('email');
  const expiresIdx = headers.indexOf('expiresAt');
  const usedIdx = headers.indexOf('used');
  const codeIdx = headers.indexOf('code') !== -1 ? headers.indexOf('code') : 5;

  for (let i = 1; i < rows.length; i++) {
    // Match by token OR by code+email combo
    const isTokenMatch = rows[i][tokenIdx] === token;
    const isCodeMatch = email && rows[i][codeIdx] === token && rows[i][emailIdx] === email.toLowerCase();

    if (isTokenMatch || isCodeMatch) {
      // Check if used
      if (rows[i][usedIdx] === 'true') {
        return { valid: false, error: 'Token already used' };
      }

      // Check if expired
      const expiresAt = new Date(rows[i][expiresIdx]);
      if (new Date() > expiresAt) {
        return { valid: false, error: 'Token expired' };
      }

      // Mark as used
      await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: `MagicLinks!E${i + 1}`,
        valueInputOption: 'USER_ENTERED',
        requestBody: {
          values: [['true']]
        }
      });

      return {
        valid: true,
        email: rows[i][emailIdx]
      };
    }
  }

  return { valid: false, error: 'Token not found' };
}

/**
 * Create a session token (signed with secret)
 * Includes both user-facing and backup sheet/folder IDs
 */
function createSessionToken(user) {
  const payload = {
    userId: user.userId,
    email: user.email,
    name: user.name,
    role: user.role || 'user',
    sheetId: user.sheetId,                     // User-facing sheet (shared with user)
    driveFolderId: user.driveFolderId,         // User-facing folder (shared with user)
    backupSheetId: user.backupSheetId || '',   // Backup sheet (service account owned)
    backupFolderId: user.backupFolderId || '', // Backup folder (service account owned)
    exp: Date.now() + SESSION_EXPIRY_MS
  };

  // Simple signing: base64(payload) + '.' + hmac(payload)
  const payloadStr = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = crypto
    .createHmac('sha256', process.env.SESSION_SECRET || 'default-secret-change-me')
    .update(payloadStr)
    .digest('base64url');

  return `${payloadStr}.${signature}`;
}

/**
 * Validate session token and return payload
 */
function validateSessionToken(token) {
  if (!token) return null;

  const parts = token.split('.');
  if (parts.length !== 2) return null;

  const [payloadStr, signature] = parts;

  // Verify signature
  const expectedSig = crypto
    .createHmac('sha256', process.env.SESSION_SECRET || 'default-secret-change-me')
    .update(payloadStr)
    .digest('base64url');

  if (signature !== expectedSig) return null;

  // Parse and check expiry
  try {
    const payload = JSON.parse(Buffer.from(payloadStr, 'base64url').toString());
    if (payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

/**
 * Middleware-style session validation from request
 */
async function validateSession(req) {
  const token = req.headers['x-session-token'];
  if (!token) return null;

  const session = validateSessionToken(token);
  if (!session) return null;

  return session;
}

/**
 * Update user's last login timestamp
 */
async function updateLastLogin(userId) {
  const { sheets, spreadsheetId } = await getMasterSheet();

  // Find user row
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: 'Users!A:K',
  });

  const rows = response.data.values || [];
  const headers = rows[0];
  const idIdx = headers.indexOf('userId');
  const lastLoginIdx = headers.indexOf('lastLogin');

  for (let i = 1; i < rows.length; i++) {
    if (rows[i][idIdx] === userId) {
      const column = String.fromCharCode(65 + lastLoginIdx); // A=0, B=1, etc.
      await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: `Users!${column}${i + 1}`,
        valueInputOption: 'USER_ENTERED',
        requestBody: {
          values: [[new Date().toISOString()]]
        }
      });
      break;
    }
  }
}

/**
 * Check if email is an admin
 */
function isAdmin(email) {
  const adminEmails = (process.env.ADMIN_EMAILS || '').split(',').map(e => e.trim().toLowerCase());
  return adminEmails.includes(email.toLowerCase());
}

module.exports = {
  getMasterSheet,
  findUserByEmail,
  findUserById,
  generateToken,
  generateCode,
  storeMagicLink,
  validateMagicLink,
  createSessionToken,
  validateSessionToken,
  validateSession,
  updateLastLogin,
  isAdmin,
  SESSION_EXPIRY_MS,
  MAGIC_LINK_EXPIRY_MS
};
