import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const RPC = "https://0xrpc.io/eth";
const STAKING = "0x9131d68c27507d68120b5c6659ff974b10902a0d";
const PALM = "0xf1df7305E4BAB3885caB5B1e4dFC338452a67891";
const SEL = {
  palmToken: "0x61530d15",
  getStakedAmount: "0x4da6a556",
  balanceOf: "0x70a08231",
};
const WHOLE = 10n ** 9n;
const PALM_PER_CREDIT = 1000n;
const TOKENS_PER_CREDIT = 2_000_000n;
const PERIOD_MS = 14 * 24 * 60 * 60 * 1000;
const EPOCH = Date.UTC(2026, 0, 5);
const MAX_PALM = 10_000_000n * WHOLE;
const CHAIN_TTL = 10 * 60 * 1000;

const file = process.env.CHAT_DB || "/root/.ollama/root-chat.sqlite";
fs.mkdirSync(path.dirname(file), { recursive: true });
const db = new DatabaseSync(file, { timeout: 5000 });
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS glm_credits (
    wallet TEXT NOT NULL,
    period INTEGER NOT NULL,
    tokens INTEGER NOT NULL,
    PRIMARY KEY (wallet, period)
  );
  CREATE TABLE IF NOT EXISTS glm_welcome (
    wallet TEXT PRIMARY KEY,
    granted INTEGER NOT NULL,
    used INTEGER NOT NULL DEFAULT 0,
    granted_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS glm_bonus (
    wallet TEXT PRIMARY KEY,
    granted INTEGER NOT NULL DEFAULT 0,
    used INTEGER NOT NULL DEFAULT 0
  );
`);

export function database() {
  return db;
}

// Credits earned from daily challenges and achievements. They do not reset and are spent last.
function bonusRow(wallet) {
  const row = db.prepare("SELECT granted, used FROM glm_bonus WHERE wallet = ?").get(wallet);
  const granted = row ? Number(row.granted) || 0 : 0;
  return { granted, used: Math.min(granted, row ? Number(row.used) || 0 : 0) };
}

export function grantBonus(address, tokens) {
  const wallet = String(address || "").toLowerCase();
  const amount = Math.max(0, Math.floor(Number(tokens) || 0));
  if (!amount) return;
  db.prepare(`
    INSERT INTO glm_bonus (wallet, granted, used) VALUES (?, ?, 0)
    ON CONFLICT (wallet) DO UPDATE SET granted = granted + excluded.granted
  `).run(wallet, amount);
}

// Every wallet is issued half a credit once, the first time it is seen here.
// It does not reset. It is spent only after the wallet's own window credits run out.
const WELCOME_TOKENS = Number(TOKENS_PER_CREDIT / 2n);

const chainCache = new Map();

export function palmPerCredit() {
  return Number(PALM_PER_CREDIT);
}

export function tokensPerCredit() {
  return Number(TOKENS_PER_CREDIT);
}

export function periodInfo(now = Date.now()) {
  const index = Math.floor((now - EPOCH) / PERIOD_MS);
  const startsAt = EPOCH + index * PERIOD_MS;
  return { index, startsAt, resetsAt: startsAt + PERIOD_MS };
}

function padAddress(selector, address) {
  return selector + address.toLowerCase().replace(/^0x/, "").padStart(64, "0");
}

async function ethCall(to, data) {
  const response = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to, data }, "latest"] }),
    signal: AbortSignal.timeout(8000),
  });
  const body = await response.json();
  if (!response.ok || body.error) {
    const error = new Error("Could not read $PALM for this wallet.");
    error.status = 503;
    throw error;
  }
  return BigInt(body.result || "0x0");
}

function palmText(raw) {
  const whole = raw / WHOLE;
  const frac = (raw % WHOLE).toString().padStart(9, "0").slice(0, 2);
  return whole.toString() + "." + frac;
}

function asCredits(tokens) {
  return Number(tokens) / Number(TOKENS_PER_CREDIT);
}

async function readChain(address) {
  const key = address.toLowerCase();
  const hit = chainCache.get(key);
  if (hit && Date.now() - hit.at < CHAIN_TTL) return hit;
  let palmToken = PALM;
  try {
    const token = await ethCall(STAKING, SEL.palmToken);
    const parsed = "0x" + token.toString(16).padStart(40, "0").slice(-40);
    if (/^0x[0-9a-f]{40}$/.test(parsed) && !/^0x0{40}$/.test(parsed)) palmToken = parsed;
  } catch {
    palmToken = PALM;
  }
  const [held, staked] = await Promise.all([
    ethCall(palmToken, padAddress(SEL.balanceOf, key)),
    ethCall(STAKING, padAddress(SEL.getStakedAmount, key)),
  ]);
  const row = { at: Date.now(), held, staked };
  chainCache.set(key, row);
  return row;
}

function usedTokens(wallet, period) {
  const row = db.prepare("SELECT tokens FROM glm_credits WHERE wallet = ? AND period = ?").get(wallet, period);
  return row ? Number(row.tokens) || 0 : 0;
}

function welcomeRow(wallet) {
  db.prepare("INSERT OR IGNORE INTO glm_welcome (wallet, granted, used, granted_at) VALUES (?, ?, 0, ?)")
    .run(wallet, WELCOME_TOKENS, new Date().toISOString());
  const row = db.prepare("SELECT granted, used, granted_at AS grantedAt FROM glm_welcome WHERE wallet = ?").get(wallet);
  const granted = Number(row.granted) || 0;
  return { granted, used: Math.min(granted, Number(row.used) || 0), grantedAt: row.grantedAt };
}

const TRANSFER_CACHE = new Map();
const TRANSFER_TTL = 10 * 60 * 1000;
const WINDOW_SEC = 180 * 24 * 60 * 60;
const PAGE = 100;
const PAGES = 8;
const PACKED = 200;

const VENUES = new Map([
  [STAKING.toLowerCase(), { venue: "Staking" }],
  ["0xf82f5da00779687931609452b7a765a6391fe84a", { venue: "Distributor" }],
  ["0x051ef36e55875c08e4efaea6072c6d0f66fb0b9f", { venue: "Uniswap", dex: true }],
  ["0x7a250d5630b4cf539739df2c5dacb4c659f2488d", { venue: "Uniswap", dex: true }],
  ["0xe592427a0aece92de3edee1f18e0157c05861564", { venue: "Uniswap", dex: true }],
  ["0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45", { venue: "Uniswap", dex: true }],
  ["0x3fc91a3afd70395cd496c647d5a6cc9d4b2b7fad", { venue: "Uniswap", dex: true }],
  ["0x66a9893cc07d91d95644aedd05d03f95e1dba8af", { venue: "Uniswap", dex: true }],
  ["0xef1c6e67703c7bd7107eed8303fbe6ec2554bf6b", { venue: "Uniswap", dex: true }],
  ["0xd9e1ce17f2641f24ae83637ab66a2cca9c378b9f", { venue: "Sushi", dex: true }],
  ["0x1111111254eeb25477b68fb85ed929f73a960582", { venue: "1inch", dex: true }],
  ["0x111111125421ca6dc452d289314280a0f8842a65", { venue: "1inch", dex: true }],
  ["0x1111111254fb6c44bac0bed2854e76f90643097d", { venue: "1inch", dex: true }],
  ["0xdef1c0ded9bec7f1a1670819833240f027b25eff", { venue: "0x", dex: true }],
  ["0x6131b5fae19ea4f9d964eac0408e4408b66337b5", { venue: "Kyber", dex: true }],
  ["0x6352a56caadc4f1e25cd6c75970fa768a3304e64", { venue: "OpenOcean", dex: true }],
]);

const SWAP_SEL = new Set([
  "022c0d9f",
  "128acb08",
  "7ff36ab5",
  "18cbafe5",
  "38ed1739",
  "fb3bdb41",
  "4a25d94a",
  "8803dbee",
  "5c11d795",
  "b6f9de95",
  "791ac947",
  "414bf389",
  "db3e2198",
  "04e45aaf",
  "c04b8d59",
  "3593564c",
  "24856bc3",
  "12aa3caf",
  "5023b4df",
  "bce0b010",
  "09b81346",
  "42712a67",
  "472b43f3",
  "f28c0498",
  "5ae401dc",
]);

let venuesAt = 0;
let venues = new Map(VENUES);

function shortWallet(value) {
  const text = String(value || "");
  if (!/^0x[a-fA-F0-9]{40}$/.test(text)) return text;
  return text.slice(0, 6) + "…" + text.slice(-4);
}

function tokenAmount(value, decimals) {
  try {
    const raw = BigInt(value || "0");
    const places = Math.min(18, Math.max(0, Number(decimals) || 9));
    const whole = 10n ** BigInt(places);
    const abs = raw < 0n ? -raw : raw;
    const head = abs / whole;
    const frac = abs % whole;
    const cents = Number((frac * 100n) / whole);
    const amount = Number(head) + cents / 100;
    return raw < 0n ? -amount : amount;
  } catch {
    return 0;
  }
}

function selectorOf(row) {
  const input = String(row.input || row.methodId || "");
  const match = input.match(/^0x([0-9a-fA-F]{8})/);
  if (match) return match[1].toLowerCase();
  const name = String(row.functionName || "").toLowerCase();
  if (name.includes("swap")) return "swap";
  return "";
}

function classify(from, to, wallet, row, book) {
  const staking = STAKING.toLowerCase();
  if (to === staking) return { kind: "stake", venue: "Staking", party: to };
  if (from === staking) return { kind: "unstake", venue: "Staking", party: from };
  const other = to === wallet ? from : to;
  const hit = book.get(other);
  const sel = selectorOf(row);
  const swapped = Boolean(hit?.dex) || SWAP_SEL.has(sel) || sel === "swap";
  if (swapped) {
    return { kind: to === wallet ? "buy" : "sell", venue: hit?.venue || "Swap", party: other };
  }
  return { kind: to === wallet ? "in" : "out", venue: hit?.venue || "", party: other };
}

async function loadVenues() {
  if (venuesAt && Date.now() - venuesAt < 30 * 60 * 1000) return venues;
  try {
    const response = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${PALM}`, {
      signal: AbortSignal.timeout(8000),
    });
    const body = await response.json();
    const next = new Map(VENUES);
    for (const pair of body.pairs || []) {
      if (String(pair.chainId) !== "ethereum") continue;
      const addr = String(pair.pairAddress || "").toLowerCase();
      if (!/^0x[0-9a-f]{40}$/.test(addr)) continue;
      const dex = String(pair.dexId || "swap");
      const venue = dex === "uniswap" ? "Uniswap" : dex.charAt(0).toUpperCase() + dex.slice(1);
      next.set(addr, { venue, dex: true });
    }
    venues = next;
    venuesAt = Date.now();
  } catch {
    venuesAt = Date.now();
  }
  return venues;
}

