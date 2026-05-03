#!/usr/bin/env node
/**
 * End-to-end test: Drive mirror-on-upload + server-side trash on delete.
 *
 * Logs in as the designated test user via /api/auth/test-session (no email
 * required), creates a unique invoice with a real PDF round-trip, asserts
 * that BOTH the user-facing PDF and the hidden backup mirror exist in
 * Google Drive and are not trashed, then deletes the invoice and asserts
 * that BOTH PDFs are now trashed. Each run uses a unique invoice number
 * so the test is safe to re-run.
 *
 * Required env:
 *   APP_URL              Base URL of the deployment to test
 *                        (e.g. https://booksiq.app or http://localhost:3000)
 *   TEST_SESSION_SECRET  Must match the server's TEST_SESSION_SECRET env
 *
 * The server must additionally have TEST_USER_EMAIL configured (and that
 * user must already exist in the Master Sheet's Users tab AND have a
 * backupFolderId set — i.e. be a migrated user — otherwise the mirror
 * code paths are not exercised).
 *
 * Usage:
 *   APP_URL=https://booksiq.app TEST_SESSION_SECRET=xxx \
 *     node scripts/e2e-drive-sync.js
 *
 * Exit codes:
 *   0  All assertions passed
 *   1  Assertion failure or runtime error
 *   2  Missing required env
 */

'use strict';

const APP_URL = (process.env.APP_URL || '').replace(/\/+$/, '');
const TEST_SECRET = process.env.TEST_SESSION_SECRET;

if (!APP_URL) {
  console.error('Missing required env: APP_URL');
  process.exit(2);
}
if (!TEST_SECRET) {
  console.error('Missing required env: TEST_SESSION_SECRET');
  process.exit(2);
}

let session = null;

function ts() { return new Date().toISOString(); }
function step(name) { console.log(`\n[${ts()}] === ${name} ===`); }
function ok(msg) { console.log(`  PASS  ${msg}`); }
function fail(msg, extra) {
  console.error(`  FAIL  ${msg}`);
  if (extra !== undefined) {
    try { console.error(JSON.stringify(extra, null, 2)); }
    catch { console.error(String(extra)); }
  }
  process.exit(1);
}

