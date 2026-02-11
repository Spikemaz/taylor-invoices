// Google Sheets sync endpoint
// Actions: append_entry, append_invoice, update_entry, delete_entry, load_all, etc.

module.exports = async (req, res) => {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { action, data } = req.body;

  // TODO: Implement Google Sheets integration
  // Will use googleapis package with service account auth

  return res.status(200).json({
    success: true,
    message: `Stub: ${action} received`,
    data: data
  });
};
