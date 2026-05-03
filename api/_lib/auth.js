/**
 * Shared authentication helpers for BooksIQ multi-user system
 */

const { google } = require('googleapis');
const crypto = require('crypto');

// Session token validity (365 days)
// Kept at 365 for user convenience (Marcus, Taylor, Reo log in once a year).
// Blast radius of a leaked token is bounded by requireSession()'s 60s status
// re-check — a suspended user is kicked within a minute regardless of token
// expiry, so the long-lived token does not weaken our suspension SLA.
const SESSION_EXPIRY_MS = 365 * 24 * 60 * 60 * 1000;

// Magic link validity (15 minutes)
const MAGIC_LINK_EXPIRY_MS = 15 * 60 * 1000;

/**
 * Get authenticated Google Sheets client
 */
function normalizePrivateKey(raw) {
  if (!raw) return '';
  let k = String(raw).trim();
  // Strip wrapping single or double quotes (common Vercel paste mistake).
  if ((k.startsWith('"') && k.endsWith('"')) || (k.startsWith("'") && k.endsWith("'"))) {
    k = k.slice(1, -1);
  }
  // Convert double-escaped \\n -> \n first, then literal \n -> real newline.
  k = k.replace(/\\\\n/g, '\\n').replace(/\\n/g, '\n');
  // Normalize CRLF to LF.
  k = k.replace(/\r\n/g, '\n');
  return k;
}

function getAuthClient() {
  // Prefer a base64-encoded key (paste-safe: no quotes/newlines/escapes).
  // Set GOOGLE_PRIVATE_KEY_B64 = base64(<raw PEM including BEGIN/END lines>).
  let privateKey = '';
  if (process.env.GOOGLE_PRIVATE_KEY_B64) {
    try {
      const decoded = Buffer.from(process.env.GOOGLE_PRIVATE_KEY_B64, 'base64').toString('utf8');
      if (decoded.includes('-----BEGIN PRIVATE KEY-----') && decoded.includes('-----END PRIVATE KEY-----')) {
        privateKey = decoded;
      } else {
        console.warn('[auth] GOOGLE_PRIVATE_KEY_B64 is set but did not decode to a valid PEM; falling back to GOOGLE_PRIVATE_KEY.');
      }
    } catch {
      console.warn('[auth] GOOGLE_PRIVATE_KEY_B64 base64 decode failed; falling back to GOOGLE_PRIVATE_KEY.');
    }
  }
  if (!privateKey) {
    privateKey = normalizePrivateKey(process.env.GOOGLE_PRIVATE_KEY);
  }
  const auth = new google.auth.GoogleAuth({
    credentials: {
      client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      private_key: privateKey,
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
 * Includes both user-facing and backup sheet/folder IDs.
 *
 * Role resolution: ADMIN_EMAILS env is the source of truth for admin status.
 * If the user's email is in ADMIN_EMAILS we set role='admin' regardless of what
 * is stored on their Users-tab row, so adding/removing admins is a one-line
 * env change with no manual sheet edits required. The Master Sheet role column
 * is informational only (used by the admin UI to display badges).
 */
function createSessionToken(user) {
  const role = isAdmin(user.email) ? 'admin' : (user.role || 'user');
  const payload = {
    userId: user.userId,
    email: user.email,
    name: user.name,
    role,
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

/**
 * Read a runtime-rotatable config value from the master sheet's Config tab.
 * Falls back to env var, then to undefined.
 *
 * Config tab schema: key | value | updatedAt | updatedBy
 */
async function getConfigValue(key, envFallback = undefined) {
  try {
    const { sheets, spreadsheetId } = await getMasterSheet();
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: 'Config!A:D',
    });
    const rows = response.data.values || [];
    for (let i = 1; i < rows.length; i++) {
      if (rows[i][0] === key) {
        // Key EXISTS in Config — its value is authoritative even if empty.
        // An empty-string value is the deliberate "disable this feature"
        // signal from the admin UI (e.g. clearing the master override code);
        // we must NOT fall through to env or hardcoded defaults in that case,
        // otherwise saving an empty value silently re-enables the old code.
        return rows[i][1] !== undefined ? rows[i][1] : '';
      }
    }
    // Key absent from Config — fall through to env fallback below
  } catch (e) {
    // Config tab may not exist yet — fall through to env
  }
  return envFallback !== undefined ? envFallback : process.env[key];
}

/**
 * Write a runtime-rotatable config value into the Config tab. Creates the row
 * if missing, updates in place if present.
 */
async function setConfigValue(key, value, updatedBy) {
  const { sheets, spreadsheetId } = await getMasterSheet();
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: 'Config!A:D',
  });
  const rows = response.data.values || [];
  const now = new Date().toISOString();
  for (let i = 1; i < rows.length; i++) {
    if (rows[i][0] === key) {
      await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: `Config!A${i + 1}:D${i + 1}`,
        valueInputOption: 'RAW',
        requestBody: { values: [[key, value, now, updatedBy || '']] }
      });
      return;
    }
  }
  // Append new row
  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: 'Config!A:D',
    valueInputOption: 'RAW',
    requestBody: { values: [[key, value, now, updatedBy || '']] }
  });
}

