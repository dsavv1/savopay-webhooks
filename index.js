// savopay-webhooks/index.js

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");

const app = express();

// ───────────────────────────────────────────────────────────
// CORS for browser UIs / tests
app.use(cors());

// IMPORTANT: ForumPay posts x-www-form-urlencoded to your callback.
// Parse ONLY on /webhook so we still allow JSON elsewhere.
app.use("/webhook", express.urlencoded({ extended: false }));

// JSON parser for any other endpoints/tools you add
app.use(express.json());

// Health checks
app.get("/", (_req, res) => res.send("SavoPay API is live"));
app.get("/healthz", (_req, res) => res.send("ok"));

// ───────────────────────────────────────────────────────────
// Postgres connection
// Set DATABASE_URL in Render → Environment (use Internal DB URL if possible)
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// Prepare DB (create table if needed)
(async () => {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS payments (
        id SERIAL PRIMARY KEY,
        payment_id TEXT UNIQUE,
        order_id TEXT,
        status TEXT,
        currency TEXT,
        amount TEXT,
        invoice_currency TEXT,
        invoice_amount TEXT,
        raw_json JSONB,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    console.log("✅ Payments table ready");
  } finally {
    client.release();
  }
})();

// ───────────────────────────────────────────────────────────
// ForumPay callback endpoint (target this in StartPayment.callback_url)
app.post("/webhook", async (req, res) => {
  const payload = req.body || {};

  // Log what arrived (helps debug content-type and body shape)
  console.log("[FORUMPAY CALLBACK]", new Date().toISOString(), {
    contentType: req.headers["content-type"],
    body: payload,
  });

  // payment_id + status are the minimum to store
  const payment_id = payload.payment_id || null;
  const status = payload.status || null;

  if (!payment_id) {
    // Accept 200 so FP doesn't retry endlessly, but log the issue
    console.warn("⚠️ webhook missing payment_id, body:", payload);
    return res.status(200).send("OK");
  }

  try {
    const client = await pool.connect();
    await client.query(
      `
      INSERT INTO payments
        (payment_id, order_id, status, currency, amount, invoice_currency, invoice_amount, raw_json, updated_at)
      VALUES
        ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, NOW())
      ON CONFLICT (payment_id)
      DO UPDATE SET
        order_id = EXCLUDED.order_id,
        status = EXCLUDED.status,
        currency = EXCLUDED.currency,
        amount = EXCLUDED.amount,
        invoice_currency = EXCLUDED.invoice_currency,
        invoice_amount = EXCLUDED.invoice_amount,
        raw_json = EXCLUDED.raw_json,
        updated_at = NOW()
      `,
      [
        payment_id,
        payload.order_id || null,
        status,
        payload.currency || null,
        payload.amount || null,
        payload.invoice_currency || null,
        payload.invoice_amount || null,
        JSON.stringify(payload),
      ]
    );
    client.release();
    return res.status(200).send("OK");
  } catch (err) {
    console.error("❌ DB insert error:", err);
    return res.status(500).send("DB error");
  }
});

// ───────────────────────────────────────────────────────────
// Read endpoints your POS/UI can call

// Get by payment_id
app.get("/payments/:payment_id", async (req, res) => {
  const id = req.params.payment_id;
  try {
    const client = await pool.connect();
    const result = await client.query(
      "SELECT * FROM payments WHERE payment_id = $1",
      [id]
    );
    client.release();

    if (result.rows.length === 0) {
      return res.status(404).json({ err: "unknown payment_id" });
    }
    return res.json(result.rows[0]);
  } catch (err) {
    console.error("❌ DB fetch error:", err);
    return res.status(500).json({ err: "Server error" });
  }
});

// Optional: list recent rows to quickly see what's stored
app.get("/debug/payments", async (_req, res) => {
  try {
    const client = await pool.connect();
    const result = await client.query(
      `SELECT payment_id, order_id, status, updated_at
       FROM payments
       ORDER BY updated_at DESC
       LIMIT 50`
    );
    client.release();
    return res.json({ rows: result.rows });
  } catch (err) {
    console.error("❌ DB list error:", err);
    return res.status(500).json({ err: "Server error" });
  }
});

// ───────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`SavoPay API listening on :${PORT}`));
