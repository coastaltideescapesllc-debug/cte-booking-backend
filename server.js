require("dotenv").config();
const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const nodemailer = require("nodemailer");
const { Client, Environment, ApiError } = require("square");

const app = express();
app.use(cors());
app.use(express.json());

const client = new Client({
  environment:
    String(process.env.SQUARE_ENVIRONMENT || "production").toLowerCase() === "sandbox"
      ? Environment.Sandbox
      : Environment.Production,
  accessToken: process.env.SQUARE_ACCESS_TOKEN,
});

const checkoutApi = client.checkoutApi;
const LOCATION_ID = process.env.SQUARE_LOCATION_ID;
const PORT = process.env.PORT || 3000;

// ─── Utility helpers ─────────────────────────────────────────────────────────

function toCents(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return 0;
  return Math.round(num * 100);
}

function money(amountCents, currency = "USD") {
  return {
    amount: BigInt(amountCents),
    currency,
  };
}

function safeString(value) {
  return String(value == null ? "" : value).trim();
}

function positiveCents(value) {
  const cents = toCents(value);
  return cents > 0 ? cents : 0;
}

// ─── Email notification ───────────────────────────────────────────────────────

function getMailer() {
  if (!process.env.NOTIFY_EMAIL_USER || !process.env.NOTIFY_EMAIL_PASS) return null;
  return nodemailer.createTransport({
    service: "gmail",
    auth: {
      user: process.env.NOTIFY_EMAIL_USER,
      pass: process.env.NOTIFY_EMAIL_PASS,
    },
  });
}

async function sendBookingNotification(payload, checkoutUrl) {
  const mailer = getMailer();
  if (!mailer || !process.env.NOTIFY_EMAIL_TO) return;

  const p = payload;
  const subject = `New Booking: ${p.guestName || "Guest"} | ${p.checkin} → ${p.checkout} | ${p.bookingRef}`;

  const html = `
    <h2 style="color:#0b5ea8;">New Coastal Tide Escapes Booking</h2>
    <table style="border-collapse:collapse;font-family:Arial,sans-serif;font-size:14px;">
      <tr><td style="padding:4px 12px 4px 0;color:#555;">Booking Ref</td><td><strong>${p.bookingRef || "—"}</strong></td></tr>
      <tr><td style="padding:4px 12px 4px 0;color:#555;">Guest Name</td><td>${p.guestName || "—"}</td></tr>
      <tr><td style="padding:4px 12px 4px 0;color:#555;">Email</td><td>${p.guestEmail || "—"}</td></tr>
      <tr><td style="padding:4px 12px 4px 0;color:#555;">Phone</td><td>${p.guestPhone || "—"}</td></tr>
      <tr><td style="padding:4px 12px 4px 0;color:#555;">Check-in</td><td>${p.checkin || "—"}</td></tr>
      <tr><td style="padding:4px 12px 4px 0;color:#555;">Check-out</td><td>${p.checkout || "—"}</td></tr>
      <tr><td style="padding:4px 12px 4px 0;color:#555;">Nights</td><td>${p.nights || "—"}</td></tr>
      <tr><td style="padding:4px 12px 4px 0;color:#555;">Guests</td><td>${p.guests || "—"}</td></tr>
      <tr><td style="padding:8px 12px 4px 0;color:#555;border-top:1px solid #eee;">Lodging</td><td style="border-top:1px solid #eee;">$${p.lodging || "0.00"}</td></tr>
      <tr><td style="padding:4px 12px 4px 0;color:#555;">Cleaning Fee</td><td>$${p.cleaning || "0.00"}</td></tr>
      ${p.discountApplied ? `<tr><td style="padding:4px 12px 4px 0;color:#555;">Discount</td><td style="color:#c0392b;">-$${p.discountAmount || "0.00"}</td></tr>` : ""}
      <tr><td style="padding:4px 12px 4px 0;color:#555;">Lodging Tax</td><td>$${p.lodgingTaxAmount || "0.00"}</td></tr>
      ${p.golfCartSelected ? `<tr><td style="padding:4px 12px 4px 0;color:#555;">Golf Cart (6-Seater)</td><td>$${p.golfCartBase || "0.00"}</td></tr>` : ""}
      ${p.golfCartSelected ? `<tr><td style="padding:4px 12px 4px 0;color:#555;">Golf Cart Tax</td><td>$${p.golfCartTax || "0.00"}</td></tr>` : ""}
      <tr>
        <td style="padding:10px 12px 4px 0;color:#0b5ea8;font-weight:bold;font-size:16px;border-top:2px solid #0b5ea8;">Total Charged</td>
        <td style="padding:10px 0 4px 0;font-weight:bold;font-size:16px;color:#0b5ea8;border-top:2px solid #0b5ea8;">$${p.total || "0.00"}</td>
      </tr>
      <tr><td style="padding:8px 12px 4px 0;color:#555;">Rate Mode</td><td>${p.rateMode || "—"}</td></tr>
    </table>
    <p style="margin-top:20px;font-family:Arial,sans-serif;font-size:13px;">
      <a href="${checkoutUrl}" style="color:#0b5ea8;">View Square Checkout Link</a>
    </p>
    <p style="margin-top:8px;font-family:Arial,sans-serif;font-size:11px;color:#999;">
      This notification was sent automatically by the Coastal Tide Escapes booking system.
    </p>
  `;

  try {
    await mailer.sendMail({
      from: `"Coastal Tide Escapes Bookings" <${process.env.NOTIFY_EMAIL_USER}>`,
      to: process.env.NOTIFY_EMAIL_TO,
      subject,
      html,
    });
    console.log("Booking notification email sent to", process.env.NOTIFY_EMAIL_TO);
  } catch (err) {
    // Non-fatal — log but don't block the checkout response
    console.error("Booking notification email failed:", err.message);
  }
}

