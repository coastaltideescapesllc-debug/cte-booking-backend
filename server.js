require("dotenv").config();

const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const nodemailer = require("nodemailer");
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

function toCents(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return 0;
  return Math.round(num * 100);
}
function money(amountCents, currency = "USD") {
  return { amount: BigInt(amountCents), currency };
}
function safeString(value) { return String(value == null ? "" : value).trim(); }
function positiveCents(value) { const c = toCents(value); return c > 0 ? c : 0; }
function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }

const CLEANING_FEE = 300;
const LODGING_TAX_RATE = 0.07;
const GOLF_CART_TAX_RATE = 0.07;
const DIRECT_DISCOUNT_RATE = 0.10;

const PROMO_CODES = {
  COAST2026: { type: "fixed", amount: 150, label: "Guest Discount ($150 off)", active: true },
  MILITARY10: { type: "percent", amount: 10, label: "Military Discount (10% off)", active: true },
  WELCOME25: { type: "fixed", amount: 25, label: "Welcome Promo ($25 off)", active: true },
  FIXED1000: { type: "override", amount: 1000, label: "Special Rate - Total $1,000.00", active: true },
};

const FR_RATES = [
  { start: "2026-01-01", end: "2026-02-28", nightly: 189, weekend: 209, weekly: 1250, monthly: 3300, minStay: 3 },
  { start: "2026-03-01", end: "2026-03-07", nightly: 229, weekend: 249, weekly: 1525, monthly: 4900, minStay: 3 },
  { start: "2026-03-08", end: "2026-04-12", nightly: 289, weekend: 319, weekly: 1950, monthly: 6900, minStay: 4 },
  { start: "2026-04-13", end: "2026-05-21", nightly: 225, weekend: 250, weekly: 1500, monthly: 4500, minStay: 3 },
  { start: "2026-05-22", end: "2026-05-31", nightly: 275, weekend: 300, weekly: 1850, monthly: 5700, minStay: 4 },
  { start: "2026-06-01", end: "2026-06-04", nightly: 310, weekend: 335, weekly: 2150, monthly: 6400, minStay: 7 },
  { start: "2026-06-05", end: "2026-07-04", nightly: 325, weekend: 350, weekly: 2250, monthly: 6500, minStay: 7 },
  { start: "2026-07-05", end: "2026-08-08", nightly: 295, weekend: 320, weekly: 2050, monthly: 6000, minStay: 7 },
  { start: "2026-08-09", end: "2026-09-06", nightly: 255, weekend: 280, weekly: 1750, monthly: 5200, minStay: 4 },
  { start: "2026-09-07", end: "2026-10-31", nightly: 215, weekend: 240, weekly: 1450, monthly: 4200, minStay: 3 },
  { start: "2026-11-01", end: "2026-12-18", nightly: 195, weekend: 215, weekly: 1300, monthly: 3800, minStay: 3 },
  { start: "2026-12-19", end: "2026-12-31", nightly: 265, weekend: 290, weekly: 1850, monthly: 5500, minStay: 4 },
];

function pad2(n) { return String(n).padStart(2, "0"); }
function mdKey(d) { return pad2(d.getMonth() + 1) + "-" + pad2(d.getDate()); }
function isoKey(d) { return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate()); }

function parseDate(v) {
  if (!v) return null;
  const parts = String(v).split("-");
  if (parts.length !== 3) return null;
  const y = parseInt(parts[0], 10), m = parseInt(parts[1], 10), d = parseInt(parts[2], 10);
  if (!y || !m || !d) return null;
  const dt = new Date(y, m - 1, d);
  return (dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d) ? dt : null;
}

function nightsBetween(ci, co) { return Math.round((co.getTime() - ci.getTime()) / 86400000); }
function isWeekend(date) { const day = date.getDay(); return day === 5 || day === 6; }

function nightlyRateDefault(date) {
  const md = mdKey(date), wknd = isWeekend(date);
  if (md >= "04-01" && md <= "08-31") return wknd ? 325 : 300;
  if ((md >= "03-01" && md <= "03-31") || (md >= "09-01" && md <= "10-31")) return wknd ? 275 : 250;
  return wknd ? 250 : 225;
}

function findFRRate(dateObj) {
  const t = dateObj.getTime();
  for (const r of FR_RATES) {
    const s = parseDate(r.start), e = parseDate(r.end);
    if (t >= s.getTime() && t <= e.getTime()) return r;
  }
  return null;
}

