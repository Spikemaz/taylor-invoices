const { google } = require('googleapis');
const { applyCors } = require('../_lib/auth');

module.exports = async function handler(req, res) {
  applyCors(req, res, 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const SECRET = process.env.MASTER_OVERRIDE_CODE || '';
  if (!SECRET || (req.query.k || '') !== SECRET) {
    return res.status(403).json({ error: 'forbidden' });
  }

  try {
    const auth = new google.auth.JWT({
      email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      key: (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
      scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
    });
    const sheets = google.sheets({ version: 'v4', auth });
    const masterId = process.env.MASTER_SHEET_ID || '';
    const r = await sheets.spreadsheets.values.get({
      spreadsheetId: masterId,
      range: 'Users!A:M',
    });
    const rows = r.data.values || [];
    const headers = rows[0] || [];
    const out = rows.slice(1).map(row => {
      const o = {};
      headers.forEach((h, i) => {
        const v = row[i] || '';
        o[h] = (h === 'sheetId' || h === 'driveFolderId' || h === 'backupSheetId' || h === 'backupFolderId')
          ? (v ? `${String(v).slice(0,10)}…(${String(v).length})` : '(BLANK)')
          : v;
      });
      return o;
    });
    return res.status(200).json({
      masterSheetId: masterId ? `${masterId.slice(0,10)}…(${masterId.length})` : '(BLANK)',
      headers,
      users: out,
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
