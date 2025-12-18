import fetch from "node-fetch";
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";

dotenv.config();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const URL =
  "https://margincalculator.angelbroking.com/OpenAPI_File/files/OpenAPIScripMaster.json";

async function run() {
  console.log("Downloading Angel instrument master...");
  const res = await fetch(URL);
  const data = await res.json();

  const records = data.filter((i) => {
    if (i.exch_seg !== "NSE") return false;
    if (!i.symbol || !i.token) return false;
    return i.instrumenttype === "EQ" || i.symbol.endsWith("-EQ");
  });

  console.log(`Filtered ${records.length} NSE EQ records`);

  const batchSize = 500;
  for (let i = 0; i < records.length; i += batchSize) {
    const batch = records.slice(i, i + batchSize).map((r) => ({
      symbol: r.symbol.replace("-EQ", "").trim(),
      name: r.name || null,
      isin: r.isin || null,
      exchange: r.exch_seg,
      token: r.token,
      instrument_type: "EQ",
    }));

    const { error } = await supabase
      .from("symbol_token_map")
      .upsert(batch, { onConflict: "symbol" });

    if (error) {
      console.error("Upsert error:", error);
      return;
    }

    console.log(`Upserted ${i + batch.length}`);
  }

  console.log("Angel master import complete");
}

run();
