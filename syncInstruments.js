const axios = require("axios");
const zlib = require("zlib");
const { createClient } = require("@supabase/supabase-js");
require("dotenv").config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error("❌ ERROR: SUPABASE_URL or SUPABASE_KEY is missing!");
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

async function syncInstruments() {
  const segments = ["NSE", "BSE", "MCX", "NSE_FO"];
  console.log("📥 Starting instrument sync to Supabase for:", segments.join(", "));

  try {
    // 1. Clear existing data
    console.log("🧹 Clearing existing instruments from Supabase...");
    const { error: deleteError } = await supabase
      .from("instruments_upstoxmaster")
      .delete()
      .neq("id", 0); // Delete all

    if (deleteError) {
      console.error("❌ Error clearing instruments:", deleteError.message);
      return { success: false, error: deleteError.message };
    }

    let totalInserted = 0;

    for (const segment of segments) {
      try {
        // Delay to avoid rate limiting
        await new Promise(r => setTimeout(r, 1000));

        const url = `https://assets.upstox.com/market-quote/instruments/exchange/${segment}.json.gz`;
        console.log(`🌐 Fetching ${segment} instruments...`);

        const response = await axios({
          method: "get",
          url: url,
          responseType: "stream",
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
            "Accept": "*/*",
            "Accept-Encoding": "gzip, deflate, br",
            "Referer": "https://upstox.com/",
            "Origin": "https://upstox.com"
          }
        });

        const gunzip = zlib.createGunzip();
        let chunks = [];

        response.data.pipe(gunzip);

        await new Promise((resolve, reject) => {
          gunzip.on("data", (chunk) => { chunks.push(chunk); });
          gunzip.on("end", () => resolve());
          gunzip.on("error", (err) => reject(err));
        });

        const rawData = Buffer.concat(chunks).toString();
        let instruments = JSON.parse(rawData);
        
        // Handle cases where the response might be { data: [...] } instead of directly [...]
        if (!Array.isArray(instruments) && instruments.data && Array.isArray(instruments.data)) {
          instruments = instruments.data;
        }

        if (!Array.isArray(instruments)) {
          console.error(`❌ ${segment} response is not an array. Keys:`, Object.keys(instruments));
          continue;
        }

        console.log(`📊 Processing ${instruments.length} instruments for ${segment}...`);

        // Pre-filter like the old code did
        const filteredInstruments = instruments.filter(inst => {
          if (!inst.instrument_key || !inst.trading_symbol) return false;
          
          const type = inst.instrument_type?.toUpperCase() || "";
          const segmentName = inst.segment?.toUpperCase() || "";
          
          // Only EQ, FUT, OPT, INDEX, CE, PE, FO
          return (
            type.startsWith('EQ') || 
            type === 'INDEX' || 
            type.includes('FUT') || 
            type.includes('OPT') || 
            type === 'CE' || 
            type === 'PE' || 
            segmentName.includes('FO')
          );
        });

        console.log(`🧹 Filtered down to ${filteredInstruments.length} relevant instruments for ${segment}.`);

        // Batch insert in chunks of 1000
        const batchSize = 1000;
        for (let i = 0; i < filteredInstruments.length; i += batchSize) {
          const chunk = filteredInstruments.slice(i, i + batchSize).map(inst => {
            // Handle expiry (could be timestamp number or string)
            let expiryDate = null;
            if (inst.expiry && inst.expiry !== "" && inst.expiry !== "0") {
              try {
                const d = new Date(inst.expiry);
                if (!isNaN(d.getTime())) {
                  expiryDate = d.toISOString().split('T')[0];
                }
              } catch (e) {
                expiryDate = null;
              }
            }

            return {
              trading_symbol: inst.trading_symbol,
              name: inst.name,
              instrument_key: inst.instrument_key,
              exchange: inst.exchange,
              instrument_type: inst.instrument_type,
              expiry: expiryDate,
              lot_size: (inst.lot_size && !isNaN(inst.lot_size)) ? parseInt(inst.lot_size) : null,
              strike_price: (inst.strike_price && !isNaN(inst.strike_price)) ? parseFloat(inst.strike_price) : null,
              segment: inst.segment
            };
          });

          const { error: insertError } = await supabase
            .from("instruments_upstoxmaster")
            .upsert(chunk, { onConflict: "instrument_key" });

          if (insertError) {
            console.error(`❌ Error inserting batch for ${segment}:`, insertError.message);
          } else {
            totalInserted += chunk.length;
          }
        }
        console.log(`✅ ${segment} completed.`);
      } catch (segmentError) {
        console.error(`❌ Error processing segment ${segment}:`, segmentError.message);
      }
    }

    console.log(`✨ Sync completed! Total instruments inserted: ${totalInserted}`);
    return { success: true, total: totalInserted };
  } catch (error) {
    console.error("❌ Sync failed:", error.message);
    return { success: false, error: error.message };
  }
}

// Allow it to be run directly or imported
if (require.main === module) {
  syncInstruments().then(() => process.exit(0));
}

module.exports = syncInstruments;
