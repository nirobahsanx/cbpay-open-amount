import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import crypto from "crypto";

const app = express();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 3000;

/* =========================
   ENVIRONMENT VARIABLES
========================= */

const CBPAY_API_KEY = process.env.CBPAY_API_KEY;

const CBPAY_BASE_URL =
  process.env.CBPAY_API_BASE ||
  process.env.CBPAY_BASE_URL ||
  "https://api.qbank.cl/platform";

const CBPAY_WEBHOOK_SECRET =
  process.env.CBPAY_WEBHOOK_SECRET;

const TRON_DESTINATION_ADDRESS =
  process.env.TRON_DESTINATION_ADDRESS;

const CBPAY_BENEFICIARY_NAME =
  process.env.CBPAY_BENEFICIARY_NAME;


/* =========================
   JSON + RAW WEBHOOK BODY
========================= */

app.use(
  express.json({
    verify: (req, res, buf) => {
      req.rawBody = Buffer.from(buf);
    },
  })
);


/* =========================
   CBPAY API HELPER
========================= */

async function cbpayRequest(endpoint, options = {}) {
  if (!CBPAY_API_KEY) {
    throw new Error("CBPAY_API_KEY is missing");
  }

  const response = await fetch(
    `${CBPAY_BASE_URL}${endpoint}`,
    {
      ...options,
      headers: {
        Authorization: `Bearer ${CBPAY_API_KEY}`,
        "Content-Type": "application/json",
        ...(options.headers || {}),
      },
    }
  );

  const text = await response.text();

  let data;

  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }

  if (!response.ok) {
    const error = new Error(
      `CBPay API error ${response.status}`
    );

    error.status = response.status;
    error.data = data;

    throw error;
  }

  return data;
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

    const parsedAmount = Number(amount);

    if (
      !Number.isFinite(parsedAmount) ||
      parsedAmount <= 0
    ) {
      return res.status(400).json({
        error: "Invalid amount",
      });
    }

    const idempotencyKey =
      `web-${Date.now()}-${crypto.randomUUID()}`;

    const payload = {
      method: "checkout",

      amount: parsedAmount.toFixed(2),

      settlement_asset: "USDT",

      description,

      

      expires_in: 86400,

      idempotency_key: idempotencyKey,
    };

    const data = await cbpayRequest(
      "/v1/payins",
      {
        method: "POST",
        body: JSON.stringify(payload),
      }
    );

    const checkoutUrl =
      data.checkout_url ||
      data.payment_url ||
      data.url ||
      data?.data?.checkout_url ||
      data?.data?.payment_url ||
      data?.data?.url;

    if (!checkoutUrl) {
      console.error(
        "CBPay returned no checkout URL:",
        data
      );

      return res.status(502).json({
        error: "CBPay did not return checkout URL",
      });
    }

    return res.json({
      checkout_url: checkoutUrl,
      cbpay: data,
    });

  } catch (error) {
    console.error(
      "Checkout error:",
      error.data || error.message
    );

    return res
      .status(error.status || 500)
      .json({
        error: "CBPay checkout failed",
        details: error.data || error.message,
      });
  }
});


/* =========================
   VERIFY CBPAY WEBHOOK
========================= */

function verifyWebhook(req) {
  if (!CBPAY_WEBHOOK_SECRET) {
    console.error(
      "CBPAY_WEBHOOK_SECRET missing"
    );

    return false;
  }

  const timestamp =
    req.headers["x-webhook-timestamp"];

  const signature =
    req.headers["x-webhook-signature"];

  if (
    !timestamp ||
    !signature ||
    !req.rawBody
  ) {
    return false;
  }

  const webhookTimestamp =
    Number(timestamp);

  const now =
    Math.floor(Date.now() / 1000);

  if (
    !Number.isFinite(webhookTimestamp) ||
    Math.abs(now - webhookTimestamp) > 300
  ) {
    console.error(
      "Webhook timestamp rejected"
    );

    return false;
  }

  const expectedSignature =
    crypto
      .createHmac(
        "sha256",
        CBPAY_WEBHOOK_SECRET
      )
      .update(
        Buffer.concat([
          Buffer.from(
            `${timestamp}.`,
            "utf8"
          ),
          req.rawBody,
        ])
      )
      .digest("hex");

  try {
    const received =
      Buffer.from(
        String(signature),
        "utf8"
      );

    const expected =
      Buffer.from(
        expectedSignature,
        "utf8"
      );

    if (
      received.length !== expected.length
    ) {
      return false;
    }

    return crypto.timingSafeEqual(
      received,
      expected
    );

  } catch (error) {
    console.error(
      "Signature verification error:",
      error.message
    );

    return false;
  }
}


