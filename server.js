require("dotenv").config();
const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
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

function buildLineItems(payload) {
  const lineItems = [];

  const lodgingCents = positiveCents(payload.lodging);
  const cleaningCents = positiveCents(payload.cleaning);
  const discountCents = positiveCents(payload.discountAmount);
  const golfCartBaseCents = positiveCents(payload.golfCartBase);
  const golfCartTaxCents = positiveCents(payload.golfCartTax);

  if (lodgingCents > 0) {
    lineItems.push({
      name: "Lodging",
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

function buildOrderNote(payload) {
  const parts = [];

  const guestName = safeString(payload.guestName);
  const guestEmail = safeString(payload.guestEmail);
  const guestPhone = safeString(payload.guestPhone);
  const checkin = safeString(payload.checkin);
  const checkout = safeString(payload.checkout);
  const guests = safeString(payload.guests);
  const nights = safeString(payload.nights);
  const bookingRef = safeString(payload.bookingRef);
  const rateMode = safeString(payload.rateMode);

  if (bookingRef) parts.push(`Booking Ref: ${bookingRef}`);
  if (guestName) parts.push(`Guest: ${guestName}`);
  if (guestEmail) parts.push(`Email: ${guestEmail}`);
  if (guestPhone) parts.push(`Phone: ${guestPhone}`);
  if (checkin && checkout) parts.push(`Stay: ${checkin} to ${checkout}`);
  if (guests) parts.push(`Guests: ${guests}`);
  if (nights) parts.push(`Nights: ${nights}`);
  if (rateMode) parts.push(`Rate Mode: ${rateMode}`);

  return parts.join(" | ");
}

function buildCheckoutBody(payload) {
  const bookingRef = safeString(payload.bookingRef) || `CTE-${Date.now()}`;
  const guestName = safeString(payload.guestName);
  const checkin = safeString(payload.checkin);
  const checkout = safeString(payload.checkout);

  const requestedTotalCents = positiveCents(payload.total);
  let lineItems = buildLineItems(payload);

  if (!lineItems.length) {
    lineItems = buildFallbackLineItems(payload);
  }

  const lineItemsTotalCents = lineItems.reduce((sum, item) => {
    const amt = Number(item.basePriceMoney.amount);
    return sum + amt;
  }, 0);

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
  if (guestName) descriptionParts.push(guestName);
  if (checkin && checkout) descriptionParts.push(`${checkin} to ${checkout}`);
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
      merchantSupportEmail: process.env.SQUARE_SUPPORT_EMAIL || "coastaltideescapesllc@gmail.com",
      redirectUrl: process.env.SQUARE_REDIRECT_URL || "https://www.coastaltideescapes.com/book-now",
    },
    prePopulatedData: guestName
      ? {
          buyerEmail: safeString(payload.guestEmail) || undefined,
        }
      : {
          buyerEmail: safeString(payload.guestEmail) || undefined,
        },
    paymentNote: buildOrderNote(payload),
  };
}

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
    const checkin = safeString(payload.checkin);
    const checkout = safeString(payload.checkout);

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
        err.result?.errors?.map((e) => `${e.category || "ERROR"}: ${e.detail || e.code}`).join(" | ") ||
        err.message ||
        "Square API error";
      return res.status(500).json({ error: details });
    }

    return res.status(500).json({
      error: err && err.message ? err.message : "Unknown server error",
    });
  }
});

app.listen(PORT, () => {
  console.log(`CTE backend listening on port ${PORT}`);
});
