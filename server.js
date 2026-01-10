// server.js
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const crypto = require("crypto");

const app = express();
app.use(cors());
app.use(express.json());

// --------------------
// ENV
// --------------------
const SQUARE_ACCESS_TOKEN = process.env.SQUARE_ACCESS_TOKEN;
const SQUARE_LOCATION_ID = process.env.SQUARE_LOCATION_ID;
const SQUARE_ENV = (process.env.SQUARE_ENV || "production").toLowerCase(); // production | sandbox
const SQUARE_VERSION = process.env.SQUARE_VERSION || "2025-10-16";

const CTE_SHEETS_WEBHOOK_URL = process.env.CTE_SHEETS_WEBHOOK_URL;
const CTE_SHEETS_WEBHOOK_SECRET = process.env.CTE_SHEETS_WEBHOOK_SECRET;

const PORT = process.env.PORT || 3000;

// Convert dollars to integer cents
function toCents(total) {
  const num = Number(total);
  if (!Number.isFinite(num)) return null;
  return Math.round(num * 100);
}

function makeBookingRef() {
  return "CTE-" + Date.now() + "-" + crypto.randomBytes(3).toString("hex");
}

function squareBaseUrl() {
  return SQUARE_ENV === "sandbox"
    ? "https://connect.squareupsandbox.com"
    : "https://connect.squareup.com";
}

/**
 * Google Apps Script often redirects /exec (302) to script.googleusercontent.com.
 * Some redirects change POST->GET (depending on client). This preserves POST by
 * manually following redirects and POSTing again.
 */
async function postJsonFollowRedirectPreserveMethod(url, body, timeoutMs = 12000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      redirect: "manual",
      signal: controller.signal,
    });

    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const loc = res.headers.get("location");
      if (loc) {
        const res2 = await fetch(loc, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const text2 = await res2.text();
        let json2 = null;
        try { json2 = JSON.parse(text2); } catch (_) {}
        return { status: res2.status, redirectedFrom: url, redirectedTo: loc, json: json2, raw: text2 };
      }
    }

    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (_) {}
    return { status: res.status, json, raw: text };
  } finally {
    clearTimeout(t);
  }
}

app.get("/", (_req, res) => {
  res.json({ ok: true, service: "Coastal Tide Escapes backend" });
});

app.get("/env-check", (_req, res) => {
  res.json({
    ok: true,
    square: {
      accessTokenSet: !!SQUARE_ACCESS_TOKEN,
      locationIdSet: !!SQUARE_LOCATION_ID,
      env: SQUARE_ENV,
      version: SQUARE_VERSION,
    },
    sheets: {
      webhookUrlSet: !!CTE_SHEETS_WEBHOOK_URL,
      webhookSecretSet: !!CTE_SHEETS_WEBHOOK_SECRET,
      webhookUrlLooksLikeSheetsEditLink:
        typeof CTE_SHEETS_WEBHOOK_URL === "string" &&
        CTE_SHEETS_WEBHOOK_URL.includes("/spreadsheets/"),
      webhookUrlLooksLikeAppsScriptExec:
        typeof CTE_SHEETS_WEBHOOK_URL === "string" &&
        CTE_SHEETS_WEBHOOK_URL.includes("script.google.com/macros/s/") &&
        CTE_SHEETS_WEBHOOK_URL.endsWith("/exec"),
      webhookUrlLooksLikeGoogleUserContent:
        typeof CTE_SHEETS_WEBHOOK_URL === "string" &&
        CTE_SHEETS_WEBHOOK_URL.includes("script.googleusercontent.com"),
    },
  });
});

