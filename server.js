// server.js (CTE Booking Backend)
// - POST /create-checkout -> creates Square payment link + writes lead to Sheets via Apps Script webhook
// - GET  /env-check       -> shows which env vars are set (no secrets)
// - GET  /test-sheets     -> writes a test lead to Sheets
// - GET  /               -> health

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const crypto = require("crypto");

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

const PORT = process.env.PORT || 3000;

// =========================
// ENV
// =========================
const SQUARE_ACCESS_TOKEN = process.env.SQUARE_ACCESS_TOKEN;
const SQUARE_LOCATION_ID = process.env.SQUARE_LOCATION_ID;
const SQUARE_ENV = (process.env.SQUARE_ENV || "production").toLowerCase(); // production | sandbox
const SQUARE_VERSION = process.env.SQUARE_VERSION || "2025-10-16";

const CTE_SHEETS_WEBHOOK_URL = process.env.CTE_SHEETS_WEBHOOK_URL;       // Apps Script /exec URL
const CTE_SHEETS_WEBHOOK_SECRET = process.env.CTE_SHEETS_WEBHOOK_SECRET; // Must match Apps Script property

const SQUARE_BASE =
  SQUARE_ENV === "sandbox"
    ? "https://connect.squareupsandbox.com"
    : "https://connect.squareup.com";

function isFiniteNumber(n) {
  return typeof n === "number" && Number.isFinite(n);
}

function toCents(amount) {
  const n = Number(amount);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

function looksLikeAppsScriptExec(url) {
  return typeof url === "string" && /^https:\/\/script\.google\.com\/macros\/s\/[^/]+\/exec\/?$/.test(url);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 10000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { ...options, signal: controller.signal, redirect: "follow" });
    return resp;
  } finally {
    clearTimeout(t);
  }
}

// =========================
// Routes
// =========================
app.get("/", (req, res) => {
  res.json({ ok: true, service: "Coastal Tide Escapes backend" });
});

app.get("/env-check", (req, res) => {
  const webhookUrl = CTE_SHEETS_WEBHOOK_URL || "";
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
      webhookUrlLooksLikeAppsScriptExec: looksLikeAppsScriptExec(webhookUrl),
      webhookUrlLooksLikeGoogleUserContent: /^https:\/\/script\.googleusercontent\.com\//.test(webhookUrl),
      webhookUrlLooksLikeSheetsEditLink: /docs\.google\.com\/spreadsheets/.test(webhookUrl),
    },
  });
});

app.get("/test-sheets", async (req, res) => {
  try {
    if (!CTE_SHEETS_WEBHOOK_URL || !CTE_SHEETS_WEBHOOK_SECRET) {
      return res.status(400).json({ ok: false, error: "Missing CTE_SHEETS_WEBHOOK_URL or CTE_SHEETS_WEBHOOK_SECRET" });
    }

    const bookingRef = `TEST-${Date.now()}-${crypto.randomBytes(3).toString("hex")}`;
    const payload = {
      action: "upsertLead",
      secret: CTE_SHEETS_WEBHOOK_SECRET,
      bookingRef,
      source: "render-test-sheets",
      createdAt: new Date().toISOString(),
      checkin: "2026-01-20",
      checkout: "2026-01-23",
      guests: 4,
      nights: 3,
      total: 999.99,
      discountApplied: false,
      discountAmount: 0,
      preTaxTotal: 934.57,
      taxAmount: 65.42,
      rateMode: "test-sheets",
      squareCheckoutUrl: "https://example.com/test-checkout-link",

      guestName: "Test Guest",
      guestEmail: "test@example.com",
      guestPhone: "555-555-5555",
    };

    const resp = await fetchWithTimeout(
      CTE_SHEETS_WEBHOOK_URL,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      },
      15000
    );

    const text = await resp.text();
    let json = null;
    try { json = JSON.parse(text); } catch (_) {}

    res.json({
      ok: resp.ok,
      bookingRef,
      sheetsResponse: {
        status: resp.status,
        json,
        raw: json ? null : text,
      },
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) });
  }
});

