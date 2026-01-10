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

function toCents(total) {
  const num = Number(total);
  if (!Number.isFinite(num)) return null;
  return Math.round(num * 100);
}

function makeBookingRef() {
  return "CTE-" + Date.now() + "-" + crypto.randomBytes(3).toString("hex");
}

function normalizePhoneE164(input) {
  const s = String(input || "").trim();
  const digits = s.replace(/[^\d]/g, "");

  if (digits.length === 10) return "+1" + digits; // US 10-digit
  if (digits.length === 11 && digits[0] === "1") return "+" + digits; // US 11-digit starting with 1
  if (s.startsWith("+") && digits.length >= 10) return "+" + digits; // already has country code
  return s; // best effort
}

function squareBaseUrl() {
  return SQUARE_ENV === "sandbox"
    ? "https://connect.squareupsandbox.com"
    : "https://connect.squareup.com";
}

// Preserve POST across Google Apps Script redirect (302 to script.googleusercontent.com)
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

// --------------------
// ROUTES
// --------------------
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
      webhookUrlLooksLikeAppsScriptExec:
        typeof CTE_SHEETS_WEBHOOK_URL === "string" &&
        CTE_SHEETS_WEBHOOK_URL.includes("script.google.com/macros/s/") &&
        CTE_SHEETS_WEBHOOK_URL.endsWith("/exec"),
    },
  });
});

// NEW: test Square payment link creation (no widget needed)
app.get("/test-square", async (_req, res) => {
  try {
    if (!SQUARE_ACCESS_TOKEN || !SQUARE_LOCATION_ID) {
      return res.status(500).json({ ok: false, error: "Missing SQUARE_ACCESS_TOKEN or SQUARE_LOCATION_ID" });
    }

    const squareUrl = `${squareBaseUrl()}/v2/online-checkout/payment-links`;

    const body = {
      idempotency_key: crypto.randomUUID(),
      quick_pay: {
        name: "CTE Test Payment Link ($1)",
        price_money: { amount: 100, currency: "USD" },
        location_id: SQUARE_LOCATION_ID,
      },
      pre_populated_data: {
        buyer_email: "test@example.com",
        buyer_phone_number: "+14155551212",
      },
    };

    const sqRes = await fetch(squareUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${SQUARE_ACCESS_TOKEN}`,
        "Content-Type": "application/json",
        "Square-Version": SQUARE_VERSION,
      },
      body: JSON.stringify(body),
    });

    const text = await sqRes.text();
    let json = null;
    try { json = JSON.parse(text); } catch (_) {}

    if (!sqRes.ok) {
      return res.status(502).json({
        ok: false,
        error: "Square CreatePaymentLink failed",
        status: sqRes.status,
        details: json || text,
      });
    }

    return res.json({
      ok: true,
      url: json?.payment_link?.url || null,
      payment_link: json?.payment_link || null,
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});

app.get("/test-sheets", async (_req, res) => {
  try {
    if (!CTE_SHEETS_WEBHOOK_URL || !CTE_SHEETS_WEBHOOK_SECRET) {
      return res.status(400).json({ ok: false, error: "Missing CTE_SHEETS_WEBHOOK_URL or CTE_SHEETS_WEBHOOK_SECRET" });
    }

    const bookingRef = "TEST-" + Date.now() + "-" + crypto.randomBytes(3).toString("hex");
    const payload = {
      action: "upsertLead",
      secret: CTE_SHEETS_WEBHOOK_SECRET,
      bookingRef,
      guestName: "Test Guest",
      guestEmail: "test@example.com",
      guestPhone: "+14155551212",
      checkin: "2026-01-20",
      checkout: "2026-01-23",
      guests: 4,
      nights: 3,
      total: 999.99,
      squareCheckoutUrl: "https://example.com/test-checkout-link",
      source: "render-test-sheets",
      createdAt: new Date().toISOString(),
    };

    const sheetsResponse = await postJsonFollowRedirectPreserveMethod(CTE_SHEETS_WEBHOOK_URL, payload, 12000);
    return res.json({ ok: true, bookingRef, sheetsResponse });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err?.message || String(err) });
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
      guestName,
      guestEmail,
      guestPhone,
      total,
      checkin,
      checkout,
      guests,
      nights,
      discountApplied,
      discountAmount,
      preTaxTotal,
      taxAmount,
      rateMode,
    } = req.body || {};

    const cents = toCents(total);
    if (!cents || cents < 1) return res.status(400).json({ ok: false, error: "Invalid total" });
    if (!checkin || !checkout || !guests || !nights) return res.status(400).json({ ok: false, error: "Missing stay details" });
    if (!guestName || !guestEmail || !guestPhone) return res.status(400).json({ ok: false, error: "Missing guestName/guestEmail/guestPhone" });

    const bookingRef = makeBookingRef();
    const phoneE164 = normalizePhoneE164(guestPhone);

    const squareUrl = `${squareBaseUrl()}/v2/online-checkout/payment-links`;

    const squareBody = {
      idempotency_key: crypto.randomUUID(),
      quick_pay: {
        name: `Coastal Tide Escapes – Booking (${bookingRef})`,
        price_money: { amount: cents, currency: "USD" },
        location_id: SQUARE_LOCATION_ID,
      },
      pre_populated_data: {
        buyer_email: String(guestEmail).trim(),
        buyer_phone_number: String(phoneE164).trim(),
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

    const leadPayload = {
      action: "upsertLead",
      secret: CTE_SHEETS_WEBHOOK_SECRET,
      bookingRef,
      createdAt: new Date().toISOString(),
      source: "website-widget",
      guestName: String(guestName).trim(),
      guestEmail: String(guestEmail).trim(),
      guestPhone: String(phoneE164).trim(),
      checkin,
      checkout,
      guests,
      nights,
      total: Number(total),
      discountApplied: !!discountApplied,
      discountAmount: Number(discountAmount || 0),
      preTaxTotal: Number(preTaxTotal || 0),
      taxAmount: Number(taxAmount || 0),
      rateMode: String(rateMode || ""),
      squareCheckoutUrl,
    };

    const sheetsResponse = await postJsonFollowRedirectPreserveMethod(CTE_SHEETS_WEBHOOK_URL, leadPayload, 12000);

    // IMPORTANT: return both keys to match any widget version
    return res.json({
      ok: true,
      bookingRef,
      url: squareCheckoutUrl,
      squareCheckoutUrl,
      sheets: { status: sheetsResponse.status, ok: !!(sheetsResponse.json && sheetsResponse.json.ok) },
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});

app.listen(PORT, () => {
  console.log(`Coastal Tide backend listening on port ${PORT}`);
});
