require('dotenv').config();
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const { Pool } = require('pg');

const app = express();
app.use(cors());
app.use(express.json());

// --- Postgres setup ---
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Create table if not exists
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

// --- Health check ---
app.get('/', (_req, res) => res.send('SavoPay API is live'));

// --- Webhook handler ---
app.post('/webhook', async (req, res) => {
  const payload = req.body;
  console.log("[FORUMPAY CALLBACK]", new Date().toISOString(), payload);

  try {
    const client = await pool.connect();
    await client.query(
      `
        INSERT INTO payments (payment_id, order_id, status, currency, amount, invoice_currency, invoice_amount, raw_json)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
        ON CONFLICT (payment_id)
        DO UPDATE SET status = EXCLUDED.status, updated_at = NOW()
      `,
      [
        payload.payment_id,
        payload.order_id || null,
        payload.status,
        payload.currency || null,
        payload.amount || null,
        payload.invoice_currency || null,
        payload.invoice_amount || null,
        JSON.stringify(payload)
      ]
    );
    client.release();
    res.status(200).send('OK');
  } catch (err) {
    console.error("❌ DB insert error:", err);
    res.status(500).send('DB error');
  }
});

// --- Lookup endpoint ---
app.get('/payments/:payment_id', async (req, res) => {
  try {
    const client = await pool.connect();
    const result = await client.query(
      'SELECT * FROM payments WHERE payment_id = $1',
      [req.params.payment_id]
    );
    client.release();

    if (result.rows.length === 0) {
      return res.status(404).json({ err: "unknown payment_id" });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error("❌ DB fetch error:", err);
    res.status(500).send('DB error');
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`SavoPay API listening on :${PORT}`));
