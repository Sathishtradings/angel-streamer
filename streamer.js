// streamer.js
import pkg from "smartapi-javascript";
import { createClient } from "@supabase/supabase-js";
import OTPAuth from "otpauth";
import dotenv from "dotenv";

dotenv.config();

const { SmartAPI, SmartWebSocketV2 } = pkg;

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
}

start();
