 HEAD
// streamer.js
import pkg from "smartapi-javascript";
import { createClient } from "@supabase/supabase-js";
import OTPAuth from "otpauth";

import { createRequire } from "module";
import { createClient } from "@supabase/supabase-js";
import * as OTPAuth from "otpauth";
>>>>>>> d98c6ea (angel streamer)
import dotenv from "dotenv";

dotenv.config();

 HEAD
const { SmartAPI, SmartWebSocketV2 } = pkg;
/* -------------------- SMARTAPI (CJS FIX) -------------------- */
const require = createRequire(import.meta.url);
const smartapi = require("smartapi-javascript");

const SmartAPI = smartapi.SmartAPI;
const WebSocketV2 = smartapi.WebSocketV2;
 d98c6ea (angel streamer)

/* -------------------- SUPABASE -------------------- */
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

/* -------------------- ANGEL API -------------------- */
const smartApi = new SmartAPI({
  api_key: process.env.ANGEL_API_KEY,
});

/* -------------------- TOTP -------------------- */
function generateTOTP() {
  const totp = new OTPAuth.TOTP({
    issuer: "AngelOne",
    label: process.env.ANGEL_CLIENT_CODE,
    algorithm: "SHA1",
    digits: 6,
    period: 30,
    HEAD
    secret: process.env.ANGEL_TOTP_SECRET,
  });

  return totp.generate();
}

/* -------------------- START STREAM -------------------- */
async function start() {
  try {
    console.log("🔐 Generating TOTP...");
    const otp = generateTOTP();

    console.log("🔑 Creating session...");
    const session = await smartApi.generateSession(
      process.env.ANGEL_CLIENT_CODE,
      process.env.ANGEL_PASSWORD,
      otp
    );

    if (!session?.data?.jwtToken) {
      throw new Error("Angel login failed – invalid TOTP or credentials");
    }

    console.log("✅ Angel login success");

    const ws = new SmartWebSocketV2({
      jwtToken: session.data.jwtToken,
      apiKey: process.env.ANGEL_API_KEY,
      clientCode: process.env.ANGEL_CLIENT_CODE,
      feedToken: session.data.feedToken,
    });

    ws.on("open", () => {
      console.log("📡 Angel WebSocket connected");

      ws.subscribe({
        correlationID: "prices",
        mode: 1, // LTP mode
        exchangeTokens: {
          NSE: process.env.NSE_TOKENS.split(","), // ex: 2885,11536
        },
      });
    });

    ws.on("message", async (data) => {
      try {
        if (!data?.token || !data?.last_traded_price) return;

        const price = data.last_traded_price / 100;

        await supabase
          .from("live_prices")
          .upsert(
            {
              symbol_token: data.token,
              price,
              updated_at: new Date().toISOString(),
            },
            { onConflict: "symbol_token" }
          );

        console.log(`💹 ${data.token} → ₹${price}`);
      } catch (err) {
        console.error("DB error:", err.message);
      }
    });

    ws.on("error", (err) => {
      console.error("❌ WS error:", err);
    });

    ws.on("close", () => {
      console.log("⚠️ WS closed — reconnecting in 5s...");
      setTimeout(start, 5000);
    });

    ws.connect();
  } catch (err) {
    console.error("🔥 Fatal error:", err.message);
    setTimeout(start, 10000);
  }
    secret: OTPAuth.Secret.fromBase32(
      process.env.ANGEL_TOTP.replace(/\s+/g, "")
    ),
  });
  return totp.generate();
}

/* -------------------- LOAD TOKENS FROM SUPABASE -------------------- */
async function loadTokens() {
  const { data, error } = await supabase
    .from("symbol_token_map")
    .select("token")
    .eq("exchange", "NSE");

  if (error) throw error;

  const tokens = data.map(d => d.token.toString());
  console.log(`📊 Loaded ${tokens.length} tokens`);
  return tokens;
}

/* -------------------- START STREAM -------------------- */
async function start() {
  console.log("🔐 Generating TOTP...");
  const otp = generateTOTP();

  console.log("🔑 Logging into Angel One...");
  const session = await smartApi.generateSession(
    process.env.ANGEL_CLIENT_CODE,
    process.env.ANGEL_PASSWORD,
    otp
  );

  if (!session?.data?.jwtToken) {
    throw new Error("Angel login failed");
  }

  console.log("✅ Angel login successful");

  const tokens = await loadTokens();

  const ws = new WebSocketV2({
    clientcode: process.env.ANGEL_CLIENT_CODE,
    jwttoken: session.data.jwtToken,
    apikey: process.env.ANGEL_API_KEY,
    feedtype: session.data.feedToken,
  });

  ws.on("open", () => {
    console.log("📡 WebSocket connected");
    
setTimeout(() => {
   try {
     ws.subscribe({
      correlationID: "prices",
      mode: 1, // LTP
      exchangeTokens: {
        NSE: tokens,
      },
    });

    console.log("✅ Subscription sent");
   } catch(err) {
    console.error(" Subscribe failed :", srr.message);
   }
}, 1500);
  });

  ws.on("message", async (data) => {
    if (!data?.token || !data?.last_traded_price) return;

    const price = data.last_traded_price / 100;

    const { error } = await supabase
      .from("live_prices")
      .upsert(
        {
          symbol_token: data.token,
          price,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "symbol_token" }
      );

    if (!error) {
      console.log(`💹 ${data.token} → ₹${price}`);
    }
  });

  ws.on("error", (err) => {
    console.error("❌ WS error:", err);
  });

  ws.on("close", () => {
    console.log("⚠️ WS closed — restarting in 5s");
    setTimeout(start, 5000);
  });

  ws.connect();
d98c6ea (angel streamer)
}

/* -------------------- START -------------------- */
start();

/* -------------------- GRACEFUL SHUTDOWN -------------------- */
process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
