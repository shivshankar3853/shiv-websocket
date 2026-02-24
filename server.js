require("dotenv").config();
const express = require("express");
const axios = require("axios");
const fs = require("fs");
const cron = require("node-cron");
const { createClient } = require("@supabase/supabase-js");
const csv = require("csv-parser");
const zlib = require("zlib");
const { finished } = require("stream/promises");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 5000;

// ===============================
// Supabase Configuration
// ===============================
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

// ===============================
// Store Upstox Tokens (Memory + DB)
// ===============================
let upstoxAccessToken = null;
let upstoxRefreshToken = null;
let tokenExpiryTime = null;

// Helper: Save tokens to Supabase
async function saveTokensToDB(accessToken, refreshToken) {
  try {
    console.log("💾 Saving tokens to Supabase...");
    
    // 1. Delete old tokens (as requested: remove old non useable token from db)
    const { error: deleteError } = await supabase
      .from("auth_tokens")
      .delete()
      .neq("access_token", "dummy"); // Delete all

    if (deleteError) throw deleteError;

    // 2. Insert new tokens
    const { error: insertError } = await supabase
      .from("auth_tokens")
      .insert([
        { 
          access_token: accessToken, 
          refresh_token: refreshToken,
          updated_at: new Date().toISOString()
        }
      ]);

    if (insertError) throw insertError;

    console.log("✅ Tokens saved to Supabase successfully");
  } catch (error) {
    console.error("❌ Supabase Save Error:", error.message);
  }
}

// Helper: Load tokens from Supabase
async function loadTokensFromDB() {
  try {
    console.log("🔄 Loading tokens from Supabase...");
    const { data, error } = await supabase
      .from("auth_tokens")
      .select("*")
      .order("updated_at", { ascending: false })
      .limit(1);

    if (error) throw error;

    if (data && data.length > 0) {
      upstoxAccessToken = data[0].access_token;
      upstoxRefreshToken = data[0].refresh_token;
      // We don't store expiry in DB currently, but Upstox tokens usually last 24h.
      // We'll set it to 23 hours from now if we just loaded it, 
      // or we could just rely on the next refresh cycle.
      tokenExpiryTime = Date.now() + 23 * 60 * 60 * 1000; 
      console.log("✅ Tokens loaded from Supabase");
      return true;
    } else {
      console.log("⚠️ No tokens found in Supabase");
      return false;
    }
  } catch (error) {
    console.error("❌ Supabase Load Error:", error.message);
    return false;
  }
}

// ===============================
// Risk Management & Settings
// ===============================
const MAX_CAPITAL_PER_TRADE = process.env.MAX_CAPITAL_PER_TRADE || 10000; // Default 10k
const MAX_TOTAL_POSITIONS = process.env.MAX_TOTAL_POSITIONS || 5;
const MAX_QUANTITY_PER_TRADE = process.env.MAX_QUANTITY_PER_TRADE || 100;
const DUPLICATE_SIGNAL_WINDOW = 60000; // 1 minute in ms
const recentSignals = new Map();

// ===============================
// Instrument Map (Symbol → Token)
// ===============================
let instrumentMap = {};

// ===============================
// Load/Sync Instrument Master
// ===============================
async function syncInstruments() {
  const segments = ["NSE", "NFO", "MCX", "CDS"];
  console.log("📥 Starting instrument sync for:", segments.join(", "));

  for (const segment of segments) {
    try {
      const url = `https://api.upstox.com/v2/instruments/short_name/${segment}.csv.gz`;
      console.log(`🌐 Fetching ${segment} instruments...`);

      const response = await axios({
        method: "get",
        url: url,
        responseType: "stream",
      });

      const gunzip = zlib.createGunzip();
      const parser = csv();

      response.data.pipe(gunzip).pipe(parser);

      parser.on("data", (row) => {
        // Upstox CSV columns: instrument_key, exchange_token, trading_symbol, etc.
        const symbol = row.trading_symbol;
        const key = row.instrument_key;
        if (symbol && key) {
          instrumentMap[symbol] = key;
        }
      });

      await finished(parser);
      console.log(`✅ ${segment} sync completed.`);
    } catch (error) {
      console.error(`❌ Error syncing ${segment}:`, error.message);
    }
  }

  console.log(
    `✨ Total Instruments in Map: ${Object.keys(instrumentMap).length}`
  );
}

