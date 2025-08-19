// index.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');

const app = express();

// Keep raw body for your generic /webhook endpoints (if you need HMAC on raw)
app.use('/webhook', express.raw({ type: '*/*' }));

// ForumPay callback expects x-www-form-urlencoded
app.use('/forumpay/callback', express.urlencoded({ extended: false }));

app.use(cors());

// Health checks
app.get('/', (_req, res) => res.send('SavoPay API is live'));
app.get('/healthz', (_req, res) => res.send('ok'));

// (Optional) verify HMAC for /webhook/* later if ForumPay provides a secret
function verifySignature(req) {
  const secret = process.env.FORUMPAY_WEBHOOK_SECRET || '';
  if (!secret) return true; // skip until you have a secret
  const sig = req.header('x-forumpay-signature') || '';
  try {
    const digest = crypto.createHmac('sha256', secret).update(req.body).digest('hex');
    return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(digest));
  } catch { return false; }
}

function handleWebhook(kind) {
  return (req, res) => {
    const ok = verifySignature(req);
    if (!ok) console.warn(`[WEBHOOK:${kind}] signature check failed (secret set?)`);

    let payload;
    try { payload = JSON.parse(req.body?.toString('utf8') || '{}'); }
    catch { payload = { raw: req.body?.toString('utf8') || '' }; }

    console.log(`[WEBHOOK:${kind}]`, new Date().toISOString(), payload);
    res.status(200).send('OK');
  };
}

// Your existing generic webhook endpoints (raw)
app.post('/webhook/payments', handleWebhook('payments'));
app.post('/webhook/subscriptions', handleWebhook('subscriptions'));
app.post('/webhook', handleWebhook('generic'));

// ForumPay callback (form data)
app.post('/forumpay/callback', (req, res) => {
  console.log('[FORUMPAY CALLBACK]', new Date().toISOString(), req.body);
  res.sendStatus(200);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`SavoPay API listening on :${PORT}`));