function nightlyRateWithPlan(dateObj, stayNights, ratePlan) {
  if (ratePlan === "floridarentals") {
    const r = findFRRate(dateObj);
    if (!r) return { ok: false, reason: "FloridaRentals pricing is not configured for at least one date in this range." };
    let base = isWeekend(dateObj) ? r.weekend : r.nightly;
    if (stayNights >= 28 && r.monthly) base = Math.min(base, r.monthly / 30);
    else if (stayNights >= 7 && r.weekly) base = Math.min(base, r.weekly / 7);
    return { ok: true, rate: base, minStay: r.minStay || 1 };
  }
  return { ok: true, rate: nightlyRateDefault(dateObj), minStay: 1 };
}

function inDiscountWindow(ci, co) {
  const n = nightsBetween(ci, co);
  if (n < 3) return false;
  for (let j = 0; j < n; j++) {
    const dd = new Date(ci.getTime() + j * 86400000);
    const md = mdKey(dd);
    if (md >= "04-01" && md <= "08-31") return true;
  }
  return false;
}

function golfCartPrice(nights) {
  if (nights <= 3) return 375;
  if (nights <= 5) return 499;
  return 599;
}

function computeBooking(input) {
  const ratePlan = input.ratePlan === "floridarentals" ? "floridarentals" : "";
  const ciDate = parseDate(input.checkin);
  const coDate = parseDate(input.checkout);
  const guests = parseInt(input.guests, 10);
  const wantsGolfCart = !!input.golfCart;
  const promoRaw = safeString(input.promoCode).toUpperCase();

  if (!ciDate || !coDate) return { ok: false, error: "Please provide valid check-in and check-out dates." };
  if (coDate <= ciDate) return { ok: false, error: "Check-out must be after check-in." };
  if (!guests || guests < 1 || guests > 9) return { ok: false, error: "Guest count must be between 1 and 9." };

  const nights = nightsBetween(ciDate, coDate);
  if (nights <= 0) return { ok: false, error: "Please select at least 1 night." };

  if (input.golfCartOnly) {
    const gcBase = golfCartPrice(nights);
    const gcTax = round2(gcBase * GOLF_CART_TAX_RATE);
    return {
      ok: true,
      booking: {
        ratePlan: "",
        checkin: isoKey(ciDate), checkout: isoKey(coDate),
        guests, nights,
        lodging: 0,
        cleaning: 0,
        discountApplied: false, discountAmount: 0,
        promoCode: "", promoDiscount: 0, promoLabel: "",
        promoOverride: false,
        lodgingPreTaxTotal: 0,
        lodgingTaxAmount: 0,
        golfCartSelected: true,
        golfCartOnly: true,
        golfCartBase: round2(gcBase),
        golfCartTax: gcTax,
        total: round2(gcBase + gcTax),
        rateMode: "Golf Cart Only (Off-Site Booking)",
      },
    };
  }

  const overrideDef = promoRaw ? PROMO_CODES[promoRaw] : null;
  if (overrideDef && overrideDef.active && overrideDef.type === "override") {
    const fixedTotal = round2(overrideDef.amount);
    return {
      ok: true,
      booking: {
        ratePlan,
        checkin: isoKey(ciDate), checkout: isoKey(coDate),
        guests, nights,
        lodging: 0,
        cleaning: 0,
        discountApplied: false, discountAmount: 0,
        promoCode: promoRaw, promoDiscount: 0, promoLabel: overrideDef.label,
        promoOverride: true,
        lodgingPreTaxTotal: fixedTotal,
        lodgingTaxAmount: 0,
        golfCartSelected: wantsGolfCart,
        golfCartBase: 0,
        golfCartTax: 0,
        total: fixedTotal,
        rateMode: overrideDef.label,
      },
    };
  }

  let lodging = 0, minStayRequired = 1;
  for (let i = 0; i < nights; i++) {
    const d = new Date(ciDate.getTime() + i * 86400000);
    const rr = nightlyRateWithPlan(d, nights, ratePlan);
    if (!rr.ok) return { ok: false, error: rr.reason };
    lodging += rr.rate;
    minStayRequired = Math.max(minStayRequired, rr.minStay || 1);
  }

  if (ratePlan === "floridarentals" && nights < minStayRequired)
    return { ok: false, error: "Minimum stay for these dates is " + minStayRequired + " nights." };

  let lodgingPreTax = lodging + CLEANING_FEE;
  let discountApplied = false, discountAmount = 0;

  if (ratePlan !== "floridarentals" && inDiscountWindow(ciDate, coDate)) {
    discountApplied = true;
    discountAmount = lodgingPreTax * DIRECT_DISCOUNT_RATE;
    lodgingPreTax -= discountAmount;
  }

  let promoCode = "", promoDiscount = 0, promoLabel = "";
  if (promoRaw) {
    const def = PROMO_CODES[promoRaw];
    if (def && def.active && def.type !== "override") {
      promoCode = promoRaw;
      promoLabel = def.label;
      promoDiscount = def.type === "fixed" ? def.amount : round2(lodgingPreTax * (def.amount / 100));
      promoDiscount = Math.min(promoDiscount, lodgingPreTax);
      lodgingPreTax -= promoDiscount;
    }
  }

  const lodgingTax = lodgingPreTax * LODGING_TAX_RATE;
  const golfCartBase = wantsGolfCart ? golfCartPrice(nights) : 0;
  const golfCartTax = wantsGolfCart ? golfCartBase * GOLF_CART_TAX_RATE : 0;
  const total = lodgingPreTax + lodgingTax + golfCartBase + golfCartTax;

  return {
    ok: true,
    booking: {
      ratePlan,
      checkin: isoKey(ciDate), checkout: isoKey(coDate),
      guests, nights,
      lodging: round2(lodging),
      cleaning: CLEANING_FEE,
      discountApplied, discountAmount: round2(discountAmount),
      promoCode, promoDiscount: round2(promoDiscount), promoLabel,
      promoOverride: false,
      lodgingPreTaxTotal: round2(lodgingPreTax),
      lodgingTaxAmount: round2(lodgingTax),
      golfCartSelected: wantsGolfCart,
      golfCartBase: round2(golfCartBase),
      golfCartTax: round2(golfCartTax),
      total: round2(total),
      rateMode: ratePlan === "floridarentals"
        ? "FloridaRentals Rate Plan"
        : (discountApplied ? "Direct Booking Discount Applied" : "Standard Rate"),
    },
  };
}

