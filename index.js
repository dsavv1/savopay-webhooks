// index.js — SavoPay backend for UI + ForumPay helpers (Postgres-backed)
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import fetch from 'node-fetch';
import path from 'path';
import { fileURLToPath } from 'url';
import { store } from './store.js';

// ---------- Setup ----------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.set('trust proxy', true);
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

// Serve static demo pages (optional)
app.use(express.static(path.join(__dirname, 'public')));

// ---------- CORS ----------
const allowedOrigins = [
  'http://localhost:3000',
  'http://localhost:3002',
  'https://savopay-ui-1.onrender.com',
  process.env.ALLOWED_ORIGIN, // e.g. https://savopay.co
].filter(Boolean);

app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true); // curl/Postman or same-origin
      if (allowedOrigins.includes(origin)) return cb(null, true);
      return cb(null, false); // no CORS headers, but no crash
    },
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  })
);

// ---------- ENV ----------
const PORT = process.env.PORT || 3000;

// ForumPay PROD dashboard (your /api/* info endpoints)
const FP_BASE = process.env.FORUMPAY_API_BASE || 'https://dashboard.forumpay.com/pay/payInfo.api';
const FP_USER = process.env.FORUMPAY_USER || '';
const FP_PASS = process.env.FORUMPAY_PASS || '';

// ForumPay SANDBOX payment API (for /start-payment & CheckPayment)
const PAY_BASE = process.env.FORUMPAY_BASE_URL || 'https://sandbox.api.forumpay.com';
const PAY_USER = process.env.FORUMPAY_PAY_USER || process.env.FORUMPAY_USER || '';
const PAY_SECRET = process.env.FORUMPAY_PAY_SECRET || process.env.FORUMPAY_SECRET || '';
const POS_ID = process.env.FORUMPAY_POS_ID || 'savopay-pos-01';

// Webhook settings
const CALLBACK_URL = process.env.FORUMPAY_CALLBACK_URL || '';
const WEBHOOK_TOKEN = process.env.WEBHOOK_TOKEN || process.env.FORUMPAY_WEBHOOK_SECRET || '';

const basicAuthHeader = 'Basic ' + Buffer.from(`${PAY_USER}:${PAY_SECRET}`).toString('base64');

// ---------- Helpers ----------
function nowIso() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

async function parseMaybeJson(res) {
  const text = await res.text();
  try { return { kind: 'json', data: JSON.parse(text) }; }
  catch { return { kind: 'html', data: text }; }
}

// ---------- UI endpoints (what the React app calls) ----------

// Health
app.get('/health', (_req, res) => res.json({ ok: true }));

// List recent payments (with error detail)
app.get('/payments', async (_req, res) => {
  try {
    const rows = await store.listPayments();
    res.json(rows);
  } catch (e) {
    console.error('payments error:', e);
    res.status(500).json({ error: 'payments failed', detail: e.message });
  }
});

