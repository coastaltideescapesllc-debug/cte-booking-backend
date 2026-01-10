// server.js
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const crypto = require("crypto");

const app = express();
app.use(cors());
app.use(express.json());

// --- Square credentials from env ---
const SQUARE_ACCESS_TOKEN = process.env.SQUARE_ACCESS_TOKEN;
const SQUARE_LOCATION_ID = process.env.SQUARE_LOCATION_ID;
const SQUARE_ENV = (process.env.SQUARE_ENV || "production").toLowerCase(); // "production" or "sandbox"
const SQUARE_VERSION = process.env.SQUARE_VERSION || "2025-10-16";

// --- Sheets webhook env ---
const CTE_SHEETS_WEBHOOK_URL = process.env.CTE_SHEETS_WEBHOOK_URL;
const CTE_SHEETS_WEBHOOK_SECRET = process.env.CTE_SHEETS_WEBHOOK_SECRET;

// Square base URL
const SQUARE_API_BASE =
  SQUARE_ENV === "sandbox"
    ? "https://connect.squareupsandbox.com"
    : "https://connect.squareup.com";

// Basic sanity checks
if (!SQUARE_ACCESS_TOKEN || !SQUARE_LOCATION_ID) {
  console.warn("WARNING: SQUARE_ACCESS_TOKEN or SQUARE_LOCATION_ID is not set.");
}
if (!CTE_SHEETS_WEBHOOK_URL || !CTE_SHEETS_WEBHOOK_SECRET) {
  console.warn("WARNING: CTE_SHEETS_WEBHOOK_URL or CTE_SHEETS_WEBHOOK_SECRET is not set.");
}

// Convert dollars to integer cents
function toCents(total) {
  const num = Number(total);
  if (!Number.isFinite(num)) return null;
  return Math.round(num * 100);
}

/**
 * Fetch with timeout (Node 22 has global fetch)
 */
async function fetchWithTimeout(url, options = {}, timeoutMs = 25000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { ...options, signal: controller.signal, redirect: "follow" });
    const text = await resp.text();
    let json = null;
    try { json = JSON.parse(text); } catch (_) {}
    return { status: resp.status, text, json };
  } finally {
    clearTimeout(id);
  }
}

/**
 * Sheets webhook call via GET with base64url payload.
 * This avoids the POST->redirect->405 issue.
 */
async function writeLeadToSheets_(lead) {
  if (!CTE_SHEETS_WEBHOOK_URL || !CTE_SHEETS_WEBHOOK_SECRET) {
    console.warn("Sheets webhook not configured; skipping write.");
    return { skipped: true, status: 0 };
  }

  const payloadObj = {
    action: "upsertLead",
    secret: CTE_SHEETS_WEBHOOK_SECRET,
    ...lead,
  };

  // base64url encode JSON payload
  const payload = Buffer.from(JSON.stringify(payloadObj), "utf8").toString("base64url");

  const url = new URL(CTE_SHEETS_WEBHOOK_URL);
  url.searchParams.set("payload", payload);

  return await fetchWithTimeout(url.toString(), { method: "GET" }, 25000);
}

// Health
app.get("/", (req, res) => {
  res.json({ ok: true, service: "Coastal Tide Escapes backend" });
});

// Debug: confirm env presence (never returns secrets)
app.get("/env-check", (req, res) => {
  const u = CTE_SHEETS_WEBHOOK_URL || "";
  res.json({
    ok: true,
    square: {
      accessTokenSet: Boolean(SQUARE_ACCESS_TOKEN),
      locationIdSet: Boolean(SQUARE_LOCATION_ID),
      env: SQUARE_ENV,
      version: SQUARE_VERSION,
    },
    sheets: {
      webhookUrlSet: Boolean(CTE_SHEETS_WEBHOOK_URL),
      webhookSecretSet: Boolean(CTE_SHEETS_WEBHOOK_SECRET),
      webhookUrlLooksLikeSheetsEditLink: u.includes("docs.google.com/spreadsheets"),
      webhookUrlLooksLikeAppsScriptExec: u.includes("script.google.com") && u.includes("/exec"),
    },
  });
});

// Debug: attempts a write into your leads sheet via Apps Script webhook
app.get("/test-sheets", async (req, res) => {
  try {
    const bookingRef = `TEST-${Date.now()}-${crypto.randomBytes(3).toString("hex")}`;

    const lead = {
      bookingRef,
      checkin: "2026-01-20",
      checkout: "2026-01-23",
      guests: 4,
      nights: 3,
      total: 999.99,
      squareCheckoutUrl: "https://example.com/test-checkout-link",
      source: "render-test-sheets",
      createdAt: new Date().toISOString(),
    };

    const resp = await writeLeadToSheets_(lead);

    res.json({
      ok: resp.skipped ? false : resp.status >= 200 && resp.status < 300,
      bookingRef,
      sheetsResponse: {
        status: resp.status,
        json: resp.json,
        raw: resp.json ? undefined : resp.text?.slice(0, 500),
      },
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});

// Create Square hosted payment link AND write lead to Sheets
app.post("/create-checkout", async (req, res) => {
  try {
    const {
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
    if (!cents || cents <= 0) {
      return res.status(400).json({ ok: false, error: "Invalid total." });
    }

    const bookingRef = `CTE-${Date.now()}-${crypto.randomBytes(3).toString("hex")}`;

    // Create Square payment link
    const payload = {
      idempotency_key: crypto.randomUUID(),
      quick_pay: {
        name: `Coastal Tide Escapes Booking (${bookingRef})`,
        price_money: { amount: cents, currency: "USD" },
        location_id: SQUARE_LOCATION_ID,
      },
      payment_note: `BookingRef ${bookingRef} | ${checkin} to ${checkout} | Guests ${guests} | Nights ${nights}`,
    };

    const squareResp = await fetch(`${SQUARE_API_BASE}/v2/online-checkout/payment-links`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Square-Version": SQUARE_VERSION,
        Authorization: `Bearer ${SQUARE_ACCESS_TOKEN}`,
      },
      body: JSON.stringify(payload),
    });

    const squareData = await squareResp.json();
    if (!squareResp.ok) {
      console.error("Square error:", squareData);
      return res.status(502).json({
        ok: false,
        error: "Square payment link creation failed.",
        details: squareData,
      });
    }

    const squareCheckoutUrl = squareData?.payment_link?.url;
    if (!squareCheckoutUrl) {
      return res.status(502).json({ ok: false, error: "Square returned no payment_link.url" });
    }

    // Fire-and-forget Sheets write (do not block checkout)
    writeLeadToSheets_({
      bookingRef,
      checkin,
      checkout,
      guests,
      nights,
      total,
      discountApplied,
      discountAmount,
      preTaxTotal,
      taxAmount,
      rateMode,
      squareCheckoutUrl,
      source: "website-widget",
      createdAt: new Date().toISOString(),
    })
      .then((resp) => console.log("Sheets write:", resp.status, resp.json || resp.text?.slice(0, 200)))
      .catch((err) => console.error("Sheets write failed:", err?.message || err));

    res.json({ ok: true, bookingRef, squareCheckoutUrl });
  } catch (err) {
    console.error("Server error:", err);
    res.status(500).json({ ok: false, error: "Server error." });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Coastal Tide backend listening on port ${PORT}`));
