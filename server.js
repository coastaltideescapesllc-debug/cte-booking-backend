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
  if (digits.length === 10) return "+1" + digits;
  if (digits.length === 11 && digits[0] === "1") return "+" + digits;
  if (s.startsWith("+") && digits.length >= 10) return "+" + digits;
  return s;
}

function squareBaseUrl() {
  return SQUARE_ENV === "sandbox"
    ? "https://connect.squareupsandbox.com"
    : "https://connect.squareup.com";
}

// Preserve POST across Google Apps Script redirect (302)
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

/**
 * WIDGET PAGE: Host the full booking widget (HTML + JS) here.
 * Tailor Brands HTML Content will embed this via iframe.
 */
app.get("/widget", (_req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Coastal Tide Escapes Booking</title>
</head>
<body style="margin:0; padding:16px; font-family:Arial,Helvetica,sans-serif; background:#ffffff;">

<!-- Coastal Tide Escapes Booking Widget -->
<div id="cte-booking-widget" style="max-width: 480px; margin: 0 auto; padding: 1.5rem; border: 1px solid #ddd; border-radius: 12px;">
  <h2 style="text-align: center; margin-bottom: 1rem;">Book Your Stay</h2>

  <p style="font-size:0.9rem; line-height:1.4; margin-bottom:1rem;">
    <strong>Early Booking Offer:</strong>
    Get <strong>10% off</strong> eligible peak-season stays when you book direct and pay in full between
    <strong>November 28, 2025</strong> and <strong>January 15, 2026</strong>.
  </p>

  <form id="cte-booking-form">
    <div style="margin-bottom: 0.75rem;">
      <label for="cte-guest-name" style="display:block; margin-bottom:0.25rem;">Full Name</label>
      <input type="text" id="cte-guest-name" required style="width:100%; padding:0.5rem;">
    </div>

    <div style="margin-bottom: 0.75rem;">
      <label for="cte-guest-email" style="display:block; margin-bottom:0.25rem;">Email</label>
      <input type="email" id="cte-guest-email" required style="width:100%; padding:0.5rem;">
    </div>

    <div style="margin-bottom: 0.75rem;">
      <label for="cte-guest-phone" style="display:block; margin-bottom:0.25rem;">Phone</label>
      <input type="tel" id="cte-guest-phone" required style="width:100%; padding:0.5rem;">
    </div>

    <div style="margin-bottom: 0.75rem;">
      <label for="cte-checkin" style="display:block; margin-bottom:0.25rem;">Check-in</label>
      <input type="date" id="cte-checkin" required style="width:100%; padding:0.5rem;">
    </div>

    <div style="margin-bottom: 0.75rem;">
      <label for="cte-checkout" style="display:block; margin-bottom:0.25rem;">Check-out</label>
      <input type="date" id="cte-checkout" required style="width:100%; padding:0.5rem;">
    </div>

    <div style="margin-bottom: 0.75rem;">
      <label for="cte-guests" style="display:block; margin-bottom:0.25rem;">Number of Guests</label>
      <input type="number" id="cte-guests" min="1" max="9" value="1" required style="width:100%; padding:0.5rem;">
    </div>

    <div id="cte-error" style="display:none; margin-bottom:0.75rem; color:#b00020; font-size:0.9rem;"></div>

    <button type="submit" style="width:100%; padding:0.75rem; border:none; border-radius:10px; font-size:1rem; cursor:pointer; background:#0b5ea8; color:#fff;">
      See Price &amp; Continue
    </button>
  </form>

  <div id="cte-summary" style="display:none; margin-top:1.5rem;">
    <h3 style="margin-bottom:0.5rem;">Stay Summary</h3>
    <div id="cte-summary-details" style="font-size:0.95rem; margin-bottom:0.5rem;"></div>
    <div id="cte-summary-price" style="font-weight:700; font-size:1.1rem; margin-bottom:0.75rem;"></div>
    <div id="cte-price-breakdown" style="font-size:0.9rem; line-height:1.4; margin-bottom:1rem;"></div>

    <button id="cte-pay-button" type="button" style="width:100%; padding:0.75rem; border:none; border-radius:10px; font-size:1rem; cursor:pointer; background:#0b5ea8; color:#fff;">
      Proceed to Secure Payment
    </button>
  </div>
</div>

<!-- Secure Checkout Notice (Safari / popup guidance) -->
<div id="cte-checkout-notice" style="
  display:none;
  position:fixed;
  inset:0;
  background:rgba(0,0,0,0.55);
  z-index:999999;
  align-items:center;
  justify-content:center;
  padding:16px;">
  <div style="
    background:#ffffff;
    width:100%;
    max-width:460px;
    border-radius:12px;
    padding:18px 18px 14px 18px;
    box-shadow:0 10px 30px rgba(0,0,0,0.25);
    font-family:Arial,Helvetica,sans-serif;
    color:#1f2933;">
    <div style="font-size:16px; font-weight:700; margin-bottom:8px; color:#0b5ea8;">
      Opening Secure Checkout
    </div>
    <div id="cte-checkout-notice-msg" style="font-size:14px; line-height:1.45; margin-bottom:10px;">
      Please click only once. Your secure payment page will open in a new window/tab.
    </div>
    <div style="font-size:12px; color:#5b6770; line-height:1.4; margin-bottom:12px;">
      Mac &amp; Safari users: if nothing appears, please check your pop-up blocker and look for a new tab/window.
    </div>
    <div style="display:flex; gap:10px; justify-content:flex-end;">
      <button type="button" id="cte-checkout-notice-close" style="
        border:1px solid #cbd2d9;
        background:#ffffff;
        color:#1f2933;
        padding:8px 12px;
        border-radius:8px;
        cursor:pointer;">
        OK
      </button>
    </div>
  </div>
</div>

<script>
(function(){
  // Call the backend on the SAME origin (this Render service)
  var BACKEND_URL = "/create-checkout";
  var BRAND = "Coastal Tide Escapes";
  var ACCENT = "#0b5ea8";

  var MEDIA_POOL = [
    { type: "image", src: "https://lirp.cdn-website.com/22b9a45e/dms3rep/multi/opt/blue+gradient+travel+%28Presentation+%28169%29%29-1920w.jpg", alt: "Coastal Tide Escapes" },
    { type: "image", src: "https://lirp.cdn-website.com/22b9a45e/dms3rep/multi/opt/amazing-leisure-beach-couple-chairs-600nw-2439344175.jpg-1920w.webp", alt: "Coastal Tide Escapes" },
    { type: "image", src: "https://lirp.cdn-website.com/22b9a45e/dms3rep/multi/opt/7-1920w.png", alt: "Coastal Tide Escapes" },
    { type: "image", src: "https://lirp.cdn-website.com/22b9a45e/dms3rep/multi/opt/IMG_6922-1920w.jpeg", alt: "Coastal Tide Escapes" }
  ];

  var form           = document.getElementById("cte-booking-form");
  var checkinInput   = document.getElementById("cte-checkin");
  var checkoutInput  = document.getElementById("cte-checkout");
  var guestsInput    = document.getElementById("cte-guests");
  var errorBox       = document.getElementById("cte-error");
  var summarySection = document.getElementById("cte-summary");
  var summaryDetails = document.getElementById("cte-summary-details");
  var summaryPrice   = document.getElementById("cte-summary-price");
  var priceBreakdown = document.getElementById("cte-price-breakdown");
  var payButton      = document.getElementById("cte-pay-button");

  var nameInput  = document.getElementById("cte-guest-name");
  var emailInput = document.getElementById("cte-guest-email");
  var phoneInput = document.getElementById("cte-guest-phone");

  var noticeEl = document.getElementById("cte-checkout-notice");
  var noticeMsgEl = document.getElementById("cte-checkout-notice-msg");
  var noticeCloseBtn = document.getElementById("cte-checkout-notice-close");

  function showCheckoutNotice_(msg){
    if (!noticeEl) return;
    if (noticeMsgEl && msg) noticeMsgEl.textContent = msg;
    noticeEl.style.display = "flex";
  }
  function hideCheckoutNotice_(){
    if (!noticeEl) return;
    noticeEl.style.display = "none";
  }
  if (noticeCloseBtn) noticeCloseBtn.addEventListener("click", hideCheckoutNotice_);

  function pad2(n){ return String(n).padStart(2, "0"); }
  function mdKey(d){ return pad2(d.getMonth()+1) + "-" + pad2(d.getDate()); }
  function isoKey(d){ return d.getFullYear() + "-" + pad2(d.getMonth()+1) + "-" + pad2(d.getDate()); }

  function parseDateInput(v){
    if (!v) return null;
    var parts = v.split("-");
    if (parts.length !== 3) return null;
    var y = parseInt(parts[0],10), m = parseInt(parts[1],10), d = parseInt(parts[2],10);
    if (!y || !m || !d) return null;
    var dt = new Date(y, m-1, d);
    if (dt.getFullYear() !== y || dt.getMonth() !== (m-1) || dt.getDate() !== d) return null;
    return dt;
  }

  function nightsBetween(ci, co){
    var ms = (co.getTime() - ci.getTime());
    return Math.round(ms / 86400000);
  }

  function isWeekend(date){
    var day = date.getDay();
    return day === 5 || day === 6;
  }

  function nightlyRate(date){
    var md = mdKey(date);
    var wknd = isWeekend(date);
    if (md >= "04-01" && md <= "08-31") return wknd ? 325 : 300;
    if ((md >= "03-01" && md <= "03-31") || (md >= "09-01" && md <= "10-31")) return wknd ? 275 : 250;
    return wknd ? 250 : 225;
  }

  function inDiscountWindow(ci, co){
    var nights = nightsBetween(ci, co);
    if (nights < 3) return false;
    for (var i=0; i<nights; i++){
      var d = new Date(ci.getTime() + i*86400000);
      var md = mdKey(d);
      if (md >= "04-01" && md <= "08-31") return true;
    }
    return false;
  }

  function formatMoney(n){ return "$" + n.toFixed(2); }

  function setError(msg){
    if (!msg) { errorBox.style.display = "none"; errorBox.textContent = ""; return; }
    errorBox.style.display = "block";
    errorBox.textContent = msg;
  }

  function looksLikeEmail_(v){
    return /^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(String(v || "").trim());
  }

  function normalizePhone_(v){
    var s = String(v || "").trim();
    var digits = s.replace(/[^\\d]/g, "");
    if (digits.length === 10) return "+1" + digits;
    if (digits.length === 11 && digits[0] === "1") return "+" + digits;
    if (s.startsWith("+") && digits.length >= 10) return "+" + digits;
    return s;
  }

  function escapeHtml_(s){
    return String(s || "")
      .replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")
      .replace(/"/g,"&quot;").replace(/'/g,"&#039;");
  }

  function chooseMediaPerSession_(){
    try {
      var key = "cte_checkout_media_index";
      var existing = sessionStorage.getItem(key);
      var idx = existing !== null ? parseInt(existing, 10) : NaN;
      if (!Number.isFinite(idx) || idx < 0 || idx >= MEDIA_POOL.length) {
        idx = Math.floor(Math.random() * MEDIA_POOL.length);
        sessionStorage.setItem(key, String(idx));
      }
      return MEDIA_POOL[idx] || MEDIA_POOL[0];
    } catch (e) {
      return MEDIA_POOL[Math.floor(Math.random() * MEDIA_POOL.length)] || MEDIA_POOL[0];
    }
  }

  function writeBrandedLoadingPage_(checkoutWin){
    if (!checkoutWin) return;
    var media = chooseMediaPerSession_();
    var mediaHtml =
      '<img class="hero" src="' + escapeHtml_(media.src) + '" alt="' + escapeHtml_(media.alt || BRAND) + '">';

    var html =
      '<!doctype html><html><head><meta charset="utf-8">' +
      '<meta name="viewport" content="width=device-width, initial-scale=1">' +
      '<title>Opening Secure Checkout</title>' +
      '<style>' +
        'html,body{height:100%;margin:0;font-family:Arial,Helvetica,sans-serif;background:#0b1220;color:#fff;}' +
        '.wrap{min-height:100%;display:flex;align-items:center;justify-content:center;padding:18px;}' +
        '.card{width:100%;max-width:640px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.14);' +
              'border-radius:16px;overflow:hidden;box-shadow:0 18px 50px rgba(0,0,0,.35);}' +
        '.hero{display:block;width:100%;height:320px;object-fit:cover;background:#111827;}' +
        '.content{padding:16px 16px 18px 16px;}' +
        '.title{font-size:18px;font-weight:800;margin:0;color:#fff;}' +
        '.sub{margin:8px 0 0 0;font-size:14px;line-height:1.45;color:rgba(255,255,255,.85);}' +
        '.row{display:flex;align-items:center;gap:10px;margin-top:14px;}' +
        '.spinner{width:26px;height:26px;border-radius:50%;border:4px solid rgba(255,255,255,.25);border-top-color:' + ACCENT + ';animation:spin 1s linear infinite;}' +
        '@keyframes spin{to{transform:rotate(360deg);}}' +
        '.hint{margin-top:12px;font-size:12px;line-height:1.4;color:rgba(255,255,255,.75);}' +
        '.pill{display:inline-block;margin-top:10px;padding:6px 10px;border-radius:999px;background:rgba(11,94,168,.25);border:1px solid rgba(11,94,168,.5);font-size:12px;}' +
      '</style></head><body>' +
        '<div class="wrap"><div class="card">' +
          mediaHtml +
          '<div class="content">' +
            '<p class="title">Opening Secure Checkout</p>' +
            '<p class="sub">We are generating your private payment link. This usually takes a moment.</p>' +
            '<div class="row"><div class="spinner" aria-label="Loading"></div><div class="pill">' + escapeHtml_(BRAND) + '</div></div>' +
            '<div class="hint">If checkout doesn\\'t open within 10 seconds, your browser may have blocked the pop-up. Look for a new tab/window, then return and try again.</div>' +
          '</div>' +
        '</div></div>' +
      '</body></html>';

    try {
      checkoutWin.document.open();
      checkoutWin.document.write(html);
      checkoutWin.document.close();
    } catch (e) {}
  }

  var lastBooking = null;

  form.addEventListener("submit", function(e){
    e.preventDefault();
    setError(null);

    var guestName = String(nameInput.value || "").trim();
    var guestEmail = String(emailInput.value || "").trim();
    var guestPhone = normalizePhone_(phoneInput.value);

    if (!guestName) return setError("Please enter your full name.");
    if (!looksLikeEmail_(guestEmail)) return setError("Please enter a valid email address.");
    if (!guestPhone) return setError("Please enter a valid phone number.");

    var ciDate = parseDateInput(checkinInput.value);
    var coDate = parseDateInput(checkoutInput.value);
    var guests = parseInt(guestsInput.value, 10);

    if (!ciDate || !coDate) return setError("Please select valid check-in and check-out dates.");
    if (coDate <= ciDate) return setError("Check-out must be after check-in.");
    if (!guests || guests < 1 || guests > 9) return setError("Please enter a guest count between 1 and 9.");

    var nights = nightsBetween(ciDate, coDate);
    if (nights <= 0) return setError("Please select at least 1 night.");

    var lodging = 0;
    for (var i=0; i<nights; i++){
      var d = new Date(ciDate.getTime() + i*86400000);
      lodging += nightlyRate(d);
    }

    var CLEANING = 150;
    var TAX_RATE = 0.07;
    var preTax = lodging + CLEANING;

    var discountApplied = false;
    var discountAmount = 0;
    if (inDiscountWindow(ciDate, coDate)){
      discountApplied = true;
      discountAmount = preTax * 0.10;
      preTax = preTax - discountAmount;
    }

    var tax = preTax * TAX_RATE;
    var total = preTax + tax;

    lastBooking = {
      guestName: guestName,
      guestEmail: guestEmail,
      guestPhone: guestPhone,
      checkin: isoKey(ciDate),
      checkout: isoKey(coDate),
      guests: guests,
      nights: nights,
      lodging: lodging,
      cleaning: CLEANING,
      preTaxTotal: preTax,
      discountApplied: discountApplied,
      discountAmount: discountAmount,
      taxAmount: tax,
      grandTotal: total,
      rateModeLabel: discountApplied ? "Direct Booking Discount Applied" : "Standard Rate"
    };

    summaryDetails.textContent = lastBooking.nights + " nights • " + lastBooking.guests + " guests • " + lastBooking.checkin + " to " + lastBooking.checkout;
    summaryPrice.textContent = "Estimated Total: " + formatMoney(lastBooking.grandTotal);

    var breakdownLines = [];
    breakdownLines.push("Lodging: " + formatMoney(lastBooking.lodging));
    breakdownLines.push("Cleaning: " + formatMoney(lastBooking.cleaning));
    if (lastBooking.discountApplied) breakdownLines.push("Direct Booking Discount (10%): - " + formatMoney(lastBooking.discountAmount));
    breakdownLines.push("Tax (7%): " + formatMoney(lastBooking.taxAmount));
    priceBreakdown.innerHTML = breakdownLines.map(function(x){ return "• " + x; }).join("<br>");

    summarySection.style.display = "block";
    summarySection.scrollIntoView({ behavior: "smooth", block: "start" });
  });

  payButton.addEventListener("click", function(){
    if (!lastBooking) return;

    showCheckoutNotice_("Opening secure checkout… Please click only once. A new window/tab will open.");
    payButton.disabled = true;
    payButton.style.opacity = "0.75";
    var originalPayText = payButton.textContent;
    payButton.textContent = "Opening secure checkout…";

    var checkoutWin = window.open("about:blank", "_blank");
    if (checkoutWin) writeBrandedLoadingPage_(checkoutWin);

    fetch(BACKEND_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        guestName: lastBooking.guestName,
        guestEmail: lastBooking.guestEmail,
        guestPhone: lastBooking.guestPhone,
        total: lastBooking.grandTotal,
        checkin: lastBooking.checkin,
        checkout: lastBooking.checkout,
        guests: lastBooking.guests,
        nights: lastBooking.nights,
        lodging: lastBooking.lodging,
        cleaning: lastBooking.cleaning,
        discountApplied: lastBooking.discountApplied,
        discountAmount: lastBooking.discountAmount,
        preTaxTotal: lastBooking.preTaxTotal,
        taxAmount: lastBooking.taxAmount,
        rateMode: lastBooking.rateModeLabel
      })
    })
    .then(function(r){ return r.json().then(function(d){ if(!r.ok) throw new Error("Backend error"); return d || {}; }); })
    .then(function(data){
      var checkoutUrl = data.url || data.squareCheckoutUrl;
      if (checkoutUrl) {
        if (checkoutWin) checkoutWin.location.href = checkoutUrl;
        else window.location.href = checkoutUrl;
        setTimeout(function(){ hideCheckoutNotice_(); }, 1800);
      } else {
        if (checkoutWin) checkoutWin.close();
        hideCheckoutNotice_();
        alert("There was a problem creating your payment link. Please try again or contact us.");
      }
    })
    .catch(function(){
      if (checkoutWin) checkoutWin.close();
      hideCheckoutNotice_();
      alert("There was a problem connecting to our payment system. Please try again or contact us.");
    })
    .finally(function(){
      setTimeout(function(){
        payButton.disabled = false;
        payButton.style.opacity = "1";
        payButton.textContent = originalPayText;
      }, 4000);
    });
  });
})();
</script>