// ─── Line item builder ────────────────────────────────────────────────────────

function buildLineItems(payload) {
  const lineItems = [];

  const lodgingCents     = positiveCents(payload.lodging);
  const cleaningCents    = positiveCents(payload.cleaning);
  const discountCents    = positiveCents(payload.discountAmount);
  const golfCartBaseCents = positiveCents(payload.golfCartBase);
  const golfCartTaxCents  = positiveCents(payload.golfCartTax);

  // Lodging — include stay dates and night count on the receipt line
  if (lodgingCents > 0) {
    const checkin  = safeString(payload.checkin);
    const checkout = safeString(payload.checkout);
    const nights   = safeString(payload.nights);
    const nightsLabel = nights
      ? ` • ${nights} night${Number(nights) !== 1 ? "s" : ""}`
      : "";
    const datesLabel = checkin && checkout
      ? ` (${checkin} → ${checkout}${nightsLabel})`
      : "";
    lineItems.push({
      name: `Lodging${datesLabel}`,
      quantity: "1",
      basePriceMoney: money(lodgingCents),
    });
  }

  if (cleaningCents > 0) {
    lineItems.push({
      name: "Cleaning Fee",
      quantity: "1",
      basePriceMoney: money(cleaningCents),
    });
  }

  if (discountCents > 0) {
    lineItems.push({
      name: "Direct Booking Discount",
      quantity: "1",
      basePriceMoney: money(-discountCents),
    });
  }

  if (golfCartBaseCents > 0) {
    lineItems.push({
      name: "6-Seater Golf Cart Add-On",
      quantity: "1",
      basePriceMoney: money(golfCartBaseCents),
    });
  }

  if (golfCartTaxCents > 0) {
    lineItems.push({
      name: "Golf Cart Tax",
      quantity: "1",
      basePriceMoney: money(golfCartTaxCents),
    });
  }

  return lineItems;
}

function buildFallbackLineItems(payload) {
  const totalCents = positiveCents(payload.total);
  return [
    {
      name: "Coastal Tide Escapes Reservation",
      quantity: "1",
      basePriceMoney: money(totalCents),
    },
  ];
}

// ─── Order note (shows in Square Dashboard transaction detail) ────────────────

function buildOrderNote(payload) {
  const parts = [];

  const bookingRef  = safeString(payload.bookingRef);
  const guestName   = safeString(payload.guestName);
  const guestEmail  = safeString(payload.guestEmail);
  const guestPhone  = safeString(payload.guestPhone);
  const checkin     = safeString(payload.checkin);
  const checkout    = safeString(payload.checkout);
  const guests      = safeString(payload.guests);
  const nights      = safeString(payload.nights);
  const rateMode    = safeString(payload.rateMode);

  if (bookingRef)           parts.push(`Booking Ref: ${bookingRef}`);
  if (guestName)            parts.push(`Guest: ${guestName}`);
  if (guestEmail)           parts.push(`Email: ${guestEmail}`);
  if (guestPhone)           parts.push(`Phone: ${guestPhone}`);
  if (checkin && checkout)  parts.push(`Stay: ${checkin} to ${checkout}`);
  if (guests)               parts.push(`Guests: ${guests}`);
  if (nights)               parts.push(`Nights: ${nights}`);
  if (rateMode)             parts.push(`Rate Mode: ${rateMode}`);

  return parts.join(" | ");
}