async function postJson(path, body, opts = {}) {
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  if (session?.token && !opts.noAuth) headers['X-Session-Token'] = session.token;

  const res = await fetch(`${APP_URL}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { _raw: text }; }
  return { status: res.status, data };
}

async function login() {
  step('Test session login');
  const r = await postJson(
    '/api/auth/test-session',
    { action: 'session' },
    { noAuth: true, headers: { 'X-Test-Secret': TEST_SECRET } }
  );
  if (r.status !== 200 || !r.data?.session?.token) {
    fail('Could not obtain test session', r);
  }
  session = r.data.session;
  ok(`Logged in as ${session.email} (userId=${session.userId})`);

  if (!session.driveFolderId) {
    fail('Test user has no driveFolderId — cannot test primary upload flow');
  }
  if (!session.backupFolderId) {
    fail('Test user has no backupFolderId — must be a migrated user to test mirror flow');
  }
  ok(`driveFolderId=${session.driveFolderId}`);
  ok(`backupFolderId=${session.backupFolderId}`);
}

async function checkFiles(fileIds) {
  const r = await postJson(
    '/api/auth/test-session',
    { action: 'check_files', fileIds },
    { noAuth: true, headers: { 'X-Test-Secret': TEST_SECRET } }
  );
  if (r.status !== 200) fail('check_files endpoint failed', r);
  return r.data.results;
}

function buildInvoicePayload() {
  // Each run uses a unique 'E2E<timestamp>' invoice number so re-runs do
  // not collide on the Invoices sheet (column A is the natural primary key).
  const invoiceNum = `E2E${Date.now()}`;
  const now = new Date();
  const isoDate = now.toISOString().slice(0, 10);
  const monthName = now.toLocaleString('en-GB', { month: 'long' });
  const yearStr = String(now.getFullYear());

  const payload = {
    num: invoiceNum,
    date: isoDate,
    practice: 'e2e-test',
    practiceName: 'E2E Test Practice',
    practiceAddr: '1 Test Lane\nTestville',
    period: `${monthName} ${yearStr}`,
    entity: 'Self-Employed',
    entName: 'E2E Test Entity',
    entAddr: '1 Test Street\nTestburg',
    entPhone: '+00 0000 000000',
    bankName: 'Test Bank',
    bankAccName: 'E2E Tester',
    bankAcc: '00000000',
    bankSort: '00-00-00',
    amount: 12.34,
    gross: 12.34,
    commRate: '0',
    svcs: { s1: { name: 'E2E Service', date: isoDate, price: 12.34, pts: 1, total: 12.34 } },
    addons: {},
    airTotal: 0,
    logoType: 'self',
    payTerms: '5 working days',
    footerMsg: 'E2E test invoice — safe to delete',
    companyNo: '',
    isAdhoc: true, // adhoc routes the file into ".../Ad Hoc/" which keeps it isolated
    paidStatus: 'pending',
    paidDate: '',
  };

  return { invoiceNum, isoDate, monthName, yearStr, payload };
}

async function run() {
  console.log(`Target: ${APP_URL}`);
  await login();

  const { invoiceNum, monthName, yearStr, payload } = buildInvoicePayload();
  console.log(`Invoice number: ${invoiceNum}`);

  step('Generate invoice PDF');
  const pdfRes = await postJson('/api/generate-pdf', payload);
  if (pdfRes.status !== 200 || !pdfRes.data?.pdfBase64 || !pdfRes.data?.fileName) {
    fail('PDF generation failed', pdfRes);
  }
  ok(`PDF generated: ${pdfRes.data.fileName}`);

  step('Upload PDF (primary + mirror)');
  const uploadRes = await postJson('/api/drive-upload', {
    fileName: pdfRes.data.fileName,
    pdfBase64: pdfRes.data.pdfBase64,
    entity: 'self',
    year: yearStr,
    month: monthName,
    isAdhoc: true,
  });
  if (uploadRes.status !== 200 || !uploadRes.data?.fileId) {
    fail('Drive upload failed', uploadRes);
  }
  const {
    fileId: primaryId,
    backupFileId,
    backupTier,
    mirrorFailures = [],
    webViewLink,
  } = uploadRes.data;
  ok(`Primary uploaded: fileId=${primaryId}`);
  if (!backupFileId) {
    fail('No backupFileId in upload response — mirror did not happen', uploadRes.data);
  }
  if (mirrorFailures.length) {
    fail('Mirror reported failures', mirrorFailures);
  }
  ok(`Mirror uploaded: backupFileId=${backupFileId} (tier=${backupTier})`);

  step('Verify both PDFs exist in Drive and are NOT trashed');
  const presence = await checkFiles([primaryId, backupFileId]);
  for (const r of presence) {
    if (!r.exists) fail(`File ${r.fileId} not found in Drive`, r);
    if (r.trashed) fail(`File ${r.fileId} unexpectedly trashed before delete`, r);
  }
  ok('Both PDFs present and live');

  step('Append invoice row to Sheets');
  const appendRes = await postJson('/api/sheets-sync', {
    action: 'append_invoice',
    data: { ...payload, driveLink: webViewLink },
  });
  if (appendRes.status !== 200) fail('append_invoice failed', appendRes);
  ok('Invoice row appended');

  step('Delete invoice (server-side trash)');
  const delRes = await postJson('/api/sheets-sync', {
    action: 'delete_invoice',
    data: { num: invoiceNum, driveLink: webViewLink },
  });
  if (delRes.status !== 200) fail('delete_invoice failed', delRes);

  const cleanup = delRes.data?.pdfCleanup;
  if (!cleanup) {
    fail(
      'No pdfCleanup in delete response — server did NOT run server-side trash. ' +
        'Likely cause: session.backupFolderId not propagated; check sheets-sync.deleteInvoice.',
      delRes.data
    );
  }
  if (!cleanup.primaryTrashed) fail('Server reported primary not trashed', cleanup);
  if (!cleanup.mirrorAttempted) {
    fail('Server did not attempt mirror trash (backupFolderId missing in session?)', cleanup);
  }
  if (!cleanup.mirrorTrashed) fail('Server reported mirror not trashed', cleanup);
  ok('Server reported both primary + mirror trashed');

  step('Verify both PDFs are now trashed in Drive');
  const post = await checkFiles([primaryId, backupFileId]);
  for (const r of post) {
    if (!r.exists) {
      // Trash is expected; outright deletion would also satisfy the user
      // intent but indicates a code path we don't expect — fail loudly.
      fail(`File ${r.fileId} no longer findable (expected trashed=true, not deleted)`, r);
    }
    if (!r.trashed) fail(`File ${r.fileId} not trashed in Drive`, r);
  }
  ok('Both PDFs are trashed in Drive');

  step('DONE — Drive sync end-to-end verified');
  console.log(`Invoice number used: ${invoiceNum}`);
  console.log(`Primary file:        ${primaryId} (trashed)`);
  console.log(`Mirror file:         ${backupFileId} (trashed)`);
}

run().catch((e) => {
  console.error('Test crashed:', e);
  process.exit(1);
});
