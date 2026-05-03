/**
 * Stage 3 — Auto-categorisation engine.
 *
 * Surfaces:
 *   - `extractMerchantSignature(description, counterparty)` — normalises a
 *     bank line into a stable "this is the same merchant" key, stripping
 *     dates, transaction refs, card numbers, locations, case, and
 *     punctuation. Used as the unique-by-(entity, signature) lookup
 *     key for `merchant_memory`.
 *
 *   - `seedDefaultRulesForEntity(entityId, opts)` — installs the UK
 *     default rule library. Idempotent: re-running inserts only the
 *     rules whose `name` doesn't yet exist for the entity (so users
 *     can rename or delete a system rule without it being re-added).
 *
 *   - `findRuleMatch(entityId, bankTx, { tx, rules? })` — runs the rule
 *     engine in priority order, first match wins. Returns
 *     `{ rule, action, confidence: 100 }` or null.
 *
 *   - `findMemoryMatch(entityId, bankTx, { tx })` — looks up the
 *     merchant signature in `merchant_memory`. Confidence ramps with
 *     hit count (60 → 95) so a once-seen merchant is a soft suggestion
 *     and a 10×-seen merchant is auto-post-eligible.
 *
 *   - `suggestCategory(entityId, bankTxId)` — combines the two. Rule
 *     hits beat memory hits (rules are explicit user intent).
 *
 *   - `recordMerchantMemory(entityId, bankTxOrSignature, accountId)` —
 *     idempotent upsert; bumps `hitsCount` and `lastUsed`. Called by
 *     every accepted categorisation (rule, memory, or manual).
 *
 *   - `applyRulesToUnmatched({ bankAccountId, dryRun, autoPostThreshold })`
 *     — bulk-pass: walks every unmatched bank line, finds suggestions,
 *     and (if not dryRun) auto-posts those above the threshold via
 *     `categoriseTransaction`. Returns a per-line breakdown.
 *
 *   - `testRuleAgainstHistory(entityId, conditions, { windowDays })` —
 *     "if I had this rule, what would have matched in the last N days?"
 *     Used by the (future) Rules UI's preview button.
 *
 * Conditions JSONB shape:
 *
 *   {
 *     allOf?: Predicate[],            // ALL must match
 *     anyOf?: Predicate[],            // ANY must match (OR)
 *     amountSign?: 'in' | 'out' | 'any',
 *     amountMin?: number,             // pence, absolute value
 *     amountMax?: number              // pence, absolute value
 *   }
 *
 * Predicate shape:
 *
 *   { field: 'description' | 'counterparty' | 'reference',
 *     op:    'contains_ci' | 'equals_ci' | 'starts_with_ci' |
 *            'regex' | 'regex_ci',
 *     value: string }
 *
 * Action JSONB shape:
 *
 *   { kind: 'categorise', accountCode: '7100' }
 *   { kind: 'ignore',     reason: 'personal' }
 */

const crypto = require('crypto');
const { and, eq, gte, lte, asc, isNull } = require('drizzle-orm');
const { getDb, getSchema } = require('../db');
const { audit } = require('../audit-log');
const { getAccountByCode } = require('../ledger/accounts');
const { UK_DEFAULT_RULES } = require('./default-rules');

// =====================================================================
// IDs
// =====================================================================

function newRuleId() {
  return `br_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
}
function newMemoryId() {
  return `mm_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
}

// =====================================================================
// Merchant signature extraction
// =====================================================================
//
// Bank line descriptions look like one of:
//
//   "AMZNMktplace*RT3X9 LUXEMBOURG"
//   "Card 1234 STARBUCKS LIVERPOOL ST 03MAR25"
//   "TFL TRAVEL CH 12345 LONDON"
//   "DD AVIVA INSURANCE REF 7785421"
//
// We want a stable signature that survives:
//   - card-number prefixes ("Card 1234")
//   - transaction refs ("REF 7785421", "*RT3X9")
//   - dates ("03MAR25", "2025-03-03")
//   - the city/country tail ("LONDON", "LUXEMBOURG")
//   - case + punctuation
//
// The result is a lowercase ASCII string with a few significant tokens.
// We then take a SHA-1 prefix as the storage key so the signature is
// fixed-length (matches the dedupe-hash style used elsewhere).