async function etherscanTokenTx(wallet, page) {
  const key = process.env.ETHERSCAN_API_KEY ? `&apikey=${process.env.ETHERSCAN_API_KEY}` : "";
  const query = `module=account&action=tokentx&contractaddress=${PALM}&address=${wallet}&page=${page}&offset=${PAGE}&sort=desc`;
  const urls = [
    `https://eth.blockscout.com/api?${query}`,
    ...(key ? [`https://api.etherscan.io/v2/api?chainid=1&${query}${key}`] : []),
  ];
  for (const url of urls) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(12000) });
      const body = await response.json();
      if (Array.isArray(body.result)) return body.result;
    } catch {
      /* try the next host */
    }
  }
  return null;
}

async function readPalmTransfers(wallet) {
  const since = Math.floor(Date.now() / 1000) - WINDOW_SEC;
  const rows = [];
  const seen = new Set();
  for (let page = 1; page <= PAGES; page += 1) {
    const batch = await etherscanTokenTx(wallet, page);
    if (!batch) return page === 1 ? null : rows;
    if (!batch.length) break;
    let oldest = Infinity;
    for (const row of batch) {
      const id = `${row.hash}:${row.from}:${row.to}:${row.value}:${row.timeStamp}`;
      if (seen.has(id)) continue;
      seen.add(id);
      const at = Number(row.timeStamp) || 0;
      if (at && at < oldest) oldest = at;
      if (at >= since) rows.push(row);
    }
    if (oldest < since || batch.length < PAGE) break;
  }
  return rows;
}