/**
 * Convenience wrapper for the master override code used to sign in as any
 * existing user without email access. Reads from the master sheet's Config
 * tab first (rotatable from the admin UI), env var MASTER_OVERRIDE_CODE
 * second.
 *
 * SECURITY: there is intentionally NO hardcoded fallback. If both the Config
 * row AND the env var are absent (or empty), this returns '' and the override
 * is DISABLED. The previous behaviour fell back to the literal string '654321'
 * — the most-guessed 6-digit number on Earth — which made deleting the Config
 * row silently re-enable a known-weak code. Failing closed is the right
 * default for a master-key style mechanism.
 */
async function getMasterOverrideCode() {
  return await getConfigValue('masterOverrideCode',
    process.env.MASTER_OVERRIDE_CODE !== undefined ? process.env.MASTER_OVERRIDE_CODE : '');
}

/**
 * Returns metadata about the master override code WITHOUT exposing the code
 * itself. Used by the admin UI to show enabled/disabled state and last
 * rotation timestamp. The literal code is never returned over the wire — to
 * change the code, admins POST a new value (rotation).
 *
 * Returns: { enabled: boolean, length: number, lastRotatedAt: string|null }
 *   - lastRotatedAt is the ISO timestamp from the Config tab if set via the
 *     admin UI, or null if the code currently comes from the env var (which
 *     has no associated timestamp).
 */
async function getMasterOverrideStatus() {
  let rows;
  try {
    const { sheets, spreadsheetId } = await getMasterSheet();
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: 'Config!A:D',
    });
    rows = response.data.values || [];
  } catch (e) {
    // Only swallow the "Config tab does not exist yet" case (fresh install
    // before any config has ever been written). Any other error — auth,
    // network, quota, transient Sheets API failure — must propagate so the
    // admin UI shows a real error instead of misleading env-var-derived
    // status that may not reflect what verify-code.js will actually accept.
    const msg = (e && (e.message || e.toString())) || '';
    if (/Unable to parse range/i.test(msg) || /Config/i.test(msg) && /not.*found|does not exist/i.test(msg)) {
      rows = null;
    } else {
      throw e;
    }
  }

  if (rows) {
    for (let i = 1; i < rows.length; i++) {
      if (rows[i][0] === 'masterOverrideCode') {
        // Config row exists — its value is authoritative (see getConfigValue
        // for why an empty string here means "deliberately disabled").
        const value = rows[i][1] !== undefined ? String(rows[i][1]) : '';
        const lastRotatedAt = rows[i][2] || null;
        return {
          enabled: value.length > 0,
          length: value.length,
          lastRotatedAt,
        };
      }
    }
  }

  // No Config row for masterOverrideCode — fall back to env var.
  const envCode = process.env.MASTER_OVERRIDE_CODE || '';
  return {
    enabled: envCode.length > 0,
    length: envCode.length,
    lastRotatedAt: null,
  };
}

/**
 * Append a single admin-action audit row to the AdminLog tab.
 * Used by verify-code (override logins), impersonation, and admin endpoints.
 *
 * Never throws — audit failures must not break the underlying operation.
 */
async function logAdminAction(adminId, action, targetUserId, details = {}) {
  try {
    const { sheets, spreadsheetId } = await getMasterSheet();
    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: 'AdminLog!A:E',
      valueInputOption: 'RAW',
      requestBody: {
        values: [[
          new Date().toISOString(),
          adminId || '',
          action || '',
          targetUserId || '',
          typeof details === 'string' ? details : JSON.stringify(details || {})
        ]]
      }
    });
  } catch (e) {
    console.error('[AdminLog] Failed to log action:', action, e.message);
  }
}

// =========================================================================
// REQUEST GATING — CORS lockdown, session re-check, rate limiting, audit
// =========================================================================
// Added as part of the May-2026 hardening pass. Replaces the previous
// per-endpoint pattern of `Access-Control-Allow-Origin: *` + bare token
// validation, which left two main holes:
//   1. Any website could read API responses if a logged-in user visited it.
//   2. A suspended user's existing token kept working until natural expiry
//      (365 days). The 60s status re-check below makes the effective lockout
//      SLA ~60 seconds regardless of token age.
// =========================================================================

