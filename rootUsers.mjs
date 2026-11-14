import { database } from "./credits.mjs";

const LIVE_MS = 90_000;
const HARVEST_MS = 5 * 60_000;
const WALLET = /^0x[a-f0-9]{40}$/;
const ANON = /^anon:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const db = database();
db.exec(`
  CREATE TABLE IF NOT EXISTS root_users (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    first_seen TEXT NOT NULL,
    last_seen TEXT NOT NULL,
    live_until TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS root_users_kind ON root_users (kind);
  CREATE INDEX IF NOT EXISTS root_users_live ON root_users (live_until);
`);

let harvestedAt = 0;

function nowIso() {
  return new Date().toISOString();
}

function liveUntilIso() {
  return new Date(Date.now() + LIVE_MS).toISOString();
}

function count(sql, ...args) {
  return Number(db.prepare(sql).get(...args)?.n) || 0;
}

function harvest() {
  const now = Date.now();
  if (now - harvestedAt < HARVEST_MS) return;
  harvestedAt = now;
  const seen = nowIso();
  const dead = new Date(now - LIVE_MS * 2).toISOString();
  const sources = [
    "SELECT DISTINCT lower(wallet) AS wallet FROM conversations",
    "SELECT DISTINCT lower(wallet) AS wallet FROM glm_welcome",
    "SELECT DISTINCT lower(wallet) AS wallet FROM glm_bonus",
    "SELECT DISTINCT lower(wallet) AS wallet FROM glm_credits",
    "SELECT DISTINCT lower(wallet) AS wallet FROM quest_activity",
    "SELECT DISTINCT lower(wallet) AS wallet FROM quest_claims",
  ];
  const upsert = db.prepare(`
    INSERT INTO root_users (id, kind, first_seen, last_seen, live_until)
    VALUES (?, 'wallet', ?, ?, ?)
    ON CONFLICT (id) DO UPDATE SET
      kind = 'wallet',
      last_seen = excluded.last_seen
  `);
  for (const sql of sources) {
    let rows = [];
    try {
      rows = db.prepare(sql).all();
    } catch {
      continue;
    }
    for (const row of rows) {
      const wallet = String(row.wallet || "").toLowerCase();
      if (!WALLET.test(wallet)) continue;
      upsert.run(wallet, seen, seen, dead);
    }
  }
}

export function touchUser(id, kind) {
  const key = String(id || "").toLowerCase();
  const type = kind === "anon" ? "anon" : "wallet";
  if (type === "wallet" && !WALLET.test(key)) return false;
  if (type === "anon" && !ANON.test(key)) return false;
  const seen = nowIso();
  const live = liveUntilIso();
  db.prepare(`
    INSERT INTO root_users (id, kind, first_seen, last_seen, live_until)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (id) DO UPDATE SET
      kind = excluded.kind,
      last_seen = excluded.last_seen,
      live_until = excluded.live_until
  `).run(key, type, seen, seen, live);
  return true;
}

export function userStats() {
  harvest();
  const now = nowIso();
  return {
    live: count("SELECT COUNT(*) AS n FROM root_users WHERE live_until > ?", now),
    users: count("SELECT COUNT(*) AS n FROM root_users WHERE kind = 'wallet'"),
    at: now,
  };
}

export function parseAnonId(value) {
  const id = String(value || "").trim().toLowerCase();
  return ANON.test(id) ? id : "";
}

harvest();