app.post("/create-checkout", async (req, res) => {
  try {
    // Basic validation
    const total = Number(req.body.total);
    if (!Number.isFinite(total) || total <= 0) {
      return res.status(400).json({ ok: false, error: "Invalid total." });
    }

    const cents = toCents(total);
    if (!cents || cents <= 0) {
      return res.status(400).json({ ok: false, error: "Invalid total cents." });
    }

    const checkin = String(req.body.checkin || "").trim();
    const checkout = String(req.body.checkout || "").trim();
    const guests = Number(req.body.guests);
    const nights = Number(req.body.nights);

    const discountApplied = !!req.body.discountApplied;
    const discountAmount = Number(req.body.discountAmount || 0);
    const preTaxTotal = Number(req.body.preTaxTotal || 0);
    const taxAmount = Number(req.body.taxAmount || 0);
    const rateMode = String(req.body.rateMode || "").trim();

    const guestName = String(req.body.guestName || "").trim();
    const guestEmail = String(req.body.guestEmail || "").trim();
    const guestPhone = String(req.body.guestPhone || "").trim();

    const bookingRef = `CTE-${Date.now()}-${crypto.randomBytes(3).toString("hex")}`;
    const idempotencyKey = crypto.randomUUID();

    // 1) Create Square payment link
    if (!SQUARE_ACCESS_TOKEN || !SQUARE_LOCATION_ID) {
      return res.status(500).json({ ok: false, error: "Missing Square env vars on backend." });
    }

    const squareResp = await fetchWithTimeout(
      `${SQUARE_BASE}/v2/online-checkout/payment-links`,
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${SQUARE_ACCESS_TOKEN}`,
          "Content-Type": "application/json",
          "Square-Version": SQUARE_VERSION,
        },
        body: JSON.stringify({
          idempotency_key: idempotencyKey,
          quick_pay: {
            name: `Coastal Tide Escapes Booking (${bookingRef})`,
            price_money: { amount: cents, currency: "USD" },
            location_id: SQUARE_LOCATION_ID,
          },
          checkout_options: {
            ask_for_shipping_address: false,
            redirect_url: req.body.redirectUrl || undefined,
          },
        }),
      },
      15000
    );

    const squareText = await squareResp.text();
    let squareJson = null;
    try { squareJson = JSON.parse(squareText); } catch (_) {}

    if (!squareResp.ok) {
      return res.status(400).json({
        ok: false,
        error: "Square payment link creation failed.",
        details: squareJson || squareText,
      });
    }

    const squareCheckoutUrl = squareJson?.payment_link?.url;
    if (!squareCheckoutUrl) {
      return res.status(500).json({
        ok: false,
        error: "Square did not return payment_link.url",
        details: squareJson || squareText,
      });
    }

    // 2) Write lead to Sheets (non-blocking but we will await and report status)
    let sheetsResult = null;

    if (CTE_SHEETS_WEBHOOK_URL && CTE_SHEETS_WEBHOOK_SECRET) {
      const payload = {
        action: "upsertLead",
        secret: CTE_SHEETS_WEBHOOK_SECRET,
        bookingRef,
        source: "website-widget",
        createdAt: new Date().toISOString(),

        checkin,
        checkout,
        guests: Number.isFinite(guests) ? guests : "",
        nights: Number.isFinite(nights) ? nights : "",
        total: total,
        discountApplied,
        discountAmount: Number.isFinite(discountAmount) ? discountAmount : "",
        preTaxTotal: Number.isFinite(preTaxTotal) ? preTaxTotal : "",
        taxAmount: Number.isFinite(taxAmount) ? taxAmount : "",
        rateMode,
        squareCheckoutUrl,

        guestName,
        guestEmail,
        guestPhone,
      };

      // Some users see transient Apps Script slowness; allow one retry.
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          const resp = await fetchWithTimeout(
            CTE_SHEETS_WEBHOOK_URL,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(payload),
            },
            20000
          );

          const text = await resp.text();
          let json = null;
          try { json = JSON.parse(text); } catch (_) {}

          sheetsResult = { status: resp.status, ok: resp.ok, json: json || null, raw: json ? null : text };

          if (resp.ok) break;
        } catch (e) {
          sheetsResult = { status: 0, ok: false, error: String(e) };
        }

        if (attempt === 1) await sleep(500);
      }
    } else {
      sheetsResult = { ok: false, status: 0, error: "Sheets webhook env vars not set." };
    }

    // Return to widget
    return res.json({
      ok: true,
      bookingRef,
      squareCheckoutUrl,
      sheets: sheetsResult,
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: String(err) });
  }
});

app.listen(PORT, () => {
  console.log(`Coastal Tide backend listening on port ${PORT}`);
});
