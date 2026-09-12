import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import crypto from "crypto";

const app = express();

app.use(express.json());

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CBPAY_API_KEY = process.env.CBPAY_API_KEY;

const CBPAY_BASE_URL =
  process.env.CBPAY_BASE_URL ||
  "https://api.qbank.cl/platform";

const PORT = process.env.PORT || 3000;

if (!CBPAY_API_KEY) {
  console.warn("WARNING: CBPAY_API_KEY is not set.");
}

/* =========================
   CREATE CHECKOUT
========================= */

app.post("/api/create-checkout", async (req, res) => {
  try {
    const {
      amount,
      description = "Payment",
    } = req.body || {};

    const parsed = Number(amount);

    if (!Number.isFinite(parsed) || parsed <= 0) {
      return res.status(400).json({
        error: "Invalid amount",
      });
    }

    const idempotencyKey =
      `web-${Date.now()}-${crypto.randomUUID()}`;

    const payload = {
      method: "checkout",
      amount: parsed.toFixed(2),
      settlement_asset: "USDT",
      description,
      country: "US",
      expires_in: 86400,
      idempotency_key: idempotencyKey,
    };

    const r = await fetch(
      `${CBPAY_BASE_URL}/v1/payins`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${CBPAY_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      }
    );

    const raw = await r.text();

    let data;

    try {
      data = JSON.parse(raw);
    } catch {
      data = { raw };
    }

    if (!r.ok) {
      return res.status(r.status).json({
            return res.status(r.status).json({
      error: "CBPay rejected the request",
      details: data,
    });
  }

  const checkoutUrl =
    data.checkout_url ||
    data.payment_url ||
    data.url ||
    data?.data?.checkout_url ||
    data?.data?.payment_url ||
    data?.data?.url;

  if (!checkoutUrl) {
    return res.status(502).json({
      error: "CBPay did not return checkout URL",
      details: data,
    });
  }

  return res.json({
    checkout_url: checkoutUrl,
    cbpay: data,
  });

} catch (err) {
  console.error("Checkout error:", err);

  return res.status(500).json({
    error: err.message || "Server error",
  });
}
});

/* =========================
   HEALTH CHECK
========================= */

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    cbpay_api: Boolean(CBPAY_API_KEY),
  });
});

/* =========================
   STATIC WEBSITE
========================= */

app.use(
  express.static(
    path.join(__dirname, "public")
  )
);

/* =========================
   START SERVER
========================= */

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