</body>
</html>`);
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
      lodging,
      cleaning,
      discountApplied,
      discountAmount,
      preTaxTotal,
      taxAmount,
      rateMode,
    } = req.body || {};

    const cents = toCents(total);
    if (!cents || cents < 1) return res.status(400).json({ ok: false, error: "Invalid total" });
    if (!checkin || !checkout || !guests || !nights) return res.status(400).json({ ok: false, error: "Missing stay details" });

    const bookingRef = makeBookingRef();
    const phoneE164 = guestPhone ? normalizePhoneE164(guestPhone) : "";

    const squareUrl = `${squareBaseUrl()}/v2/online-checkout/payment-links`;
    const squareBody = {
      idempotency_key: crypto.randomUUID(),
      quick_pay: {
        name: `Coastal Tide Escapes – Booking (${bookingRef})`,
        price_money: { amount: cents, currency: "USD" },
        location_id: SQUARE_LOCATION_ID,
      },
      pre_populated_data: {
        ...(guestEmail ? { buyer_email: String(guestEmail).trim() } : {}),
        ...(phoneE164 ? { buyer_phone_number: String(phoneE164).trim() } : {}),
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
      action: "appendLead",
      secret: CTE_SHEETS_WEBHOOK_SECRET,
      bookingRef,
      createdAt: new Date().toISOString(),
      source: "website-widget",

      guestName: guestName ? String(guestName).trim() : "",
      guestEmail: guestEmail ? String(guestEmail).trim() : "",
      guestPhone: phoneE164 ? String(phoneE164).trim() : "",

      checkin,
      checkout,
      guests,
      nights,

      lodging: Number(lodging),
      cleaning: Number(cleaning),

      total: Number(total),
      discountApplied: !!discountApplied,
      discountAmount: Number(discountAmount || 0),
      preTaxTotal: Number(preTaxTotal || 0),
      taxAmount: Number(taxAmount || 0),
      rateMode: String(rateMode || ""),

      squareCheckoutUrl,
    };

    await postJsonFollowRedirectPreserveMethod(CTE_SHEETS_WEBHOOK_URL, leadPayload, 12000);

    return res.json({
      ok: true,
      bookingRef,
      url: squareCheckoutUrl,
      squareCheckoutUrl,
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});

app.listen(PORT, () => {
  console.log(\`Coastal Tide backend listening on port \${PORT}\`);
});


