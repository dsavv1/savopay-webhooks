// store.js — Postgres access layer
import pg from 'pg';

const { Pool } = pg;

function buildPool() {
  const cs = process.env.DATABASE_URL;
  if (!cs) throw new Error('DATABASE_URL is not set');
  const ssl =
    /sslmode=require/.test(cs) || (process.env.PGSSLMODE || '').toLowerCase() === 'require'
      ? { rejectUnauthorized: false }
      : false;
  return new Pool({ connectionString: cs, ssl });
}

class Store {
  constructor() {
    this._pool = buildPool();
    this._ready = this.ensureTables();
  }

  async ensureTables() {
    const q1 = `
      CREATE TABLE IF NOT EXISTS payments (
        id                   SERIAL PRIMARY KEY,
        payment_id           TEXT UNIQUE,
        order_id             TEXT,
        status               TEXT,
        currency             TEXT,
        amount               TEXT,
        invoice_currency     TEXT,
        invoice_amount       TEXT,
        raw_json             JSONB,
        updated_at           TIMESTAMPTZ DEFAULT now(),
        pos_id               TEXT,
        address              TEXT,
        crypto_amount        TEXT,
        state                TEXT,
        confirmed            INT,
        confirmed_time       TEXT,
        payer_id             TEXT,
        customer_email       TEXT,
        print_string         TEXT,
        created_at           TIMESTAMPTZ DEFAULT now(),
        amount_exchange      TEXT,
        network_processing_fee TEXT,
        last_transaction_time TEXT,
        invoice_date         TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_payments_created_at_desc ON payments (created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_payments_state ON payments (state);
      CREATE UNIQUE INDEX IF NOT EXISTS uniq_payments_payment_id ON payments (payment_id);
    `;
    const q2 = `
      CREATE TABLE IF NOT EXISTS webhook_events (
        id           BIGSERIAL PRIMARY KEY,
        payment_id   TEXT,
        status       TEXT,                 -- received | invalid_token | bad_request | updated | error
        error        TEXT,
        payload      JSONB,
        received_at  TIMESTAMPTZ DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_webhook_events_received_at ON webhook_events (received_at DESC);
      CREATE INDEX IF NOT EXISTS idx_webhook_events_payment_id ON webhook_events (payment_id);
      CREATE INDEX IF NOT EXISTS idx_webhook_events_status ON webhook_events (status);
    `;
    const c = await this._pool.connect();
    try {
      await c.query(q1);
      await c.query(q2);
    } finally {
      c.release();
    }
  }

  async listPayments(limit = 200) {
    await this._ready;
    const { rows } = await this._pool.query(
      `SELECT * FROM payments ORDER BY created_at DESC LIMIT $1`,
      [Math.min(limit, 1000)]
    );
    return rows;
  }

  async getPayment(payment_id) {
    await this._ready;
    const { rows } = await this._pool.query(
      `SELECT * FROM payments WHERE payment_id = $1 LIMIT 1`,
      [payment_id]
    );
    return rows[0] || null;
  }

  async saveStart(p) {
    await this._ready;
    const fields = [
      'payment_id','order_id','pos_id','address','currency',
      'invoice_amount','invoice_currency','crypto_amount','status','state',
      'confirmed','confirmed_time','payer_id','customer_email','print_string',
      'created_at','amount_exchange','network_processing_fee','last_transaction_time',
      'invoice_date','amount'
    ];
    const vals = fields.map((k, i) => `$${i + 1}`);
    const params = fields.map(k => p[k] ?? null);
    const sql = `
      INSERT INTO payments (${fields.join(',')})
      VALUES (${vals.join(',')})
      ON CONFLICT (payment_id) DO UPDATE SET
        order_id = EXCLUDED.order_id,
        pos_id = EXCLUDED.pos_id,
        address = EXCLUDED.address,
        currency = EXCLUDED.currency,
        invoice_amount = EXCLUDED.invoice_amount,
        invoice_currency = EXCLUDED.invoice_currency,
        crypto_amount = EXCLUDED.crypto_amount,
        status = EXCLUDED.status,
        state = EXCLUDED.state,
        confirmed = EXCLUDED.confirmed,
        confirmed_time = EXCLUDED.confirmed_time,
        payer_id = EXCLUDED.payer_id,
        customer_email = EXCLUDED.customer_email,
        print_string = COALESCE(EXCLUDED.print_string, payments.print_string),
        amount_exchange = COALESCE(EXCLUDED.amount_exchange, payments.amount_exchange),
        network_processing_fee = COALESCE(EXCLUDED.network_processing_fee, payments.network_processing_fee),
        last_transaction_time = COALESCE(EXCLUDED.last_transaction_time, payments.last_transaction_time),
        invoice_date = COALESCE(EXCLUDED.invoice_date, payments.invoice_date),
        amount = COALESCE(EXCLUDED.amount, payments.amount),
        updated_at = now()
    `;
    await this._pool.query(sql, params);
  }

  async update(payment_id, update) {
    await this._ready;
    const keys = Object.keys(update);
    if (keys.length === 0) return;
    const sets = keys.map((k, i) => `${k} = $${i + 1}`);
    const params = keys.map(k => update[k]);
    params.push(payment_id);
    await this._pool.query(
      `UPDATE payments SET ${sets.join(', ')}, updated_at = now() WHERE payment_id = $${params.length}`,
      params
    );
  }

  async listPendingOlderThan(minAgeSeconds = 60, limit = 50) {
    await this._ready;
    const { rows } = await this._pool.query(
      `SELECT * FROM payments
       WHERE (state IS NULL OR state = 'created')
         AND now() - created_at > ($1 || ' seconds')::interval
       ORDER BY created_at ASC
       LIMIT $2`,
      [minAgeSeconds, Math.min(limit, 200)]
    );
    return rows;
  }

  async logWebhookEvent({ payment_id = null, status = 'received', error = null, payload = null }) {
    await this._ready;
    await this._pool.query(
      `INSERT INTO webhook_events (payment_id, status, error, payload) VALUES ($1,$2,$3,$4)`,
      [payment_id, status, error, payload]
    );
  }

  async listWebhookEvents(limit = 100) {
    await this._ready;
    const { rows } = await this._pool.query(
      `SELECT id, payment_id, status, error, payload, received_at
       FROM webhook_events
       ORDER BY received_at DESC
       LIMIT $1`,
      [Math.min(limit, 500)]
    );
    return rows;
  }
}

export const store = new Store();