/**
 * Lock CORS to known booksiq.app + Replit dev domain origins. Replaces the
 * old wildcard `*` everywhere. Browsers will refuse cross-site fetches from
 * any other origin, killing the "malicious site relays your session token"
 * attack class.
 *
 * Server-to-server requests (no Origin header — curl, internal jobs) are
 * passed through with `*` so we don't break operational tooling. Local dev
 * (localhost / 127.0.0.1) is allowed too.
 *
 * Override headers are always declared in Access-Control-Allow-Headers so
 * the admin "viewing as" feature works the same on every endpoint.
 */
function applyCors(req, res, methods = 'POST, OPTIONS') {
  const origin = req.headers.origin || '';
  const allowed = [
    'https://booksiq.app',
    'https://www.booksiq.app'
  ];
  if (process.env.REPLIT_DEV_DOMAIN) {
    allowed.push(`https://${process.env.REPLIT_DEV_DOMAIN}`);
  }
  if (process.env.ALLOWED_ORIGINS) {
    process.env.ALLOWED_ORIGINS.split(',')
      .map(s => s.trim()).filter(Boolean)
      .forEach(o => allowed.push(o));
  }
  let allowOrigin;
  if (!origin) {
    allowOrigin = '*'; // curl / server-to-server — no browser involved
  } else if (allowed.includes(origin)) {
    allowOrigin = origin;
  } else if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
    allowOrigin = origin; // local dev
  } else {
    // Disallowed origin — echo the canonical prod origin so the browser
    // refuses the response (it won't match the request's Origin).
    allowOrigin = allowed[0];
  }
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Origin', allowOrigin);
  res.setHeader('Access-Control-Allow-Methods', methods);
  res.setHeader('Access-Control-Allow-Headers',
    'Content-Type, X-Session-Token, X-Override-Sheet-Id, X-Override-Drive-Folder-Id, X-Override-Backup-Sheet-Id, X-Override-Backup-Folder-Id, X-Test-Secret');
}

// In-memory user-status cache. We can't hit the Users tab on every API call
// (Sheets API quota is 60 reads/min/user/project) so we cache {status, role}
// per userId for 60 seconds. Net effect: suspending a user takes effect
// within ~1 minute. Far better than the previous "365-day token, no recheck"
// posture and acceptable for our threat model.
const _statusCache = new Map(); // userId -> { status, role, exists, expiresAt }
const STATUS_CACHE_TTL_MS = 60 * 1000;

async function _getCachedStatus(userId) {
  const now = Date.now();
  const cached = _statusCache.get(userId);
  if (cached && cached.expiresAt > now) return cached;
  try {
    const user = await findUserById(userId);
    const entry = {
      status: user?.status || 'unknown',
      role: user?.role || 'user',
      exists: !!user,
      expiresAt: now + STATUS_CACHE_TTL_MS
    };
    _statusCache.set(userId, entry);
    return entry;
  } catch (e) {
    // Sheets failure — fail OPEN with a SHORT cache so we don't lock everyone
    // out when Sheets API is briefly down. The HMAC-signed token is still
    // validated, so this only widens the suspended-user window, it doesn't
    // accept forged tokens.
    console.error('[requireSession] Status check failed for', userId, '-', e.message);
    return { status: 'unknown', role: 'user', exists: true, expiresAt: now + 5000 };
  }
}

/**
 * Manually invalidate the status cache for a user. Call from admin endpoints
 * after suspend / delete / promote / demote so the change is picked up on
 * the user's NEXT request rather than waiting for the 60s TTL to expire.
 */
function invalidateUserStatus(userId) {
  if (userId) _statusCache.delete(userId);
}

/**
 * Single gate for protected endpoints. Validates the session signature, then
 * re-checks the user's CURRENT status in the Master Sheet (cached 60s) so a
 * suspended user's existing token stops working within a minute even if it
 * has weeks of life left.
 *
 * On failure it writes the response itself and returns null — caller should
 * just `return` after a falsy result.
 *
 *   const session = await requireSession(req, res);
 *   if (!session) return;
 *
 * Options:
 *   { adminOnly: true }   - require role==='admin' (after status re-check)
 *   { checkStatus: false } - skip the sheets lookup (rare; only for endpoints
 *                            that must work when the Master Sheet is down)
 */