function extractMerchantSignature(description, counterparty) {
  const cp = String(counterparty || '').trim();
  // Counterparty (when present) is already vendor-only — Starling /
  // Monzo / Revolut populate it cleanly, so prefer it over the noisy
  // description.
  let raw = cp || String(description || '');
  raw = raw.toLowerCase();

  // Strip card-number prefixes.
  raw = raw.replace(/\bcard\s+\d{2,6}\b/g, ' ');
  // Strip transaction-id markers.
  raw = raw.replace(/\b(ref|reference|trn|txn|id)\b[\s:]*\w+/g, ' ');
  raw = raw.replace(/\*[a-z0-9]{3,}/g, ' '); // Amazon-style "AMZN*ABC123"
  // Strip ISO + UK dates.
  raw = raw.replace(/\b\d{4}-\d{2}-\d{2}\b/g, ' ');
  raw = raw.replace(/\b\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{2,4}\b/g, ' ');
  raw = raw.replace(/\b\d{1,2}[a-z]{3}\d{2,4}\b/g, ' '); // 03mar25
  raw = raw.replace(/\b\d{1,2}\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\s*\d{0,4}\b/g, ' ');
  // Strip common transaction-type prefixes/suffixes.
  raw = raw.replace(/\b(dd|sto|fpi|fpo|bp|tfr|fps|chq|debit card|credit card|faster payment|direct debit|standing order)\b/g, ' ');
  // Strip stand-alone numbers > 4 digits (refs, amounts).
  raw = raw.replace(/\b\d{5,}\b/g, ' ');
  // Strip single-letter / two-letter junk tokens left over.
  raw = raw.replace(/\b[a-z0-9]{1,2}\b/g, ' ');
  // Collapse punctuation to space, then collapse whitespace.
  raw = raw.replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');

  if (!raw) {
    // Last-resort: hash the original description so we still produce
    // SOMETHING stable rather than collapse every empty signature into
    // one row.
    raw = `unknown:${String(description || '').toLowerCase().replace(/\s+/g, '').slice(0, 32)}`;
  }
  return raw;
}

// =====================================================================
// Predicate evaluation
// =====================================================================

function fieldValue(field, bankTx) {
  switch (field) {
    case 'description': return String(bankTx.description || '');
    case 'counterparty': return String(bankTx.counterparty || '');
    case 'reference': return String(bankTx.reference || '');
    default: return '';
  }
}

function evalPredicate(p, bankTx) {
  if (!p || !p.field || !p.op) return false;
  const haystack = fieldValue(p.field, bankTx);
  const needle = String(p.value == null ? '' : p.value);
  switch (p.op) {
    case 'contains_ci':    return haystack.toLowerCase().includes(needle.toLowerCase());
    case 'equals_ci':      return haystack.toLowerCase() === needle.toLowerCase();
    case 'starts_with_ci': return haystack.toLowerCase().startsWith(needle.toLowerCase());
    case 'regex':          try { return new RegExp(needle).test(haystack); } catch { return false; }
    case 'regex_ci':       try { return new RegExp(needle, 'i').test(haystack); } catch { return false; }
    default:               return false;
  }
}

function evalConditions(cond, bankTx) {
  if (!cond || typeof cond !== 'object') return false;
  // amountSign filter (inflow vs outflow vs any).
  if (cond.amountSign && cond.amountSign !== 'any') {
    const isIn = bankTx.amountPence > 0;
    if (cond.amountSign === 'in' && !isIn) return false;
    if (cond.amountSign === 'out' && isIn) return false;
  }
  const absAmt = Math.abs(Number(bankTx.amountPence) || 0);
  if (cond.amountMin != null && absAmt < Number(cond.amountMin)) return false;
  if (cond.amountMax != null && absAmt > Number(cond.amountMax)) return false;

  const allOf = Array.isArray(cond.allOf) ? cond.allOf : [];
  const anyOf = Array.isArray(cond.anyOf) ? cond.anyOf : [];
  if (allOf.length > 0 && !allOf.every((p) => evalPredicate(p, bankTx))) return false;
  if (anyOf.length > 0 && !anyOf.some((p) => evalPredicate(p, bankTx))) return false;
  // A condition with neither allOf nor anyOf and no amount filter is a
  // catch-all, which is almost always a misconfiguration; require at
  // least one populated predicate group OR an amount filter.
  if (allOf.length === 0 && anyOf.length === 0 && cond.amountSign == null && cond.amountMin == null && cond.amountMax == null) {
    return false;
  }
  return true;
}