/** $PALM transfers, swaps, and stake moves for this wallet in the last six months. */
export async function palmMonthTxs(address) {
  const wallet = String(address || "").toLowerCase();
  const hit = TRANSFER_CACHE.get(wallet);
  if (hit && Date.now() - hit.at < TRANSFER_TTL) return hit.txs;
  const [book, rows] = await Promise.all([loadVenues(), readPalmTransfers(wallet)]);
  if (!rows) return hit?.txs || [];
  const txs = [];
  for (const row of rows) {
    const from = String(row.from || "").toLowerCase();
    const to = String(row.to || "").toLowerCase();
    const amount = tokenAmount(row.value, row.tokenDecimal);
    if (!amount) continue;
    const item = classify(from, to, wallet, row, book);
    txs.push({
      hash: row.hash,
      at: (Number(row.timeStamp) || 0) * 1000,
      kind: item.kind,
      amount,
      venue: item.venue,
      counterparty: item.venue || shortWallet(item.party),
    });
  }
  const packed = txs.slice(0, PACKED);
  TRANSFER_CACHE.set(wallet, { at: Date.now(), txs: packed });
  return packed;
}

export async function creditSnapshot(address) {
  const wallet = String(address || "").toLowerCase();
  const period = periodInfo();
  const chain = await readChain(wallet);
  const counted = chain.held + chain.staked > MAX_PALM ? MAX_PALM : chain.held + chain.staked;
  const windowAllowanceTokens = Number((counted * TOKENS_PER_CREDIT) / (PALM_PER_CREDIT * WHOLE));
  const windowUsedTokens = Math.min(usedTokens(wallet, period.index), windowAllowanceTokens);
  const welcome = welcomeRow(wallet);
  const bonus = bonusRow(wallet);
  const allowanceTokens = windowAllowanceTokens + welcome.granted + bonus.granted;
  const used = windowUsedTokens + welcome.used + bonus.used;
  const remainingTokens = Math.max(0, allowanceTokens - used);
  return {
    held: palmText(chain.held),
    staked: palmText(chain.staked),
    allowanceTokens,
    usedTokens: used,
    remainingTokens,
    allowance: asCredits(allowanceTokens),
    used: asCredits(used),
    remaining: asCredits(remainingTokens),
    windowAllowanceTokens,
    windowAllowance: asCredits(windowAllowanceTokens),
    windowUsed: asCredits(windowUsedTokens),
    windowRemaining: asCredits(windowAllowanceTokens - windowUsedTokens),
    welcome: {
      credits: asCredits(welcome.granted),
      used: asCredits(welcome.used),
      remaining: asCredits(welcome.granted - welcome.used),
      grantedAt: welcome.grantedAt,
    },
    bonus: {
      credits: asCredits(bonus.granted),
      used: asCredits(bonus.used),
      remaining: asCredits(bonus.granted - bonus.used),
    },
    startsAt: new Date(period.startsAt).toISOString(),
    resetsAt: new Date(period.resetsAt).toISOString(),
    palmPerCredit: Number(PALM_PER_CREDIT),
    tokensPerCredit: Number(TOKENS_PER_CREDIT),
  };
}

