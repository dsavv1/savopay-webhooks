// routes/metaSupported.js
import express from 'express';
const router = express.Router();

function parseEnv(str) {
  const out = [];
  if (!str) return out;
  for (const part of str.split(',').map(s => s.trim()).filter(Boolean)) {
    const [symbolRaw, netsRaw] = part.split(':');
    const currency = (symbolRaw || '').toUpperCase();
    const networks = (netsRaw || '')
      .split('|')
      .map(s => s.trim().toUpperCase())
      .filter(Boolean);
    if (currency) out.push({ currency, networks });
  }
  return out;
}

const DEFAULT_ASSETS = [
  { currency: 'USDT', networks: ['ERC20', 'TRON'] },
  { currency: 'USDC', networks: ['ERC20'] },
  { currency: 'BTC',  networks: ['BTC'] },
  { currency: 'ETH',  networks: ['ERC20'] },
  { currency: 'MATIC', networks: ['Polygon'] },
  { currency: 'BNB', networks: ['BSC'] },
  { currency: 'XRP', networks: ['XRP'] },
  { currency: 'LTC', networks: ['Litecoin'] },
];

router.get('/supported', (_req, res) => {
  try {
    const envAssets = parseEnv(process.env.SUPPORTED_ASSETS || '');
    const assets = envAssets.length ? envAssets : DEFAULT_ASSETS;
    res.json({ assets });
  } catch (e) {
    console.error('GET /meta/supported error:', e);
    res.status(200).json({ assets: DEFAULT_ASSETS });
  }
});

export default router;
