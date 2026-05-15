require("dotenv").config();
const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const nodemailer = require("nodemailer");

// Square v39 API style — matches the pinned version in package.json
const { Client, Environment, ApiError } = require("square");

const app = express();
app.use(cors());
app.use(express.json());

const isProduction =
  String(process.env.SQUARE_ENVIRONMENT || "production").toLowerCase() !== "sandbox";

const client = new Client({
  accessToken: process.env.SQUARE_ACCESS_TOKEN,
  environment: isProduction ? Environment.Production : Environment.Sandbox,
});

const checkoutApi = client.checkoutApi;
const LOCATION_ID = process.env.SQUARE_LOCATION_ID;
const PORT = process.env.PORT || 3000;

// ─── Utility helpers ──────────────────────────────────────────────────────────

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
      <tr><td style="padding:4px 12px 4px 0;color:#555;">Lodging Tax (7%)</td><td>$${p.lodgingTaxAmount || "0.00"}</td></tr>
      ${p.golfCartSelected ? `<tr><td style="padding:4px 12px 4px 0;color:#555;">Golf Cart (6-Seater)</td><td>$${p.golfCartBase || "0.00"}</td></tr>` : ""}
      ${p.golfCartSelected ? `<tr><td style="padding:4px 12px 4px 0;color:#555;">Golf Cart Tax (7%)</td><td>$${p.golfCartTax || "0.00"}</td></tr>` : ""}
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
    console.error("Booking notification email failed:", err.message);
  }
}

// ─── Line item builder ────────────────────────────────────────────────────────

function buildLineItems(payload) {
  const lineItems = [];

  const lodgingCents      = positiveCents(payload.lodging);
  const cleaningCents     = positiveCents(payload.cleaning);
  const discountCents     = positiveCents(payload.discountAmount);
  const lodgingTaxCents   = positiveCents(payload.lodgingTaxAmount);
  const golfCartBaseCents = positiveCents(payload.golfCartBase);
  const golfCartTaxCents  = positiveCents(payload.golfCartTax);

  if (lodgingCents > 0) {
    const checkin     = safeString(payload.checkin);
    const checkout    = safeString(payload.checkout);
    const nights      = safeString(payload.nights);
    const nightsLabel = nights
      ? ` • ${nights} night${Number(nights) !== 1 ? "s" : ""}`
      : "";
    const datesLabel  = checkin && checkout
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

  if (lodgingTaxCents > 0) {
    lineItems.push({
      name: "Lodging Tax (7%)",
      quantity: "1",
      basePriceMoney: money(lodgingTaxCents),
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
      name: "Golf Cart Tax (7%)",
      quantity: "1",
      basePriceMoney: money(golfCartTaxCents),
    });
  }

  return lineItems;
}

function buildFallbackLineItems(payload) {
  const checkin     = safeString(payload.checkin);
  const checkout    = safeString(payload.checkout);
  const nights      = safeString(payload.nights);
  const nightsLabel = nights ? ` • ${nights} nights` : "";
  const datesLabel  = checkin && checkout
    ? ` (${checkin} → ${checkout}${nightsLabel})`
    : "";
  return [
    {
      name: `Coastal Tide Escapes Reservation${datesLabel}`,
      quantity: "1",
      basePriceMoney: money(positiveCents(payload.total)),
    },
  ];
}

// ─── Order note ───────────────────────────────────────────────────────────────

function buildOrderNote(payload) {
  const parts      = [];
  const bookingRef = safeString(payload.bookingRef);
  const guestName  = safeString(payload.guestName);
  const guestEmail = safeString(payload.guestEmail);
  const guestPhone = safeString(payload.guestPhone);
  const checkin    = safeString(payload.checkin);
  const checkout   = safeString(payload.checkout);
  const guests     = safeString(payload.guests);
  const nights     = safeString(payload.nights);
  const rateMode   = safeString(payload.rateMode);

  if (bookingRef)          parts.push(`Booking Ref: ${bookingRef}`);
  if (guestName)           parts.push(`Guest: ${guestName}`);
  if (guestEmail)          parts.push(`Email: ${guestEmail}`);
  if (guestPhone)          parts.push(`Phone: ${guestPhone}`);
  if (checkin && checkout) parts.push(`Stay: ${checkin} to ${checkout}`);
  if (guests)              parts.push(`Guests: ${guests}`);
  if (nights)              parts.push(`Nights: ${nights}`);
  if (rateMode)            parts.push(`Rate Mode: ${rateMode}`);

  return parts.join(" | ");
}

// ─── Square checkout body builder ─────────────────────────────────────────────

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

  console.log(`Total check — requested: ${requestedTotalCents}, line items: ${lineItemsTotalCents}`);

  if (requestedTotalCents > 0 && lineItemsTotalCents !== requestedTotalCents) {
    console.warn("Line item total mismatch — using fallback single line item");
    lineItems = buildFallbackLineItems(payload);
  }

  return {
    idempotencyKey: crypto.randomUUID(),
    // No quickPay — order-only so Square shows full itemized breakdown
    order: {
      locationId: LOCATION_ID,
      lineItems,
      pricingOptions: {
        autoApplyTaxes: false,
        autoApplyDiscounts: false,
      },
      referenceId: bookingRef,
      metadata: {
        bookingRef,
        guestName,
        checkin,
        checkout,
        guests: safeString(payload.guests),
        nights: safeString(payload.nights),
      },
    },
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
    environment: isProduction ? "production" : "sandbox",
  });
});

