import express from "express";

const router = express.Router();

// GET /meta/supported
router.get("/meta/supported", (req, res) => {
  res.json({
    fiat: ["USD", "GBP", "EUR", "NGN"],
    crypto: [
      { currency: "USDT", networks: ["TRON", "ETH", "BSC"] },
      { currency: "USDC", networks: ["ETH", "BSC"] },
      { currency: "BTC", networks: ["BTC"] },
      { currency: "ETH", networks: ["ETH"] }
    ]
  });
});

export default router;
