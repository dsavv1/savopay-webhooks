// routes/metaSupported.js
const express = require("express");
const router = express.Router();

// Parse env like: USDT:ERC20|TRON,BTC:BTC,ETH:ERC20
function parseEnv(str) {
  const out = [];
  if (!str) return out;
  for (const part of str.split(",").map(s => s.trim()).filter(Boolean)) {
    const [symbolRaw, netsRaw] = part.split(":");
    const symbol = (symbolRaw || "").toUpperCase();
    const networks = (netsRaw || "")
      .split("|")
      .map(s => s.trim().toUpperCase())
      .filter(Boolean);
    if (symbol) out.push({ currency: symbol, networks });
  }
  return out;
}

const DEFAULT_ASSETS = [
  { currency: "USDT", networks: ["ERC20", "TRON"] },
  { currency: "USDC", networks: ["ERC20"] },
  { currency: "BTC",  networks: ["BTC"] },
  { currency: "ETH",  networks: ["ERC20"] },
];

router.get("/supported", async (_req, res) => {
  try {
    const envAssets = parseEnv(process.env.SUPPORTED_ASSETS || "");
    const assets = envAssets.length ? envAssets : DEFAULT_ASSETS;
    res.json({ assets });
  } catch (e) {
    console.error("GET /meta/supported error:", e);
    res.status(200).json({ assets: DEFAULT_ASSETS });
  }
});

module.exports = router;
