// savopay-webhooks/index.js  (CommonJS)

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const crypto = require("crypto");

const app = express();

// ───────────────────────────────────────────────────────────
// Parsers
// Keep raw body for any generic /webhook endpoints (if you later verify HMAC on raw payloads)
app.use("/webhook", express.raw({ type: "*/*" }));

// ForumPay sends x-www-form-urlencoded to your callback_url
app.use("/forumpay/callback", express.urlencoded({ extended: false }));

// Allow cross-origin (handy for quick tests / dashboards)
app.use(cors());

// ───────────────────────────────────────────────────────────
// Health checks (Render will hit /healthz)
app.get("/", (_req, res) => res.send("SavoPay API is live"));
app.get("/healthz", (_req, res) => res.send("ok"));

// ───────────────────────────────────────────────────────────
// Optional signature verification for raw /webhook endpoints
function verifySignature(req) {
  const secret = process.env.FORUMPAY_WEBHOOK_SECRET || "";
  if (!secret) return true; // skip until you have a secret
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
    // TODO: update DB, etc.
    res.sendStatus(200);
  };
}

// Generic raw webhooks you already had (safe to keep)
app.post("/webhook/payments", handleWebhook("payments"));
app.post("/webhook/subscriptions", handleWebhook("subscriptions"));
app.post("/webhook", handleWebhook("generic"));

// ───────────────────────────────────────────────────────────
// ForumPay callback (form-encoded) — THIS is what you set as callback_url
app.post("/forumpay/callback", (req, res) => {
  // Example fields you might see (names can vary by provider):
  // payment_id, status, amount, currency, invoice_amount, invoice_currency, etc.
  console.log("[FORUMPAY CALLBACK]", new Date().toISOString(), req.body);

  // TODO: look up the order by req.body.payment_id and mark paid/confirmed accordingly
  res.sendStatus(200);
});

// ───────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`SavoPay API listening on :${PORT}`));
