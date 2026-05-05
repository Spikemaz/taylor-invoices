/**
 * Stage 8 — Accountant access invitations.
 *
 * Flow:
 *   inviteAccountant({ clientUserId, email, scope })
 *     → inserts a `pending` row with a hashed magic-link token
 *     → returns the raw token to the caller (UI emails it; we never
 *       store the plaintext)
 *
 *   acceptInvite({ token, accountantUserId })
 *     → looks up the row by token-hash, flips status → accepted,
 *       binds accountantUserId.
 *
 *   listAccessForClient(clientUserId) — what accountants can see my books
 *   listAccessForAccountant(accountantUserId) — whose books can I see
 *   revokeAccess({ id, actor }) — flips to revoked, audit-logged.
 *
 * Magic-link emailing is UI-side and out of scope for this slice. The
 * raw token is returned to the caller so tests + the future UI can
 * deliver it however they want.
 */

const cryptoNode = require('crypto');
const { getDb, getSchema } = require('../db');
const { and, eq } = require('drizzle-orm');
const { audit } = require('../audit-log');

function newAccessId() {
  return `acc_${cryptoNode.randomUUID().replace(/-/g, '').slice(0, 16)}`;
}

function newToken() {
  return cryptoNode.randomBytes(24).toString('base64url');
}

// Magic-link invites are short-lived. Default 14 days mirrors industry
// norms (Stripe / Xero) for accountant invites — long enough for the
// recipient to act on email, short enough that a leaked token from an
// old mailbox stops working.
const INVITE_TTL_MS = 14 * 24 * 60 * 60 * 1000;
function defaultExpiry() {
  return new Date(Date.now() + INVITE_TTL_MS);
}

function hashToken(token) {
  return cryptoNode.createHash('sha256').update(token).digest('hex');
}

async function inviteAccountant(input, opts = {}) {
  const { clientUserId, email, scope = 'read_only', actor, expiresAt } = input;
  const inviteExpiresAt = expiresAt instanceof Date ? expiresAt : defaultExpiry();
  if (!clientUserId || !email) throw new Error('inviteAccountant: clientUserId/email required');
  if (!['read_only', 'full'].includes(scope)) throw new Error(`inviteAccountant: bad scope ${scope}`);
  const db = opts.tx || getDb();
  const { accountantAccess } = getSchema();
  const existing = await db
    .select()
    .from(accountantAccess)
    .where(
      and(eq(accountantAccess.clientUserId, clientUserId), eq(accountantAccess.accountantEmail, email))
    )
    .limit(1);
  const token = newToken();
  const tokenHash = hashToken(token);
  if (existing[0]) {
    if (existing[0].status === 'accepted') {
      throw new Error('inviteAccountant: already accepted — revoke before re-inviting');
    }
    await db
      .update(accountantAccess)
      .set({
        status: 'pending',
        scope,
        inviteTokenHash: tokenHash,
        inviteExpiresAt,
        invitedAt: new Date(),
        revokedAt: null,
      })
      .where(eq(accountantAccess.id, existing[0].id));
    await audit({
      action: 'accountant.invite',
      actorUserId: actor?.userId,
      actorEmail: actor?.email,
      actorRole: actor?.role,
      resourceType: 'accountant_access',
      resourceId: existing[0].id,
      after: { clientUserId, email, scope, reissued: true },
    });
    return { id: existing[0].id, token, reissued: true };
  }
  const id = newAccessId();
  await db.insert(accountantAccess).values({
    id,
    clientUserId,
    accountantEmail: email,
    scope,
    status: 'pending',
    inviteTokenHash: tokenHash,
    inviteExpiresAt,
    invitedAt: new Date(),
    createdAt: new Date(),
  });
  await audit({
    action: 'accountant.invite',
    actorUserId: actor?.userId,
    actorEmail: actor?.email,
    actorRole: actor?.role,
    resourceType: 'accountant_access',
    resourceId: id,
    after: { clientUserId, email, scope, reissued: false },
  });
  return { id, token, reissued: false };
}