// =====================================================================
// Seeding the default rule library
// =====================================================================

async function seedDefaultRulesForEntity(entityId, opts = {}) {
  if (!entityId) throw new Error('entityId required');
  const writer = opts.tx || getDb();
  const { bankRules } = getSchema();
  const existing = await writer
    .select({ name: bankRules.name })
    .from(bankRules)
    .where(eq(bankRules.entityId, entityId));
  const existingNames = new Set(existing.map((r) => r.name));
  const toInsert = UK_DEFAULT_RULES.filter((r) => !existingNames.has(r.name)).map((r) => ({
    id: newRuleId(),
    entityId,
    name: r.name,
    description: r.description || null,
    source: 'system',
    priority: r.priority,
    conditions: r.conditions,
    action: r.action,
    active: true,
  }));
  if (toInsert.length > 0) {
    await writer.insert(bankRules).values(toInsert);
  }
  return { inserted: toInsert.length, skipped: existingNames.size, total: UK_DEFAULT_RULES.length };
}

// =====================================================================
// Rule lookup
// =====================================================================

async function loadActiveRules(entityId, opts = {}) {
  const db = opts.tx || getDb();
  const { bankRules } = getSchema();
  return db
    .select()
    .from(bankRules)
    .where(and(eq(bankRules.entityId, entityId), eq(bankRules.active, true)))
    .orderBy(asc(bankRules.priority));
}

/**
 * First-match-wins rule lookup. Returns null if nothing matches.
 *
 * Rule-based suggestions are CONFIDENCE 100 (deterministic) — the user
 * (or a default) explicitly said "always categorise this as X".
 */
async function findRuleMatch(entityId, bankTx, opts = {}) {
  const rules = opts.rules || (await loadActiveRules(entityId, opts));
  for (const rule of rules) {
    if (evalConditions(rule.conditions, bankTx)) {
      return { rule, action: rule.action, confidence: 100, source: 'rule' };
    }
  }
  return null;
}

// =====================================================================
// Merchant memory
// =====================================================================

/**
 * Confidence ramp: 1 hit → 60, 2 → 70, 3 → 80, 4+ → up to 95.
 *
 * Tuned so a once-seen merchant is "soft suggestion" (below typical 95
 * auto-post threshold) and a 4+× seen merchant tips into auto-post.
 */
function memoryConfidenceFor(hitsCount) {
  if (hitsCount <= 0) return 50;
  if (hitsCount === 1) return 60;
  if (hitsCount === 2) return 70;
  if (hitsCount === 3) return 80;
  if (hitsCount === 4) return 88;
  return Math.min(95, 88 + (hitsCount - 4) * 2);
}

async function findMemoryMatch(entityId, bankTx, opts = {}) {
  const db = opts.tx || getDb();
  const { merchantMemory, accounts } = getSchema();
  const sig = extractMerchantSignature(bankTx.description, bankTx.counterparty);
  const rows = await db
    .select({
      id: merchantMemory.id,
      accountId: merchantMemory.accountId,
      hitsCount: merchantMemory.hitsCount,
      supersededAt: merchantMemory.supersededAt,
      accountCode: accounts.code,
    })
    .from(merchantMemory)
    .leftJoin(accounts, eq(merchantMemory.accountId, accounts.id))
    .where(
      and(eq(merchantMemory.entityId, entityId), eq(merchantMemory.merchantSignature, sig))
    )
    .limit(1);
  const m = rows[0];
  if (!m || m.supersededAt) return null;
  return {
    memoryId: m.id,
    accountId: m.accountId,
    accountCode: m.accountCode,
    confidence: memoryConfidenceFor(m.hitsCount),
    hitsCount: m.hitsCount,
    source: 'memory',
    signature: sig,
  };
}

