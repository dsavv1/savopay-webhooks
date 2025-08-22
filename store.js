// store.js — Postgres persistence for SavoPay
import pkg from 'pg';
const { Pool } = pkg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL_DISABLE ? false : { rejectUnauthorized: false },
});

async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS payments (
      payment_id TEXT PRIMARY KEY,
      order_id TEXT,
      pos_id TEXT,
      address TEXT,
      currency TEXT,
      invoice_amount TEXT,
      invoice_currency TEXT,
      crypto_amount TEXT,
      status TEXT,
      state TEXT,
      confirmed INTEGER,
      confirmed_time TEXT,
      payer_id TEXT,
      customer_email TEXT,
      print_string TEXT,
      created_at TEXT,
      amount_exchange TEXT,
      network_processing_fee TEXT,
      last_transaction_time TEXT,
      invoice_date TEXT
    );
  `);
}
await init();

export const store = {
  async listPayments() {
    const { rows } = await pool.query(
      `SELECT * FROM payments ORDER BY created_at NULLS LAST, payment_id`
    );
    return rows;
  },
  async getPayment(id) {
    const { rows } = await pool.query(
      `SELECT * FROM payments WHERE payment_id = $1 LIMIT 1`, [id]
    );
    return rows[0] || null;
  },
  async saveStart(row) {
    const cols = [
      'payment_id','order_id','pos_id','address','currency','invoice_amount','invoice_currency',
      'crypto_amount','status','state','confirmed','confirmed_time','payer_id','customer_email',
      'print_string','created_at','amount_exchange','network_processing_fee','last_transaction_time','invoice_date'
    ];
    const vals = cols.map(c => row[c] ?? null);
    const params = vals.map((_, i) => `$${i+1}`).join(',');
    await pool.query(
      `INSERT INTO payments (${cols.join(',')}) VALUES (${params})
       ON CONFLICT (payment_id) DO UPDATE SET
         order_id=EXCLUDED.order_id,
         pos_id=EXCLUDED.pos_id,
         address=EXCLUDED.address,
         currency=EXCLUDED.currency,
         invoice_amount=EXCLUDED.invoice_amount,
         invoice_currency=EXCLUDED.invoice_currency,
         crypto_amount=EXCLUDED.crypto_amount,
         status=EXCLUDED.status,
         state=EXCLUDED.state,
         confirmed=EXCLUDED.confirmed,
         confirmed_time=EXCLUDED.confirmed_time,
         payer_id=EXCLUDED.payer_id,
         customer_email=EXCLUDED.customer_email,
         print_string=EXCLUDED.print_string,
         created_at=COALESCE(payments.created_at, EXCLUDED.created_at),
         amount_exchange=EXCLUDED.amount_exchange,
         network_processing_fee=EXCLUDED.network_processing_fee,
         last_transaction_time=EXCLUDED.last_transaction_time,
         invoice_date=EXCLUDED.invoice_date`,
      vals
    );
  },
  async update(payment_id, update) {
    const entries = Object.entries(update).filter(([,v]) => v !== undefined);
    if (!entries.length) return;
    const sets = entries.map(([k], i) => `${k}=$${i+1}`).join(', ');
    const vals = entries.map(([,v]) => v);
    vals.push(payment_id);
    await pool.query(`UPDATE payments SET ${sets} WHERE payment_id = $${vals.length}`, vals);
  },
};