/* =========================
   GET USDT BALANCE
========================= */

async function getUSDTBalance() {
  const data =
    await cbpayRequest(
      "/v1/balances",
      {
        method: "GET",
      }
    );

  const balances =
    data.balances || [];

  const usdt =
    balances.find(
      (item) =>
        item.asset === "USDT"
    );

  if (!usdt) {
    return {
      available: 0,
      held: 0,
    };
  }

  return {
    available:
      Number(usdt.available || 0),

    held:
      Number(usdt.held || 0),
  };
}


/* =========================
   AUTOMATIC TRON WITHDRAWAL
========================= */

async function processPayin(payinId) {
  try {
    if (!payinId) {
      console.log(
        "Webhook has no payin_id"
      );

      return;
    }

    if (!TRON_DESTINATION_ADDRESS) {
      console.error(
        "TRON_DESTINATION_ADDRESS missing"
      );

      return;
    }

    /*
     * Always fetch latest payin state
     * instead of trusting webhook body.
     */

    const payin =
      await cbpayRequest(
        `/v1/payins/${encodeURIComponent(
          payinId
        )}`,
        {
          method: "GET",
        }
      );

    console.log(
      "Latest payin state:",
      {
        payin_id: payinId,
        status: payin.status,
        settlement_pending:
          payin.settlement_pending,
        settle_at:
          payin.settle_at,
        settled_at:
          payin.settled_at,
        usdt_net:
          payin.usdt_net,
        usdt_credited:
          payin.usdt_credited,
      }
    );


    /*
     * DO NOT withdraw while
     * settlement is pending.
     */

    if (
      payin.settlement_pending === true
    ) {
      console.log(
        `Payin ${payinId}: settlement pending`
      );

      return;
    }


    if (
      payin.settle_at &&
      !payin.settled_at
    ) {
      console.log(
        `Payin ${payinId}: waiting for settlement`
      );

      return;
    }


    /*
     * Only process credited payins.
     */

    if (
      payin.status &&
      payin.status !== "credited"
    ) {
      console.log(
        `Payin ${payinId}: status ${payin.status}`
      );

      return;
    }


    /*
     * Amount actually credited
     * from this payment.
     */

    const creditedRaw =
      payin.usdt_net ||
      payin.usdt_credited;

    const creditedAmount =
      Number(creditedRaw);

    if (
      !Number.isFinite(
        creditedAmount
      ) ||
      creditedAmount <= 0
    ) {
      console.log(
        `Payin ${payinId}: no credited USDT`
      );

      return;
    }


    /*
     * Check current CBPay
     * available USDT balance.
     */

    const balance =
      await getUSDTBalance();

    console.log(
      "Current USDT balance:",
      balance
    );

    if (
      !Number.isFinite(
        balance.available
      ) ||
      balance.available <= 0
    ) {
      console.log(
        "No available USDT balance"
      );

      return;
    }


    /*
     * Never request more than
     * current available balance.
     *
     * IMPORTANT:
     * CBPay debits:
     *
     * withdrawal amount + fee
     *
     * Therefore requesting the
     * entire available balance may
     * fail if a withdrawal fee exists.
     *
     * Keep a small fee reserve.
     */

    const FEE_RESERVE_USDT =
      Number(
        process.env
          .CBPAY_WITHDRAWAL_FEE_RESERVE ||
        "2"
      );


    const maximumWithdrawable =
      Math.max(
        0,
        balance.available -
          FEE_RESERVE_USDT
      );


    const withdrawalAmount =
      Math.min(
        creditedAmount,
        maximumWithdrawable
      );


    if (
      !Number.isFinite(
        withdrawalAmount
      ) ||
      withdrawalAmount <= 0
    ) {
      console.log(
        `Payin ${payinId}: insufficient balance after fee reserve`
      );

      return;
    }


    /*
     * Create withdrawal payload.
     */

    const withdrawalPayload = {
      chain: "tron",

      asset: "USDT",

      to_address:
        TRON_DESTINATION_ADDRESS,

      amount:
        withdrawalAmount.toFixed(6),

      idempotency_key:
        `auto-wd-${payinId}`,

      save_contact: false,
    };


    /*
     * Travel Rule.
     *
     * CBPay documentation indicates
     * withdrawals from $1,000 require
     * beneficiary information.
     */

    if (
      withdrawalAmount >= 1000
    ) {
      if (
        !CBPAY_BENEFICIARY_NAME
      ) {
        console.error(
          `Payin ${payinId}: beneficiary name required for withdrawal >= 1000 USDT`
        );

        return;
      }

      withdrawalPayload.wallet_type =
        "self_hosted";

      withdrawalPayload.beneficiary_name =
        CBPAY_BENEFICIARY_NAME;
    }


    console.log(
      "Creating automatic TRON withdrawal:",
      {
        payin_id: payinId,

        credited:
          creditedAmount.toFixed(6),

        available:
          balance.available.toFixed(6),

        fee_reserve:
          FEE_RESERVE_USDT.toFixed(6),

        withdrawing:
          withdrawalAmount.toFixed(6),
      }
    );


    const withdrawal =
      await cbpayRequest(
        "/v1/crypto/withdrawals",
        {
          method: "POST",

          body: JSON.stringify(
            withdrawalPayload
          ),
        }
      );


    console.log(
      "AUTO WITHDRAWAL CREATED:",
      {
        payin_id:
          payinId,

        withdrawal_id:
          withdrawal.withdrawal_id,

        amount:
          withdrawal.amount,

        fee:
          withdrawal.fee,

        total_debit:
          withdrawal.total_debit,

        status:
          withdrawal.status,

        status_code:
          withdrawal.status_code,

        status_message:
          withdrawal.status_message,

        tx_id:
          withdrawal.tx_id,

        idempotency_hit:
          withdrawal.idempotency_hit,
      }
    );

  } catch (error) {
    console.error(
      `Automatic withdrawal failed for ${payinId}:`,
      error.data ||
        error.message
    );
  }
}


