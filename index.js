// index.js — SavoPay backend (savopay-webhooks)
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import fetch from 'node-fetch';
import path from 'path';
import { fileURLToPath } from 'url';
import { store } from './store.js';
import nodemailer from 'nodemailer';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Base security headers
app.use(
  helmet({
    hsts: { maxAge: 15552000, includeSubDomains: true, preload: false },
    frameguard: { action: 'deny' },
    crossOriginOpenerPolicy: { policy: 'same-origin' },
    crossOriginResourcePolicy: { policy: 'same-site' },
    referrerPolicy: { policy: 'no-referrer' },
  })
);

// Tight CSP for API responses (receipt HTML still works)
app.use(
  helmet.contentSecurityPolicy({
    useDefaults: true,
    directives: {
      "default-src": ["'self'"],
      "img-src": ["'self'", "data:", "https://api.forumpay.com", "https://widget.forumpay.com"],
      "style-src": ["'self'", "'unsafe-inline'"],
      "connect-src": ["'self'", "https://api.savopay.co", "https://widget.forumpay.com"],
      "frame-src": ["'self'", "https://widget.forumpay.com"],
      "script-src": ["'self'"], // API doesn’t serve scripts; keep strict
      "object-src": ["'none'"],
      "base-uri": ["'self'"],
      "form-action": ["'self'"]
    },
  })
);

// CORS
const isProd = (process.env.NODE_ENV || '').toLowerCase() === 'production';
const allowedOrigins = (
  isProd
    ? ['https://pos.savopay.co', process.env.UI_ORIGIN]
    : ['http://localhost:3000', 'http://localhost:3002', 'https://pos.savopay.co', process.env.UI_ORIGIN]
).filter(Boolean);

app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      if (allowedOrigins.includes(origin)) return cb(null, true);
      return cb(null, false);
    },
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    optionsSuccessStatus: 204,
  })
);
app.options(/.*/, cors());

// Rate limit for start-payment
const startPaymentLimiter = rateLimit({
  windowMs: 60_000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
});

// ENV
const PORT = process.env.PORT || 3000;
const FP_BASE = process.env.FORUMPAY_API_BASE || 'https://dashboard.forumpay.com/pay/payInfo.api';
const FP_USER = process.env.FORUMPAY_USER || '';
const FP_PASS = process.env.FORUMPAY_PASS || '';

const PAY_BASE = process.env.FORUMPAY_BASE_URL || 'https://sandbox.api.forumpay.com';
const PAY_USER = process.env.FORUMPAY_PAY_USER || process.env.FORUMPAY_USER || '';
const PAY_SECRET = process.env.FORUMPAY_PAY_SECRET || process.env.FORUMPAY_SECRET || '';
const POS_ID = process.env.FORUMPAY_POS_ID || 'savopay-pos-01';

const CALLBACK_URL = process.env.FORUMPAY_CALLBACK_URL || '';
const WEBHOOK_TOKEN = process.env.WEBHOOK_TOKEN || process.env.FORUMPAY_WEBHOOK_SECRET || '';

const SMTP_HOST = process.env.SMTP_HOST || process.env.EMAIL_HOST || 'smtp.office365.com';
const SMTP_PORT = parseInt(process.env.SMTP_PORT || process.env.EMAIL_PORT || '587', 10);
const SMTP_USER = process.env.SMTP_USER || process.env.EMAIL_USER || '';
const SMTP_PASS = process.env.SMTP_PASS || process.env.EMAIL_PASS || '';
const FROM_EMAIL = process.env.FROM_EMAIL || process.env.EMAIL_FROM || SMTP_USER || 'receipts@savopay.local';
const BRAND_NAME = process.env.BRAND_NAME || 'SavoPay';

const CRON_RECHECK_MS = parseInt(process.env.CRON_RECHECK_MS || '60000', 10);
const PENDING_MIN_AGE_SEC = parseInt(process.env.PENDING_MIN_AGE_SEC || '60', 10);
const DISABLE_AUTO_RECHECK = (process.env.DISABLE_AUTO_RECHECK || '').toLowerCase() === 'true';

const basicAuthHeader = 'Basic ' + Buffer.from(`${PAY_USER}:${PAY_SECRET}`).toString('base64');

