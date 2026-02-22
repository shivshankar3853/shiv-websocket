require("dotenv").config();
const express = require("express");
const axios = require("axios");
const fs = require("fs");
const cron = require("node-cron");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 5000;

// ===============================
// Store Upstox Tokens (Memory)
// ===============================
let upstoxAccessToken = null;
let upstoxRefreshToken = null;
let tokenExpiryTime = null;

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
// Load Instrument Master from Local File
// ===============================
function loadInstruments() {
  try {
    console.log("📥 Loading NSE instruments from local file...");

    const rawData = fs.readFileSync("./instruments/NSE.json", "utf8");
    const instruments = JSON.parse(rawData);

    instruments.forEach((item) => {
      // Adjust field names if needed
      const symbol = item.trading_symbol || item.symbol;
      const token = item.instrument_token || item.instrument_key;

      if (symbol && token && item.exchange === "NSE") {
        instrumentMap[symbol] = token;
      }
    });

    console.log(
      `✅ Instruments Loaded into Map: ${Object.keys(instrumentMap).length}`
    );
  } catch (error) {
    console.error("❌ Instrument Load Error:", error.message);
  }
}

// ===============================
// Helper: Get Instrument Token
// ===============================
function getInstrumentToken(symbol) {
  const tradingSymbol = symbol.split(":")[1];

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
    const response = await axios.get("https://api.upstox.com/v2/portfolio/net-positions", {
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
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  loadInstruments(); // Load local file at startup
  scheduleTokenRefresh(); // Start cron job
});
