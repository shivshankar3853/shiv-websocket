require("dotenv").config();
const express = require("express");
const cors = require("cors");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const cron = require("node-cron");
const { createClient } = require("@supabase/supabase-js");
const csv = require("csv-parser");
const zlib = require("zlib");
const { finished } = require("stream/promises");
const syncInstrumentsTask = require("./syncInstruments");

const app = express();
app.use(cors());
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
// Risk Management & Settings
// ===============================

// ===============================
// Helper: Get Instrument Token (Supabase)
// ===============================
async function getInstrumentToken(symbol) {
  // Input could be "NSE:SBIN" or "NFO:NIFTY23OCT19500CE"
  const parts = symbol.split(":");
  const tradingSymbol = parts.length > 1 ? parts[1] : parts[0];

  try {
    const { data, error } = await supabase
      .from("instruments_upstoxmaster")
      .select("instrument_key")
      .eq("trading_symbol", tradingSymbol)
      .limit(1)
      .single();

    if (error || !data) {
      console.log("❌ Instrument Not Found in Supabase:", tradingSymbol);
      return null;
    }

    return data.instrument_key;
  } catch (err) {
    console.error("❌ Error fetching instrument token:", err.message);
    return null;
  }
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
// API: Search Instruments (Supabase)
// ===============================
app.get("/api/search", async (req, res) => {
  const query = req.query.q || "";
  const type = req.query.type?.toUpperCase() || "ALL"; // EQUITY, FUTURE, OPTION

  if (!query && type === "ALL") {
    return res.json([]);
  }

  try {
    let supabaseQuery = supabase
      .from("instruments_upstoxmaster")
      .select("*")
      .limit(50);

    // Apply text search if query exists
    if (query) {
      supabaseQuery = supabaseQuery.or(`trading_symbol.ilike.%${query}%,name.ilike.%${query}%`);
    }

    // Apply type filtering
    if (type !== "ALL") {
      if (type === "EQUITY") {
        supabaseQuery = supabaseQuery.or(`instrument_type.ilike.EQ%,instrument_type.eq.INDEX`);
      } else if (type === "FUTURE") {
        supabaseQuery = supabaseQuery.ilike("instrument_type", "%FUT%");
      } else if (type === "OPTION") {
        supabaseQuery = supabaseQuery.or(`instrument_type.ilike.%OPT%,instrument_type.eq.CE,instrument_type.eq.PE,segment.ilike.%FO%`);
      }
    }

    const { data, error } = await supabaseQuery;

    if (error) {
      console.error("❌ Supabase Search Error:", error.message);
      return res.status(500).json({ error: error.message });
    }

    res.json(data || []);
  } catch (err) {
    console.error("❌ Search Exception:", err.message);
    res.status(500).json({ error: "Internal search error" });
  }
});

// ===============================
// API: Sync Instruments
// ===============================
app.get("/api/sync-instruments", async (req, res) => {
  console.log("🚀 Sync requested via API");
  try {
    const result = await syncInstrumentsTask();
    if (result.success) {
      res.json({ message: "Sync successful", total: result.total });
    } else {
      res.status(500).json({ error: result.error });
    }
  } catch (err) {
    console.error("❌ API Sync Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ===============================
// Health Route
// ===============================
app.get("/", (req, res) => {
  res.send("TradingView Webhook Server Running");
});

app.get("/health", (req, res) => {
  res.json({ 
    status: "ok", 
    service: "backend",
    timestamp: new Date().toISOString() 
  });
});

// ===============================
// Render Service Control
// ===============================
const RENDER_API_KEY = process.env.RENDER_API_KEY;
const SERVICE_ID = process.env.SERVICE_ID;
const FRONTEND_SERVICE_ID = process.env.FRONTEND_SERVICE_ID;

if (!RENDER_API_KEY || !SERVICE_ID || !FRONTEND_SERVICE_ID) {
  console.warn("⚠️ WARNING: RENDER_API_KEY, SERVICE_ID, or FRONTEND_SERVICE_ID is missing!");
}

app.post("/service/restart", async (req, res) => {
  try {
    console.log("🔄 Restarting Render service (Backend)...");
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
    console.log("✅ Backend Service restart initiated");
    res.json({ status: "restart initiated", data: response.data });
  } catch (error) {
    console.error("❌ Restart Error:", error.response?.data || error.message);
    res.status(500).json({ error: error.response?.data || error.message });
  }
});

app.post("/service/restart-frontend", async (req, res) => {
  try {
    console.log("🔄 Restarting Render service (Frontend)...");
    const response = await axios.post(
      `https://api.render.com/v1/services/${FRONTEND_SERVICE_ID}/restart`,
      {},
      {
        headers: {
          "Authorization": `Bearer ${RENDER_API_KEY}`,
          "Content-Type": "application/json",
        },
      }
    );
    console.log("✅ Frontend Service restart initiated");
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

app.get("/api/logs", async (req, res) => {
  try {
    const { startDate, endDate, limit = 100 } = req.query;
    let query = supabase
      .from("tradingview_logs")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(parseInt(limit));

    if (startDate) {
      query = query.gte("created_at", startDate);
    }
    if (endDate) {
      query = query.lte("created_at", endDate);
    }

    const { data, error } = await query;

    if (error) throw error;
    res.json(data);
  } catch (err) {
    console.error("❌ Fetch Logs Error:", err.message);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.delete("/api/logs", async (req, res) => {
  try {
    const { error } = await supabase
      .from("tradingview_logs")
      .delete()
      .neq("id", "00000000-0000-0000-0000-000000000000"); // Delete all

    if (error) throw error;
    res.json({ success: true, message: "All logs deleted" });
  } catch (err) {
    console.error("❌ Delete All Logs Error:", err.message);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.delete("/api/logs/:id", async (req, res) => {
  const { id } = req.params;
  try {
    const { error } = await supabase
      .from("tradingview_logs")
      .delete()
      .eq("id", id);

    if (error) throw error;
    res.json({ success: true, message: "Log deleted" });
  } catch (err) {
    console.error("❌ Delete Log Error:", err.message);
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
          product: data.product,
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

    if (!data.symbol || !data.action || !data.quantity || !data.product) {
      return res.status(400).json({ error: "Invalid payload: symbol, action, quantity, and product are required" });
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

    const instrumentToken = await getInstrumentToken(data.symbol);
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
        product: data.product,
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
  const redirectUri = process.env.UPSTOX_REDIRECT_URI || `${process.env.BACKEND_URL}/auth/callback`;
  
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
    const redirectUri = process.env.UPSTOX_REDIRECT_URI || `${process.env.BACKEND_URL}/auth/callback`;

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
  // Instruments are now synced manually via UI to Supabase
  await loadTokensFromDB(); // Try loading tokens from Supabase at startup
  scheduleCronJobs(); // Start cron jobs
});
