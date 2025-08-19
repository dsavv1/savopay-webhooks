// savopay-webhooks/index.js  (CommonJS)

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const Database = require("better-sqlite3");

const app = express();

// ───────────────────────────────────────────────────────────
// CORS (handy for dashboards / tests)
app.use(cors());

// Parsers
// RAW body for any generic /webhook endpoints where you might verify HMAC on raw payloads later
app.use("/webhook", express.raw({ type: "*/*" }));

// ForumPay sends x-www-form-urlencoded to your callback_url
app.use("/forumpay/callback", express.urlencoded({ extended: false }));

// Optional JSON parser for any future JSON endpoints
app.use(express.json());

// ───────────────────────────────────────────────────────────
// Health checks (Render probes this)
app.get("/", (_req, res) => res.send("SavoPay API is live"));
app.get("/healthz", (_req, res) => res.send("ok"));

// ───────────────────────────────────────────────────────────
// SQLite persistence (use Render's writable temp dir)
const db = new Database("/tmp/payments.db");

// Create table once
db.exec(`
  CREATE TABLE IF NOT EXISTS payments (
    payment_id TEXT PRIMARY KEY,
    order_id TEXT,
    status TEXT,
    currency TEXT,
    amount TEXT,
    invoice_currency TEXT,
    invoice_amount TEXT,
    raw_json TEXT,
    updated_at TEXT
  );
`);

// Prepared statements
const upsertStmt = db.prepare(`
  INSERT INTO payments (payment_id, order_id, status, currency, amount, invoice_currency, invoice_amount, raw_json, updated_at)
  VALUES (@payment_id, @order_id, @status, @currency, @amount, @invoice_currency, @invoice_amount, @raw_json, @updated_at)
  ON CONFLICT(payment_id) DO UPDATE SET
    order_id=excluded.order_id,
    status=excluded.status,
    currency=excluded.currency,
    amount=excluded.amount,
    invoice_currency=excluded.invoice_currency,
    invoice_amount=excluded.invoice_amount,
    raw_json=excluded.raw_json,
    updated_at=excluded.updated_at
`);

const getByPaymentId = db.prepare(`SELECT * FROM payments WHERE payment_id = ?`);
const getByOrderId   = db.prepare(`SELECT * FROM payments WHERE order_id = ?`);
const listRecent     = db.prepare(`
  SELECT payment_id, order_id, status, updated_at
  FROM payments
  ORDER BY updated_at DESC
  LIMIT 50
`);

// Helpers
function savePayment(row) {
  const now = new Date().toISOString();
  const record = {
    payment_id: row.payment_id || null,
    order_id: row.order_id || null,
    status: row.status || null,
    currency: row.currency || null,
    amount: row.amount || null,
    invoice_currency: row.invoice_currency || null,
    invoice_amount: row.invoice_amount || null,
    raw_json: JSON.stringify(row || {}),
    updated_at: now
  };
  if (!record.payment_id) return null;
  upsertStmt.run(record);
  return record;
}

// ───────────────────────────────────────────────────────────
// Optional signature verification for raw /webhook endpoints (not used by /forumpay/callback)
function verifySignature(req) {
  const secret = process.env.FORUMPAY_WEBHOOK_SECRET || "";
  if (!secret) return true; // skip until you configure a secret
  const sig = req.header("x-forumpay-signature") || "";
  try {
    const digest = crypto.createHmac("sha256", secret).update(req.body).digest("hex");
    return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(digest));
  } catch {
    return false;
  }
}

function handleWebhook(kind) {
  return (req, res) => {
    const ok = verifySignature(req);
    if (!ok) console.warn(`[WEBHOOK:${kind}] signature check failed (secret set?)`);

    // Try JSON; if not JSON, log raw
    let payload;
    try {
      payload = JSON.parse(req.body?.toString("utf8") || "{}");
    } catch {
      payload = { raw: req.body?.toString("utf8") || "" };
    }

    console.log(`[WEBHOOK:${kind}]`, new Date().toISOString(), payload);
    res.sendStatus(200);
  };
}

// Keep your generic raw webhooks (if you need them later)
app.post("/webhook/payments", handleWebhook("payments"));
app.post("/webhook/subscriptions", handleWebhook("subscriptions"));
app.post("/webhook", handleWebhook("generic"));

// ───────────────────────────────────────────────────────────
// ForumPay callback (form-encoded) — set this as StartPayment callback_url
app.post("/forumpay/callback", (req, res) => {
  // ForumPay typically posts fields like: payment_id, status, currency, amount, invoice_currency, invoice_amount, order_id, etc.
  const {
    payment_id,
    status,
    currency,
    amount,
    invoice_currency,
    invoice_amount,
    order_id
  } = req.body || {};

  const record = savePayment({
    payment_id,
    status,
    currency,
    amount,
    invoice_currency,
    invoice_amount,
    order_id,
    ...req.body // keep anything else they send
  });

  console.log("[FORUMPAY CALLBACK]", new Date().toISOString(), record || req.body);
  res.sendStatus(200);
});

// ───────────────────────────────────────────────────────────
// Read endpoints for your POS/app
app.get("/payments/:id", (req, res) => {
  const data = getByPaymentId.get(req.params.id);
  if (!data) return res.status(404).json({ err: "unknown payment_id" });
  res.json({ ...data, raw: JSON.parse(data.raw_json || "{}") });
});

app.get("/orders/:order_id", (req, res) => {
  const data = getByOrderId.get(req.params.order_id);
  if (!data) return res.status(404).json({ err: "unknown order_id" });
  res.json({ ...data, raw: JSON.parse(data.raw_json || "{}") });
});

// Debug: list most recent rows (helps verify writes/reads on the same instance)
app.get("/debug/payments", (_req, res) => {
  res.json({ rows: listRecent.all() });
});

// ───────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`SavoPay API listening on :${PORT}`));