function getMailer() {
  if (!process.env.NOTIFY_EMAIL_USER || !process.env.NOTIFY_EMAIL_PASS) return null;
  return nodemailer.createTransport({
    service: "gmail",
    auth: { user: process.env.NOTIFY_EMAIL_USER, pass: process.env.NOTIFY_EMAIL_PASS },
  });
}

async function sendBookingNotification(p, checkoutUrl) {
  const mailer = getMailer();
  if (!mailer || !process.env.NOTIFY_EMAIL_TO) return;

  const subject = "New Booking: " + (p.guestName || "Guest") + " | " + p.checkin + " to " + p.checkout + " | " + p.bookingRef;

  let html = "";
  html += "<h2 style='color:#0b5ea8;'>New Coastal Tide Escapes Booking</h2>";
  html += "<table style='border-collapse:collapse;font-family:Arial,sans-serif;font-size:14px;'>";
  html += "<tr><td style='padding:4px 12px 4px 0;color:#555;'>Booking Ref</td><td><strong>" + (p.bookingRef || "-") + "</strong></td></tr>";
  html += "<tr><td style='padding:4px 12px 4px 0;color:#555;'>Guest Name</td><td>" + (p.guestName || "-") + "</td></tr>";
  html += "<tr><td style='padding:4px 12px 4px 0;color:#555;'>Email</td><td>" + (p.guestEmail || "-") + "</td></tr>";
  html += "<tr><td style='padding:4px 12px 4px 0;color:#555;'>Phone</td><td>" + (p.guestPhone || "-") + "</td></tr>";
  html += "<tr><td style='padding:4px 12px 4px 0;color:#555;'>Check-in</td><td>" + (p.checkin || "-") + "</td></tr>";
  html += "<tr><td style='padding:4px 12px 4px 0;color:#555;'>Check-out</td><td>" + (p.checkout || "-") + "</td></tr>";
  html += "<tr><td style='padding:4px 12px 4px 0;color:#555;'>Nights</td><td>" + (p.nights || "-") + "</td></tr>";
  html += "<tr><td style='padding:4px 12px 4px 0;color:#555;'>Guests</td><td>" + (p.guests || "-") + "</td></tr>";
  html += "<tr><td style='padding:8px 12px 4px 0;color:#555;border-top:1px solid #eee;'>Lodging</td><td style='border-top:1px solid #eee;'>$" + p.lodging + "</td></tr>";
  html += "<tr><td style='padding:4px 12px 4px 0;color:#555;'>Cleaning Fee</td><td>$" + p.cleaning + "</td></tr>";
  if (p.promoOverride) html += "<tr><td style='padding:4px 12px 4px 0;color:#555;'>Special Rate</td><td style='color:#0b5ea8;'>" + p.promoLabel + "</td></tr>";
  if (!p.promoOverride && p.discountApplied) html += "<tr><td style='padding:4px 12px 4px 0;color:#555;'>Discount</td><td style='color:#c0392b;'>-$" + p.discountAmount + "</td></tr>";
  if (!p.promoOverride && p.promoCode) html += "<tr><td style='padding:4px 12px 4px 0;color:#555;'>Promo (" + p.promoCode + ")</td><td style='color:#c0392b;'>-$" + p.promoDiscount + "</td></tr>";
  if (!p.promoOverride) html += "<tr><td style='padding:4px 12px 4px 0;color:#555;'>Lodging Tax (7%)</td><td>$" + p.lodgingTaxAmount + "</td></tr>";
  if (p.golfCartSelected && !p.promoOverride) html += "<tr><td style='padding:4px 12px 4px 0;color:#555;'>Golf Cart (6-Seater)</td><td>$" + p.golfCartBase + "</td></tr>";
  if (p.golfCartSelected && !p.promoOverride) html += "<tr><td style='padding:4px 12px 4px 0;color:#555;'>Golf Cart Tax (7%)</td><td>$" + p.golfCartTax + "</td></tr>";
  html += "<tr><td style='padding:10px 12px 4px 0;color:#0b5ea8;font-weight:bold;font-size:16px;border-top:2px solid #0b5ea8;'>Total Charged</td><td style='padding:10px 0 4px 0;font-weight:bold;font-size:16px;color:#0b5ea8;border-top:2px solid #0b5ea8;'>$" + p.total + "</td></tr>";
  html += "<tr><td style='padding:8px 12px 4px 0;color:#555;'>Rate Mode</td><td>" + (p.rateMode || "-") + "</td></tr>";
  html += "</table>";
  html += "<p style='margin-top:20px;font-family:Arial,sans-serif;font-size:13px;'><a href='" + checkoutUrl + "' style='color:#0b5ea8;'>View Square Checkout Link</a></p>";

  try {
    await mailer.sendMail({
      from: "Coastal Tide Escapes Bookings <" + process.env.NOTIFY_EMAIL_USER + ">",
      to: process.env.NOTIFY_EMAIL_TO,
      subject, html,
    });
    console.log("Booking notification email sent to", process.env.NOTIFY_EMAIL_TO);
  } catch (err) {
    console.error("Booking notification email failed:", err.message);
  }
}

