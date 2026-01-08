// streamer.js — Angel One Live Price Streamer (Market Hours + DB Tokens)

import { createRequire } from "module";
import { createClient } from "@supabase/supabase-js";
import * as OTPAuth from "otpauth";
import dotenv from "dotenv";

dotenv.config();

/* ================= IMPORT FIX ================= */
const require = createRequire(import.meta.url);
const smartApiModule = require("smartapi-javascript");

const SmartAPI = smartApiModule.SmartAPI;
const SmartWebSocketV2 = smartApiModule.WebSocketV2;

/* ================= ENV CHECK ================= */
const REQUIRED_ENVS = [
  "ANGEL_API_KEY",
  "ANGEL_CLIENT_CODE",
  "ANGEL_PASSWORD",
  "ANGEL_TOTP",
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
];

for (const k of REQUIRED_ENVS) {
  if (!process.env[k]) {
    throw new Error(`❌ Missing env variable: ${k}`);
  }
}

/* ================= CONFIG ================= */
const CONFIG = {
  RECONNECT_DELAY: 5000,
  HEARTBEAT_INTERVAL: 30000,
  SESSION_REFRESH_INTERVAL: 60 * 60 * 1000, // 1 hour
  TOKEN_CHUNK_SIZE: 400, // Angel safe limit
  CHUNK_DELAY: 3000,     // delay between chunk subscribe
  MARKET_RECHECK_DELAY: 5 * 60 * 1000, // 5 min
};

/* ================= SUPABASE ================= */
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

/* ================= ANGEL API ================= */
const smartApi = new SmartAPI({
  api_key: process.env.ANGEL_API_KEY,
});

/* ================= STATE ================= */
let ws = null;
let sessionRefreshTimer = null;
let heartbeatTimer = null;
let lastMessageTime = Date.now();
let isConnecting = false;

/* ================= MARKET HOURS ================= */
function isMarketOpen() {
  const now = new Date();
  const ist = new Date(
    now.toLocaleString("en-US", { timeZone: "Asia/Kolkata" })
  );

  const day = ist.getDay(); // 0=Sun,6=Sat
  if (day === 0 || day === 6) return false;

  const minutes = ist.getHours() * 60 + ist.getMinutes();
  return minutes >= (9 * 60 + 15) && minutes <= (15 * 60 + 30);
}

/* ================= TOTP ================= */
function generateTOTP() {
  const totp = new OTPAuth.TOTP({
    issuer: "AngelOne",
    label: process.env.ANGEL_CLIENT_CODE,
    algorithm: "SHA1",
    digits: 6,
    period: 30,
    secret: OTPAuth.Secret.fromBase32(
      process.env.ANGEL_TOTP.replace(/\s+/g, "")
    ),
  });
  return totp.generate();
}

/* ================= TOKEN LOADER ================= */
async function loadTokensFromDB() {
  const { data, error } = await supabase
    .from("symbol_token_map")
    .select("token")
    .eq("exchange", "NSE");

  if (error) throw error;

  const tokens = data.map(d => d.token.toString());
  console.log(`📊 Loaded ${tokens.length} tokens from DB`);
  return tokens;
}

/* ================= RESET OLD DATA ================= */
async function resetLivePrices() {
  await supabase.from("live_prices").delete().neq("token", "");
  console.log("🧹 Cleared previous day prices");
}

/* ================= UTILS ================= */
function chunkArray(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
}

/* ================= SESSION ================= */
async function createSession() {
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

  scheduleSessionRefresh();
  console.log("✅ Angel login successful");
  return session.data;
}

function scheduleSessionRefresh() {
  if (sessionRefreshTimer) clearTimeout(sessionRefreshTimer);

  sessionRefreshTimer = setTimeout(async () => {
    console.log("🔄 Refreshing session...");
    await cleanup();
    start();
  }, CONFIG.SESSION_REFRESH_INTERVAL);
}

/* ================= HEARTBEAT ================= */
function startHeartbeat() {
  if (heartbeatTimer) clearInterval(heartbeatTimer);

  heartbeatTimer = setInterval(() => {
    if (Date.now() - lastMessageTime > CONFIG.HEARTBEAT_INTERVAL * 4) {
      console.warn("⚠️ No data — reconnecting");
      cleanup().then(start);
    }
  }, CONFIG.HEARTBEAT_INTERVAL);
}

function stopHeartbeat() {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = null;
}

/* ================= PRICE HANDLER ================= */
async function updatePrice(data) {
  if (!data?.token || !data?.last_traded_price) return;

  lastMessageTime = Date.now();
  const price = data.last_traded_price / 100;

  await supabase
    .from("live_prices")
    .upsert(
      {
        token: data.token,
        price,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "token" }
    );

  console.log(`💹 ${data.token} → ₹${price}`);
}

/* ================= WEBSOCKET ================= */
function setupWebSocket(session) {
  ws = new SmartWebSocketV2({
    clientcode: process.env.ANGEL_CLIENT_CODE,
    jwttoken: session.jwtToken,
    apikey: process.env.ANGEL_API_KEY,
    feedtype: session.feedToken,
  });

  ws.on("tick", updatePrice);

  ws.on("error", err => console.error("❌ WS error:", err));
  ws.on("close", () => {
    console.log("⚠️ WS closed");
    stopHeartbeat();
  });
}

/* ================= CLEANUP ================= */
async function cleanup() {
  stopHeartbeat();
  if (sessionRefreshTimer) clearTimeout(sessionRefreshTimer);

  if (ws) {
    try { ws.close(); } catch {}
    ws = null;
  }
}

/* ================= START ================= */
async function start() {
  if (isConnecting) return;
  isConnecting = true;

  try {
    if (!isMarketOpen()) {
      console.log("⏰ Market closed — sleeping");
      setTimeout(start, CONFIG.MARKET_RECHECK_DELAY);
      isConnecting = false;
      return;
    }

    await cleanup();
    await resetLivePrices();

    const session = await createSession();
    setupWebSocket(session);

    console.log("🔌 Connecting to WebSocket...");
    await ws.connect();
    console.log("✅ WebSocket connected");

    startHeartbeat();

    const tokens = await loadTokensFromDB();
    const chunks = chunkArray(tokens, CONFIG.TOKEN_CHUNK_SIZE);

    setTimeout(() => {
      chunks.forEach((chunk, idx) => {
        setTimeout(() => {
          ws.fetchData({
            correlationID: `prices_${idx}`,
            action: 1,
            mode: 1,
            exchangeType: 1, // NSE
            tokens: chunk,
          });
          console.log(`✅ Subscribed chunk ${idx + 1}/${chunks.length}`);
        }, idx * CONFIG.CHUNK_DELAY);
      });
    }, 3000);

  } catch (err) {
    console.error("🔥 Fatal error:", err.message);
  } finally {
    isConnecting = false;
  }
}

/* ================= SHUTDOWN ================= */
process.on("SIGINT", async () => {
  console.log("🛑 Shutdown");
  await cleanup();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  console.log("🛑 Shutdown");
  await cleanup();
  process.exit(0);
});

/* ================= RUN ================= */
console.log("🚀 Angel One Market-Hour Streamer Started");
start();
