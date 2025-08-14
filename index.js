// index.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');

const app = express();

// For signature verification, we need the raw body. Keep this on /webhook paths.
app.use('/webhook', express.raw({ type: '*/*' }));
app.use(cors());

// Health check
app.get('/', (_req, res) => res.send('SavoPay API is live'));

// (Optional) verify HMAC if ForumPay gives you a secret + header name
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
    // If you later enable the secret, change the 200 below to 401 on fail.
    const ok = verifySignature(req);
    if (!ok) console.warn(`[WEBHOOK:${kind}] signature check failed (secret set?)`);

    // Try to parse JSON; if not JSON, store raw
    let payload;
    try { payload = JSON.parse(req.body?.toString('utf8') || '{}'); }
    catch { payload = { raw: req.body?.toString('utf8') || '' }; }

    console.log(`[WEBHOOK:${kind}]`, new Date().toISOString(), payload);

    // TODO: update DB, notify dashboard, etc.
    res.status(200).send('OK');
  };
}

// Payments / buy orders
app.post('/webhook/payments', handleWebhook('payments'));
// Subscriptions
app.post('/webhook/subscriptions', handleWebhook('subscriptions'));
// Fallback single endpoint (if ForumPay only allows one URL)
app.post('/webhook', handleWebhook('generic'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`SavoPay API listening on :${PORT}`));
