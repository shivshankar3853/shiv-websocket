require("dotenv").config();
const express = require("express");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
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

if (!supabaseUrl || !supabaseKey) {
  console.error("❌ ERROR: SUPABASE_URL or SUPABASE_KEY is missing in environment variables!");
}

const supabase = createClient(supabaseUrl || "https://placeholder.supabase.co", supabaseKey || "placeholder");

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
    
    // 1. Delete old tokens
    const { error: deleteError } = await supabase
      .from("auth_tokens")
      .delete()
      .neq("access_token", "dummy");

    if (deleteError) {
      console.error("❌ Supabase Delete Error:", deleteError);
      throw deleteError;
    }

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

    if (insertError) {
      console.error("❌ Supabase Insert Error:", insertError);
      throw insertError;
    }

    console.log("✅ Tokens saved to Supabase successfully");
  } catch (error) {
    console.error("❌ Supabase Save Error:", error.message || error);
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

    if (error) {
      console.error("❌ Supabase Load Error:", error);
      throw error;
    }

    if (data && data.length > 0) {
      upstoxAccessToken = data[0].access_token;
      upstoxRefreshToken = data[0].refresh_token;
      tokenExpiryTime = Date.now() + 23 * 60 * 60 * 1000; 
      console.log("✅ Tokens loaded from Supabase");
      return true;
    } else {
      console.log("⚠️ No tokens found in Supabase");
      return false;
    }
  } catch (error) {
    console.error("❌ Supabase Load Error Summary:", error.message || error);
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
let instrumentMap = {}; // Keyed by instrument_key for search
let symbolToInstrumentMap = {}; // Keyed by trading_symbol for fast lookup

// ===============================
// Load/Sync Instrument Master
// ===============================
async function syncInstruments() {
  const segments = ["NSE", "BSE", "MCX"];
  console.log("📥 Starting instrument sync for:", segments.join(", "));

  for (const segment of segments) {
    try {
      // Use JSON format as CSV is deprecated and returning 403/404
      const url = `https://assets.upstox.com/market-quote/instruments/exchange/${segment}.json.gz`;
      console.log(`🌐 Fetching ${segment} instruments (JSON)...`);

      const response = await axios({
        method: "get",
        url: url,
        responseType: "stream",
      });

      const gunzip = zlib.createGunzip();
      let rawData = "";

      response.data.pipe(gunzip);

      gunzip.on("data", (chunk) => {
        rawData += chunk.toString();
      });

      await new Promise((resolve, reject) => {
        gunzip.on("end", () => resolve());
        gunzip.on("error", (err) => reject(err));
      });

      const instruments = JSON.parse(rawData);
      console.log(`📊 Processing ${instruments.length} instruments for ${segment}...`);

      instruments.forEach((inst) => {
        const key = inst.instrument_key;
        const symbol = inst.trading_symbol;
        if (key) {
          instrumentMap[key] = inst;
        }
        if (symbol) {
          // If multiple segments have the same symbol (e.g., NSE/BSE), prioritize NSE
          if (!symbolToInstrumentMap[symbol] || inst.exchange === "NSE") {
            symbolToInstrumentMap[symbol] = inst;
          }
        }
      });

      console.log(`✅ ${segment} sync completed.`);
    } catch (error) {
      console.error(`❌ Error syncing ${segment}:`, error.message);
      
      // Fallback: Check if we have local file
      const localPath = path.join(__dirname, "instruments", `${segment}.json`);
      if (fs.existsSync(localPath)) {
        console.log(`📦 Loading ${segment} from local fallback: ${localPath}`);
        try {
          const content = fs.readFileSync(localPath, "utf8");
          const instruments = JSON.parse(content);
          instruments.forEach((inst) => {
            const key = inst.instrument_key;
            const symbol = inst.trading_symbol;
            if (key) instrumentMap[key] = inst;
            if (symbol) {
              if (!symbolToInstrumentMap[symbol] || inst.exchange === "NSE") {
                symbolToInstrumentMap[symbol] = inst;
              }
            }
          });
          console.log(`✅ ${segment} loaded from local fallback.`);
        } catch (localErr) {
          console.error(`❌ Local fallback failed for ${segment}:`, localErr.message);
        }
      }
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

  const instrument = symbolToInstrumentMap[tradingSymbol];

  if (!instrument) {
    console.log("❌ Instrument Not Found in Map:", tradingSymbol);
    return null;
  }

  return instrument.instrument_key;
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
// Search Instruments
// ===============================
app.get("/api/search", (req, res) => {
  const query = req.query.q?.toUpperCase();
  const type = req.query.type?.toUpperCase(); // EQUITY, FUTURE, OPTION
  
  if (!query || query.length < 2) {
    return res.json([]);
  }

  const results = Object.values(instrumentMap)
    .filter((inst) => {
      const tradingSymbol = inst.trading_symbol?.toUpperCase() || "";
      const name = inst.name?.toUpperCase() || "";
      const matchesQuery = tradingSymbol.includes(query) || name.includes(query);
      
      if (!matchesQuery) return false;
      
      if (type) {
        const instType = inst.instrument_type?.toUpperCase() || "";
        if (type === 'EQUITY') {
          return instType === 'EQUITY';
        }
        if (type === 'FUTURE') {
          return instType.startsWith('FUT');
        }
        if (type === 'OPTION') {
          return instType.startsWith('OPT');
        }
      }
      
      return true;
    })
    .sort((a, b) => {
      const aSymbol = a.trading_symbol?.toUpperCase() || "";
      const bSymbol = b.trading_symbol?.toUpperCase() || "";
      
      // 1. Exact matches first
      if (aSymbol === query && bSymbol !== query) return -1;
      if (bSymbol === query && aSymbol !== query) return 1;
      
      // 2. Starts with query first
      if (aSymbol.startsWith(query) && !bSymbol.startsWith(query)) return -1;
      if (bSymbol.startsWith(query) && !aSymbol.startsWith(query)) return 1;
      
      // 3. Equity first
      if (a.instrument_type === 'EQUITY' && b.instrument_type !== 'EQUITY') return -1;
      if (b.instrument_type === 'EQUITY' && a.instrument_type !== 'EQUITY') return 1;
      
      return 0;
    })
    .slice(0, 50);

  res.json(results);
});

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
// Password Authentication (PIN)
// ===============================
app.post("/api/verify-pin", async (req, res) => {
  const { pin } = req.body;
  if (!pin) return res.status(400).json({ error: "PIN is required" });

  try {
    const { data, error } = await supabase
      .from("shiv_users")
      .select("user_password")
      .eq("user_password", pin)
      .limit(1);

    if (error) throw error;

    if (data && data.length > 0) {
      res.json({ success: true });
    } else {
      res.status(401).json({ success: false, error: "Invalid PIN" });
    }
  } catch (err) {
    console.error("❌ PIN Verification Error:", err.message);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.post("/api/change-pin", async (req, res) => {
  const { currentPin, newPin } = req.body;
  if (!currentPin || !newPin) return res.status(400).json({ error: "Current and new PIN required" });

  try {
    // 1. Verify current PIN
    const { data, error: fetchError } = await supabase
      .from("shiv_users")
      .select("*")
      .eq("user_password", currentPin)
      .limit(1);

    if (fetchError) throw fetchError;
    if (!data || data.length === 0) {
      return res.status(401).json({ error: "Invalid current PIN" });
    }

    // 2. Update to new PIN
    const { error: updateError } = await supabase
      .from("shiv_users")
      .update({ user_password: newPin })
      .eq("user_password", currentPin);

    if (updateError) throw updateError;

    res.json({ success: true });
  } catch (err) {
    console.error("❌ PIN Change Error:", err.message);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Helper: Log Webhook Order to Supabase
async function logWebhookOrder(data, status, reason = null, orderId = null) {
  try {
    const { error } = await supabase
      .from("tradingview_logs")
      .insert([
        {
          symbol: data.symbol,
          action: data.action,
          quantity: data.quantity,
          price: data.price || 0,
          status: status,
          reason: reason,
          order_id: orderId,
          payload: data,
          created_at: new Date().toISOString()
        }
      ]);

    if (error) {
      console.error("❌ Supabase Log Error:", error.message);
    }
  } catch (err) {
    console.error("❌ Log Webhook Error:", err.message);
  }
}

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
      await logWebhookOrder(data, "skipped", "duplicate signal");
      return res.status(200).json({ status: "skipped", reason: "duplicate signal" });
    }

    // Respond immediately to TradingView
    res.status(200).json({ status: "received" });

    if (!(await ensureValidAccessToken())) {
      console.log("❌ No valid access token.");
      await logWebhookOrder(data, "failed", "no valid access token");
      return;
    }

    const instrumentToken = getInstrumentToken(data.symbol);
    if (!instrumentToken) {
      await logWebhookOrder(data, "failed", "instrument token not found");
      return;
    }

    // 2. Position Checking
    const positions = await getPositions();
    const tradingSymbol = data.symbol.split(":")[1];
    const existingPosition = positions.find(p => p.trading_symbol === tradingSymbol);

    if (data.action === "BUY") {
      if (existingPosition && parseInt(existingPosition.quantity) > 0) {
        console.log(`⚠️ Already have a LONG position in ${tradingSymbol}. Skipping.`);
        await logWebhookOrder(data, "skipped", "already have long position");
        return;
      }
    } else if (data.action === "SELL") {
      if (existingPosition && parseInt(existingPosition.quantity) < 0) {
        console.log(`⚠️ Already have a SHORT position in ${tradingSymbol}. Skipping.`);
        await logWebhookOrder(data, "skipped", "already have short position");
        return;
      }
    }

    // 3. Risk Management: Max Total Positions
    const activePositions = positions.filter(p => parseInt(p.quantity) !== 0);
    if (activePositions.length >= MAX_TOTAL_POSITIONS && !existingPosition) {
       console.log(`⚠️ Max total positions reached (${MAX_TOTAL_POSITIONS}). Skipping.`);
       await logWebhookOrder(data, "skipped", `max total positions reached (${MAX_TOTAL_POSITIONS})`);
       return;
    }

    if (data.quantity > MAX_QUANTITY_PER_TRADE) {
      console.log(`⚠️ Quantity (${data.quantity}) exceeds MAX_QUANTITY_PER_TRADE (${MAX_QUANTITY_PER_TRADE}). Skipping.`);
      await logWebhookOrder(data, "skipped", `quantity (${data.quantity}) exceeds max limit (${MAX_QUANTITY_PER_TRADE})`);
      return;
    }

    // 4. Capital Management & Funds Check
    const funds = await getFunds();
    if (!funds) {
      console.log("❌ Could not verify funds. Skipping trade for safety.");
      await logWebhookOrder(data, "failed", "could not verify funds");
      return;
    }

    const availableMargin = funds.equity.available_margin;
    console.log(`💰 Available Margin: ${availableMargin}`);

    // Simple capital check
    const price = data.price || 0;
    if (price > 0) {
      const requiredCapital = price * data.quantity;
      if (requiredCapital > MAX_CAPITAL_PER_TRADE) {
        console.log(`⚠️ Trade value (${requiredCapital}) exceeds MAX_CAPITAL_PER_TRADE (${MAX_CAPITAL_PER_TRADE}). Skipping.`);
        await logWebhookOrder(data, "skipped", `required capital (${requiredCapital}) exceeds max limit (${MAX_CAPITAL_PER_TRADE})`);
        return;
      }
      if (requiredCapital > availableMargin) {
        console.log(`⚠️ Insufficient margin. Required: ${requiredCapital}, Available: ${availableMargin}. Skipping.`);
        await logWebhookOrder(data, "skipped", `insufficient margin (req: ${requiredCapital}, avail: ${availableMargin})`);
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
    await logWebhookOrder(data, "success", null, orderResponse.data.data.order_id);
  } catch (error) {
    console.error("Webhook Error:", error.response?.data || error.message);
    const errorMsg = error.response?.data?.errors?.[0]?.message || error.message;
    await logWebhookOrder(req.body, "failed", errorMsg);
  }
});

// ===============================
// Upstox OAuth Login
// ===============================
app.get("/auth/login", (req, res) => {
  const returnUrl = req.query.return_url || "http://localhost:3000";
  const redirectUri = process.env.UPSTOX_REDIRECT_URI || "https://shiv-websocket.onrender.com/auth/callback";
  
  console.log("🔗 Auth Login Initiated");
  console.log("📍 Redirect URI:", redirectUri);
  console.log("↩️ Return URL:", returnUrl);

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
    const redirectUri = process.env.UPSTOX_REDIRECT_URI || "https://shiv-websocket.onrender.com/auth/callback";

    console.log("📩 Auth Callback Received");
    console.log("🔑 Auth Code:", code ? "YES" : "NO");

    if (!code) {
      console.error("❌ No auth code received in callback");
      return res.status(400).send("No auth code received");
    }

    console.log("🔄 Exchanging code for token...");
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

    console.log("✅ Token Exchange Successful");
    
    if (!response.data.access_token) {
      console.error("❌ Access token missing in Upstox response:", response.data);
      return res.status(500).send("Failed to obtain access token");
    }

    upstoxAccessToken = response.data.access_token;
    upstoxRefreshToken = response.data.refresh_token;
    tokenExpiryTime = Date.now() + 23 * 60 * 60 * 1000;

    console.log("⏳ Token Expiry Set to 23 hours from now");

    // Persist to Supabase
    await saveTokensToDB(upstoxAccessToken, upstoxRefreshToken);

    res.redirect(`${returnUrl}?token=${encodeURIComponent(upstoxAccessToken)}`);
  } catch (error) {
    console.error("❌ Auth Error:", error.response?.data || error.message);
    res.status(500).send(`Auth Failed: ${JSON.stringify(error.response?.data || error.message)}`);
  }
});

// ===============================
// Schedule Cron Jobs
// ===============================
function scheduleCronJobs() {
  // 1. Token Refresh (Every 20 hours)
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

  // 2. Log Deletion (Every day at midnight)
  cron.schedule("0 0 * * *", async () => {
    try {
      console.log("🧹 Cron: Running log cleanup (30 days expiry)...");
      const expiryDate = new Date();
      expiryDate.setDate(expiryDate.getDate() - 30);
      
      const { data, error, count } = await supabase
        .from("tradingview_logs")
        .delete({ count: 'exact' })
        .lt("created_at", expiryDate.toISOString());

      if (error) throw error;
      console.log(`✅ Cron: Deleted ${count || 0} old logs.`);
    } catch (err) {
      console.error("❌ Cron: Log cleanup failed:", err.message);
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
  scheduleCronJobs(); // Start cron jobs
});