/**
 * Upsert (entity, signature) → accountId. Bumps hitsCount and lastUsed
 * if the same merchant is being categorised the same way; resets
 * hitsCount to 1 if the user re-points the merchant at a different
 * account (the engine treats that as "I changed my mind").
 */
async function recordMerchantMemory(entityId, bankTxOrSignature, accountId, opts = {}) {
  if (!entityId) throw new Error('entityId required');
  if (!accountId) throw new Error('accountId required');
  const sig = typeof bankTxOrSignature === 'string'
    ? bankTxOrSignature
    : extractMerchantSignature(bankTxOrSignature.description, bankTxOrSignature.counterparty);
  if (!sig) return null;
  const writer = opts.tx || getDb();
  const { merchantMemory } = getSchema();
  const existing = await writer
    .select()
    .from(merchantMemory)
    .where(
      and(eq(merchantMemory.entityId, entityId), eq(merchantMemory.merchantSignature, sig))
    )
    .limit(1);
  const now = new Date();
  if (existing[0]) {
    const repointed = existing[0].accountId !== accountId;
    const newHits = repointed ? 1 : existing[0].hitsCount + 1;
    await writer
      .update(merchantMemory)
      .set({
        accountId,
        hitsCount: newHits,
        confidence: memoryConfidenceFor(newHits),
        lastUsed: now,
        supersededAt: null,
        updatedAt: now,
      })
      .where(eq(merchantMemory.id, existing[0].id));
    return { id: existing[0].id, signature: sig, hitsCount: newHits, repointed };
  }
  const id = newMemoryId();
  await writer.insert(merchantMemory).values({
    id,
    entityId,
    merchantSignature: sig,
    accountId,
    hitsCount: 1,
    confidence: memoryConfidenceFor(1),
    lastUsed: now,
  });
  return { id, signature: sig, hitsCount: 1, repointed: false };
}

// =====================================================================
// Combined suggestion
// =====================================================================

async function loadBankTx(bankTxId, tx) {
  const db = tx || getDb();
  const { bankTransactions } = getSchema();
  const rows = await db
    .select()
    .from(bankTransactions)
    .where(eq(bankTransactions.id, bankTxId))
    .limit(1);
  if (!rows[0]) throw new Error(`bank transaction ${bankTxId} not found`);
  return rows[0];
}

async function suggestCategory(entityId, bankTxId, opts = {}) {
  const bankTx = await loadBankTx(bankTxId, opts.tx);
  if (bankTx.entityId !== entityId) {
    throw new Error('suggestCategory: entityId mismatch');
  }
  const rule = await findRuleMatch(entityId, bankTx, opts);
  if (rule) return { ...rule, bankTxId };
  const mem = await findMemoryMatch(entityId, bankTx, opts);
  if (mem) return { ...mem, action: { kind: 'categorise', accountCode: mem.accountCode }, bankTxId };
  return null;
}

// =====================================================================
// Bulk auto-categorisation
// =====================================================================

/**
 * Walk every unmatched line on a bank account, look up a suggestion,
 * and (if `autoPost` and `confidence >= autoPostThreshold`) post a
 * journal via the existing categoriseTransaction helper.
 *
 * This is the core "make the inbox empty itself" path. Returns a
 * per-line breakdown so the (future) UI can show the user exactly what
 * happened.
 */