// Admin auth
function requireAdmin(req, res, next) {
  try {
    const hdr = req.headers.authorization || '';
    if (!hdr.startsWith('Basic ')) {
      return res.status(401).set('WWW-Authenticate', 'Basic').json({ error: 'auth required' });
    }
    const [user, pass] = Buffer.from(hdr.slice(6), 'base64').toString().split(':');
    if (user === (process.env.ADMIN_USER || '') && pass === (process.env.ADMIN_PASS || '')) return next();
    return res.status(403).json({ error: 'forbidden' });
  } catch {
    return res.status(401).set('WWW-Authenticate', 'Basic').json({ error: 'auth required' });
  }
}

// Helpers
function nowIso() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}
async function parseMaybeJson(res) {
  const text = await res.text();
  try { return { kind: 'json', data: JSON.parse(text) }; }
  catch { return { kind: 'html', data: text }; }
}
function renderReceiptHTML(print_string) {
  let html = print_string || '';
  html = html
    .replace(/<SMALL>/g, "<div style='font-size:12px;'>")
    .replace(/<\/SMALL>/g, '</div>')
    .replace(/<BOLD>/g, '<b>')
    .replace(/<\/BOLD>/g, '</b>')
    .replace(/<BIG>/g, "<span style='font-size:18px'>")
    .replace(/<\/BIG>/g, '</span>')
    .replace(/<CENTER>/g, "<div style='text-align:center'>")
    .replace(/<\/CENTER>/g, '</div>')
    .replace(/<LINE>/g, "<hr style='border:none;border-top:1px dashed #aaa;margin:8px 0'/>")
    .replace(/<DLINE>/g, "<hr style='border:none;border-top:2px solid #222;margin:10px 0'/>")
    .replace(/<CUT>/g, "<hr style='border:none;border-top:2px dashed #222;margin:12px 0'/>")
    .replace(/<QR>.*?<\/QR>/g, '')
    .replace(/<BR>/g, '<br/>');
  return `<!doctype html><html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>Receipt</title><style>
    body{font-family:-apple-system,Segoe UI,Roboto,Inter,Arial;padding:16px;background:#fff}
    .card{max-width:520px;margin:0 auto;border:1px solid #e5e7eb;border-radius:12px;padding:16px;box-shadow:0 1px 2px rgba(0,0,0,.05)}
    .brand{font-weight:700;margin-bottom:4px}
    .meta{color:#6b7280;font-size:12px;margin-bottom:10px}
    @media print{body{padding:0}.card{box-shadow:none;border:none}}
  </style></head><body><div class="card"><div class="brand">${BRAND_NAME} Receipt</div><div class="meta">Printed at ${new Date().toLocaleString()}</div><div>${html}</div></div></body></html>`;
}
function renderPendingReceiptHTML(p) {
  const fiat = p?.invoice_amount ? `${p.invoice_amount} ${p?.invoice_currency || ''}`.trim() : null;
  const crypto = p?.crypto_amount ? `${p.crypto_amount} ${p?.currency || ''}`.trim() : null;
  const address = p?.address || null;
  return `<!doctype html><html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>Pending receipt</title><style>
    body{font-family:-apple-system,Segoe UI,Roboto,Inter,Arial;padding:16px;background:#fff}
    .card{max-width:520px;margin:0 auto;border:1px solid #e5e7eb;border-radius:12px;padding:16px;box-shadow:0 1px 2px rgba(0,0,0,.05)}
    .brand{font-weight:700;margin-bottom:4px}
    .badge{display:inline-block;background:#fde68a;color:#92400e;border-radius:8px;padding:2px 8px;font-size:12px;margin:6px 0}
    .row{margin:6px 0}
    .label{color:#6b7280}
    @media print{body{padding:0}.card{box-shadow:none;border:none}}
  </style></head><body><div class="card">
    <div class="brand">${BRAND_NAME} Receipt</div>
    <div class="badge">Pending — not yet confirmed on-chain</div>
    <div class="row"><span class="label">Payment ID:</span> ${p?.payment_id || '-'}</div>
    ${fiat ? `<div class="row"><span class="label">Fiat amount:</span> ${fiat}</div>` : ''}
    ${crypto ? `<div class="row"><span class="label">Crypto amount:</span> ${crypto}</div>` : ''}
    ${address ? `<div class="row"><span class="label">Address:</span> ${address}</div>` : ''}
    <div class="row"><span class="label">Status:</span> ${p?.state || p?.status || 'created'}</div>
    <p style="margin-top:10px;color:#374151">This is a provisional receipt. You’ll receive a final receipt once the payment is confirmed.</p>
  </div></body></html>`;
}
function makeTransporter() {
  if (!SMTP_HOST || !SMTP_PORT || !SMTP_USER || !SMTP_PASS) throw new Error('SMTP not configured');
  return nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_PORT === 465,
    requireTLS: SMTP_PORT === 587,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
    tls: { minVersion: 'TLSv1.2' },
  });
}
async function sendReceiptEmail({ to, subject, html }) {
  const tx = makeTransporter();
  return tx.sendMail({ from: FROM_EMAIL, to, subject, html });
}
async function checkPaymentOnForumPay({ payment_id, currency, address }) {
  const body = new URLSearchParams();
  body.set('pos_id', POS_ID);
  body.set('payment_id', payment_id);
  body.set('currency', currency);
  body.set('address', address);
  const resp = await fetch(`${PAY_BASE}/pay/v2/CheckPayment/`, {
    method: 'POST',
    headers: { Authorization: basicAuthHeader, 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const text = await resp.text();
  let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }
  console.log(`🔎 CheckPayment ${resp.status}: ${text}`);
  if (!resp.ok) throw new Error(`CheckPayment failed: ${resp.status}`);
  return json;
}
async function ensurePrintString(payment) {
  let print_string = payment?.print_string || '';
  if (!print_string && payment?.address && payment?.currency) {
    try {
      const ck = await checkPaymentOnForumPay({
        payment_id: payment.payment_id,
        currency: payment.currency,
        address: payment.address,
      });
      const update = {
        status: ck.status || ck.state || payment.status,
        state: ck.state || payment.state,
        confirmed: ck.confirmed ? 1 : 0,
        confirmed_time: ck.confirmed_time || payment.confirmed_time,
        crypto_amount: ck.amount || ck.payment || ck.crypto_amount || payment.crypto_amount,
        print_string: ck.print_string || '',
        amount_exchange: ck.amount_exchange || payment.amount_exchange,
        network_processing_fee: ck.network_processing_fee || payment.network_processing_fee,
        last_transaction_time: ck.last_transaction_time || payment.last_transaction_time,
        invoice_date: ck.invoice_date || payment.invoice_date,
        payer_id: ck.payer_id || payment.payer_id,
      };
      await store.update(payment.payment_id, update);
      print_string = update.print_string || '';
    } catch {}
  }
  return print_string;
}
async function buildEmailHtml(payment) {
  const printable = await ensurePrintString(payment);
  return printable ? renderReceiptHTML(printable) : renderPendingReceiptHTML(payment);
}
const fpHeaders = () => ({ Authorization: 'Basic ' + Buffer.from(`${FP_USER}:${FP_PASS}`).toString('base64') });

// UI endpoints
app.get('/health', (_req, res) => res.json({ ok: true }));

app.get('/payments', async (_req, res) => {
  try { res.json(await store.listPayments()); }
  catch (e) { console.error('payments error:', e); res.status(500).json({ error: 'payments failed', detail: e.message }); }
});

app.post('/start-payment', startPaymentLimiter, async (req, res) => {
  try {
    const { invoice_amount='100.00', invoice_currency='USD', currency='USDT', payer_id='walk-in', customer_email='' } = req.body || {};
    const order_id = `SVP-TEST-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    const cb_url = CALLBACK_URL ? `${CALLBACK_URL}?token=${encodeURIComponent(WEBHOOK_TOKEN)}` : '';
    const params = new URLSearchParams();
    params.set('pos_id', POS_ID);
    params.set('invoice_amount', String(invoice_amount));
    params.set('invoice_currency', String(invoice_currency));
    params.set('currency', String(currency));
    params.set('payer_ip_address', '203.0.113.10');
    params.set('payer_id', String(payer_id || 'walk-in'));
    params.set('order_id', order_id);
    if (cb_url) params.set('callback_url', cb_url);
    const resp = await fetch(`${PAY_BASE}/pay/v2/StartPayment/`, {
      method: 'POST',
      headers: { Authorization: basicAuthHeader, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params,
    });
    const text = await resp.text();
    let data; try { data = JSON.parse(text); } catch { data = { raw: text }; }
    console.log(`StartPayment ${resp.status}: ${text}`);
    if (!resp.ok) return res.status(resp.status).json({ error: 'StartPayment failed', detail: data });
    await store.saveStart({
      payment_id: data.payment_id || null,
      order_id, pos_id: POS_ID,
      address: data.address || null,
      currency, invoice_amount, invoice_currency,
      crypto_amount: data.amount || null,
      status: 'Created', state: 'created', confirmed: 0, confirmed_time: null,
      payer_id: String(payer_id || 'walk-in'),
      customer_email: customer_email || null,
      print_string: data.print_string || null,
      created_at: nowIso(),
      amount_exchange: data.amount_exchange || null,
      network_processing_fee: data.network_processing_fee || null,
      last_transaction_time: null, invoice_date: null,
      amount: data.amount || null,
    });
    return res.json(data);
  } catch (e) {
    console.error('start-payment error', e);
    res.status(500).json({ error: 'Internal error', detail: e.message });
  }
});

app.get('/receipt/:payment_id', async (req, res) => {
  const p = await store.getPayment(req.params.payment_id);
  if (!p) return res.status(404).json({ error: 'Not found' });
  const print_string = await ensurePrintString(p);
  res.json({ payment_id: p.payment_id, print_string });
});

app.get('/receipt/:payment_id/print', async (req, res) => {
  const p = await store.getPayment(req.params.payment_id);
  if (!p) return res.status(404).type('text/plain').send('Not found');
  const printable = await ensurePrintString(p);
  res.type('html').send(printable ? renderReceiptHTML(printable) : renderPendingReceiptHTML(p));
});

app.post('/payments/:payment_id/email', async (req, res) => {
  try {
    const { to_email, email } = req.body || {};
    const recipient = to_email || email;
    if (!recipient) return res.status(400).json({ error: 'to_email is required' });
    const p = await store.getPayment(req.params.payment_id);
    if (!p) return res.status(404).json({ error: 'Payment not found' });
    const html = await buildEmailHtml(p);
    const info = await sendReceiptEmail({ to: recipient, subject: `${BRAND_NAME} receipt – ${p.payment_id}`, html });
    res.json({ ok: true, payment_id: p.payment_id, to: recipient, id: info.messageId || null, provisional: !p.confirmed });
  } catch (e) {
    console.error('email error (/payments/:id/email):', e);
    res.status(500).json({ error: 'Failed to send email', detail: String(e) });
  }
});

// Admin reports
app.get('/report/daily', requireAdmin, async (req, res) => {
  const date = req.query.date || new Date().toISOString().slice(0, 10);
  const q = `
    SELECT
      COUNT(*) FILTER (WHERE state = 'confirmed') AS confirmed_count,
      COUNT(*) AS total_count
    FROM payments
    WHERE (created_at AT TIME ZONE 'UTC')::date = $1::date
  `;
  const { rows } = await store._pool.query(q, [date]);
  const rowsList = await store.listPayments();
  res.json({ date, summary: rows[0], rows: rowsList });
});

app.get('/report/daily.csv', requireAdmin, async (req, res) => {
  const date = req.query.date || new Date().toISOString().slice(0, 10);
  const q = `
    SELECT
      COUNT(*) FILTER (WHERE state = 'confirmed') AS confirmed_count,
      COUNT(*) AS total_count
    FROM payments
    WHERE (created_at AT TIME ZONE 'UTC')::date = $1::date
  `;
  const { rows } = await store._pool.query(q, [date]);
  const confirmed = rows[0]?.confirmed_count ?? 0;
  const total = rows[0]?.total_count ?? 0;
  res.type('text/csv').send(`date,confirmed,total\n${date},${confirmed},${total}\n`);
});

// Webhook audit: list recent events
app.get('/admin/webhook-events', requireAdmin, async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || '100', 10), 500);
  const events = await store.listWebhookEvents(limit);
  res.json({ events });
});

// Webhook + logging
app.post('/api/forumpay/callback', async (req, res) => {
  const token = req.query.token || '';
  const body = req.body || {};
  const payment_id = body.payment_id || null;

  if (!WEBHOOK_TOKEN || token !== WEBHOOK_TOKEN) {
    await store.logWebhookEvent({ payment_id, status: 'invalid_token', error: 'Invalid token', payload: body });
    return res.status(403).json({ error: 'Invalid token' });
  }

  if (!body.payment_id || !body.currency || !body.address) {
    await store.logWebhookEvent({ payment_id, status: 'bad_request', error: 'Missing fields', payload: body });
    return res.status(400).json({ error: 'Missing fields', need: ['payment_id', 'currency', 'address'] });
  }

  try {
    const ck = await checkPaymentOnForumPay({
      payment_id: body.payment_id,
      currency: body.currency,
      address: body.address,
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
    await store.update(body.payment_id, update);

    await store.logWebhookEvent({ payment_id, status: 'updated', payload: body, error: null });
    res.json({ ok: true });
  } catch (e) {
    await store.logWebhookEvent({ payment_id, status: 'error', error: String(e), payload: body });
    console.error('callback error', e);
    res.status(500).json({ error: 'Internal error', detail: e.message });
  }
});

// Manual recheck
app.post('/payments/:payment_id/recheck', async (req, res) => {
  try {
    const payment_id = req.params.payment_id;
    const saved = await store.getPayment(payment_id);
    if (!saved) return res.status(404).json({ error: 'Payment not found' });
    const ck = await checkPaymentOnForumPay({ payment_id, currency: saved.currency, address: saved.address });
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

// Optional admin trigger to recheck older pendings (kept)
app.post('/admin/recheck-pending', requireAdmin, async (_req, res) => {
  try {
    const pendings = await store.listPendingOlderThan(PENDING_MIN_AGE_SEC, 25);
    let count = 0;
    for (const p of pendings) {
      try {
        const ck = await checkPaymentOnForumPay({ payment_id: p.payment_id, currency: p.currency, address: p.address });
        await store.update(p.payment_id, {
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
        });
        count++;
      } catch (e) {
        console.error('auto-recheck error', p.payment_id, e.message);
      }
    }
    res.json({ ok: true, checked: count });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// ForumPay info (optional)
app.get('/api/health', async (_req, res) => {
  try {
    const r = await fetch(`${FP_BASE}/GetSubAccounts`, { headers: fpHeaders() });
    const parsed = await parseMaybeJson(r);
    if (r.ok && parsed.kind === 'json') return res.json({ ok: true, status: r.status, data: parsed.data });
    res.status(r.status || 502).json({
      ok: false, status: r.status,
      note: 'Prod Ping is unreliable; this hits GetSubAccounts.',
      preview: parsed.kind === 'html' ? parsed.data.slice(0, 500) : parsed.data,
    });
  } catch (e) { res.status(500).json({ ok: false, error: String(e) }); }
});

app.get('/api/subaccounts', async (_req, res) => {
  try {
    const r = await fetch(`${FP_BASE}/GetSubAccounts`, { headers: fpHeaders() });
    const parsed = await parseMaybeJson(r);
    if (r.ok && parsed.kind === 'json') return res.json(parsed.data);
    res.status(r.status || 502).json({ error: 'GetSubAccounts failed', preview: parsed.kind === 'html' ? parsed.data.slice(0, 500) : parsed.data });
  } catch (e) { res.status(500).json({ error: 'GetSubAccounts error', details: String(e) }); }
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
    res.status(r.status || 502).json({ error: 'GetSubAccount failed', preview: parsed.kind === 'html' ? parsed.data.slice(0, 500) : parsed.data });
  } catch (e) { res.status(500).json({ error: 'GetSubAccount error', details: String(e) }); }
});

// Root
app.get('/', (_req, res) => {
  res.type('text').send('SavoPay API is running. Try /health, /payments, /start-payment or /api/health');
});

app.listen(PORT, () => {
  console.log('ENV CHECK', {
    node_env: process.env.NODE_ENV,
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
    smtp_present: !!(SMTP_HOST && SMTP_PORT && SMTP_USER && SMTP_PASS),
    cron_ms: CRON_RECHECK_MS,
    pending_min_age_sec: PENDING_MIN_AGE_SEC,
    auto_recheck_disabled: DISABLE_AUTO_RECHECK,
  });
  console.log(`SavoPay running at http://localhost:${PORT}`);
});
