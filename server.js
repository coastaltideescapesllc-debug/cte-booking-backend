// server.js
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const https = require("https");

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

// Log missing env vars (does not crash)
if (!SQUARE_ACCESS_TOKEN || !SQUARE_LOCATION_ID) {
  console.warn("WARNING: SQUARE_ACCESS_TOKEN or SQUARE_LOCATION_ID is not set.");
}
if (!CTE_SHEETS_WEBHOOK_URL || !CTE_SHEETS_WEBHOOK_SECRET) {
  console.warn(
    "WARNING: CTE_SHEETS_WEBHOOK_URL or CTE_SHEETS_WEBHOOK_SECRET is not set."
  );
}

// Convert dollars to integer cents
function toCents(total) {
  const num = Number(total);
  if (!Number.isFinite(num)) return null;
  return Math.round(num * 100);
}

/**
 * POST JSON with redirect following (Apps Script often redirects 302 to googleusercontent)
 */
function postJson(urlString, payload, timeoutMs = 8000, maxRedirects = 5) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlString);
    const body = JSON.stringify(payload);

    const options = {
      method: "POST",
      hostname: url.hostname,
      path: url.pathname + (url.search || ""),
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
      timeout: timeoutMs,
    };

    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", async () => {
        const status = res.statusCode || 0;
        const headers = res.headers || {};
        const location = headers.location;

        // Follow redirects (including 302) by re-POSTing to the new location
        if (
          location &&
          status >= 300 &&
          status < 400 &&
          maxRedirects > 0
        ) {
          try {
            const nextUrl = new URL(location, url).toString();
            const nextResp = await postJson(
              nextUrl,
              payload,
              timeoutMs,
              maxRedirects - 1
            );
            // Preserve original redirect info for debugging
            nextResp.redirectedFrom = urlString;
            nextResp.redirectedTo = nextUrl;
            nextResp.redirectStatus = status;
            return resolve(nextResp);
          } catch (err) {
            return reject(err);
          }
        }

        // Try parse JSON; fall back to raw text
        let parsed = null;
        try {
          parsed = JSON.parse(data);
        } catch (_) {}

        resolve({
          status,
          headers,
          raw: data,
          json: parsed,
        });
      });
    });

    req.on("timeout", () => req.destroy(new Error("Request timed out")));
    req.on("error", (err) => reject(err));

    req.write(body);
    req.end();
  });
}

/**
 * Fire-and-forget Sheets write (never blocks checkout success)
 */
async function writeLeadToSheets_(lead) {
  if (!CTE_SHEETS_WEBHOOK_URL || !CTE_SHEETS_WEBHOOK_SECRET) {
    console.warn("Sheets webhook not configured; skipping write.");
    return { skipped: true };
  }

  const payload = {
    action: "upsertLead",
    secret: CTE_SHEETS_WEBHOOK_SECRET,
    ...lead,
  };

  return await postJson(CTE_SHEETS_WEBHOOK_URL, payload);
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
      webhookUrlLooksLikeAppsScriptExec:
        u.includes("script.google.com") && u.includes("/exec"),
      webhookUrlLooksLikeGoogleUserContent:
        u.includes("script.googleusercontent.com"),
    },
  });
});

// Debug: attempts a write into your leads sheet via Apps Script webhook
app.get("/test-sheets", async (req, res) => {
  try {
    const bookingRef = `TEST-${Date.now()}-${crypto
      .randomBytes(3)
      .toString("hex")}`;

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
      ok: true,
      bookingRef,
      sheetsResponse: {
        status: resp.status,
        redirectedFrom: resp.redirectedFrom,
        redirectedTo: resp.redirectedTo,
        redirectStatus: resp.redirectStatus,
        locationHeader: resp.headers?.location,
        json: resp.json,
        raw: resp.json ? undefined : resp.raw,
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

    const bookingRef = `CTE-${Date.now()}-${crypto
      .randomBytes(3)
      .toString("hex")}`;

    const payload = {
      idempotency_key: crypto.randomUUID(),
      quick_pay: {
        name: `Coastal Tide Escapes Booking (${bookingRef})`,
        price_money: { amount: cents, currency: "USD" },
        location_id: SQUARE_LOCATION_ID,
      },
      payment_note: `BookingRef ${bookingRef} | ${checkin} to ${checkout} | Guests ${guests} | Nights ${nights}`,
    };

    const squareResp = await fetch(
      `${SQUARE_API_BASE}/v2/online-checkout/payment-links`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Square-Version": SQUARE_VERSION,
          Authorization: `Bearer ${SQUARE_ACCESS_TOKEN}`,
        },
        body: JSON.stringify(payload),
      }
    );

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
      return res
        .status(502)
        .json({ ok: false, error: "Square returned no payment_link.url" });
    }

    // Fire-and-forget Sheets write
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
      .then((resp) =>
        console.log("Sheets write status:", resp.status, resp.json || resp.raw)
      )
      .catch((err) =>
        console.error("Sheets write failed:", err?.message || err)
      );

    res.json({ ok: true, bookingRef, squareCheckoutUrl });
  } catch (err) {
    console.error("Server error:", err);
    res.status(500).json({ ok: false, error: "Server error." });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log(`Coastal Tide backend listening on port ${PORT}`)
);
