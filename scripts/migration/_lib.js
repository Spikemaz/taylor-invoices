/**
 * Shared helpers for the migration CLI scripts.
 *
 * Loads .env from artifacts/taylor-invoices/.env so scripts can be run
 * directly with `node` from anywhere.
 *
 * Provides:
 *   - parseArgs(): { userId, dryRun, execute, statePath, ... } from argv
 *   - loadState(path) / saveState(path, obj): JSON state files for idempotency
 *   - log(level, msg, extra): timestamped console output
 *   - assertEnv(...names): throws if any env var is missing
 */

const fs = require('fs');
const path = require('path');

// Load env from the taylor-invoices artifact root
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

function log(level, msg, extra) {
  const ts = new Date().toISOString();
  const line = `[${ts}] [${level.toUpperCase()}] ${msg}`;
  if (extra !== undefined) {
    console.log(line, typeof extra === 'string' ? extra : JSON.stringify(extra, null, 2));
  } else {
    console.log(line);
  }
}

function parseArgs(argv = process.argv.slice(2)) {
  const out = {
    dryRun: true,    // safe by default
    execute: false,
    userId: null,
    output: null,
    statePath: null,
    force: false,
    masterSheetId: process.env.MASTER_SHEET_ID || null,
    _raw: argv.slice(),
  };
  for (const arg of argv) {
    if (arg === '--dry-run') { out.dryRun = true; out.execute = false; continue; }
    if (arg === '--execute') { out.execute = true; out.dryRun = false; continue; }
    if (arg === '--force') { out.force = true; continue; }
    const m = arg.match(/^--([\w-]+)=(.*)$/);
    if (m) {
      const key = m[1].replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      out[key] = m[2];
    }
  }
  return out;
}

function assertEnv(...names) {
  const missing = names.filter(n => !process.env[n]);
  if (missing.length > 0) {
    throw new Error(`Missing required env vars: ${missing.join(', ')}. Set them in artifacts/taylor-invoices/.env`);
  }
}

function defaultStateDir() {
  // Prefer .local/migration so it's automatically gitignored at the repo root
  return path.join(__dirname, '..', '..', '..', '..', '.local', 'migration');
}

function stateFilePathFor(userId, label = 'migrate') {
  const dir = process.env.MIGRATION_STATE_DIR || defaultStateDir();
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${label}-${userId}.json`);
}

function loadState(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e) {
    throw new Error(`Failed to parse state file ${filePath}: ${e.message}`);
  }
}

function saveState(filePath, obj) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  // Atomic write: tmp file + rename
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, filePath);
}

function nowIso() {
  return new Date().toISOString();
}

function dateStamp() {
  return new Date().toISOString().slice(0, 10);
}

module.exports = {
  log,
  parseArgs,
  assertEnv,
  loadState,
  saveState,
  stateFilePathFor,
  nowIso,
  dateStamp,
};