async function requireSession(req, res, opts = {}) {
  const token = req.headers['x-session-token'];
  if (!token) {
    res.status(401).json({ error: 'Authentication required' });
    return null;
  }
  const session = validateSessionToken(token);
  if (!session || !session.userId) {
    res.status(401).json({ error: 'Invalid or expired session. Please sign in again.' });
    return null;
  }
  if (opts.checkStatus !== false) {
    const live = await _getCachedStatus(session.userId);
    if (!live.exists) {
      res.status(401).json({ error: 'Account no longer exists' });
      return null;
    }
    if (live.status === 'suspended') {
      res.status(403).json({ error: 'Account suspended. Please contact support.' });
      return null;
    }
    if (live.status === 'deleted') {
      res.status(403).json({ error: 'Account no longer active' });
      return null;
    }
    // Refresh role from live data so admin promotion/demotion takes effect
    // without forcing a re-login. ADMIN_EMAILS env still wins as override.
    if (isAdmin(session.email)) {
      session.role = 'admin';
    } else if (live.role) {
      session.role = live.role;
    }
  }
  if (opts.adminOnly && session.role !== 'admin') {
    res.status(403).json({ error: 'Admin access required' });
    return null;
  }
  return session;
}

/**
 * Lightweight in-memory sliding-window rate limiter. Keys are arbitrary
 * strings — typical pattern is `email:${email}` or `ip:${ip}`.
 *
 * Returns { ok: bool, remaining: int, resetAt: ms }.
 *
 * Note: in-memory state means an attacker who can hit multiple instances
 * gets N×limit attempts. For Replit single-region autoscale this is fine
 * for the brute-force surface we care about (verify-code, magic-link).
 */
const _rateBuckets = new Map(); // key -> [timestamps...]
function checkRateLimit(key, max, windowMs) {
  const now = Date.now();
  const cutoff = now - windowMs;
  const arr = (_rateBuckets.get(key) || []).filter(t => t > cutoff);
  if (arr.length >= max) {
    _rateBuckets.set(key, arr);
    return { ok: false, remaining: 0, resetAt: arr[0] + windowMs };
  }
  arr.push(now);
  _rateBuckets.set(key, arr);
  return { ok: true, remaining: max - arr.length, resetAt: now + windowMs };
}

// =========================================================================
// PERSISTENT RATE LIMITER (sheet-backed)
// =========================================================================
// The in-memory `checkRateLimit` above doesn't survive Vercel's serverless
// cold starts — every fresh Lambda instance gets an empty Map, so an
// attacker who happens to land on a fresh instance gets a fresh allowance.
// For an auth-boundary control that's not acceptable in production.
//
// This persistent variant stores the sliding window in a `RateLimits` tab
// on the master sheet, so the count is shared across instances.
//
// Cost: one Sheets read + (on hit) one Sheets write per attempt. At our
// scale (3 → 100 users, ~5 logins/user/week) this is negligible against
// the 60 req/min/project Sheets quota.
//
// Race condition: two concurrent reads can both observe count=N-1 and both
// pass when one should fail. Worst case is a small overshoot under burst,
// which is fine for brute-force defence (the burst still gets capped near
// the limit, and the next request lands on the now-correct count).
//
// Failure mode: if Sheets is unreachable, falls back to the in-memory
// limiter on the current instance so we still cap THIS instance's burst.
// Logged loudly so we notice the degradation.
//
// Tab schema: A=key, B=timestamps_json (JSON array of unix ms), C=updated_iso.
// Rows accumulate one per unique key. Old rows are not auto-pruned — at
// hundreds of unique IPs/emails this is fine; if it ever matters we can add
// an admin sweep endpoint later.
// =========================================================================

let _rateLimitsTabReady = false;

async function _ensureRateLimitsTab(sheets, spreadsheetId) {
  if (_rateLimitsTabReady) return;
  try {
    await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: 'RateLimits!A1:C1'
    });
    _rateLimitsTabReady = true;
    return;
  } catch (e) {
    // Likely "Unable to parse range" — tab doesn't exist. Fall through to create.
  }
  try {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [{
          addSheet: {
            properties: {
              title: 'RateLimits',
              gridProperties: { rowCount: 1000, columnCount: 3 }
            }
          }
        }]
      }
    });
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: 'RateLimits!A1:C1',
      valueInputOption: 'RAW',
      requestBody: { values: [['key', 'timestamps_json', 'updated_iso']] }
    });
    _rateLimitsTabReady = true;
  } catch (e) {
    // Race: another instance created it first → fine.
    if (/already exists/i.test(e?.message || '')) {
      _rateLimitsTabReady = true;
      return;
    }
    throw e;
  }
}

