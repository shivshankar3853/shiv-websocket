require("dotenv").config();
const express = require("express");
const cors = require("cors");
const axios = require("axios");
const cron = require("node-cron");
const { createClient } = require("@supabase/supabase-js");

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 5000;

// ===============================
// Supabase Configuration
// ===============================
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// ===============================
// Upstox Token Storage
// ===============================
let upstoxAccessToken = null;
let upstoxRefreshToken = null;
let tokenExpiryTime = null;

// Save tokens to Supabase
async function saveTokensToDB(accessToken, refreshToken) {
  try {
    await supabase.from("auth_tokens").delete().neq("access_token", "dummy");
    await supabase.from("auth_tokens").insert([
      { access_token: accessToken, refresh_token: refreshToken, updated_at: new Date().toISOString() }
    ]);
    console.log("✅ Tokens saved to Supabase");
  } catch (err) {
    console.error("❌ Error saving tokens:", err.message);
  }
}

// Load tokens from Supabase
async function loadTokensFromDB() {
  try {
    const { data } = await supabase
      .from("auth_tokens")
      .select("*")
      .order("updated_at", { ascending: false })
      .limit(1);

    if (data && data.length > 0) {
      upstoxAccessToken = data[0].access_token;
      upstoxRefreshToken = data[0].refresh_token;
      tokenExpiryTime = Date.now() + 23 * 60 * 60 * 1000;
      console.log("✅ Tokens loaded from Supabase");
      return true;
    }
    console.log("⚠️ No tokens found");
    return false;
  } catch (err) {
    console.error("❌ Error loading tokens:", err.message);
    return false;
  }
}

// ===============================
// Risk Management
// ===============================
const MAX_CAPITAL_PER_TRADE = parseFloat(process.env.MAX_CAPITAL_PER_TRADE || 10000);
const MAX_TOTAL_POSITIONS = parseInt(process.env.MAX_TOTAL_POSITIONS || 5);
const MAX_QUANTITY_PER_TRADE = parseInt(process.env.MAX_QUANTITY_PER_TRADE || 100);
const DUPLICATE_SIGNAL_WINDOW = 60 * 1000; // 1 min
const recentSignals = new Map();

function isDuplicateSignal(symbol, action) {
  const key = `${symbol}-${action}`;
  const now = Date.now();
  const last = recentSignals.get(key);
  if (last && now - last < DUPLICATE_SIGNAL_WINDOW) return true;
  recentSignals.set(key, now);
  if (recentSignals.size > 100) {
    for (const [k, v] of recentSignals.entries()) if (now - v > DUPLICATE_SIGNAL_WINDOW) recentSignals.delete(k);
  }
  return false;
}

// ===============================
// Ensure Access Token
// ===============================
async function ensureValidAccessToken() {
  if (!upstoxAccessToken) return false;
  if (Date.now() >= tokenExpiryTime - 60000) {
    console.log("🔄 Refreshing token...");
    try {
      const res = await axios.post(
        "https://api.upstox.com/v2/login/authorization/token",
        new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: upstoxRefreshToken,
          client_id: process.env.UPSTOX_CLIENT_ID,
          client_secret: process.env.UPSTOX_CLIENT_SECRET
        }),
        { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
      );
      upstoxAccessToken = res.data.access_token;
      upstoxRefreshToken = res.data.refresh_token;
      tokenExpiryTime = Date.now() + 23 * 60 * 60 * 1000;
      await saveTokensToDB(upstoxAccessToken, upstoxRefreshToken);
      console.log("✅ Token refreshed");
      return true;
    } catch (err) {
      console.error("❌ Token refresh failed:", err.response?.data || err.message);
      return false;
    }
  }
  return true;
}

// ===============================
// Normalize symbol for DB lookup
// ===============================
function normalizeSymbol(tvSymbol) {
  return tvSymbol.trim().replace(/\s+/g, " ");
}

// ===============================
// Get Instrument from DB
// ===============================
async function getInstrument(tvSymbol) {
  const normalized = normalizeSymbol(tvSymbol);
  try {
    const { data } = await supabase
      .from("instruments_upstoxmaster")
      .select("instrument_key, lot_size, segment, instrument_type")
      .eq("trading_symbol", normalized)
      .single();

    if (!data) return null;
    return data;
  } catch (err) {
    console.error("❌ Instrument fetch error:", err.message);
    return null;
  }
}

