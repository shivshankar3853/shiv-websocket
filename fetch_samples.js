const axios = require("axios");
const zlib = require("zlib");
const fs = require("fs");
const path = require("path");

const segments = ["NSE", "BSE", "MCX"];
const instrumentsDir = path.join(__dirname, "instruments");

// Ensure instruments directory exists
if (!fs.existsSync(instrumentsDir)) {
    fs.mkdirSync(instrumentsDir);
}

function jsonToCsv(jsonArray) {
    if (jsonArray.length === 0) return "";
    const headers = Object.keys(jsonArray[0]);
    const rows = jsonArray.map(obj => 
        headers.map(header => {
            let val = obj[header];
            if (val === null || val === undefined) return "";
            val = String(val).replace(/"/g, '""'); // Escape quotes
            return `"${val}"`;
        }).join(",")
    );
    return [headers.join(","), ...rows].join("\n");
}

async function fetchSampleRows() {
    console.log("🚀 Starting extraction of 10 sample rows per segment...");

    for (const segment of segments) {
        try {
            // Add a small delay to avoid 403
            await new Promise(r => setTimeout(r, 2000));
            
            const url = `https://assets.upstox.com/market-quote/instruments/exchange/${segment}.json.gz`;
            console.log(`🌐 Fetching ${segment}...`);

            const response = await axios({
                method: "get",
                url: url,
                responseType: "stream",
                headers: {
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
                    "Accept": "*/*",
                    "Accept-Encoding": "gzip",
                    "Referer": "https://upstox.com/",
                    "Origin": "https://upstox.com"
                }
            });

            const gunzip = zlib.createGunzip();
            let rawData = "";

            response.data.pipe(gunzip);

            await new Promise((resolve, reject) => {
                gunzip.on("data", (chunk) => { rawData += chunk.toString(); });
                gunzip.on("end", resolve);
                gunzip.on("error", reject);
            });

            const allInstruments = JSON.parse(rawData);
            const samples = allInstruments.slice(0, 10);
            
            const csvData = jsonToCsv(samples);
            const filePath = path.join(instrumentsDir, `${segment}_samples.csv`);
            
            fs.writeFileSync(filePath, csvData);
            console.log(`✅ Saved 10 rows for ${segment} to ${filePath}`);

        } catch (error) {
            console.error(`❌ Failed ${segment}: ${error.message}`);
        }
    }
    console.log("\n✨ Task complete!");
}

fetchSampleRows();