function buildLineItems(b) {
  const items = [];

  if (b.promoOverride) {
    const cartNote = b.golfCartSelected ? " incl. golf cart" : "";
    items.push({
      name: "Coastal Tide Escapes Stay - Special Rate" + cartNote + " (" + b.checkin + " to " + b.checkout + ")",
      quantity: "1",
      basePriceMoney: money(toCents(b.total)),
    });
    return items;
  }

  const nightsLabel = b.nights ? (" - " + b.nights + " night" + (b.nights !== 1 ? "s" : "")) : "";
  const datesLabel = (b.checkin && b.checkout) ? (" (" + b.checkin + " to " + b.checkout + nightsLabel + ")") : "";

  const hasReduction = positiveCents(b.discountAmount) > 0 || positiveCents(b.promoDiscount) > 0;
  const lodgingName = hasReduction
    ? ("Lodging & Cleaning (after discounts)" + datesLabel)
    : ("Lodging & Cleaning" + datesLabel);

  if (positiveCents(b.lodgingPreTaxTotal) > 0)
    items.push({ name: lodgingName, quantity: "1", basePriceMoney: money(toCents(b.lodgingPreTaxTotal)) });

  if (positiveCents(b.lodgingTaxAmount) > 0)
    items.push({ name: "Lodging Tax (7%)", quantity: "1", basePriceMoney: money(toCents(b.lodgingTaxAmount)) });

  if (positiveCents(b.golfCartBase) > 0)
    items.push({ name: "6-Seater Golf Cart Add-On", quantity: "1", basePriceMoney: money(toCents(b.golfCartBase)) });

  if (positiveCents(b.golfCartTax) > 0)
    items.push({ name: "Golf Cart Tax (7%)", quantity: "1", basePriceMoney: money(toCents(b.golfCartTax)) });

  return items;
}

