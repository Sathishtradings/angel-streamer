import { SmartAPI, SmartWebSocketV2 } from "smartapi-javascript";
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";

dotenv.config();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const smartApi = new SmartAPI({
  api_key: process.env.ANGEL_API_KEY,
});

async function start() {
  const session = await smartApi.generateSession(
    process.env.ANGEL_CLIENT_CODE,
    process.env.ANGEL_PASSWORD,
    process.env.ANGEL_TOTP
  );

  const ws = new SmartWebSocketV2({
    jwtToken: session.data.jwtToken,
    apiKey: process.env.ANGEL_API_KEY,
    clientCode: process.env.ANGEL_CLIENT_CODE,
    feedToken: session.data.feedToken,
  });

  ws.on("open", () => {
    console.log("Angel One WS Connected");

    ws.subscribe({
      correlationID: "prices",
      mode: 1,
      exchangeTokens: {
        NSE: ["3045", "1333"], // example tokens
      },
    });
  });

  ws.on("message", async (tick) => {
    if (!tick.token || !tick.last_traded_price) return;

    await supabase.from("live_prices").upsert({
      token: tick.token,
      price: tick.last_traded_price / 100,
      updated_at: new Date(),
    });
  });

  ws.on("error", console.error);
}

start();
