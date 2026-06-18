require('dotenv').config();
const express = require('express');
const path    = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'Mortgage Assistant',
    version: '1.0.0',
    runtime: process.env.RENDER ? 'render' : 'local',
    dryRun: process.env.DRY_RUN === 'true',
    approvalPdfOnly: process.env.APPROVAL_PDF_ONLY !== 'false',
    digestHours: process.env.DIGEST_HOURS || '8,12,16',
    timestamp: new Date().toISOString(),
    endpoints: [
      'GET  /api/gmail-watch         — unified inbox scan (approval PDFs + AI classify)',
      'GET  /api/digest              — send digest if scheduled hour',
      'GET  /api/digest?force=true   — send digest now',
      'POST /api/arive-webhook       — Arive → Notion loan status updates',
      'GET  /api/clear-ptf           — clear PTF conditions for a loan'
    ]
  });
});

app.get('/api/gmail-watch', (req, res) => require('./api/gmail-watch')(req, res));
app.get('/api/digest',      (req, res) => require('./api/digest')(req, res));
app.post('/api/arive-webhook', (req, res) => require('./api/arive-webhook')(req, res));
app.get('/api/clear-ptf',   (req, res) => require('./api/clear-ptf')(req, res));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`[${new Date().toISOString()}] Mortgage Assistant running on http://localhost:${PORT}`);
});