async function checkRateLimitPersistent(key, max, windowMs) {
  const now = Date.now();
  const cutoff = now - windowMs;
  let sheets, spreadsheetId;
  try {
    ({ sheets, spreadsheetId } = await getMasterSheet());
    await _ensureRateLimitsTab(sheets, spreadsheetId);
  } catch (e) {
    console.error('[RateLimit] Sheet unavailable, falling back to in-memory:', e.message);
    return checkRateLimit(key, max, windowMs);
  }
  let rows;
  try {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: 'RateLimits!A:C'
    });
    rows = response.data.values || [];
  } catch (e) {
    console.error('[RateLimit] Read failed, falling back to in-memory:', e.message);
    return checkRateLimit(key, max, windowMs);
  }
  let rowIndex = -1; // 0-indexed within rows array (row 0 = header)
  let timestamps = [];
  for (let i = 1; i < rows.length; i++) {
    if (rows[i][0] === key) {
      rowIndex = i;
      try {
        timestamps = JSON.parse(rows[i][1] || '[]');
        if (!Array.isArray(timestamps)) timestamps = [];
      } catch { timestamps = []; }
      break;
    }
  }
  timestamps = timestamps.filter(t => typeof t === 'number' && t > cutoff);
  if (timestamps.length >= max) {
    // Don't write — over limit. resetAt is when the OLDEST in-window
    // attempt ages out, freeing one slot.
    return { ok: false, remaining: 0, resetAt: timestamps[0] + windowMs };
  }
  timestamps.push(now);
  const rowValues = [[key, JSON.stringify(timestamps), new Date(now).toISOString()]];
  try {
    if (rowIndex >= 0) {
      await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: `RateLimits!A${rowIndex + 1}:C${rowIndex + 1}`,
        valueInputOption: 'RAW',
        requestBody: { values: rowValues }
      });
    } else {
      await sheets.spreadsheets.values.append({
        spreadsheetId,
        range: 'RateLimits!A:C',
        valueInputOption: 'RAW',
        requestBody: { values: rowValues }
      });
    }
  } catch (e) {
    // Write failed — still cap on this instance via in-memory so we don't
    // let through unlimited attempts on this Lambda warm cycle.
    console.error('[RateLimit] Write failed, capping in-memory only:', e.message);
    checkRateLimit(key, max, windowMs);
  }
  return { ok: true, remaining: max - timestamps.length, resetAt: now + windowMs };
}

/** Best-effort client IP derivation (Replit proxy → x-forwarded-for first). */
function getClientIp(req) {
  const xff = (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return xff || req.connection?.remoteAddress || req.socket?.remoteAddress || 'unknown';
}

/** Send a 429 with Retry-After and a friendly message. */
function sendRateLimited(res, resetAt, message) {
  const retryAfter = Math.max(1, Math.ceil((resetAt - Date.now()) / 1000));
  res.setHeader('Retry-After', String(retryAfter));
  res.status(429).json({
    error: message || 'Too many requests. Please try again shortly.',
    retryAfter
  });
}

/**
 * Audit helper: log when an admin uses X-Override-* headers to operate on
 * another user's data. The impersonation start/stop is already logged from
 * the UI — this captures the actual writes/reads under that context so a
 * forensic review can answer "what did Marcus DO while viewing as Reo?".
 *
 * Only fires when admin actually used override headers. Caller decides
 * whether read-only ops should be audited (we generally skip those to keep
 * the AdminLog tab readable).
 */
async function auditAdminOverride(session, req, action, details = {}) {
  if (!session || session.role !== 'admin') return;
  const overrideSheet = req.headers['x-override-sheet-id'];
  const overrideFolder = req.headers['x-override-drive-folder-id'];
  const overrideBackup = req.headers['x-override-backup-sheet-id'];
  if (!overrideSheet && !overrideFolder && !overrideBackup) return;
  try {
    await logAdminAction(session.userId, 'admin_override_op', '', {
      action,
      overrideSheetId: overrideSheet || null,
      overrideFolderId: overrideFolder || null,
      overrideBackupSheetId: overrideBackup || null,
      ...details
    });
  } catch (e) {
    console.error('[auditAdminOverride] Failed to log override:', e.message);
  }
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
  getConfigValue,
  setConfigValue,
  getMasterOverrideCode,
  getMasterOverrideStatus,
  logAdminAction,
  // New gating helpers
  applyCors,
  requireSession,
  invalidateUserStatus,
  checkRateLimit,
  checkRateLimitPersistent,
  getClientIp,
  sendRateLimited,
  auditAdminOverride,
  SESSION_EXPIRY_MS,
  MAGIC_LINK_EXPIRY_MS
};
