const { google } = require('googleapis');
const { applyCors } = require('../_lib/auth');

const ONE_TIME_KEY = 'e64143ca3a0aa32405db7a345c7faa2e';

module.exports = async function handler(req, res) {
  applyCors(req, res, 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if ((req.query.k || '') !== ONE_TIME_KEY) {
    return res.status(403).json({ error: 'forbidden' });
  }

  const masterId = process.env.MASTER_SHEET_ID || '';
  const saEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || '';
  const pkLen = (process.env.GOOGLE_PRIVATE_KEY || '').length;

  try {
    const auth = new google.auth.JWT({
      email: saEmail,
      key: (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
      scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
    });
    const sheets = google.sheets({ version: 'v4', auth });
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
        const sensitive = /sheetId|driveFolderId/i.test(h);
        o[h] = sensitive
          ? (v ? `${String(v).slice(0,10)}…(len=${String(v).length})` : '(BLANK)')
          : v;
      });
      return o;
    });
    return res.status(200).json({
      masterSheetIdFull: masterId,
      saEmail,
      pkLen,
      headers,
      userCount: out.length,
      users: out,
    });
  } catch (e) {
    return res.status(500).json({
      error: e.message,
      masterSheetIdFull: masterId,
      saEmail,
      pkLen,
    });
  }
};