// Start payment (SANDBOX)
app.post('/start-payment', async (req, res) => {
  try {
    const {
      invoice_amount = '100.00',
      invoice_currency = 'USD',
      currency = 'USDT',
      payer_id = 'walk-in',
      customer_email = '',
    } = req.body || {};

    const order_id = `SVP-TEST-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    const cb_url = CALLBACK_URL ? `${CALLBACK_URL}?token=${encodeURIComponent(WEBHOOK_TOKEN)}` : '';

    const params = new URLSearchParams();
    params.set('pos_id', POS_ID);
    params.set('invoice_amount', String(invoice_amount));
    params.set('invoice_currency', String(invoice_currency));
    params.set('currency', String(currency));
    params.set('payer_ip_address', '203.0.113.10'); // or derive from X-Forwarded-For
    params.set('payer_id', String(payer_id || 'walk-in'));
    params.set('order_id', order_id);
    if (cb_url) params.set('callback_url', cb_url);

    const resp = await fetch(`${PAY_BASE}/pay/v2/StartPayment/`, {
      method: 'POST',
      headers: {
        Authorization: basicAuthHeader,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params,
    });

    const text = await resp.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }
    console.log(`StartPayment ${resp.status}: ${text}`);

    if (!resp.ok) {
      return res.status(resp.status).json({ error: 'StartPayment failed', detail: data });
    }

    await store.saveStart({
      payment_id: data.payment_id || null,
      order_id,
      pos_id: POS_ID,
      address: data.address || null,
      currency,
      invoice_amount,
      invoice_currency,
      crypto_amount: data.amount || null,
      status: 'Created',
      state: 'created',
      confirmed: 0,
      confirmed_time: null,
      payer_id: String(payer_id || 'walk-in'),
      customer_email: customer_email || null,
      print_string: data.print_string || null,
      created_at: nowIso(),
      amount_exchange: data.amount_exchange || null,
      network_processing_fee: data.network_processing_fee || null,
      last_transaction_time: null,
      invoice_date: null,
    });

    return res.json(data);
  } catch (e) {
    console.error('start-payment error', e);
    res.status(500).json({ error: 'Internal error', detail: e.message });
  }
});

// Minimal receipt endpoints so the UI buttons work
app.get('/receipt/:payment_id', async (req, res) => {
  const p = await store.getPayment(req.params.payment_id);
  if (!p) return res.status(404).json({ error: 'Not found' });
  res.json({ payment_id: p.payment_id, print_string: p.print_string || '' });
});

app.get('/receipt/:payment_id/print', async (req, res) => {
  const p = await store.getPayment(req.params.payment_id);
  if (!p) return res.status(404).type('text/plain').send('Not found');
  res
    .type('html')
    .send(`<html><body><h1>Receipt ${p.payment_id}</h1><p>Thank you.</p></body></html>`);
});

// Email receipt (returns JSON so UI doesn't crash; wire real email later)
app.post('/payments/:payment_id/email', async (req, res) => {
  const payment_id = req.params.payment_id;
  const { to_email } = req.body || {};
  if (!to_email) return res.status(400).json({ error: 'to_email is required' });
  return res.json({ ok: true, payment_id, to: to_email });
});

// Daily report stubs
app.get('/report/daily', async (req, res) => {
  const date = req.query.date || new Date().toISOString().slice(0, 10);
  const rows = await store.listPayments();
  res.json({ date, summary: { totalCount: rows.length }, rows });
});

app.get('/report/daily.csv', async (req, res) => {
  const date = req.query.date || new Date().toISOString().slice(0, 10);
  const rows = await store.listPayments();
  res.type('text/csv').send(`date,count\n${date},${rows.length}\n`);
});

// ---------- CheckPayment helper + Webhook ----------
async function checkPaymentOnForumPay({ payment_id, currency, address }) {
  const body = new URLSearchParams();
  body.set('pos_id', POS_ID);
  body.set('payment_id', payment_id);
  body.set('currency', currency);
  body.set('address', address);

  const resp = await fetch(`${PAY_BASE}/pay/v2/CheckPayment/`, {
    method: 'POST',
    headers: {
      Authorization: basicAuthHeader,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });

  const text = await resp.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  console.log(`🔎 CheckPayment ${resp.status}: ${text}`);
  if (!resp.ok) throw new Error(`CheckPayment failed: ${resp.status}`);
  return json;
}

app.post('/api/forumpay/callback', async (req, res) => {
  try {
    const token = req.query.token || '';
    if (!WEBHOOK_TOKEN || token !== WEBHOOK_TOKEN) {
      return res.status(403).json({ error: 'Invalid token' });
    }

    const { payment_id, currency, address } = req.body || {};
    if (!payment_id || !currency || !address) {
      return res.status(400).json({ error: 'Missing fields', need: ['payment_id', 'currency', 'address'] });
    }

    const ck = await checkPaymentOnForumPay({ payment_id, currency, address });

    const update = {
      status: ck.status || ck.state || null,
      state: ck.state || null,
      confirmed: ck.confirmed ? 1 : 0,
      confirmed_time: ck.confirmed_time || null,
      crypto_amount: ck.amount || ck.payment || ck.crypto_amount || null,
      print_string: ck.print_string || null,
      amount_exchange: ck.amount_exchange || null,
      network_processing_fee: ck.network_processing_fee || null,
      last_transaction_time: ck.last_transaction_time || null,
      invoice_date: ck.invoice_date || null,
      payer_id: ck.payer_id || null,
    };
    await store.update(payment_id, update);

    res.json({ ok: true });
  } catch (e) {
    console.error('callback error', e);
    res.status(500).json({ error: 'Internal error', detail: e.message });
  }
});

// Re-check a payment's status without exposing webhook token to the client
app.post('/payments/:payment_id/recheck', async (req, res) => {
  try {
    const payment_id = req.params.payment_id;
    const saved = await store.getPayment(payment_id);
    if (!saved) return res.status(404).json({ error: 'Payment not found' });

    const ck = await checkPaymentOnForumPay({
      payment_id,
      currency: saved.currency,
      address: saved.address,
    });

    const update = {
      status: ck.status || ck.state || null,
      state: ck.state || null,
      confirmed: ck.confirmed ? 1 : 0,
      confirmed_time: ck.confirmed_time || null,
      crypto_amount: ck.amount || ck.payment || ck.crypto_amount || null,
      print_string: ck.print_string || null,
      amount_exchange: ck.amount_exchange || null,
      network_processing_fee: ck.network_processing_fee || null,
      last_transaction_time: ck.last_transaction_time || null,
      invoice_date: ck.invoice_date || null,
      payer_id: ck.payer_id || null,
    };
    await store.update(payment_id, update);

    res.json({ ok: true, state: update.state, confirmed: update.confirmed, crypto_amount: update.crypto_amount });
  } catch (e) {
    console.error('recheck error', e);
    res.status(500).json({ error: 'recheck failed', detail: e.message });
  }
});

// ---------- Your existing /api/* routes (kept intact) ----------
const fpHeaders = () => ({
  Authorization: 'Basic ' + Buffer.from(`${FP_USER}:${FP_PASS}`).toString('base64'),
});

app.get('/api/health', async (_req, res) => {
  try {
    const r = await fetch(`${FP_BASE}/GetSubAccounts`, { headers: fpHeaders() });
    const parsed = await parseMaybeJson(r);
    if (r.ok && parsed.kind === 'json') {
      return res.json({ ok: true, status: r.status, data: parsed.data });
    }
    return res.status(r.status || 502).json({
      ok: false,
      status: r.status,
      note: 'Prod Ping is unreliable; this hits GetSubAccounts.',
      preview: parsed.kind === 'html' ? parsed.data.slice(0, 500) : parsed.data,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

app.get('/api/subaccounts', async (_req, res) => {
  try {
    const r = await fetch(`${FP_BASE}/GetSubAccounts`, { headers: fpHeaders() });
    const parsed = await parseMaybeJson(r);
    if (r.ok && parsed.kind === 'json') return res.json(parsed.data);
    res.status(r.status || 502).json({
      error: 'GetSubAccounts failed',
      preview: parsed.kind === 'html' ? parsed.data.slice(0, 500) : parsed.data,
    });
  } catch (e) {
    res.status(500).json({ error: 'GetSubAccounts error', details: String(e) });
  }
});

app.get('/api/subaccount', async (req, res) => {
  const sid = req.query.sid;
  if (!sid) return res.status(400).json({ error: 'Missing sid query param' });
  try {
    const url = new URL(`${FP_BASE}/GetSubAccount`);
    url.searchParams.set('sid', sid);
    const r = await fetch(url, { headers: fpHeaders() });
    const parsed = await parseMaybeJson(r);
    if (r.ok && parsed.kind === 'json') return res.json(parsed.data);
    res.status(r.status || 502).json({
      error: 'GetSubAccount failed',
      preview: parsed.kind === 'html' ? parsed.data.slice(0, 500) : parsed.data,
    });
  } catch (e) {
    res.status(500).json({ error: 'GetSubAccount error', details: String(e) });
  }
});

// Root info
app.get('/', (_req, res) => {
  res.type('text').send('SavoPay API is running. Try /health, /payments, /start-payment or /api/health');
});

// ---------- Start ----------
app.listen(PORT, () => {
  console.log('ENV CHECK', {
    pay_base: PAY_BASE,
    pay_user_present: !!PAY_USER,
    pay_secret_present: !!PAY_SECRET,
    pos_id: POS_ID,
    callback_url: CALLBACK_URL,
    webhook_token_present: !!WEBHOOK_TOKEN,
    dash_api_base: FP_BASE,
    dash_user_present: !!FP_USER,
    dash_pass_present: !!FP_PASS,
    port: String(PORT),
    allowed_origin_list: allowedOrigins,
    db_url_present: !!process.env.DATABASE_URL,
  });
  console.log(`SavoPay running at http://localhost:${PORT}`);
});
