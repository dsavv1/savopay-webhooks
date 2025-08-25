// store.js
import pg from 'pg';
const { Pool } = pg;

const connectionString = process.env.DATABASE_URL || '';
const pool = new Pool({
  connectionString,
  ssl: connectionString.includes('sslmode=require') ? { rejectUnauthorized: false } : undefined,
});

async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS payments (
      id BIGSERIAL PRIMARY KEY,
      payment_id TEXT UNIQUE,
      order_id TEXT,
      status TEXT,
      currency TEXT,
      amount TEXT,
      invoice_currency TEXT,
      invoice_amount TEXT,
      raw_json JSONB,
      updated_at TIMESTAMPTZ DEFAULT now(),
      pos_id TEXT,
      address TEXT,
      crypto_amount TEXT,
      state TEXT,
      confirmed INT,
      confirmed_time TEXT,
      payer_id TEXT,
      customer_email TEXT,
      print_string TEXT,
      created_at TIMESTAMPTZ DEFAULT now(),
      amount_exchange TEXT,
      network_processing_fee TEXT,
      last_transaction_time TEXT,
      invoice_date TEXT
    );
  `);

  const addCols = [
    `ALTER TABLE payments ADD COLUMN IF NOT EXISTS raw_json JSONB`,
    `ALTER TABLE payments ADD COLUMN IF NOT EXISTS pos_id TEXT`,
    `ALTER TABLE payments ADD COLUMN IF NOT EXISTS address TEXT`,
    `ALTER TABLE payments ADD COLUMN IF NOT EXISTS crypto_amount TEXT`,
    `ALTER TABLE payments ADD COLUMN IF NOT EXISTS state TEXT`,
    `ALTER TABLE payments ADD COLUMN IF NOT EXISTS confirmed INT`,
    `ALTER TABLE payments ADD COLUMN IF NOT EXISTS confirmed_time TEXT`,
    `ALTER TABLE payments ADD COLUMN IF NOT EXISTS payer_id TEXT`,
    `ALTER TABLE payments ADD COLUMN IF NOT EXISTS customer_email TEXT`,
    `ALTER TABLE payments ADD COLUMN IF NOT EXISTS print_string TEXT`,
    `ALTER TABLE payments ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT now()`,
    `ALTER TABLE payments ADD COLUMN IF NOT EXISTS amount_exchange TEXT`,
    `ALTER TABLE payments ADD COLUMN IF NOT EXISTS network_processing_fee TEXT`,
    `ALTER TABLE payments ADD COLUMN IF NOT EXISTS last_transaction_time TEXT`,
    `ALTER TABLE payments ADD COLUMN IF NOT EXISTS invoice_date TEXT`,
    `ALTER TABLE payments ADD COLUMN IF NOT EXISTS amount TEXT`,
    `ALTER TABLE payments ADD COLUMN IF NOT EXISTS invoice_currency TEXT`,
    `ALTER TABLE payments ADD COLUMN IF NOT EXISTS invoice_amount TEXT`
  ];
  for (const sql of addCols) await pool.query(sql);

  await pool.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'payments_payment_id_unique'
      ) THEN
        ALTER TABLE payments
        ADD CONSTRAINT payments_payment_id_unique UNIQUE (payment_id);
      END IF;
    END $$;
  `);

  await pool.query(`CREATE INDEX IF NOT EXISTS payments_created_at_idx ON payments (created_at DESC)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS payments_state_idx ON payments (state)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS payments_pending_idx ON payments (created_at) WHERE state = 'created'`);
}

function pick(obj, keys) {
  const out = {};
  for (const k of keys) if (obj[k] !== undefined) out[k] = obj[k];
  return out;
}

function buildUpdateSet(obj, start = 1) {
  const keys = Object.keys(obj);
  const sets = [];
  const vals = [];
  let i = start;
  for (const k of keys) {
    sets.push(`${k} = $${i++}`);
    vals.push(obj[k]);
  }
  return { clause: sets.join(', '), values: vals };
}

async function listPayments(limit = 200) {
  const { rows } = await pool.query(
    `SELECT *
     FROM payments
     ORDER BY COALESCE(updated_at, created_at) DESC
     LIMIT $1`,
    [limit]
  );
  return rows;
}

async function getPayment(payment_id) {
  const { rows } = await pool.query(
    `SELECT * FROM payments WHERE payment_id = $1 LIMIT 1`,
    [payment_id]
  );
  return rows[0] || null;
}

async function saveStart(data) {
  const allowed = [
    'payment_id','order_id','pos_id','address','currency',
    'invoice_amount','invoice_currency','crypto_amount',
    'status','state','confirmed','confirmed_time','payer_id',
    'customer_email','print_string','created_at','amount_exchange',
    'network_processing_fee','last_transaction_time','invoice_date','amount'
  ];
  const d = pick(data, allowed);

  const cols = Object.keys(d);
  const vals = Object.values(d);
  const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');

  const updates = cols
    .filter(c => c !== 'payment_id')
    .map((c, i) => `${c} = EXCLUDED.${c}`)
    .join(', ');

  await pool.query(
    `
    INSERT INTO payments (${cols.join(', ')})
    VALUES (${placeholders})
    ON CONFLICT (payment_id) DO UPDATE
      SET ${updates}${updates ? ',' : ''} updated_at = now()
    `,
    vals
  );
}

async function update(payment_id, fields) {
  const allowed = [
    'order_id','pos_id','address','currency','amount',
    'invoice_amount','invoice_currency','crypto_amount',
    'status','state','confirmed','confirmed_time','payer_id',
    'customer_email','print_string','created_at','amount_exchange',
    'network_processing_fee','last_transaction_time','invoice_date','raw_json','updated_at'
  ];
  const d = pick(fields, allowed);
  d.updated_at = new Date().toISOString();

  if (Object.keys(d).length === 0) return;

  const { clause, values } = buildUpdateSet(d, 2);
  await pool.query(
    `UPDATE payments SET ${clause} WHERE payment_id = $1`,
    [payment_id, ...values]
  );
}

async function listPendingOlderThan(minAgeSec = 60, limit = 25) {
  const { rows } = await pool.query(
    `
    SELECT payment_id, currency, address, state, created_at
    FROM payments
    WHERE state = 'created'
      AND (now() - created_at) > make_interval(secs => $1::int)
    ORDER BY created_at DESC
    LIMIT $2
    `,
    [minAgeSec, limit]
  );
  return rows;
}

await init();

export const store = {
  listPayments,
  getPayment,
  saveStart,
  update,
  listPendingOlderThan,
  _pool: pool,
};
