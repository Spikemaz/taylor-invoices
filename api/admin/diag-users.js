module.exports = function handler(_req, res) {
  res.status(410).json({ error: 'gone' });
};