// ===============================
// Get Positions & Funds
// ===============================
async function getPositions() {
  try {
    const res = await axios.get("https://api.upstox.com/v2/portfolio/short-term-positions", {
      headers: { Authorization: `Bearer ${upstoxAccessToken}` }
    });
    return res.data.data || [];
  } catch (err) {
    console.error("❌ Positions fetch error:", err.response?.data || err.message);
    return [];
  }
}

async function getFunds() {
  try {
    const res = await axios.get("https://api.upstox.com/v2/user/get-funds-and-margin", {
      headers: { Authorization: `Bearer ${upstoxAccessToken}` }
    });
    return res.data.data || null;
  } catch (err) {
    console.error("❌ Funds fetch error:", err.response?.data || err.message);
    return null;
  }
}

// ===============================
// Log Webhook
// ===============================
async function logWebhookOrder(data, status, reason = null, orderId = null) {
  try {
    await supabase.from("tradingview_logs").insert([{
      symbol: data.symbol || data.instrument_token || "UNKNOWN",
      action: data.action,
      quantity: data.quantity,
      product: data.product,
      price: data.price || 0,
      status,
      reason,
      order_id: orderId,
      payload: data,
      created_at: new Date().toISOString()
    }]);
  } catch (err) {
    console.error("❌ Log error:", err.message);
  }
}

// ===============================
// Determine Product Type
// ===============================
function getProductType(segment) {
  if (segment === "NSE_FO") return "I"; // Intraday F&O is 'I' in Upstox V2
  return "D"; // Equity or Carry Forward F&O
}

// ===============================
// TradingView Webhook
// ===============================
app.post("/webhook/tradingview", async (req, res) => {
  try {
    const data = req.body;
    if (!data.token || data.token !== process.env.WEBHOOK_SECRET)
      return res.status(401).json({ error: "Unauthorized" });

    // Allow either symbol or instrument_token
    if ((!data.symbol && !data.instrument_token) || !data.action || !data.product || !data.quantity)
      return res.status(400).json({ error: "Invalid payload" });

    const lookupValue = data.instrument_token || data.symbol;
    if (isDuplicateSignal(lookupValue, data.action)) {
      await logWebhookOrder(data, "skipped", "duplicate signal");
      return res.json({ status: "skipped", reason: "duplicate signal" });
    }

    res.json({ status: "received" }); // immediate response
    console.log("📥 Received signal for:", lookupValue);

    if (!(await ensureValidAccessToken())) {
      console.error("❌ Access token invalid");
      await logWebhookOrder(data, "failed", "invalid access token");
      return;
    }

    // Lookup instrument details (lot_size, segment, etc.)
    let instrument = null;
    if (data.instrument_token) {
      const { data: instData, error: instError } = await supabase
        .from("instruments_upstoxmaster")
        .select("instrument_key, lot_size, segment, instrument_type, trading_symbol")
        .eq("instrument_key", data.instrument_token)
        .maybeSingle(); // Use maybeSingle to avoid coercion error if not found
      
      if (instError) console.error("❌ Supabase lookup error:", instError.message);
      instrument = instData;
    } else {
      instrument = await getInstrument(data.symbol);
    }

    if (!instrument && !data.instrument_token) {
      console.error("❌ Instrument not found for:", lookupValue);
      await logWebhookOrder(data, "failed", "instrument not found");
      return;
    }

    // Use provided token or lookup token
    const finalInstrumentToken = data.instrument_token || instrument.instrument_key;
    const finalLotSize = instrument?.lot_size || 1;
    const finalSegment = instrument?.segment || "NSE_EQ";
    const finalTradingSymbol = instrument?.trading_symbol || (data.symbol?.split(":")[1] || data.symbol);

    console.log(`🔍 Instrument: ${finalTradingSymbol}, Token: ${finalInstrumentToken}, Lot Size: ${finalLotSize}`);

    const finalQuantity = data.quantity * finalLotSize;
    const productType = getProductType(finalSegment);

    const positions = await getPositions();
    const existing = positions.find(p => p.trading_symbol === finalTradingSymbol);

    // Position Checks
    if (data.action === "BUY" && existing?.quantity > 0) {
      console.log("⏭️ Already long, skipping");
      await logWebhookOrder(data, "skipped", "already long");
      return;
    }
    if (data.action === "SELL" && existing?.quantity < 0) {
      console.log("⏭️ Already short, skipping");
      await logWebhookOrder(data, "skipped", "already short");
      return;
    }

    // Max positions
    const active = positions.filter(p => parseInt(p.quantity) !== 0);
    if (active.length >= MAX_TOTAL_POSITIONS && !existing) {
      console.log("⏭️ Max positions reached:", active.length);
      await logWebhookOrder(data, "skipped", "max positions reached");
      return;
    }

    if (finalQuantity > MAX_QUANTITY_PER_TRADE) {
      console.log("⏭️ Quantity exceeds max:", finalQuantity);
      await logWebhookOrder(data, "skipped", "quantity exceeds max");
      return;
    }

    const funds = await getFunds();
    if (!funds) {
      console.log("❌ Funds unavailable");
      await logWebhookOrder(data, "failed", "funds unavailable");
      return;
    }

    const price = data.price || 0;
    const requiredCapital = price * finalQuantity;
    if (requiredCapital > MAX_CAPITAL_PER_TRADE || (funds.equity && requiredCapital > funds.equity.available_margin)) {
      console.log(`⏭️ Capital/Margin check failed. Req: ${requiredCapital}, Max: ${MAX_CAPITAL_PER_TRADE}, Avail: ${funds.equity?.available_margin}`);
      await logWebhookOrder(data, "skipped", "capital/margin exceeded");
      return;
    }

    // Place Order
    console.log("📤 Placing Upstox order with token:", finalInstrumentToken);
    const orderRes = await axios.post(
      "https://api.upstox.com/v2/order/place",
      {
        quantity: finalQuantity,
        product: productType,
        validity: "DAY",
        price: data.price || 0,
        tag: "tv-order",
        instrument_token: finalInstrumentToken,
        order_type: data.order_type || "MARKET",
        transaction_type: data.action,
        disclosed_quantity: 0,
        trigger_price: 0,
        is_amo: data.is_amo || false
      },
      { headers: { Authorization: `Bearer ${upstoxAccessToken}` } }
    );

    console.log("✅ Upstox Response:", orderRes.data);
    await logWebhookOrder(data, "success", null, orderRes.data.data.order_id);
  } catch (err) {
    console.error("❌ Webhook Error:", err.response?.data || err.message);
    await logWebhookOrder(req.body, "failed", err.response?.data?.errors?.[0]?.message || err.message);
  }
});