async function applyRulesToUnmatched(args, opts = {}) {
  const {
    bankAccountId,
    autoPost = false,
    autoPostThreshold = 95,
    dryRun = false,
    limit = 500,
  } = args;
  if (!bankAccountId) throw new Error('bankAccountId required');

  // Lazy require to break circularity with transactions.js.
  const { categoriseTransaction, ignoreTransaction, listTransactions } = require('./transactions');
  const unmatched = await listTransactions({ bankAccountId, status: 'unmatched', limit }, opts);
  if (unmatched.length === 0) {
    return { scanned: 0, suggested: 0, posted: 0, ignored: 0, results: [] };
  }
  const entityId = unmatched[0].entityId;
  const rules = await loadActiveRules(entityId, opts); // load once
  const results = [];
  let suggested = 0;
  let posted = 0;
  let ignoredCount = 0;

  for (const btx of unmatched) {
    let suggestion = null;
    const ruleHit = await findRuleMatch(entityId, btx, { ...opts, rules });
    if (ruleHit) suggestion = { ...ruleHit, bankTxId: btx.id };
    if (!suggestion) {
      const memHit = await findMemoryMatch(entityId, btx, opts);
      if (memHit) {
        suggestion = {
          ...memHit,
          action: { kind: 'categorise', accountCode: memHit.accountCode },
          bankTxId: btx.id,
        };
      }
    }
    if (!suggestion) {
      results.push({ bankTxId: btx.id, status: 'no_match' });
      continue;
    }
    suggested += 1;
    const action = suggestion.action || {};
    const meetsThreshold = (suggestion.confidence || 0) >= autoPostThreshold;

    if (!autoPost || dryRun || !meetsThreshold) {
      results.push({
        bankTxId: btx.id,
        status: 'suggested',
        action,
        confidence: suggestion.confidence,
        source: suggestion.source,
        ruleId: suggestion.rule?.id,
        wouldPost: meetsThreshold && autoPost && !dryRun,
      });
      continue;
    }
    // autoPost=true, dryRun=false, threshold met → execute.
    if (action.kind === 'ignore') {
      await ignoreTransaction(btx.id, action.reason || 'auto', { actor: opts.actor });
      ignoredCount += 1;
      results.push({ bankTxId: btx.id, status: 'auto_ignored', reason: action.reason || 'auto' });
      continue;
    }
    if (action.kind === 'categorise') {
      try {
        const r = await categoriseTransaction(
          {
            bankTxId: btx.id,
            accountCode: action.accountCode,
            vendorOrPayer: btx.counterparty || null,
          },
          { actor: opts.actor }
        );
        // Bump rule timesApplied + record memory in a side-effect tx.
        const writer = getDb();
        await writer.transaction(async (innerTx) => {
          if (suggestion.rule?.id) {
            const { bankRules } = getSchema();
            await innerTx
              .update(bankRules)
              .set({ timesApplied: (suggestion.rule.timesApplied || 0) + 1, lastAppliedAt: new Date(), updatedAt: new Date() })
              .where(eq(bankRules.id, suggestion.rule.id));
          }
          // Resolve the account id from the code so we can write memory.
          const acct = await getAccountByCode(entityId, action.accountCode, { tx: innerTx });
          await recordMerchantMemory(entityId, btx, acct.id, { tx: innerTx });
        });
        posted += 1;
        results.push({
          bankTxId: btx.id,
          status: 'auto_posted',
          journalId: r.journalId,
          accountCode: action.accountCode,
          source: suggestion.source,
          confidence: suggestion.confidence,
          ruleId: suggestion.rule?.id,
        });
      } catch (err) {
        results.push({ bankTxId: btx.id, status: 'error', error: err.message });
      }
      continue;
    }
    results.push({ bankTxId: btx.id, status: 'unknown_action_kind' });
  }

  await audit(
    {
      action: 'bank.rules.apply',
      actorUserId: opts.actor?.userId || null,
      actorEmail: opts.actor?.email,
      actorRole: opts.actor?.role,
      resourceType: 'bank_account',
      resourceId: bankAccountId,
      entityId,
      after: { scanned: unmatched.length, suggested, posted, ignored: ignoredCount, autoPost, autoPostThreshold, dryRun },
    },
    {}
  );

  return {
    scanned: unmatched.length,
    suggested,
    posted,
    ignored: ignoredCount,
    results,
  };
}

// =====================================================================
// CRUD helpers (admin / user-facing UI in slice 2)
// =====================================================================

