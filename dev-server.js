/**
 * Replit dev server — mimics Vercel's serverless function routing locally.
 *
 * - Static files served from /public
 * - Any request to /api/<path> dynamically loads ./api/<path>.js and calls
 *   its exported handler with (req, res) — same signature as Vercel.
 * - Hot-reload friendly: the API module cache is busted on every request in dev
 *   so editing an api/*.js file is reflected immediately.
 *
 * In production (Vercel), this file is unused — Vercel routes /api/* to its
 * own serverless runtime via vercel.json.
 */

const path = require('path');
const fs = require('fs');
const express = require('express');

require('dotenv').config({ path: path.join(__dirname, '.env') });

const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';
const API_DIR = path.join(__dirname, 'api');
const PUBLIC_DIR = path.join(__dirname, 'public');

const app = express();

app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true, limit: '25mb' }));

app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

function resolveHandlerFile(apiPath) {
  const cleanPath = apiPath.replace(/^\/+|\/+$/g, '');
  const candidates = [
    path.join(API_DIR, `${cleanPath}.js`),
    path.join(API_DIR, cleanPath, 'index.js'),
  ];
  for (const candidate of candidates) {
    if (
      candidate.startsWith(API_DIR + path.sep) &&
      fs.existsSync(candidate) &&
      fs.statSync(candidate).isFile()
    ) {
      return candidate;
    }
  }
  return null;
}

app.all('/api/*', async (req, res) => {
  const apiPath = req.path.replace(/^\/api\//, '');
  const handlerFile = resolveHandlerFile(apiPath);

  if (!handlerFile) {
    return res.status(404).json({ error: `No API handler for /api/${apiPath}` });
  }

  if (process.env.NODE_ENV !== 'production') {
    delete require.cache[require.resolve(handlerFile)];
  }

  try {
    const handler = require(handlerFile);
    const fn = typeof handler === 'function' ? handler : handler.default;
    if (typeof fn !== 'function') {
      return res.status(500).json({ error: `Handler ${apiPath} did not export a function` });
    }
    await fn(req, res);
  } catch (err) {
    console.error(`[api] error in /api/${apiPath}:`, err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Internal server error', detail: String(err.message || err) });
    }
  }
});

app.use(express.static(PUBLIC_DIR, { extensions: ['html'] }));

app.get('/', (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

app.use((req, res) => {
  const indexPath = path.join(PUBLIC_DIR, 'index.html');
  if (fs.existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    res.status(404).send('Not found');
  }
});

app.listen(PORT, HOST, () => {
  console.log(`\n  Taylor Invoices dev server`);
  console.log(`  ───────────────────────────`);
  console.log(`  Listening on http://${HOST}:${PORT}`);
  console.log(`  Static:  ${PUBLIC_DIR}`);
  console.log(`  API:     ${API_DIR}`);
  console.log(`  Env:     ${fs.existsSync(path.join(__dirname, '.env')) ? '.env loaded' : 'no .env file (using process env only)'}\n`);
});
