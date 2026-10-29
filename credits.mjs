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
const TOKENS_PER_PALM = 2000n;
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
`);

const chainCache = new Map();

export function tokensPerPalm() {
  return Number(TOKENS_PER_PALM);
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

export async function creditSnapshot(address) {
  const wallet = String(address || "").toLowerCase();
  const period = periodInfo();
  const chain = await readChain(wallet);
  const counted = chain.held + chain.staked > MAX_PALM ? MAX_PALM : chain.held + chain.staked;
  const allowance = Number((counted * TOKENS_PER_PALM) / WHOLE);
  const used = usedTokens(wallet, period.index);
  return {
    held: palmText(chain.held),
    staked: palmText(chain.staked),
    allowance,
    used,
    remaining: Math.max(0, allowance - used),
    resetsAt: new Date(period.resetsAt).toISOString(),
    tokensPerPalm: Number(TOKENS_PER_PALM),
  };
}

export function chargeCredit(address, tokens) {
  const wallet = String(address || "").toLowerCase();
  const amount = Math.max(1, Math.floor(Number(tokens) || 0));
  const period = periodInfo().index;
  db.prepare(`
    INSERT INTO glm_credits (wallet, period, tokens) VALUES (?, ?, ?)
    ON CONFLICT (wallet, period) DO UPDATE SET tokens = tokens + excluded.tokens
  `).run(wallet, period, amount);
  return usedTokens(wallet, period);
}
