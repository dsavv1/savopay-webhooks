// savopay-webhooks/index.js  (CommonJS)

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const crypto = require("crypto");

const app = express();

// ───────────────────────────────────────────────────────────
// CORS (handy for dashboards / tests)
app.use(cors());

// Parsers
// Keep RAW body for any generic /webhook endpoints where you might verify HMAC on raw payloads later
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
// Minimal in-memory store for payment statuses
// NOTE: This resets on redeploy; good for sandbox. Swap with a DB for production.
const payments = new Map();

function savePayment({ payment_id, ...rest }) {
  if (!payment_id) return null;
  const current = payments.get(payment_id) || {};
  const next = { ...current, ...rest, payment_id, updated_at: new Date().toISOString() };
  payments.set(payment_id, next);
  return next;
}

function getPayment(id) {
  return payments.get(id);
}

// Read API so your POS/app can poll YOUR backend instead of ForumPay
app.get("/payments/:id", (req, res) => {
  const data = getPayment(req.params.id);
  if (!data) return res.status(404).json({ err: "unknown payment_id" });
  res.json(data);
});

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
  // ForumPay typically posts fields like: payment_id, status, currency, amount, invoice_currency, invoice_amount, etc.
  const { payment_id, status } = req.body || {};
  const record = savePayment({ payment_id, status, raw: req.body });

  console.log("[FORUMPAY CALLBACK]", new Date().toISOString(), record || req.body);
  // TODO (prod): verify signature if ForumPay provides one, enrich from payInfo.api, persist to DB

  res.sendStatus(200);
});

// ───────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`SavoPay API listening on :${PORT}`));