// ===============================
// Helper: Get Instrument Token
// ===============================
function getInstrumentToken(symbol) {
  // Input could be "NSE:SBIN" or "NFO:NIFTY23OCT19500CE"
  const parts = symbol.split(":");
  const tradingSymbol = parts.length > 1 ? parts[1] : parts[0];

  const token = instrumentMap[tradingSymbol];

  if (!token) {
    console.log("❌ Instrument Not Found in Map:", tradingSymbol);
    return null;
  }

  return token;
}

// ===============================
// Helper: Get Positions
// ===============================
async function getPositions() {
  try {
    const response = await axios.get("https://api.upstox.com/v2/portfolio/short-term-positions", {
      headers: {
        Authorization: `Bearer ${upstoxAccessToken}`,
        Accept: "application/json",
      },
    });
    return response.data.data || [];
  } catch (error) {
    console.error("❌ Fetch Positions Error:", error.response?.data || error.message);
    return [];
  }
}

// ===============================
// Helper: Get Funds
// ===============================
async function getFunds() {
  try {
    const response = await axios.get("https://api.upstox.com/v2/user/get-funds-and-margin", {
      headers: {
        Authorization: `Bearer ${upstoxAccessToken}`,
        Accept: "application/json",
      },
    });
    return response.data.data || null;
  } catch (error) {
    console.error("❌ Fetch Funds Error:", error.response?.data || error.message);
    return null;
  }
}

// ===============================
// Helper: Check for Duplicate Signal
// ===============================
function isDuplicateSignal(symbol, action) {
  const key = `${symbol}-${action}`;
  const now = Date.now();
  const lastTime = recentSignals.get(key);

  if (lastTime && (now - lastTime) < DUPLICATE_SIGNAL_WINDOW) {
    return true;
  }

  recentSignals.set(key, now);
  // Clean up old signals every now and then
  if (recentSignals.size > 100) {
    for (const [k, v] of recentSignals.entries()) {
      if (now - v > DUPLICATE_SIGNAL_WINDOW) recentSignals.delete(k);
    }
  }
  return false;
}

// ===============================
// Helper: Check & Refresh Token
// ===============================
async function ensureValidAccessToken() {
  if (!upstoxAccessToken) return false;

  if (Date.now() >= tokenExpiryTime - 60000) {
    console.log("🔄 Refreshing Access Token...");

    try {
      const response = await axios.post(
        "https://api.upstox.com/v2/login/authorization/token",
        new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: upstoxRefreshToken,
          client_id: process.env.UPSTOX_CLIENT_ID,
          client_secret: process.env.UPSTOX_CLIENT_SECRET,
        }),
        {
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
          },
        }
      );

      upstoxAccessToken = response.data.access_token;
      upstoxRefreshToken = response.data.refresh_token;
      tokenExpiryTime = Date.now() + 23 * 60 * 60 * 1000;

      console.log("✅ Token Refreshed Successfully");

      // Persist refreshed tokens to Supabase
      await saveTokensToDB(upstoxAccessToken, upstoxRefreshToken);
    } catch (error) {
      console.error(
        "❌ Token Refresh Failed:",
        error.response?.data || error.message
      );
      return false;
    }
  }

  return true;
}

// ===============================
// Health Route
// ===============================
app.get("/", (req, res) => {
  res.send("TradingView Webhook Server Running");
});

// ===============================
// Render Service Control
// ===============================
const RENDER_API_KEY = process.env.RENDER_API_KEY || "rnd_uq7DTg3YkAw9jVq2ta9BVNzWDHEx";
const SERVICE_ID = process.env.SERVICE_ID || "srv-d6dgj1a4d50c73apk16g";