// Window credits are spent first. Only the overflow touches the one-time welcome balance.
export function chargeCredit(address, tokens, windowAllowanceTokens) {
  const wallet = String(address || "").toLowerCase();
  const amount = Math.max(1, Math.floor(Number(tokens) || 0));
  const period = periodInfo().index;
  let toWindow = amount;
  if (Number.isFinite(windowAllowanceTokens)) {
    toWindow = Math.min(amount, Math.max(0, windowAllowanceTokens - usedTokens(wallet, period)));
  }
  let rest = amount - toWindow;
  const welcomeLeft = rest > 0 ? (() => { const w = welcomeRow(wallet); return Math.max(0, w.granted - w.used); })() : 0;
  let toWelcome = Math.min(rest, welcomeLeft);
  rest -= toWelcome;
  const bonus = rest > 0 ? bonusRow(wallet) : { granted: 0, used: 0 };
  const toBonus = Math.min(rest, Math.max(0, bonus.granted - bonus.used));
  rest -= toBonus;
  toWelcome += rest;
  if (toBonus > 0) {
    db.prepare("UPDATE glm_bonus SET used = used + ? WHERE wallet = ?").run(toBonus, wallet);
  }
  if (toWindow > 0) {
    db.prepare(`
      INSERT INTO glm_credits (wallet, period, tokens) VALUES (?, ?, ?)
      ON CONFLICT (wallet, period) DO UPDATE SET tokens = tokens + excluded.tokens
    `).run(wallet, period, toWindow);
  }
  if (toWelcome > 0) {
    welcomeRow(wallet);
    db.prepare("UPDATE glm_welcome SET used = used + ? WHERE wallet = ?").run(toWelcome, wallet);
  }
  return usedTokens(wallet, period);
}