// ===============================
// Upstox OAuth
// ===============================
app.get("/auth/login", (req, res) => {
  const redirectUri = process.env.UPSTOX_REDIRECT_URI || `${process.env.BACKEND_URL}/auth/callback`;
  const returnUrl = req.query.return_url || "http://localhost:3000";
  const authUrl = `https://api.upstox.com/v2/login/authorization/dialog?response_type=code&client_id=${process.env.UPSTOX_CLIENT_ID}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${encodeURIComponent(returnUrl)}`;
  res.redirect(authUrl);
});

app.get("/auth/callback", async (req, res) => {
  try {
    const code = req.query.code;
    const returnUrl = req.query.state || "http://localhost:3000";
    if (!code) return res.status(400).send("No auth code received");

    const redirectUri = process.env.UPSTOX_REDIRECT_URI || `${process.env.BACKEND_URL}/auth/callback`;
    const tokenRes = await axios.post(
      "https://api.upstox.com/v2/login/authorization/token",
      new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: process.env.UPSTOX_CLIENT_ID,
        client_secret: process.env.UPSTOX_CLIENT_SECRET,
        redirect_uri: redirectUri
      }),
      { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
    );

    upstoxAccessToken = tokenRes.data.access_token;
    upstoxRefreshToken = tokenRes.data.refresh_token;
    tokenExpiryTime = Date.now() + 23 * 60 * 60 * 1000;
    await saveTokensToDB(upstoxAccessToken, upstoxRefreshToken);
    res.redirect(`${returnUrl}?token=${encodeURIComponent(upstoxAccessToken)}`);
  } catch (err) {
    console.error("❌ Auth callback error:", err.response?.data || err.message);
    res.status(500).send("Auth Failed");
  }
});

// ===============================
// Cron Jobs
// ===============================
function scheduleCronJobs() {
  // Token refresh every 20 hours
  cron.schedule("0 */20 * * *", async () => {
    if (upstoxRefreshToken) await ensureValidAccessToken();
  });

  // Clean logs older than 30 days
  cron.schedule("0 0 * * *", async () => {
    try {
      const expiry = new Date();
      expiry.setDate(expiry.getDate() - 30);
      await supabase.from("tradingview_logs").delete().lt("created_at", expiry.toISOString());
      console.log("🧹 Old logs cleaned");
    } catch (err) {
      console.error("❌ Log cleanup failed:", err.message);
    }
  });
}

// ===============================
// Start Server
// ===============================
app.listen(PORT, async () => {
  console.log(`🚀 Server running on port ${PORT}`);
  await loadTokensFromDB();
  scheduleCronJobs();
});