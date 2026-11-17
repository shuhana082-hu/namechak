"use strict";
const express = require("express");
const cors = require("cors");
const rateLimit = require("express-rate-limit");

const app = express();
const PORT = process.env.PORT || 3000;

// ---- Config (set these in Render > Environment) ----
// UPSTREAM_URL: তোমার ডেটা সোর্স। {uid} ও {region} প্লেসহোল্ডার ব্যবহার করা যাবে।
// উদাহরণ: https://your-data-source.example/api/info?uid={uid}&region={region}
const UPSTREAM_URL = process.env.UPSTREAM_URL || "";
const UPSTREAM_KEY = process.env.UPSTREAM_KEY || ""; // থাকলে Authorization: Bearer ... যাবে
const API_KEYS = (process.env.API_KEYS || "").split(",").map(s => s.trim()).filter(Boolean); // খালি = ওপেন
const DEFAULT_REGION = process.env.DEFAULT_REGION || "BD";
const CACHE_TTL_MS = (Number(process.env.CACHE_TTL_SECONDS) || 300) * 1000;
const RATE_LIMIT_PER_MIN = Number(process.env.RATE_LIMIT_PER_MIN) || 60;

app.set("trust proxy", 1);
app.use(cors());

// ---- Rate limit ----
app.use("/api/", rateLimit({
  windowMs: 60 * 1000,
  limit: RATE_LIMIT_PER_MIN,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: "Too many requests, slow down." },
}));

// ---- Simple in-memory cache ----
const cache = new Map();
function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() > hit.exp) { cache.delete(key); return null; }
  return hit.val;
}
function cacheSet(key, val) {
  if (cache.size > 5000) cache.delete(cache.keys().next().value);
  cache.set(key, { val, exp: Date.now() + CACHE_TTL_MS });
}

// ---- Optional API key check ----
function auth(req, res, next) {
  if (API_KEYS.length === 0) return next();
  const key = req.get("x-api-key") || req.query.key;
  if (key && API_KEYS.includes(key)) return next();
  return res.status(401).json({ success: false, error: "Invalid or missing API key." });
}

// ---- Provider: upstream থেকে ডেটা আনে ও স্ট্যান্ডার্ড ফরম্যাটে সাজায় ----
async function fetchPlayer(uid, region) {
  if (!UPSTREAM_URL) {
    const e = new Error("UPSTREAM_URL is not configured on the server.");
    e.status = 503;
    throw e;
  }
  const url = UPSTREAM_URL.replace("{uid}", encodeURIComponent(uid)).replace("{region}", encodeURIComponent(region));
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const r = await fetch(url, {
      signal: ctrl.signal,
      headers: UPSTREAM_KEY ? { Authorization: `Bearer ${UPSTREAM_KEY}` } : {},
    });
    if (r.status === 404) { const e = new Error("Player not found."); e.status = 404; throw e; }
    if (!r.ok) { const e = new Error(`Upstream error (${r.status}).`); e.status = 502; throw e; }
    return normalize(await r.json(), uid, region);
  } catch (err) {
    if (err.name === "AbortError") { const e = new Error("Upstream timeout."); e.status = 504; throw e; }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// বিভিন্ন সোর্সের ফিল্ড নাম আলাদা হতে পারে, তাই কয়েকটা সম্ভাব্য নাম চেক করা হয়।
function pick(o, ...keys) {
  for (const k of keys) if (o && o[k] !== undefined && o[k] !== null) return o[k];
  return null;
}
function normalize(raw, uid, region) {
  const d = raw.player || raw.data || raw.AccountInfo || raw;
  const acc = raw.AccountInfo || d;
  const guild = raw.GuildInfo || d.guild || {};
  const name = pick(acc, "name", "nickname", "AccountName");
  if (!name) { const e = new Error("Player not found."); e.status = 404; throw e; }
  return {
    success: true,
    uid: String(uid),
    name,
    level: pick(acc, "level", "AccountLevel"),
    likes: pick(acc, "likes", "liked", "AccountLikes"),
    region: pick(acc, "region", "AccountRegion") || region,
    signature: pick(d, "signature") || pick(raw.SocialInfo || {}, "signature"),
    last_login: pick(acc, "last_login", "AccountLastLogin"),
    created_at: pick(acc, "created_at", "AccountCreateTime"),
    battle_royale: {
      max_rank: pick(d, "br_max_rank", "BrMaxRank"),
      points: pick(d, "br_rank_point", "BrRankPoint"),
    },
    clash_squad: {
      max_rank: pick(d, "cs_max_rank", "CsMaxRank"),
      points: pick(d, "cs_rank_point", "CsRankPoint"),
    },
    guild: {
      id: pick(guild, "id", "GuildID"),
      name: pick(guild, "name", "GuildName"),
      level: pick(guild, "level", "GuildLevel"),
      member_count: pick(guild, "member_count", "GuildMember"),
      capacity: pick(guild, "capacity", "GuildCapacity"),
    },
    fetched_at: new Date().toISOString(),
  };
}

// ---- Routes ----
app.get("/", (req, res) => {
  res.type("html").send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Name Check API</title>
<body style="font-family:system-ui;background:#0a0e17;color:#e6edf3;max-width:640px;margin:10vh auto;padding:0 16px">
<h1>✅ API Running</h1>
<p>Free Fire name check API is live.</p>
<pre style="background:#111826;padding:12px;border-radius:8px;overflow:auto">GET /api/player?uid=PLAYER_UID&amp;region=BD
GET /api/name?uid=PLAYER_UID
GET /health</pre></body>`);
});

app.get("/health", (req, res) => res.json({ status: "ok", uptime: process.uptime() }));

async function handle(req, res, onlyName) {
  const uid = String(req.query.uid || "").trim();
  const region = String(req.query.region || DEFAULT_REGION).trim().toUpperCase();
  if (!/^\d{5,15}$/.test(uid)) {
    return res.status(400).json({ success: false, error: "Invalid uid. Use digits only (5-15 digits)." });
  }
  try {
    const key = `${region}:${uid}`;
    let data = cacheGet(key);
    const cached = !!data;
    if (!data) { data = await fetchPlayer(uid, region); cacheSet(key, data); }
    if (onlyName) return res.json({ success: true, uid: data.uid, name: data.name, region: data.region, cached });
    res.json({ ...data, cached });
  } catch (err) {
    res.status(err.status || 500).json({ success: false, error: err.message || "Internal error" });
  }
}

app.get("/api/player", auth, (req, res) => handle(req, res, false));
app.get("/api/name", auth, (req, res) => handle(req, res, true));

app.use((req, res) => res.status(404).json({ success: false, error: "Not found." }));

app.listen(PORT, () => console.log(`API listening on :${PORT}`));