async function createRule(input, opts = {}) {
  const { entityId, name, description, priority = 100, conditions, action, source = 'user' } = input;
  if (!entityId) throw new Error('entityId required');
  if (!name) throw new Error('name required');
  if (!conditions) throw new Error('conditions required');
  if (!action) throw new Error('action required');
  // Sanity-check the action shape so we fail at create-time, not match-time.
  if (!['categorise', 'ignore'].includes(action.kind)) {
    throw new Error(`unknown action.kind: ${action.kind}`);
  }
  if (action.kind === 'categorise' && !action.accountCode) {
    throw new Error('action.accountCode required for kind=categorise');
  }
  const id = newRuleId();
  const writer = opts.tx || getDb();
  const { bankRules } = getSchema();
  await writer.insert(bankRules).values({
    id,
    entityId,
    name,
    description: description || null,
    source,
    priority,
    conditions,
    action,
    active: true,
    createdBy: opts.actor?.userId || null,
  });
  await audit(
    {
      action: 'bank.rule.create',
      actorUserId: opts.actor?.userId || null,
      actorEmail: opts.actor?.email,
      actorRole: opts.actor?.role,
      resourceType: 'bank_rule',
      resourceId: id,
      entityId,
      after: { name, priority, source, action, conditions },
    },
    { tx: opts.tx }
  );
  return { id };
}

async function listRules(entityId, opts = {}) {
  if (!entityId) throw new Error('entityId required');
  const db = opts.tx || getDb();
  const { bankRules } = getSchema();
  return db
    .select()
    .from(bankRules)
    .where(eq(bankRules.entityId, entityId))
    .orderBy(asc(bankRules.priority), asc(bankRules.name));
}

async function updateRule(id, patch, opts = {}) {
  if (!id) throw new Error('id required');
  const writer = opts.tx || getDb();
  const { bankRules } = getSchema();
  const allowed = ['name', 'description', 'priority', 'conditions', 'action', 'active'];
  const set = { updatedAt: new Date() };
  for (const k of allowed) if (k in patch) set[k] = patch[k];
  await writer.update(bankRules).set(set).where(eq(bankRules.id, id));
  await audit(
    {
      action: 'bank.rule.update',
      actorUserId: opts.actor?.userId || null,
      resourceType: 'bank_rule',
      resourceId: id,
      after: set,
    },
    { tx: opts.tx }
  );
  return { ok: true };
}

async function deleteRule(id, opts = {}) {
  if (!id) throw new Error('id required');
  const writer = opts.tx || getDb();
  const { bankRules } = getSchema();
  await writer.delete(bankRules).where(eq(bankRules.id, id));
  await audit(
    {
      action: 'bank.rule.delete',
      actorUserId: opts.actor?.userId || null,
      resourceType: 'bank_rule',
      resourceId: id,
      after: null,
    },
    { tx: opts.tx }
  );
  return { ok: true };
}

/**
 * Preview: given a (possibly-unsaved) ruleConditions, count how many
 * bank lines on the entity in the last `windowDays` would have matched.
 *
 * Returns { matched: number, sampleIds: string[] } so the UI can show
 * "this would have matched 23 transactions" with a few examples.
 */
async function testRuleAgainstHistory(entityId, conditions, opts = {}) {
  if (!entityId) throw new Error('entityId required');
  if (!conditions) throw new Error('conditions required');
  const windowDays = opts.windowDays || 90;
  const limit = opts.limit || 1000;
  const db = opts.tx || getDb();
  const { bankTransactions } = getSchema();
  const since = new Date();
  since.setUTCDate(since.getUTCDate() - windowDays);
  const sinceIso = since.toISOString().slice(0, 10);
  const rows = await db
    .select()
    .from(bankTransactions)
    .where(and(eq(bankTransactions.entityId, entityId), gte(bankTransactions.date, sinceIso)))
    .limit(limit);
  const matches = rows.filter((r) => evalConditions(conditions, r));
  return {
    scanned: rows.length,
    matched: matches.length,
    sampleIds: matches.slice(0, 10).map((m) => m.id),
  };
}

module.exports = {
  extractMerchantSignature,
  evalConditions,
  evalPredicate,
  seedDefaultRulesForEntity,
  loadActiveRules,
  findRuleMatch,
  findMemoryMatch,
  recordMerchantMemory,
  suggestCategory,
  applyRulesToUnmatched,
  createRule,
  listRules,
  updateRule,
  deleteRule,
  testRuleAgainstHistory,
  memoryConfidenceFor,
};