// Optional quick test: writes a dummy row via your Apps Script webhook
app.get("/test-sheets", async (_req, res) => {
  try {
    if (!CTE_SHEETS_WEBHOOK_URL || !CTE_SHEETS_WEBHOOK_SECRET) {
      return res.status(500).json({ ok: false, error: "Sheets webhook env vars missing on server" });
    }

    const bookingRef = "TEST-" + Date.now() + "-" + crypto.randomBytes(3).toString("hex");

    const payload = {
      action: "appendLead",
      secret: CTE_SHEETS_WEBHOOK_SECRET,
      bookingRef,
      checkin: "2026-01-20",
      checkout: "2026-01-23",
      guests: 4,
      nights: 3,
      total: 999.99,
      discountApplied: false,
      discountAmount: 0,
      preTaxTotal: 934.57,
      taxAmount: 65.42,
      rateMode: "render-test-sheets",
      squareCheckoutUrl: "https://example.com/test-checkout-link",
      source: "render-test-sheets",
      createdAt: new Date().toISOString(),
    };

    const sheetsResponse = await postJsonFollowRedirectPreserveMethod(
      CTE_SHEETS_WEBHOOK_URL,
      payload,
      12000
    );

    res.json({ ok: true, bookingRef, sheetsResponse });
  } catch (err) {
    res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});

app.post("/create-checkout", async (req, res) => {
  try {
    if (!SQUARE_ACCESS_TOKEN || !SQUARE_LOCATION_ID) {
      return res.status(500).json({ ok: false, error: "Square env vars missing on server" });
    }
    if (!CTE_SHEETS_WEBHOOK_URL || !CTE_SHEETS_WEBHOOK_SECRET) {
      return res.status(500).json({ ok: false, error: "Sheets webhook env vars missing on server" });
    }

    const {
      total,
      checkin,
      checkout,
      guests,
      nights,
      lodging,
      cleaning,
      discountApplied,
      discountAmount,
      preTaxTotal,
      taxAmount,
      rateMode,
      guestName,
      guestEmail,
      guestPhone,
    } = req.body || {};

    const cents = toCents(total);
    if (!cents || cents < 1) return res.status(400).json({ ok: false, error: "Invalid total" });
    if (!checkin || !checkout || !guests || !nights) return res.status(400).json({ ok: false, error: "Missing stay details" });

    const bookingRef = makeBookingRef();

    // --------------------
    // SQUARE: CreatePaymentLink
    // --------------------
    const squareUrl = `${squareBaseUrl()}/v2/online-checkout/payment-links`;

    const squareBody = {
      idempotency_key: crypto.randomUUID(),
      quick_pay: {
        name: `Coastal Tide Escapes – Booking (${bookingRef})`,
        price_money: { amount: cents, currency: "USD" },
        location_id: SQUARE_LOCATION_ID,
      },
      // Prefill if available
      pre_populated_data: {
        ...(guestEmail ? { buyer_email: String(guestEmail).trim() } : {}),
        ...(guestPhone ? { buyer_phone_number: String(guestPhone).trim() } : {}),
      },
    };

    const sqRes = await fetch(squareUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${SQUARE_ACCESS_TOKEN}`,
        "Content-Type": "application/json",
        "Square-Version": SQUARE_VERSION,
      },
      body: JSON.stringify(squareBody),
    });

    const sqText = await sqRes.text();
    let sqJson = null;
    try { sqJson = JSON.parse(sqText); } catch (_) {}

    if (!sqRes.ok) {
      return res.status(502).json({
        ok: false,
        error: "Square CreatePaymentLink failed",
        status: sqRes.status,
        details: sqJson || sqText,
      });
    }

    const squareCheckoutUrl = sqJson?.payment_link?.url;
    if (!squareCheckoutUrl) {
      return res.status(502).json({ ok: false, error: "Square response missing payment_link.url", details: sqJson });
    }

    // --------------------
    // SHEETS: Append lead row (NOT upsert)
    // --------------------
    const leadPayload = {
      action: "appendLead",
      secret: CTE_SHEETS_WEBHOOK_SECRET,

      bookingRef,
      createdAt: new Date().toISOString(),
      source: "website-widget",

      guestName: guestName ? String(guestName).trim() : "",
      guestEmail: guestEmail ? String(guestEmail).trim() : "",
      guestPhone: guestPhone ? String(guestPhone).trim() : "",

      checkin,
      checkout,
      guests,
      nights,

      // these help populate your sheet columns if you map them
      lodging: Number(lodging),
      cleaning: Number(cleaning),

      total: Number(total),
      discountApplied: !!discountApplied,
      discountAmount: Number(discountAmount || 0),
      preTaxTotal: Number(preTaxTotal || 0),
      taxAmount: Number(taxAmount || 0),
      rateMode: String(rateMode || ""),

      squareCheckoutUrl,
    };

    await postJsonFollowRedirectPreserveMethod(CTE_SHEETS_WEBHOOK_URL, leadPayload, 12000);

    return res.json({
      ok: true,
      bookingRef,
      url: squareCheckoutUrl,
      squareCheckoutUrl,
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});

app.listen(PORT, () => {
  console.log(`Coastal Tide backend listening on port ${PORT}`);
});