app.post("/service/restart", async (req, res) => {
  try {
    console.log("🔄 Restarting Render service...");
    const response = await axios.post(
      `https://api.render.com/v1/services/${SERVICE_ID}/restart`,
      {},
      {
        headers: {
          "Authorization": `Bearer ${RENDER_API_KEY}`,
          "Content-Type": "application/json",
        },
      }
    );
    console.log("✅ Service restart initiated");
    res.json({ status: "restart initiated", data: response.data });
  } catch (error) {
    console.error("❌ Restart Error:", error.response?.data || error.message);
    res.status(500).json({ error: error.response?.data || error.message });
  }
});

app.post("/service/stop", async (req, res) => {
  try {
    console.log("⏹️ Stopping Render service...");
    const response = await axios.post(
      `https://api.render.com/v1/services/${SERVICE_ID}/suspend`,
      {},
      {
        headers: {
          "Authorization": `Bearer ${RENDER_API_KEY}`,
          "Content-Type": "application/json",
        },
      }
    );
    console.log("✅ Service stopped");
    res.json({ status: "service stopped", data: response.data });
  } catch (error) {
    console.error("❌ Stop Error:", error.response?.data || error.message);
    res.status(500).json({ error: error.response?.data || error.message });
  }
});

// ===============================
// TradingView Webhook
// ===============================
app.post("/webhook/tradingview", async (req, res) => {
  try {
    const data = req.body;

    if (!data.token || data.token !== process.env.WEBHOOK_SECRET) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    if (!data.symbol || !data.action || !data.quantity) {
      return res.status(400).json({ error: "Invalid payload" });
    }

    console.log("📩 Webhook Received:", data);

    // 1. Prevent Duplicate Signals
    if (isDuplicateSignal(data.symbol, data.action)) {
      console.log(`⚠️ Duplicate signal detected for ${data.symbol} - ${data.action}. Skipping.`);
      return res.status(200).json({ status: "skipped", reason: "duplicate signal" });
    }

    // Respond immediately to TradingView
    res.status(200).json({ status: "received" });

    if (!(await ensureValidAccessToken())) {
      console.log("❌ No valid access token.");
      return;
    }

    const instrumentToken = getInstrumentToken(data.symbol);
    if (!instrumentToken) return;

    // 2. Position Checking
    const positions = await getPositions();
    const tradingSymbol = data.symbol.split(":")[1];
    const existingPosition = positions.find(p => p.trading_symbol === tradingSymbol);

    if (data.action === "BUY") {
      if (existingPosition && parseInt(existingPosition.quantity) > 0) {
        console.log(`⚠️ Already have a LONG position in ${tradingSymbol}. Skipping.`);
        return;
      }
    } else if (data.action === "SELL") {
      if (existingPosition && parseInt(existingPosition.quantity) < 0) {
        console.log(`⚠️ Already have a SHORT position in ${tradingSymbol}. Skipping.`);
        return;
      }
    }

    // 3. Risk Management: Max Total Positions
    const activePositions = positions.filter(p => parseInt(p.quantity) !== 0);
    if (activePositions.length >= MAX_TOTAL_POSITIONS && !existingPosition) {
       console.log(`⚠️ Max total positions reached (${MAX_TOTAL_POSITIONS}). Skipping.`);
       return;
    }

    if (data.quantity > MAX_QUANTITY_PER_TRADE) {
      console.log(`⚠️ Quantity (${data.quantity}) exceeds MAX_QUANTITY_PER_TRADE (${MAX_QUANTITY_PER_TRADE}). Skipping.`);
      return;
    }

    // 4. Capital Management & Funds Check
    const funds = await getFunds();
    if (!funds) {
      console.log("❌ Could not verify funds. Skipping trade for safety.");
      return;
    }

    const availableMargin = funds.equity.available_margin;
    console.log(`💰 Available Margin: ${availableMargin}`);

    // Simple capital check: assume price is needed for more accurate check, 
    // but we can at least check against a hard limit per trade
    // If TV sends price, we can use it.
    const price = data.price || 0; // If TV sends price
    if (price > 0) {
      const requiredCapital = price * data.quantity;
      if (requiredCapital > MAX_CAPITAL_PER_TRADE) {
        console.log(`⚠️ Trade value (${requiredCapital}) exceeds MAX_CAPITAL_PER_TRADE (${MAX_CAPITAL_PER_TRADE}). Skipping.`);
        return;
      }
      if (requiredCapital > availableMargin) {
        console.log(`⚠️ Insufficient margin. Required: ${requiredCapital}, Available: ${availableMargin}. Skipping.`);
        return;
      }
    }

    const orderResponse = await axios.post(
      "https://api.upstox.com/v2/order/place",
      {
        quantity: data.quantity,
        product: "I",
        validity: "DAY",
        price: 0,
        tag: "tv-order",
        instrument_token: instrumentToken,
        order_type: "MARKET",
        transaction_type: data.action,
        disclosed_quantity: 0,
        trigger_price: 0,
        is_amo: false,
      },
      {
        headers: {
          Authorization: `Bearer ${upstoxAccessToken}`,
          "Content-Type": "application/json",
        },
      }
    );

    console.log("✅ Order Placed:", orderResponse.data);
  } catch (error) {
    console.error("Webhook Error:", error.response?.data || error.message);
  }
});