async function acceptInvite(input, opts = {}) {
  const { token, accountantUserId } = input;
  if (!token || !accountantUserId) throw new Error('acceptInvite: token/accountantUserId required');
  const db = opts.tx || getDb();
  const { accountantAccess } = getSchema();
  const tokenHash = hashToken(token);
  const rows = await db
    .select()
    .from(accountantAccess)
    .where(eq(accountantAccess.inviteTokenHash, tokenHash))
    .limit(1);
  if (!rows[0]) throw new Error('acceptInvite: invalid or expired token');
  if (rows[0].status !== 'pending') throw new Error(`acceptInvite: status is ${rows[0].status}`);
  if (rows[0].inviteExpiresAt && new Date(rows[0].inviteExpiresAt).getTime() < Date.now()) {
    throw new Error('acceptInvite: invalid or expired token');
  }
  const now = new Date();
  await db
    .update(accountantAccess)
    .set({
      status: 'accepted',
      acceptedAt: now,
      accountantUserId,
      // burn the token so it can't be reused
      inviteTokenHash: null,
    })
    .where(eq(accountantAccess.id, rows[0].id));
  await audit({
    action: 'accountant.accept',
    actorUserId: accountantUserId,
    resourceType: 'accountant_access',
    resourceId: rows[0].id,
    after: { clientUserId: rows[0].clientUserId, scope: rows[0].scope },
  });
  return { id: rows[0].id, clientUserId: rows[0].clientUserId, scope: rows[0].scope };
}

async function revokeAccess(input, opts = {}) {
  const { id, actor } = input;
  if (!id) throw new Error('revokeAccess: id required');
  if (!actor?.userId) throw new Error('revokeAccess: actor required');
  const db = opts.tx || getDb();
  const { accountantAccess } = getSchema();
  const rows = await db.select().from(accountantAccess).where(eq(accountantAccess.id, id)).limit(1);
  if (!rows[0]) throw new Error(`revokeAccess: ${id} not found`);
  if (rows[0].status === 'revoked') return rows[0];
  await db
    .update(accountantAccess)
    .set({ status: 'revoked', revokedAt: new Date(), inviteTokenHash: null })
    .where(eq(accountantAccess.id, id));
  await audit({
    action: 'accountant.revoke',
    actorUserId: actor.userId,
    actorEmail: actor.email,
    actorRole: actor.role,
    resourceType: 'accountant_access',
    resourceId: id,
    before: { status: rows[0].status },
    after: { status: 'revoked' },
  });
  return { ...rows[0], status: 'revoked' };
}

async function listAccessForClient(clientUserId, opts = {}) {
  const db = opts.tx || getDb();
  const { accountantAccess } = getSchema();
  return db.select().from(accountantAccess).where(eq(accountantAccess.clientUserId, clientUserId));
}

async function listAccessForAccountant(accountantUserId, opts = {}) {
  const db = opts.tx || getDb();
  const { accountantAccess } = getSchema();
  return db
    .select()
    .from(accountantAccess)
    .where(
      and(eq(accountantAccess.accountantUserId, accountantUserId), eq(accountantAccess.status, 'accepted'))
    );
}

/**
 * Authorisation helper: throws unless `accountantUserId` has accepted
 * access to `clientUserId`, optionally requiring `full` scope.
 */
async function assertAccessAllowed({ clientUserId, accountantUserId, requireFullScope = false }, opts = {}) {
  const db = opts.tx || getDb();
  const { accountantAccess } = getSchema();
  const rows = await db
    .select()
    .from(accountantAccess)
    .where(
      and(
        eq(accountantAccess.clientUserId, clientUserId),
        eq(accountantAccess.accountantUserId, accountantUserId),
        eq(accountantAccess.status, 'accepted')
      )
    )
    .limit(1);
  if (!rows[0]) throw new Error('accountant has no accepted access to this client');
  if (requireFullScope && rows[0].scope !== 'full') {
    throw new Error('accountant scope is read_only — write actions denied');
  }
  return rows[0];
}

module.exports = {
  inviteAccountant,
  acceptInvite,
  revokeAccess,
  listAccessForClient,
  listAccessForAccountant,
  assertAccessAllowed,
  hashToken,
};