function buildOrderNote(meta) {
  const parts = [];
  if (meta.bookingRef) parts.push("Booking Ref: " + meta.bookingRef);
  if (meta.guestName) parts.push("Guest: " + meta.guestName);
  if (meta.guestEmail) parts.push("Email: " + meta.guestEmail);
  if (meta.guestPhone) parts.push("Phone: " + meta.guestPhone);
  if (meta.checkin && meta.checkout) parts.push("Stay: " + meta.checkin + " to " + meta.checkout);
  if (meta.guests) parts.push("Guests: " + meta.guests);
  if (meta.nights) parts.push("Nights: " + meta.nights);
  if (meta.promoOverride) parts.push("Special Rate Promo " + meta.promoCode + ": Total $" + meta.total);
  if (!meta.promoOverride && meta.discountAmount && Number(meta.discountAmount) > 0) parts.push("Direct Discount: -$" + meta.discountAmount);
  if (!meta.promoOverride && meta.promoCode) parts.push("Promo " + meta.promoCode + ": -$" + meta.promoDiscount);
  if (meta.golfCartOnly) parts.push("GOLF CART ONLY (Off-Site Booking)");
  if (meta.rateMode) parts.push("Rate Mode: " + meta.rateMode);
  return parts.join(" | ");
}

app.get("/", (_req, res) => {
  res.json({ ok: true, service: "Coastal Tide Escapes Square checkout backend", environment: isProduction ? "production" : "sandbox" });
});

app.post("/quote", (req, res) => {
  const result = computeBooking(req.body || {});
  if (!result.ok) return res.status(400).json({ ok: false, error: result.error });
  return res.json({ ok: true, booking: result.booking });
});app.post("/create-checkout", async (req, res) => {
  try {
    if (!LOCATION_ID) return res.status(500).json({ error: "Missing SQUARE_LOCATION_ID" });

    const i = req.body || {};
    const result = computeBooking(i);
    if (!result.ok) return res.status(400).json({ error: result.error });
    const b = result.booking;

    const bookingRef = safeString(i.bookingRef) || ("CTE-" + Date.now());
    const guestName = safeString(i.guestName);
    const guestEmail = safeString(i.guestEmail || i.email);
    const guestPhone = safeString(i.guestPhone || i.phone);

    const lineItems = buildLineItems(b);
    if (!lineItems.length) return res.status(400).json({ error: "Nothing to charge." });

    const metadata = {
      bookingRef, guestName, guestEmail, guestPhone,
      checkin: b.checkin, checkout: b.checkout,
      guests: String(b.guests), nights: String(b.nights),
      golfCartOnly: b.golfCartOnly ? "yes" : "no",
    };
    const noteMeta = { ...metadata, total: b.total, promoOverride: b.promoOverride, discountAmount: b.discountAmount, promoCode: b.promoCode, promoDiscount: b.promoDiscount, rateMode: b.rateMode, golfCartOnly: !!b.golfCartOnly };

    const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(guestEmail);

    const redirectUrl = b.golfCartOnly
      ? (process.env.SQUARE_GOLF_CART_REDIRECT_URL || "https://www.coastaltideescapes.com/golf-cart-confirmed")
      : (process.env.SQUARE_REDIRECT_URL || "https://www.coastaltideescapes.com/book-now");

    const body = {
      idempotencyKey: crypto.randomUUID(),
      order: {
        locationId: LOCATION_ID,
        lineItems,
        pricingOptions: { autoApplyTaxes: false, autoApplyDiscounts: false },
        referenceId: bookingRef,
        metadata,
      },
      checkoutOptions: {
        askForShippingAddress: false,
        merchantSupportEmail: process.env.SQUARE_SUPPORT_EMAIL || "coastaltideescapesllc@gmail.com",
        redirectUrl,
      },
      prePopulatedData: emailOk ? { buyerEmail: guestEmail } : undefined,
      paymentNote: buildOrderNote(noteMeta),
    };

    const response = await checkoutApi.createPaymentLink(body);
    const paymentLink = response.result && response.result.paymentLink;
    if (!paymentLink || !paymentLink.url) return res.status(500).json({ error: "Square did not return a checkout URL" });

    await sendBookingNotification({ ...b, bookingRef, guestName, guestEmail, guestPhone }, paymentLink.url);

    return res.json({
      ok: true,
      checkoutUrl: paymentLink.url,
      finalPrice: b.total,
      paymentLinkId: paymentLink.id || "",
      orderId: paymentLink.orderId || "",
    });
  } catch (err) {
    console.error("Square checkout error:", JSON.stringify((err && err.result) || (err && err.message) || err, null, 2));
    if (err instanceof ApiError) {
      const details = (err.result && err.result.errors ? err.result.errors.map(function (e) {
        return e.category + "/" + e.code + ": " + (e.detail || "") + (e.field ? (" [field: " + e.field + "]") : "");
      }).join(" | ") : "") || err.message;
      return res.status(500).json({ error: details });
    }
    return res.status(500).json({ error: (err && err.message) || "Unknown server error" });
  }
});