// ===============================
// Upstox OAuth Login
// ===============================
app.get("/auth/login", (req, res) => {
  const returnUrl = req.query.return_url || "http://localhost:3000";
  const redirectUri = "https://shiv-websocket.onrender.com/auth/callback";
  const authUrl = `https://api.upstox.com/v2/login/authorization/dialog?response_type=code&client_id=${process.env.UPSTOX_CLIENT_ID}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${encodeURIComponent(returnUrl)}`;
  res.redirect(authUrl);
});

// ===============================
// Upstox OAuth Callback
// ===============================
app.get("/auth/callback", async (req, res) => {
  try {
    const code = req.query.code;
    const returnUrl = req.query.state || "http://localhost:3000";
    const redirectUri = "https://shiv-websocket.onrender.com/auth/callback";

    const response = await axios.post(
      "https://api.upstox.com/v2/login/authorization/token",
      new URLSearchParams({
        grant_type: "authorization_code",
        code: code,
        client_id: process.env.UPSTOX_CLIENT_ID,
        client_secret: process.env.UPSTOX_CLIENT_SECRET,
        redirect_uri: redirectUri,
      }),
      {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
      }
    );

    upstoxAccessToken = response.data.access_token;
    upstoxRefreshToken = response.data.refresh_token;
    tokenExpiryTime = Date.now() + 23 * 60 * 60 * 1000;

    console.log("✅ Access Token Stored");
    console.log("⏳ Token Expiry Set to 23 hours from now");

    // Persist to Supabase
    await saveTokensToDB(upstoxAccessToken, upstoxRefreshToken);

    res.redirect(`${returnUrl}?token=${encodeURIComponent(upstoxAccessToken)}`);
  } catch (error) {
    console.error("Auth Error:", error.response?.data || error.message);
    res.status(500).send("Auth Failed");
  }
});

// ===============================
// Schedule Token Refresh (Every 20 hours)
// ===============================
function scheduleTokenRefresh() {
  cron.schedule("0 */20 * * *", async () => {
    console.log("🔄 Cron: Checking token refresh...");
    if (upstoxRefreshToken) {
      const isValid = await ensureValidAccessToken();
      if (isValid) {
        console.log("✅ Cron: Token refreshed successfully");
      } else {
        console.log("❌ Cron: Token refresh failed. Need manual login.");
      }
    } else {
      console.log("⚠️ Cron: No refresh token stored. Need to login first.");
    }
  });
}

// ===============================
// Start Server
// ===============================
app.listen(PORT, async () => {
  console.log(`🚀 Server running on port ${PORT}`);
  await syncInstruments(); // Download & Parse fresh instruments from Upstox
  await loadTokensFromDB(); // Try loading tokens from Supabase at startup
  scheduleTokenRefresh(); // Start cron job
});