app.post("/create-checkout", async (req, res) => {
  try {
    if (!LOCATION_ID) {
      return res.status(500).json({ error: "Missing SQUARE_LOCATION_ID" });
    }

    const payload    = req.body || {};
    const totalCents = positiveCents(payload.total);
    const checkin    = safeString(payload.checkin);
    const checkout   = safeString(payload.checkout);

    if (!totalCents) {
      return res.status(400).json({ error: "Missing or invalid total" });
    }
    if (!checkin || !checkout) {
      return res.status(400).json({ error: "Missing checkin or checkout" });
    }

    const body     = buildCheckoutBody(payload);
    const response = await checkoutApi.createPaymentLink(body);

    const paymentLink = response.result?.paymentLink;

    if (!paymentLink?.url) {
      return res.status(500).json({ error: "Square did not return a checkout URL" });
    }

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
        err.result?.errors?.map((e) => `${e.category}: ${e.detail}`).join(" | ") ||
        err.message ||
        "Square API error";
      return res.status(500).json({ error: details });
    }

    return res.status(500).json({
      error: err?.message || "Unknown server error",
    });
  }
});

// ─── Start server ─────────────────────────────────────────────────────────────

app.listen(PORT, () => {
// ─── Square Webhook — Payment Confirmed → Google Calendar ─────────────────────
// In Square Developer Dashboard → Webhooks, add:
//   URL: https://coastal-tide-backend-95by.onrender.com/square-webhook
//   Event: payment.completed

app.post("/square-webhook", async (req, res) => {
  try {
    res.status(200).json({ ok: true });

    const event = req.body;
    if (!event || event.type !== "payment.completed") return;

    const payment = event?.data?.object?.payment;
    if (!payment) return;

    const orderId    = payment.order_id || "";
    const paymentId  = payment.id || "";
    const amountPaid = payment.amount_money?.amount
      ? Number(payment.amount_money.amount) / 100 : 0;

    let bookingRef = "", guestName = "Guest", guestEmail = "", guestPhone = "";
    let checkin = "", checkout = "", guests = 0, nights = 0;

    if (orderId) {
      try {
        const { result } = await client.ordersApi.retrieveOrder(orderId);
        const order = result?.order;
        if (order) {
          bookingRef = order.referenceId || "";
          const m    = order.metadata || {};
          guestName  = m.guestName  || m.guest_name  || guestName;
          guestEmail = m.guestEmail || m.guest_email || "";
          guestPhone = m.guestPhone || m.guest_phone || "";
          checkin    = m.checkin    || m.check_in    || "";
          checkout   = m.checkout   || m.check_out   || "";
          guests     = Number(m.guests) || 0;
          nights     = Number(m.nights) || 0;
          if (!checkin && order.note) {
            checkin  = (order.note.match(/Check-?in:\s*(\d{4}-\d{2}-\d{2})/i)  || [])[1] || "";
            checkout = (order.note.match(/Check-?out:\s*(\d{4}-\d{2}-\d{2})/i) || [])[1] || "";
          }
          if (!bookingRef && order.note) {
            bookingRef = (order.note.match(/Ref:\s*(CTE-[^\s\n]+)/i) || [])[1] || "";
          }
          if (guestName === "Guest" && order.note) {
            guestName = (order.note.match(/Guest:\s*(.+?)(?:\n|$)/i) || [])[1]?.trim() || guestName;
          }
        }
      } catch (orderErr) {
        console.error("Could not retrieve Square order:", orderErr.message);
      }
    }

    if (!checkin || !checkout) {
      console.log("Square webhook: missing dates — skipping calendar. PaymentId:", paymentId);
      return;
    }

    const gasUrl = process.env.GOOGLE_APPS_SCRIPT_URL;
    if (!gasUrl) {
      console.error("GOOGLE_APPS_SCRIPT_URL not set.");
      return;
    }

    const payload = {
      action: "squarePaymentConfirmed",
      secret: process.env.WEBHOOK_SECRET || "",
      paymentId, bookingRef,
      guestName, guestEmail, guestPhone,
      checkin, checkout, guests, nights, amountPaid,
    };

    const { default: fetch } = await import("node-fetch");
    const scriptRes  = await fetch(gasUrl, {
      method:  "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body:    JSON.stringify(payload),
    });
    const scriptData = await scriptRes.json().catch(() => ({}));
    console.log("Apps Script response:", JSON.stringify(scriptData));

  } catch (err) {
    console.error("Square webhook handler error:", err.message);
  }
});


  console.log(`CTE backend listening on port ${PORT}`);
});
