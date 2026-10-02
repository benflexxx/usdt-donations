"use strict";
/**
 * USDT donation tracker. Zero dependencies, Node 20.6+.
 * Polls block explorers for incoming USDT transfers to your public wallets,
 * keeps them in a JSON file, and serves /api/config and /api/stats.
 * It never holds private keys and never moves funds.
 */
const http = require("http");
const fs = require("fs");
const path = require("path");

const env = process.env;
const PORT = Number(env.PORT || 3000);
const POLL_MS = Math.max(15, Number(env.POLL_SECONDS || 60)) * 1000;
const MIN_MICRO = Math.round(Number(env.MIN_DONATION_USDT || 1) * 1e6); // ignores dust / address-poisoning spam
const DATA_FILE = env.DATA_FILE || path.join(__dirname, "data", "donations.json");
const TRUST_PROXY = env.TRUST_PROXY === "1";

const NETWORKS = [
  { id: "trc20", name: "TRON", tag: "TRC-20", env: "TRON_ADDRESS", kind: "tron",
    contract: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
    explorer: "https://tronscan.org/#/address/", txUrl: "https://tronscan.org/#/transaction/",
    note: "Send USDT on the TRON network only." },
  { id: "erc20", name: "Ethereum", tag: "ERC-20", env: "ETH_ADDRESS", kind: "evm", chainId: 1, minConf: 12,
    contract: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
    explorer: "https://etherscan.io/address/", txUrl: "https://etherscan.io/tx/",
    note: "Send USDT on the Ethereum network only. Fees are higher on this network." },
  { id: "bep20", name: "BNB Chain", tag: "BEP-20", env: "BSC_ADDRESS", kind: "evm", chainId: 56, minConf: 15,
    contract: "0x55d398326f99059fF775485246999027B3197955",
    explorer: "https://bscscan.com/address/", txUrl: "https://bscscan.com/tx/",
    note: "Send USDT on the BNB Smart Chain network only." },
].map((n) => Object.assign({}, n, { address: (env[n.env] || "").trim() })).filter((n) => n.address);

/* ---------- startup checks ---------- */
const RE = { tron: /^T[1-9A-HJ-NP-Za-km-z]{33}$/, evm: /^0x[0-9a-fA-F]{40}$/ };
if (!NETWORKS.length) die("Set at least one of TRON_ADDRESS, ETH_ADDRESS, BSC_ADDRESS in .env");
for (const n of NETWORKS) if (!RE[n.kind].test(n.address)) die(`${n.env} is not a valid ${n.name} address`);
if (NETWORKS.some((n) => n.kind === "evm") && !env.ETHERSCAN_API_KEY) die("ETHERSCAN_API_KEY is required for Ethereum / BNB Chain");
function die(m) { console.error("Config error: " + m); process.exit(1); }

/* ---------- state (persisted) ---------- */
let state = { donations: {}, cursors: {} };
try { state = JSON.parse(fs.readFileSync(DATA_FILE, "utf8")); } catch (_) { /* first run */ }
const errors = {};
let updatedAt = null;

function save() {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  const tmp = DATA_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(state));
  fs.renameSync(tmp, DATA_FILE);
}

