// streamer.js — Angel One Live Price Streamer (DB-driven tokens)

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
  FATAL_ERROR_DELAY: 10000,
  HEARTBEAT_INTERVAL: 30000,
  MAX_RECONNECT_ATTEMPTS: 5,
  SESSION_REFRESH_INTERVAL: 60 * 60 * 1000, // 1 hour
  TOKEN_CHUNK_SIZE: 400, // Angel safe limit
  CHUNK_DELAY: 3000,     // ms between subscriptions
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
let sessionData = null;
let reconnectAttempts = 0;
let heartbeatTimer = null;
let sessionRefreshTimer = null;
let isConnecting = false;
let lastMessageTime = Date.now();
let priceUpdateCount = 0;

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

/* ================= DB TOKEN LOADER ================= */
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

/* ================= UTILS ================= */
function chunkArray(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
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

  console.log("✅ Angel login successful");
  sessionData = session.data;
  scheduleSessionRefresh();
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
    if (Date.now() - lastMessageTime > CONFIG.HEARTBEAT_INTERVAL * 2) {
      console.warn("⚠️ No data for 60s — reconnecting");
      reconnect();
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

  const price = data.last_traded_price / 100;
  lastMessageTime = Date.now();

  const { error } = await supabase
    .from("live_prices")
    .upsert(
      {
        token: data.token,
        price,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "token" }
    );

  if (!error) {
    priceUpdateCount++;
    console.log(`💹 ${data.token} → ₹${price}`);
  }
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

  ws.on("error", err => {
    console.error("❌ WS error:", err);
  });

  ws.on("close", () => {
    console.log("⚠️ WS closed");
    stopHeartbeat();
    reconnect();
  });

  return ws;
}

/* ================= CLEANUP ================= */
async function cleanup() {
  stopHeartbeat();
  if (sessionRefreshTimer) clearTimeout(sessionRefreshTimer);
  sessionRefreshTimer = null;

  if (ws) {
    try { ws.close(); } catch {}
    ws = null;
  }
}

/* ================= RECONNECT ================= */
async function reconnect() {
  if (isConnecting) return;

  reconnectAttempts++;
  if (reconnectAttempts > CONFIG.MAX_RECONNECT_ATTEMPTS) {
    reconnectAttempts = 0;
    setTimeout(start, CONFIG.FATAL_ERROR_DELAY);
    return;
  }

  setTimeout(start, CONFIG.RECONNECT_DELAY * reconnectAttempts);
}

/* ================= START ================= */
async function start() {
  if (isConnecting) return;
  isConnecting = true;

  try {
    await cleanup();

    const session = await createSession();
    setupWebSocket(session);

    console.log("🔌 Connecting to WebSocket...");
    await ws.connect();
    console.log("✅ WebSocket connected");

    startHeartbeat();

    const allTokens = await loadTokensFromDB();
    const chunks = chunkArray(allTokens, CONFIG.TOKEN_CHUNK_SIZE);

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

    isConnecting = false;
  } catch (err) {
    isConnecting = false;
    console.error("🔥 Fatal error:", err.message);
    setTimeout(start, CONFIG.FATAL_ERROR_DELAY);
  }
}

/* ================= STATS ================= */
setInterval(() => {
  console.log(`📊 Updates: ${priceUpdateCount} | Uptime: ${Math.floor(process.uptime()/60)} min`);
}, 300000);

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
console.log("🚀 Angel One DB-Driven Price Streamer Started");
start();
