// server.js
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const crypto = require("crypto");

const app = express();
app.use(cors());
app.use(express.json());

// --- Square credentials from .env ---
const SQUARE_ACCESS_TOKEN = process.env.SQUARE_ACCESS_TOKEN;
const SQUARE_LOCATION_ID = process.env.SQUARE_LOCATION_ID;

// Basic sanity check so we fail loudly if env vars are missing
if (!SQUARE_ACCESS_TOKEN || !SQUARE_LOCATION_ID) {
  console.warn(
    "WARNING: SQUARE_ACCESS_TOKEN or SQUARE_LOCATION_ID is not set in .env"
  );
}

// Convert dollars to integer cents
function toCents(total) {
  const num = Number(total);
  if (!Number.isFinite(num) || num <= 0) return null;
  return Math.round(num * 100);
}

// Health check (optional)
app.get("/", (req, res) => {
  res.json({ ok: true, service: "Coastal Tide Escapes backend" });
});

// Main endpoint your website calls
app.post("/create-checkout", async (req, res) => {
  try {
    const { total, checkin, checkout, guests, nights } = req.body || {};

    if (!total || !checkin || !checkout) {
      return res.status(400).json({ error: "Missing booking fields" });
    }

    const amountCents = toCents(total);
    if (!amountCents) {
      return res.status(400).json({ error: "Invalid total amount" });
    }

    if (!SQUARE_ACCESS_TOKEN || !SQUARE_LOCATION_ID) {
      return res
        .status(500)
        .json({ error: "Square credentials not configured on server" });
    }

    const idempotencyKey = crypto.randomUUID();

    // Build request body for Square's Create Payment Link API
    // Docs: POST /v2/online-checkout/payment-links :contentReference[oaicite:0]{index=0}
    const body = {
      idempotency_key: idempotencyKey,
      quick_pay: {
        name: "Coastal Tide Escapes Booking",
        location_id: SQUARE_LOCATION_ID,
        price_money: {
          amount: amountCents, // cents
          currency: "USD",
        },
      },
      checkout_options: {
        redirect_url: "https://www.coastaltideescapes.com/thank-you",
      },
      // Optional: You could add payment_note or description here
      // payment_note: `Stay ${checkin}–${checkout}, ${guests} guests, ${nights} nights`,
    };

    const squareResponse = await fetch(
      "https://connect.squareup.com/v2/online-checkout/payment-links",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${SQUARE_ACCESS_TOKEN}`,
          "Content-Type": "application/json",
          // You can pin a specific Square API version if you like
          // "Square-Version": "2024-08-21",
        },
        body: JSON.stringify(body),
      }
    );

    const data = await squareResponse.json();

    if (!squareResponse.ok) {
      console.error("Square API error:", squareResponse.status, data);
      return res.status(500).json({
        error: "Square API error",
        details: data,
      });
    }

    const url = data?.payment_link?.url;
    if (!url) {
      console.error("No payment_link.url in Square response:", data);
      return res
        .status(500)
        .json({ error: "No payment link URL returned from Square" });
    }

    return res.json({ url });
  } catch (err) {
    console.error("Unexpected error in /create-checkout:", err);
    return res
      .status(500)
      .json({ error: "Failed to create payment link with Square" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Coastal Tide backend listening on port ${PORT}`);
});