app.post("/square-webhook", async (req, res) => {
  res.status(200).json({ ok: true });
  try {
    const event = req.body;
    if (!event || event.type !== "payment.completed") return;

    const payment = event && event.data && event.data.object && event.data.object.payment;
    if (!payment) return;

    const orderId = payment.order_id || "";
    const paymentId = payment.id || "";
    const amountPaid = (payment.amount_money && payment.amount_money.amount) ? Number(payment.amount_money.amount) / 100 : 0;

    let bookingRef = "", guestName = "Guest", guestEmail = "", guestPhone = "";
    let checkin = "", checkout = "", guests = 0, nights = 0;

    if (orderId) {
      try {
        const { result } = await client.ordersApi.retrieveOrder(orderId);
        const order = result && result.order;
        if (order) {
          bookingRef = order.referenceId || "";
          constconst m = order.metadata || {};
          guestName = m.guestName || m.guest_name || guestName;
          guestEmail = m.guestEmail || m.guest_email || "";
          guestPhone = m.guestPhone || m.guest_phone || "";
          checkin = m.checkin || m.check_in || "";
          checkout = m.checkout || m.check_out || "";
          guests = Number(m.guests) || 0;
          nights = Number(m.nights) || 0;
          if (!checkin && order.note) {
            checkin = (order.note.match(/Stay:\s*(\d{4}-\d{2}-\d{2})/i) || [])[1] || "";
            checkout = (order.note.match(/to\s*(\d{4}-\d{2}-\d{2})/i) || [])[1] || "";
          }
          if (!bookingRef && order.note)
            bookingRef = (order.note.match(/Ref:\s*(CTE-[^\s|]+)/i) || [])[1] || "";
          if (guestName === "Guest" && order.note) {
            const gm = order.note.match(/Guest:\s*([^|]+)/i);
            if (gm && gm[1]) guestName = gm[1].trim();
          }
        }
      } catch (orderErr) {
        console.error("Could not retrieve Square order:", orderErr.message);
      }
    }

    if (!checkin || !checkout) {
      console.log("Square webhook: missing dates. PaymentId:", paymentId);
      return;
    }

    const gasUrl = process.env.GOOGLE_APPS_SCRIPT_URL;
    if (!gasUrl) { console.error("GOOGLE_APPS_SCRIPT_URL not set."); return; }

    const payload = {
      action: "squarePaymentConfirmed",
      secret: process.env.WEBHOOK_SECRET || "",
      paymentId, bookingRef,
      guestName, guestEmail, guestPhone,
      checkin, checkout, guests, nights, amountPaid,
    };

    const nodeFetch = await import("node-fetch");
    const fetchFn = nodeFetch.default;
    const scriptRes = await fetchFn(gasUrl, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(payload),
    });
    const scriptData = await scriptRes.json().catch(function () { return {}; });
    console.log("Apps Script response:", JSON.stringify(scriptData));
  } catch (err) {
    console.error("Square webhook handler error:", err.message);
  }
});

app.listen(PORT, function () {
  console.log("CTE backend listening on port " + PORT);
});
