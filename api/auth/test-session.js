/**
 * POST /api/auth/test-session
 *
 * Test-only path for obtaining an authenticated session and (optionally)
 * inspecting Drive file state. Replaces the magic-link round-trip for
 * automated end-to-end tests, which cannot read a real inbox.
 *
 * Disabled unless BOTH env vars are set:
 *   - TEST_SESSION_SECRET  — shared secret the test runner must present
 *   - TEST_USER_EMAIL      — the ONE email this endpoint is allowed to issue
 *                            sessions for. Limits blast radius if the secret
 *                            ever leaks: an attacker can only impersonate the
 *                            designated test user, not any user in the system.
 *
 * When either env var is missing the endpoint returns 404, so the very
 * existence of the test path is invisible in the default deployment.
 *
 * Actions:
 *   { action: "session" }
 *     Returns a fully-formed session object for TEST_USER_EMAIL, including
 *     sheetId / driveFolderId / backupFolderId so the test runner can drive
 *     the same code paths a normal user would.
 *
 *   { action: "check_files", fileIds: [string] }
 *     Looks up each Drive file ID with the service account (same creds the
 *     server uses for upload + trash) and reports { exists, trashed, name }.
 *     Used by the e2e test to verify that the mirror PDF was created on
 *     upload and trashed on delete — without giving the test runner direct
 *     access to the SA private key.
 *
 * Every successful invocation is recorded to AdminLog with adminId='TEST'.
 */

const crypto = require('crypto');
const { google } = require('googleapis');
const {
  findUserByEmail,
  createSessionToken,
  applyCors,
  getClientIp,
  logAdminAction,
  SESSION_EXPIRY_MS,
} = require('../_lib/auth');

const MAX_FILE_IDS_PER_CALL = 20;

function timingSafeEqualString(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

let _drive = null;
async function getDrive() {
  if (_drive) return _drive;
  const auth = new google.auth.GoogleAuth({
    credentials: {
      client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      private_key: (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    },
    scopes: ['https://www.googleapis.com/auth/drive'],
  });
  _drive = google.drive({ version: 'v3', auth });
  return _drive;
}

module.exports = async function handler(req, res) {
  applyCors(req, res, 'POST, OPTIONS');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const secret = process.env.TEST_SESSION_SECRET;
  const allowedEmail = (process.env.TEST_USER_EMAIL || '').toLowerCase().trim();

  // Endpoint must be invisible when not configured. Returning 404 (rather than
  // 403) avoids confirming the route exists at all on a default install.
  if (!secret || !allowedEmail) {
    return res.status(404).json({ error: 'Not found' });
  }

  const provided = req.headers['x-test-secret'];
  if (!provided || !timingSafeEqualString(provided, secret)) {
    return res.status(401).json({ error: 'Invalid test secret' });
  }

  const { action, fileIds } = req.body || {};
  const ip = getClientIp(req);

  try {
    if (action === 'session') {
      const user = await findUserByEmail(allowedEmail);
      if (!user) {
        return res.status(404).json({
          error: 'Test user not found in Master Sheet Users tab',
          email: allowedEmail,
        });
      }
      if (user.status === 'suspended' || user.status === 'deleted' || user.status === 'pending') {
        return res.status(403).json({ error: `Test user is ${user.status}` });
      }

      const token = createSessionToken(user);
      await logAdminAction('TEST', 'test_session_login', user.userId, {
        email: user.email,
        ip,
      });

      return res.status(200).json({
        success: true,
        session: {
          token,
          userId: user.userId,
          email: user.email,
          name: user.name,
          role: user.role || 'user',
          sheetId: user.sheetId,
          driveFolderId: user.driveFolderId,
          backupSheetId: user.backupSheetId || '',
          backupFolderId: user.backupFolderId || '',
          exp: Date.now() + SESSION_EXPIRY_MS,
        },
      });
    }

    if (action === 'check_files') {
      if (!Array.isArray(fileIds) || fileIds.length === 0) {
        return res.status(400).json({ error: 'fileIds (non-empty array) required' });
      }
      if (fileIds.length > MAX_FILE_IDS_PER_CALL) {
        return res.status(400).json({
          error: `Too many fileIds (max ${MAX_FILE_IDS_PER_CALL})`,
        });
      }
      const drive = await getDrive();
      const results = await Promise.all(fileIds.map(async (id) => {
        if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{10,}$/.test(id)) {
          return { fileId: id, exists: null, trashed: null, error: 'Invalid file id' };
        }
        try {
          const r = await drive.files.get({
            fileId: id,
            fields: 'id, name, trashed, parents',
            supportsAllDrives: true,
          });
          return {
            fileId: id,
            exists: true,
            trashed: !!r.data.trashed,
            name: r.data.name || null,
            parents: r.data.parents || [],
          };
        } catch (e) {
          const code = e?.code || e?.response?.status;
          if (code === 404) {
            return { fileId: id, exists: false, trashed: null, name: null };
          }
          return { fileId: id, exists: null, trashed: null, error: e.message };
        }
      }));
      await logAdminAction('TEST', 'test_check_drive_files', '', {
        ip,
        count: fileIds.length,
      });
      return res.status(200).json({ success: true, results });
    }

    return res.status(400).json({ error: `Unknown action: ${action}` });
  } catch (e) {
    console.error('[auth/test-session] error:', e);
    return res.status(500).json({ error: 'Internal error', details: e.message });
  }
};
