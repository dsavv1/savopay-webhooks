// index.js — SavoPay backend for UI + ForumPay helpers
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import fetch from 'node-fetch';
import path from 'path';
import { fileURLToPath } from 'url';

// ---------- Setup ----------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.set('trust proxy', true);
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

// serve static test pages (success/cancel) + any future dashboard files
app.use(express.static(path.join(__dirname, 'public')));

// ---------- CORS ----------
const allowedOrigins = [
  'http://localhost:3000',
  'http://localhost:3002',
  'https://savopay-ui-1.onrender.com',
  process.env.ALLOWED_ORIGIN,
].filter(Boolean);

app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true); // curl/Postman
      if (allowedOrigins.includes(origin)) return cb(null, true);
      return cb(null, false); // no CORS headers, but no crash
    },
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  })
);

// ---------- ENV ----------
const PORT = process.env.PORT || 3000;

// ForumPay PROD dashboard creds (you had these already)
const FP_BASE = process.env.FORUMPAY_API_BASE || 'https://dashboard.forumpay.com/pay/payInfo.api';
const FP_USER = process.env.FORUMPAY_USER;
const FP_PASS = process.env.FORUMPAY_PASS;

// ForumPay SANDBOX payment API (for /start-payment)
const PAY_BASE = process.env.FORUMPAY_BASE_URL || 'https://sandbox.api.forumpay.com';
const PAY_USER = process.env.FORUMPAY_PAY_USER || process.env.FORUMPAY_USER || '';
const PAY_SECRET = process.env.FORUMPAY_PAY_SECRET || process.env.FORUMPAY_SECRET || '';
const POS_ID = process.env.FORUMPAY_POS_ID || 'savopay-pos-01';
const CALLBACK_URL = process.env.FORUMPAY_CALLBACK_URL || '';
const WEBHOOK_TOKEN = process.env.WEBHOOK_TOKEN || '';

const basicAuthHeader =
  'Basic ' + Buffer.from(`${PAY_USER}:${PAY_SECRET}`).toString('base64');

// ---------- Helpers ----------
function nowIso() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}
async function parseMaybeJson(res) {
  const text = await res.text();
  try { return { kind: 'json', data: JSON.parse(text) }; }
  catch { return { kind: 'html', data: text }; }
}

// Minimal in-memory storage so UI tables/buttons don’t crash
const mem = { payments: [], emails: [] };
const store = {
  async listPayments() {
    return mem.payments
      .slice()
      .sort((a, b) => (a.created_at || '').localeCompare(b.created_at || ''));
  },
  async getPayment(id) {
    return mem.payments.find(p => p.payment_id === id) || null;
  },
  async saveStart(row) {
    const i = mem.payments.findIndex(p => p.payment_id === row.payment_id);
    const created_at = row.created_at || nowIso();
    if (i >= 0) mem.payments[i] = { ...mem.payments[i], ...row, created_at: mem.payments[i].created_at || created_at };
    else mem.payments.push({ ...row, created_at });
  }
};

// ---------- UI endpoints (what the React app calls) ----------

// Health
app.get('/health', (_req, res) => res.json({ ok: true }));

// List recent payments
app.get('/payments', async (_req, res) => {
  const rows = await store.listPayments();
  res.json(rows);
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
    const callback_url = CALLBACK_URL
      ? `${CALLBACK_URL}?token=${encodeURIComponent(WEBHOOK_TOKEN)}`
      : '';

    const params = new URLSearchParams();
    params.set('pos_id', POS_ID);
    params.set('invoice_amount', String(invoice_amount));
    params.set('invoice_currency', String(invoice_currency));
    params.set('currency', String(currency));
    params.set('payer_ip_address', '203.0.113.10');
    params.set('payer_id', String(payer_id || 'walk-in'));
    params.set('order_id', order_id);
    if (callback_url) params.set('callback_url', callback_url);

    // Call ForumPay Sandbox StartPayment
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
    });

    // UI needs at least: payment_id, access_url
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
  res.type('html').send(`<html><body><h1>Receipt ${p.payment_id}</h1><p>Thank you.</p></body></html>`);
});

// (Optional) email receipt stub
app.post('/payments/:payment_id/email', async (_req, res) => {
  return res.status(204).end();
});

// Daily report stubs (so buttons don’t 404)
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

// ---------- Your existing /api/* routes (kept intact) ----------
if (!FP_USER || !FP_PASS) {
  console.warn('⚠️ Missing FORUMPAY_USER or FORUMPAY_PASS in env for /api/* routes');
}
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
    dash_api_base: FP_BASE,
    dash_user_present: !!FP_USER,
    dash_pass_present: !!FP_PASS,
    port: String(PORT),
    allowed_origin_list: allowedOrigins,
  });
  console.log(`SavoPay running at http://localhost:${PORT}`);
});
