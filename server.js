require("dotenv").config();

const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const nodemailer = require("nodemailer");
const { Client, Environment, ApiError } = require("square");
const { google } = require("googleapis"); // ← ADDED for giveaway Google Sheet logging

const app = express();
app.use(cors());
// ← CHANGED: capture the raw body (needed to verify the Square webhook signature).
//    req.body still parses normally everywhere, so nothing else is affected.
app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));

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
  const promoRaw = safeString(input.promoCode).toUpperCase();

  if (!ciDate || !coDate) return { ok: false, error: "Please provide valid check-in and check-out dates." };
  if (coDate <= ciDate) return { ok: false, error: "Check-out must be after check-in." };

  const nights = nightsBetween(ciDate, coDate);
  if (nights <= 0) return { ok: false, error: "Please select at least 1 night." };

  // ── Golf Cart Only (off-site guests renting cart separately) ──────────────
  if (input.golfCartOnly) {
    const gcBase = golfCartPrice(nights);
    const gcTax = round2(gcBase * GOLF_CART_TAX_RATE);
    return {
      ok: true,
      booking: {
        ratePlan: "",
        checkin: isoKey(ciDate), checkout: isoKey(coDate),
        guests: 1, nights,
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

  // ── Guest count validation (only needed for full stay bookings) ───────────
  const guests = parseInt(input.guests, 10);
  if (!guests || guests < 1 || guests > 9) return { ok: false, error: "Guest count must be between 1 and 9." };

  const wantsGolfCart = !!input.golfCart;

  // ── Promo override ────────────────────────────────────────────────────────
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

  // ── Standard lodging calculation ──────────────────────────────────────────
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
    items.push({ name: "6-Seater Golf Cart Rental", quantity: "1", basePriceMoney: money(toCents(b.golfCartBase)) });

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

/* ==========================================================================
   ░░ GIVEAWAY ADD-ON ░░  (Beach Stay Giveaway for the Columbus Rawlings Tigers)
   Everything below is self-contained. Uses your same Square client, mailer,
   and money() helper. Logs to a Google Sheet ("Entries" tab).
   ========================================================================== */
const GV_TIERS = {
  t1: { count: 1, amount: 1000, label: "1 Giveaway Entry" },
  t3: { count: 3, amount: 2500, label: "3 Giveaway Entries" },
  t7: { count: 7, amount: 5000, label: "7 Giveaway Entries" },
};
const GV_PAD = (n) => String(n).padStart(4, "0");

function gvSheets() {
  const creds = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const auth = new google.auth.JWT(creds.client_email, null, creds.private_key, [
    "https://www.googleapis.com/auth/spreadsheets",
  ]);
  return google.sheets({ version: "v4", auth });
}
async function gvGet(range) {
  const r = await gvSheets().spreadsheets.values.get({ spreadsheetId: (process.env.SHEET_ID || "").trim(), range });
  return r.data.values || [];
}
async function gvAppend(range, rows) {
  await gvSheets().spreadsheets.values.append({
    spreadsheetId: (process.env.SHEET_ID || "").trim(), range, valueInputOption: "RAW", requestBody: { values: rows },
  });
}
async function gvMaxTicket() {
  let m = 0;
  for (const row of await gvGet("Entries!A2:A")) {
    const n = parseInt(row[0], 10);
    if (!isNaN(n) && n > m) m = n;
  }
  return m;
}
async function gvRecorded(id) {
  return (await gvGet("Entries!H2:H")).some((r) => r[0] === id);
}
async function gvEmailTickets(name, email, tickets) {
  const mailer = getMailer();
  if (!mailer || !email) return;
  const list = tickets.map((t) => "#" + GV_PAD(t)).join(", ");
  await mailer.sendMail({
    from: "Coastal Tide Escapes <" + process.env.NOTIFY_EMAIL_USER + ">",
    to: email,
    subject: "Your Beach Stay Giveaway " + (tickets.length > 1 ? "tickets" : "ticket") + " (" + list + ")",
    html:
      "<div style='font-family:Georgia,serif;max-width:520px;margin:auto;color:#26333f'>" +
      "<h2 style='color:#1E3A5F'>You're entered! &#127903;</h2>" +
      "<p>Hi " + (name || "there") + ", thanks for supporting the <b>Columbus Rawlings Tigers</b>. " +
      "Your entry into the Coastal Tide Escapes Beach Stay Giveaway is confirmed.</p>" +
      "<p style='font-size:1.15rem'><b>Your ticket " + (tickets.length > 1 ? "numbers" : "number") + ":</b> " +
      "<span style='color:#C9531A;font-weight:bold'>" + list + "</span></p>" +
      "<p>Winner drawn <b>August 3, 2026 at 7:00 PM ET</b> and notified by phone/email. " +
      "No purchase was necessary to enter — see the Official Rules on our site.</p>" +
      "<p style='color:#6a7480;font-size:.85rem'>Coastal Tide Escapes, LLC &middot; Panama City Beach, FL</p></div>",
  });
}

// Core: given a payment's ids + amount (cents), issue tickets if it's a giveaway order.
// Returns {status:"ok",...} | {status:"skip",reason} | {status:"error",reason}
async function issueGiveawayTickets(paymentId, orderId, amountCents) {
  if (!orderId) return { status: "skip", reason: "no order id" };
  let meta = {}, entryRef = "";
  try {
    const { result } = await client.ordersApi.retrieveOrder(orderId);
    const order = result && result.order;
    meta = (order && order.metadata) || {};
    entryRef = (order && order.referenceId) || "";
  } catch (e) {
    console.error("Giveaway: order retrieve failed:", e.message);
    return { status: "error", reason: e.message };
  }
  if (meta.type !== "giveaway") return { status: "skip", reason: "not giveaway" };
  if (await gvRecorded(paymentId)) return { status: "skip", reason: "already recorded" };

  const count = parseInt(meta.count, 10) || 1;
  const name = meta.gvName || "", email = meta.gvEmail || "", phone = meta.gvPhone || "", tier = meta.tier || "";
  const start = (await gvMaxTicket()) + 1;
  const tickets = [], rows = [], ts = new Date().toISOString();
  for (let i = 0; i < count; i++) {
    const num = start + i;
    tickets.push(num);
    rows.push([num, name, email, phone, "PAID", tier, (amountCents / 100).toFixed(2), paymentId, entryRef, ts]);
  }
  await gvAppend("Entries!A:J", rows);
  await gvEmailTickets(name, email, tickets);

  const mailer = getMailer();
  if (mailer && process.env.NOTIFY_EMAIL_TO) {
    try {
      await mailer.sendMail({
        from: "Coastal Tide Escapes <" + process.env.NOTIFY_EMAIL_USER + ">",
        to: process.env.NOTIFY_EMAIL_TO,
        subject: "New giveaway entry",
        text: (name || email) + " — " + count + " entr" + (count > 1 ? "ies" : "y") +
              ", tickets #" + GV_PAD(tickets[0]) + "-#" + GV_PAD(tickets[tickets.length - 1]) + ".",
      });
    } catch (_) {}
  }
  return { status: "ok", tickets, name, email, count };
}

// Webhook wrapper: returns true if this was a giveaway payment (handled here).
async function handleGiveawayWebhook(payment) {
  try {
    const amount = (payment.amount_money && payment.amount_money.amount) ? Number(payment.amount_money.amount) : 0;
    const r = await issueGiveawayTickets(payment.id, payment.order_id, amount);
    return !(r.status === "skip" && r.reason === "not giveaway"); // handled unless it wasn't a giveaway order
  } catch (err) {
    console.error("handleGiveawayWebhook error:", err.message);
    return true;
  }
}
/* ░░ END GIVEAWAY HELPERS ░░ */

app.get("/", (_req, res) => {
  res.json({ ok: true, service: "Coastal Tide Escapes Square checkout backend", environment: isProduction ? "production" : "sandbox" });
});

app.post("/quote", (req, res) => {
  const result = computeBooking(req.body || {});
  if (!result.ok) return res.status(400).json({ ok: false, error: result.error });
  return res.json({ ok: true, booking: result.booking });
});

app.post("/create-checkout", async (req, res) => {
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

/* ── GIVEAWAY ROUTE: site form calls this to start a $10/$25/$50 entry ── */
app.post("/giveaway/create-checkout", async (req, res) => {
  try {
    if (!LOCATION_ID) return res.status(500).json({ error: "Missing SQUARE_LOCATION_ID" });
    const { name, email, phone, tier } = req.body || {};
    const t = GV_TIERS[tier];
    if (!t) return res.status(400).json({ error: "invalid tier" });
    const buyerEmail = safeString(email);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(buyerEmail)) return res.status(400).json({ error: "valid email required" });

    const entryRef = "CTE-GIVE-" + crypto.randomBytes(4).toString("hex").toUpperCase();
    const body = {
      idempotencyKey: crypto.randomUUID(),
      order: {
        locationId: LOCATION_ID,
        referenceId: entryRef,
        lineItems: [{ name: t.label, quantity: "1", basePriceMoney: money(t.amount) }],
        metadata: {
          type: "giveaway", tier, count: String(t.count),
          gvName: safeString(name), gvEmail: buyerEmail, gvPhone: safeString(phone),
        },
      },
      checkoutOptions: {
        askForShippingAddress: false,
        merchantSupportEmail: process.env.SQUARE_SUPPORT_EMAIL || "coastaltideescapesllc@gmail.com",
        redirectUrl: process.env.GIVEAWAY_THANK_YOU_URL || "https://coastaltideescapes.com/beach-stay-giveaway?paid=1",
      },
      prePopulatedData: { buyerEmail },
    };

    const response = await checkoutApi.createPaymentLink(body);
    const pl = response.result && response.result.paymentLink;
    if (!pl || !pl.url) return res.status(500).json({ error: "Square did not return a checkout URL" });
    return res.json({ url: pl.url });
  } catch (err) {
    console.error("Giveaway checkout error:", JSON.stringify((err && err.result) || (err && err.message) || err, null, 2));
    return res.status(500).json({ error: (err && err.message) || "server error" });
  }
});

/* ── GIVEAWAY ROUTE: add a mailed-in FREE entry (admin) ── */
app.post("/giveaway/free-entry", async (req, res) => {
  if (req.header("x-admin-key") !== process.env.GIVEAWAY_ADMIN_KEY) return res.status(401).json({ error: "unauthorized" });
  const { name, email, phone } = req.body || {};
  if (!name) return res.status(400).json({ error: "name required" });
  const num = (await gvMaxTicket()) + 1;
  await gvAppend("Entries!A:J", [[num, safeString(name), safeString(email), safeString(phone), "FREE", "mail-in", "0.00", "", "", new Date().toISOString()]]);
  if (email) await gvEmailTickets(name, email, [num]);
  res.json({ ticket: GV_PAD(num) });
});

/* ── GIVEAWAY ROUTE: diagnose the Google Sheet connection ──
   Call: GET /giveaway/sheet-check?key=YOUR_GIVEAWAY_ADMIN_KEY
   Tells you: is SHEET_ID readable, what tabs exist, and is "Entries" among them. */
app.get("/giveaway/sheet-check", async (req, res) => {
  if (req.query.key !== process.env.GIVEAWAY_ADMIN_KEY) return res.status(401).json({ error: "unauthorized" });
  const out = {
    sheetIdSeen: (process.env.SHEET_ID || "").trim(),
    sheetIdLength: (process.env.SHEET_ID || "").length,
    serviceAccount: null,
  };
  try {
    out.serviceAccount = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON).client_email;
  } catch (e) {
    out.serviceAccountError = "GOOGLE_SERVICE_ACCOUNT_JSON is missing or not valid JSON";
  }
  try {
    const meta = await gvSheets().spreadsheets.get({ spreadsheetId: (process.env.SHEET_ID || "").trim() });
    out.spreadsheetTitle = meta.data.properties && meta.data.properties.title;
    out.tabs = (meta.data.sheets || []).map((s) => s.properties.title);
    out.hasEntriesTab = out.tabs.includes("Entries");
    out.result = out.hasEntriesTab ? "OK — sheet opens and Entries tab found" : "Sheet opens, but NO tab named exactly 'Entries'";
    return res.json(out);
  } catch (err) {
    out.result = "FAILED to open spreadsheet";
    out.error = (err && err.errors) ? err.errors : (err && err.message) || String(err);
    return res.status(500).json(out);
  }
});

/* ── GIVEAWAY ROUTE: draw a random winner (admin) ── */
app.get("/giveaway/draw", async (req, res) => {
  if (req.query.key !== process.env.GIVEAWAY_ADMIN_KEY) return res.status(401).json({ error: "unauthorized" });
  const entries = (await gvGet("Entries!A2:E")).filter((r) => r[0]);
  if (!entries.length) return res.json({ error: "no entries yet" });
  const w = entries[Math.floor(Math.random() * entries.length)];
  res.json({ totalEntries: entries.length, winningTicket: GV_PAD(parseInt(w[0], 10)), name: w[1], email: w[2], phone: w[3], type: w[4] });
});

/* ── GIVEAWAY ROUTE: recover paid entries from Square that never logged ──
   Safe to run repeatedly — already-logged payments are skipped. Processes
   oldest first so ticket numbers follow purchase order.
   Call: GET /giveaway/backfill?key=YOUR_GIVEAWAY_ADMIN_KEY  (&days=14 optional) */
app.get("/giveaway/backfill", async (req, res) => {
  if (req.query.key !== process.env.GIVEAWAY_ADMIN_KEY) return res.status(401).json({ error: "unauthorized" });
  try {
    const days = Math.min(parseInt(req.query.days, 10) || 14, 90);
    const beginTime = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const loc = (LOCATION_ID || "").trim();          // guard against stray newline/whitespace
    let cursor, guard = 0;
    const all = [];

    // Square SDK v39 positional signature:
    //   listPayments(beginTime, endTime, sortOrder, cursor, locationId, ...)
    // Passing `undefined` for middle args yields a malformed query string, so we
    // request only beginTime + cursor, then filter/sort ourselves.
    do {
      const { result } = await client.paymentsApi.listPayments(beginTime, undefined, undefined, cursor);
      for (const p of (result.payments || [])) all.push(p);
      cursor = result.cursor;
      guard++;
    } while (cursor && guard < 10);

    // oldest first, so ticket numbers follow purchase order
    const eligible = all
      .filter((p) => p.status === "COMPLETED")
      .filter((p) => !loc || !p.locationId || p.locationId === loc)
      .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));

    const recovered = [];
    for (const p of eligible) {
      const amt = (p.amountMoney && p.amountMoney.amount) ? Number(p.amountMoney.amount) : 0;
      const r = await issueGiveawayTickets(p.id, p.orderId, amt);
      if (r.status === "ok") recovered.push({ payment: p.id, name: r.name, email: r.email, tickets: r.tickets.map(GV_PAD) });
    }
    res.json({ scanned: all.length, eligible: eligible.length, recoveredCount: recovered.length, recovered });
  } catch (err) {
    const detail = (err && err.errors) ? err.errors
                 : (err && err.result && err.result.errors) ? err.result.errors
                 : (err && err.message) || String(err);
    console.error("backfill error:", JSON.stringify(detail));
    res.status(500).json({ error: "backfill failed", detail });
  }
});

app.post("/square-webhook", async (req, res) => {
  // ── Optional signature verification. Active only once you set BOTH
  //    SQUARE_WEBHOOK_SIGNATURE_KEY and SQUARE_WEBHOOK_URL (recommended).
  //    If unset, behaves exactly as before (no verification).
  if (process.env.SQUARE_WEBHOOK_SIGNATURE_KEY && process.env.SQUARE_WEBHOOK_URL) {
    try {
      const sig = req.header("x-square-hmacsha256-signature") || "";
      const raw = req.rawBody ? req.rawBody.toString("utf8") : JSON.stringify(req.body || {});
      const expected = crypto
        .createHmac("sha256", process.env.SQUARE_WEBHOOK_SIGNATURE_KEY)
        .update(process.env.SQUARE_WEBHOOK_URL + raw)
        .digest("base64");
      const valid = sig.length === expected.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
      if (!valid) return res.sendStatus(403);
    } catch (e) {
      return res.sendStatus(403);
    }
  }

  res.status(200).json({ ok: true });
  try {
    const event = req.body;
    if (!event) return;

    // ── GIVEAWAY branch: completed giveaway payments get ticket numbers ──
    if (event.type === "payment.updated" || event.type === "payment.created") {
      const gp = event.data && event.data.object && event.data.object.payment;
      if (gp && gp.status === "COMPLETED" && gp.order_id) {
        const handled = await handleGiveawayWebhook(gp);
        if (handled) return; // giveaway payment done; don't run booking logic
      }
    }

    // ── EXISTING BOOKING logic (unchanged) ──
    if (event.type !== "payment.completed") return;

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
          const m = order.metadata || {};
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