// ─── Square checkout body builder ────────────────────────────────────────────

function buildCheckoutBody(payload) {
  const bookingRef = safeString(payload.bookingRef) || `CTE-${Date.now()}`;
  const guestName  = safeString(payload.guestName);
  const checkin    = safeString(payload.checkin);
  const checkout   = safeString(payload.checkout);

  const requestedTotalCents = positiveCents(payload.total);
  let lineItems = buildLineItems(payload);

  if (!lineItems.length) {
    lineItems = buildFallbackLineItems(payload);
  }

  const lineItemsTotalCents = lineItems.reduce((sum, item) => {
    return sum + Number(item.basePriceMoney.amount);
  }, 0);

  // If line items don't add up to the expected total, fall back to a single line
  if (requestedTotalCents > 0 && lineItemsTotalCents !== requestedTotalCents) {
    lineItems = buildFallbackLineItems(payload);
  }

  const order = {
    locationId: LOCATION_ID,
    lineItems,
    pricingOptions: {
      autoApplyTaxes: false,
      autoApplyDiscounts: false,
    },
  };

  const descriptionParts = [];
  if (guestName)            descriptionParts.push(guestName);
  if (checkin && checkout)  descriptionParts.push(`${checkin} to ${checkout}`);
  descriptionParts.push(bookingRef);

  return {
    idempotencyKey: crypto.randomUUID(),
    quickPay: {
      name: "Coastal Tide Escapes Reservation",
      priceMoney: money(
        requestedTotalCents > 0
          ? requestedTotalCents
          : lineItems.reduce((sum, item) => sum + Number(item.basePriceMoney.amount), 0)
      ),
      locationId: LOCATION_ID,
    },
    order,
    description: descriptionParts.join(" • "),
    checkoutOptions: {
      askForShippingAddress: false,
      merchantSupportEmail:
        process.env.SQUARE_SUPPORT_EMAIL || "coastaltideescapesllc@gmail.com",
      redirectUrl:
        process.env.SQUARE_REDIRECT_URL || "https://www.coastaltideescapes.com/book-now",
    },
    prePopulatedData: {
      buyerEmail: safeString(payload.guestEmail) || undefined,
    },
    paymentNote: buildOrderNote(payload),
  };
}

// ─── Routes ───────────────────────────────────────────────────────────────────

app.get("/", (_req, res) => {
  res.json({
    ok: true,
    service: "Coastal Tide Escapes Square checkout backend",
    environment:
      String(process.env.SQUARE_ENVIRONMENT || "production").toLowerCase() === "sandbox"
        ? "sandbox"
        : "production",
  });
});

app.post("/create-checkout", async (req, res) => {
  try {
    if (!LOCATION_ID) {
      return res.status(500).json({ error: "Missing SQUARE_LOCATION_ID" });
    }

    const payload = req.body || {};
    const totalCents = positiveCents(payload.total);
    const checkin    = safeString(payload.checkin);
    const checkout   = safeString(payload.checkout);

    if (!totalCents) {
      return res.status(400).json({ error: "Missing or invalid total" });
    }

    if (!checkin || !checkout) {
      return res.status(400).json({ error: "Missing checkin or checkout" });
    }

    const body = buildCheckoutBody(payload);
    const response = await checkoutApi.createPaymentLink(body);
    const paymentLink = response.result?.paymentLink;

    if (!paymentLink?.url) {
      return res.status(500).json({ error: "Square did not return a checkout URL" });
    }

    // Send booking notification email to owner (non-blocking)
    await sendBookingNotification(payload, paymentLink.url);

    return res.json({
      ok: true,
      checkoutUrl: paymentLink.url,
      paymentLinkId: paymentLink.id || "",
      orderId: paymentLink.orderId || "",
      squareInvoiceId: "",
      lineItemsShown: true,
    });
  } catch (err) {
    console.error("Square checkout error:", err);

    if (err instanceof ApiError) {
      const details =
        err.result?.errors
          ?.map((e) => `${e.category || "ERROR"}: ${e.detail || e.code}`)
          .join(" | ") ||
        err.message ||
        "Square API error";
      return res.status(500).json({ error: details });
    }

    return res.status(500).json({
      error: err && err.message ? err.message : "Unknown server error",
    });
  }
});

// ─── Start server ─────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`CTE backend listening on port ${PORT}`);
});