/* ---------- helpers ---------- */
// Convert a raw token amount to micro-USDT (6 decimals) with BigInt, no float rounding.
function toMicro(value, decimals) {
  const v = BigInt(value), d = BigInt(decimals);
  return Number(d >= 6n ? v / 10n ** (d - 6n) : v * 10n ** (6n - d));
}
async function getJson(url, headers) {
  const r = await fetch(url, { headers: headers || {}, signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`HTTP ${r.status} from ${new URL(url).host}`);
  return r.json();
}
function add(n, hash, from, micro, ts) {
  const key = `${n.id}:${hash}:${from}:${micro}`;
  if (!state.donations[key]) state.donations[key] = { net: n.id, hash, from, micro, ts };
}

/* ---------- pollers ---------- */
async function pollTron(n) {
  const cursor = state.cursors[n.id] || 0;
  const headers = env.TRONGRID_API_KEY ? { "TRON-PRO-API-KEY": env.TRONGRID_API_KEY } : {};
  let fingerprint = null, maxTs = cursor;
  for (let page = 0; page < 50; page++) {
    const u = new URL(`https://api.trongrid.io/v1/accounts/${n.address}/transactions/trc20`);
    u.searchParams.set("only_to", "true");
    u.searchParams.set("only_confirmed", "true");
    u.searchParams.set("contract_address", n.contract);
    u.searchParams.set("order_by", "block_timestamp,asc");
    u.searchParams.set("limit", "200");
    if (cursor) u.searchParams.set("min_timestamp", String(cursor));
    if (fingerprint) u.searchParams.set("fingerprint", fingerprint);
    const j = await getJson(u.toString(), headers);
    for (const t of j.data || []) {
      if (t.to !== n.address) continue;
      add(n, t.transaction_id, t.from, toMicro(t.value, (t.token_info && t.token_info.decimals) || 6), t.block_timestamp);
      maxTs = Math.max(maxTs, t.block_timestamp);
    }
    fingerprint = j.meta && j.meta.fingerprint;
    if (!fingerprint) break;
  }
  state.cursors[n.id] = maxTs;
}

async function pollEvm(n) {
  const start = state.cursors[n.id] || 0;
  let maxBlock = start;
  for (let page = 1; page <= 10; page++) {
    const u = new URL("https://api.etherscan.io/v2/api");
    const q = { chainid: n.chainId, module: "account", action: "tokentx", contractaddress: n.contract,
      address: n.address, startblock: start, endblock: 99999999, page, offset: 1000, sort: "asc", apikey: env.ETHERSCAN_API_KEY };
    for (const k in q) u.searchParams.set(k, String(q[k]));
    const j = await getJson(u.toString());
    if (!Array.isArray(j.result)) {
      if (/no transactions/i.test(String(j.message))) break;
      throw new Error(String(j.result || j.message));
    }
    for (const t of j.result) {
      if (t.to.toLowerCase() !== n.address.toLowerCase()) continue;
      if (Number(t.confirmations) < n.minConf) continue; // wait for finality
      add(n, t.hash, t.from.toLowerCase(), toMicro(t.value, t.tokenDecimal), Number(t.timeStamp) * 1000);
      maxBlock = Math.max(maxBlock, Number(t.blockNumber));
    }
    if (j.result.length < 1000) break;
  }
  state.cursors[n.id] = maxBlock;
}

async function pollAll() {
  for (const n of NETWORKS) {
    try {
      await (n.kind === "tron" ? pollTron(n) : pollEvm(n));
      delete errors[n.id];
    } catch (e) {
      errors[n.id] = e.message;
      console.error(`[${n.tag}] ${e.message}`);
    }
  }
  updatedAt = Date.now();
  try { save(); } catch (e) { console.error("save failed: " + e.message); }
  setTimeout(pollAll, POLL_MS);
}

/* ---------- API ---------- */
const short = (a) => a.slice(0, 5) + "…" + a.slice(-4);
function stats() {
  const own = new Set(NETWORKS.map((n) => n.address.toLowerCase()));
  const list = Object.values(state.donations)
    .filter((d) => d.micro >= MIN_MICRO && !own.has(d.from.toLowerCase()))
    .sort((a, b) => b.ts - a.ts);
  const byNetwork = {};
  let total = 0;
  for (const n of NETWORKS) byNetwork[n.id] = { total: 0, count: 0 };
  for (const d of list) { total += d.micro; byNetwork[d.net].total += d.micro / 1e6; byNetwork[d.net].count++; }
  const by = Object.fromEntries(NETWORKS.map((n) => [n.id, n]));
  return {
    total: total / 1e6, count: list.length, byNetwork, updatedAt,
    stale: Object.keys(errors).length > 0,
    recent: list.slice(0, 20).map((d) => ({
      network: by[d.net].tag, amount: d.micro / 1e6, from: short(d.from), ts: d.ts, url: by[d.net].txUrl + d.hash,
    })),
  };
}
function publicConfig() {
  return {
    orgName: env.ORG_NAME || "Open Path Fund",
    contactEmail: env.CONTACT_EMAIL || "",
    networks: NETWORKS.map((n) => ({ id: n.id, name: n.name, tag: n.tag, address: n.address, explorer: n.explorer, note: n.note })),
  };
}

// tiny per-IP rate limit: 60 requests / minute
const hits = new Map();
setInterval(() => hits.clear(), 60000).unref();
function limited(req) {
  const ip = (TRUST_PROXY && String(req.headers["x-forwarded-for"] || "").split(",")[0].trim()) || req.socket.remoteAddress;
  const c = (hits.get(ip) || 0) + 1;
  hits.set(ip, c);
  return c > 60;
}

const HTML = () => fs.readFileSync(path.join(__dirname, "public", "index.html"));
const SEC = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy": "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com; " +
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; " +
    "img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
};
function send(res, code, type, body, extra) {
  res.writeHead(code, Object.assign({ "Content-Type": type }, SEC, extra || {}));
  res.end(body);
}
const json = (res, obj, cache) => send(res, 200, "application/json", JSON.stringify(obj), { "Cache-Control": cache || "public, max-age=30" });

http.createServer((req, res) => {
  if (req.method !== "GET") return send(res, 405, "text/plain", "Method not allowed");
  const p = new URL(req.url, "http://x").pathname;
  if (p === "/" || p === "/index.html") return send(res, 200, "text/html; charset=utf-8", HTML(), { "Cache-Control": "no-cache" });
  if (p.startsWith("/api/")) {
    if (limited(req)) return send(res, 429, "text/plain", "Too many requests");
    if (p === "/api/config") return json(res, publicConfig(), "public, max-age=300");
    if (p === "/api/stats") return json(res, stats());
    if (p === "/api/health") return json(res, { ok: true, updatedAt, errors }, "no-store");
  }
  send(res, 404, "text/plain", "Not found");
}).listen(PORT, () => console.log(`Donation site on http://localhost:${PORT} watching ${NETWORKS.map((n) => n.tag).join(", ")}`));

pollAll();
