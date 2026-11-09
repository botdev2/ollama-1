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
const TRANSFER_TTL = 5 * 60 * 1000;
const MONTH_SEC = 30 * 24 * 60 * 60;

function shortWallet(value) {
  const text = String(value || "");
  if (!/^0x[a-fA-F0-9]{40}$/.test(text)) return text;
  return text.slice(0, 6) + "…" + text.slice(-4);
}

function txKind(from, to, wallet) {
  const staking = STAKING.toLowerCase();
  if (to === staking) return "stake";
  if (from === staking) return "unstake";
  if (to === wallet) return "in";
  return "out";
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

async function etherscanTokenTx(wallet) {
  const key = process.env.ETHERSCAN_API_KEY ? `&apikey=${process.env.ETHERSCAN_API_KEY}` : "";
  const query = `module=account&action=tokentx&contractaddress=${PALM}&address=${wallet}&page=1&offset=80&sort=desc`;
  const urls = [
    `https://eth.blockscout.com/api?${query}`,
    ...(key ? [`https://api.etherscan.io/v2/api?chainid=1&${query}${key}`] : []),
  ];
  for (const url of urls) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
      const body = await response.json();
      if (Array.isArray(body.result)) return body.result;
    } catch {
      /* try the next host */
    }
  }
  return null;
}

/** $PALM transfers for this wallet in the last 30 days. Public, cached. */
export async function palmMonthTxs(address) {
  const wallet = String(address || "").toLowerCase();
  const hit = TRANSFER_CACHE.get(wallet);
  if (hit && Date.now() - hit.at < TRANSFER_TTL) return hit.txs;
  const rows = await etherscanTokenTx(wallet);
  if (!rows) return hit?.txs || [];
  const since = Math.floor(Date.now() / 1000) - MONTH_SEC;
  const txs = [];
  for (const row of rows) {
    const at = Number(row.timeStamp) || 0;
    if (at < since) continue;
    const from = String(row.from || "").toLowerCase();
    const to = String(row.to || "").toLowerCase();
    const amount = tokenAmount(row.value, row.tokenDecimal);
    if (!amount) continue;
    const kind = txKind(from, to, wallet);
    txs.push({
      hash: row.hash,
      at: at * 1000,
      kind,
      amount,
      counterparty: kind === "in" || kind === "unstake" ? from : to,
    });
  }
  const packed = txs.slice(0, 40).map((item) => ({
    ...item,
    counterparty: shortWallet(item.counterparty),
  }));
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