/* =========================
   CBPAY WEBHOOK
========================= */

app.post(
  "/webhooks/cbpay",
  (req, res) => {

    if (!verifyWebhook(req)) {
      console.error(
        "Invalid CBPay webhook signature"
      );

      return res
        .status(401)
        .json({
          error:
            "Invalid webhook signature",
        });
    }


    const eventType =
      req.headers[
        "x-webhook-event"
      ];

    const eventId =
      req.headers[
        "x-webhook-event-id"
      ];

    const deliveryId =
      req.headers[
        "x-webhook-delivery-id"
      ];


    console.log(
      "CBPay webhook received:",
      {
        eventType,
        eventId,
        deliveryId,
      }
    );


    /*
     * Respond immediately so CBPay
     * knows webhook was received.
     */

    res.status(200).json({
      received: true,
    });


    /*
     * Automatically withdraw
     * credited payin.
     */

    if (
      eventType ===
      "payin_credited"
    ) {
      const payinId =
        req.body?.payin_id;

      processPayin(
        payinId
      ).catch(
        (error) => {
          console.error(
            "Payin processing error:",
            error
          );
        }
      );
    }


    /*
     * Log final withdrawal status.
     */

    if (
      eventType ===
      "crypto_withdrawal_status_changed"
    ) {
      console.log(
        "Withdrawal status changed:",
        req.body
      );
    }
  }
);

app.get("/api/cbpay-account-check", async (req, res) => {
  try {
    const data = await cbpayRequest("/v1/me", {
      method: "GET",
    });

    res.json({
      id: data.id,
      org_id: data.org_id,
      type: data.type,
      status: data.status,
      kyc_status: data.kyc_status,
      country: data.country,
    });

  } catch (error) {
    res.status(error.status || 500).json({
      error: error.data || error.message,
    });
  }
});
/* =========================
   HEALTH CHECK
========================= */

app.get(
  "/health",
  (req, res) => {

    res.json({
      ok: true,

      cbpay_api:
        Boolean(
          CBPAY_API_KEY
        ),

      webhook_secret:
        Boolean(
          CBPAY_WEBHOOK_SECRET
        ),

      tron_destination:
        Boolean(
          TRON_DESTINATION_ADDRESS
        ),

      beneficiary_name:
        Boolean(
          CBPAY_BENEFICIARY_NAME
        ),

      auto_withdraw_ready:
        Boolean(
          CBPAY_API_KEY &&
          CBPAY_WEBHOOK_SECRET &&
          TRON_DESTINATION_ADDRESS
        ),
    });
  }
);


/* =========================
   STATIC WEBSITE
========================= */

app.use(
  express.static(
    path.join(
      __dirname,
      "public"
    )
  )
);


/* =========================
   START SERVER
========================= */

app.listen(
  PORT,
  () => {

    console.log(
      `Server running on port ${PORT}`
    );

    console.log(
      "CBPay auto-withdraw:",
      CBPAY_API_KEY &&
      CBPAY_WEBHOOK_SECRET &&
      TRON_DESTINATION_ADDRESS
        ? "READY"
        : "NOT CONFIGURED"
    );
  }
);
