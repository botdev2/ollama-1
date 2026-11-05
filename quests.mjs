import { database, grantBonus, tokensPerCredit } from "./credits.mjs";

// Daily challenges and achievements. Points are earned by using the harness and are paid out
// as bonus Hamrin credits when the wallet claims them.
//
// What the server sees itself (messages, modes, Auto-Prompt, web lookups) is counted as it happens.
// Visits to a tab and finished Episodes are reported by the page, so they are whitelisted, counted
// once per day, and worth little. Every payout is claimed once, so total spend per wallet is bounded.

const db = database();
db.exec(`
  CREATE TABLE IF NOT EXISTS quest_activity (
    wallet TEXT NOT NULL,
    day TEXT NOT NULL,
    key TEXT NOT NULL,
    count INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (wallet, day, key)
  );
  CREATE TABLE IF NOT EXISTS quest_claims (
    wallet TEXT NOT NULL,
    quest TEXT NOT NULL,
    day TEXT NOT NULL,
    points INTEGER NOT NULL,
    tokens INTEGER NOT NULL,
    claimed_at TEXT NOT NULL,
    PRIMARY KEY (wallet, quest, day)
  );
`);

// 1 point = 1,000 tokens, so 2,000 points = 1 credit.
export const TOKENS_PER_POINT = 1000;
const ALL = "all";
const DAY_CAP = 400;

const EPISODES = [
  { id: "ops-1", name: "Introduction to Ops" },
  { id: "defi-2", name: "Building Products in DeFi" },
  { id: "workflows-3", name: "Workflows and Maintenance" },
  { id: "privacy-4", name: "Privacy & Compliance Aspect" },
  { id: "revenue-5", name: "Managing Revenue Streams" },
];
const VIEWS = ["ops", "help", "reasoning", "notes", "billing", "settings", "plugins", "automations", "telemetry", "quests"];
const CLIENT_EVENTS = new Set([
  "episode_any",
  ...EPISODES.map((item) => "episode:" + item.id),
  ...VIEWS.map((item) => "view:" + item),
]);

const DAILY_POOL = {
  easy: [
    { id: "hello", title: "Say hello to Hamrin", desc: "Send one message.", goal: { key: "turn", target: 1 } },
    { id: "visit-ops", title: "Pay Ops a visit", desc: "Open the Ops tab.", goal: { key: "view:ops", target: 1 } },
    { id: "read-help", title: "Read the manual", desc: "Open the Help tab.", goal: { key: "view:help", target: 1 } },
    { id: "see-think", title: "See how it thinks", desc: "Open the Reasoning tab.", goal: { key: "view:reasoning", target: 1 } },
    { id: "plan-day", title: "Plan your day", desc: "Open the Notes tab.", goal: { key: "view:notes", target: 1 } },
    { id: "back-to-class", title: "Back to class", desc: "Finish any Episode.", goal: { key: "episode_any", target: 1 } },
  ],
  medium: [
    { id: "keep-going", title: "Keep it going", desc: "Send 3 messages.", goal: { key: "turn", target: 3 } },
    { id: "just-asking", title: "Just asking", desc: "Send 2 messages in Ask mode.", goal: { key: "turn:ask", target: 2 } },
    { id: "plan-first", title: "Plan first", desc: "Send 2 messages in Plan mode.", goal: { key: "turn:plan", target: 2 } },
    { id: "fresh-start", title: "Fresh start", desc: "Begin 2 new chats.", goal: { key: "chat_new", target: 2 } },
    { id: "sharpen", title: "Sharpen the ask", desc: "Use Auto-Prompt once.", goal: { key: "autoprompt", target: 1 } },
  ],
  hard: [
    { id: "on-a-roll", title: "On a roll", desc: "Send 6 messages.", goal: { key: "turn", target: 6 } },
    { id: "ask-the-web", title: "Ask the web", desc: "Let Hamrin look up 2 web pages or searches.", goal: { key: "web", target: 2 } },
    { id: "agent-at-work", title: "Agent at work", desc: "Send 4 messages in Agent mode.", goal: { key: "turn:agent", target: 4 } },
    {
      id: "three-modes",
      title: "Three modes",
      desc: "Send a message in Agent, Ask, and Plan mode.",
      goal: { all: [{ key: "turn:agent", target: 1 }, { key: "turn:ask", target: 1 }, { key: "turn:plan", target: 1 }] },
    },
  ],
};
const TIER_POINTS = { easy: 30, medium: 50, hard: 70 };
const DAILY_BONUS_POINTS = 100;

const ACHIEVEMENTS = [
  { id: "first-words", group: "Chat", title: "First words", desc: "Send your first message to Hamrin.", points: 25, goal: { key: "turn", target: 1 } },
  { id: "chatterbox", group: "Chat", title: "Chatterbox", desc: "Send 25 messages.", points: 100, goal: { key: "turn", target: 25 } },
  { id: "centurion", group: "Chat", title: "Centurion", desc: "Send 100 messages.", points: 300, goal: { key: "turn", target: 100 } },
  { id: "ask-away", group: "Chat", title: "Ask away", desc: "Send 3 messages in Ask mode.", points: 50, goal: { key: "turn:ask", target: 3 } },
  { id: "planner", group: "Chat", title: "Planner", desc: "Send 3 messages in Plan mode.", points: 50, goal: { key: "turn:plan", target: 3 } },
  { id: "agent-smith", group: "Chat", title: "Agent at large", desc: "Send 10 messages in Agent mode.", points: 50, goal: { key: "turn:agent", target: 10 } },
  { id: "collector", group: "Chat", title: "Collector", desc: "Begin 5 chats.", points: 60, goal: { key: "chat_new", target: 5 } },
  { id: "prompt-smith", group: "Tools", title: "Prompt smith", desc: "Use Auto-Prompt 5 times.", points: 75, goal: { key: "autoprompt", target: 5 } },
  { id: "scout", group: "Tools", title: "Scout", desc: "Let Hamrin look up 5 web pages or searches.", points: 75, goal: { key: "web", target: 5 } },
  ...EPISODES.map((item, index) => ({
    id: "class-" + item.id,
    group: "Learn",
    title: "Episode " + (index + 1),
    desc: "Finish " + item.name + ".",
    points: 60,
    goal: { key: "episode:" + item.id, target: 1 },
  })),
  {
    id: "graduate",
    group: "Learn",
    title: "Graduate",
    desc: "Finish all five Episodes.",
    points: 250,
    goal: { all: EPISODES.map((item) => ({ key: "episode:" + item.id, target: 1 })) },
  },
  {
    id: "explorer",
    group: "Explore",
    title: "Explorer",
    desc: "Visit Ops, Help, Reasoning, Notes, Billing, and Settings.",
    points: 100,
    goal: { all: ["ops", "help", "reasoning", "notes", "billing", "settings"].map((item) => ({ key: "view:" + item, target: 1 })) },
  },
  { id: "streak-3", group: "Streaks", title: "Warming up", desc: "Be active 3 days in a row.", points: 75, goal: { special: "streak", target: 3 } },
  { id: "streak-7", group: "Streaks", title: "One full week", desc: "Be active 7 days in a row.", points: 200, goal: { special: "streak", target: 7 } },
  { id: "streak-14", group: "Streaks", title: "Fortnight", desc: "Be active 14 days in a row.", points: 400, goal: { special: "streak", target: 14 } },
  { id: "streak-30", group: "Streaks", title: "Unstoppable", desc: "Be active 30 days in a row.", points: 1000, goal: { special: "streak", target: 30 } },
  { id: "daily-1", group: "Streaks", title: "Clean sweep", desc: "Finish all three daily challenges in one day.", points: 50, goal: { special: "sweeps", target: 1 } },
  { id: "daily-7", group: "Streaks", title: "Seven sweeps", desc: "Finish all three daily challenges on 7 days.", points: 250, goal: { special: "sweeps", target: 7 } },
];

function today(now = Date.now()) {
  return new Date(now).toISOString().slice(0, 10);
}

function nextMidnight(now = Date.now()) {
  const date = new Date(now);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1);
}

function hash(text) {
  let value = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    value ^= text.charCodeAt(i);
    value = Math.imul(value, 16777619) >>> 0;
  }
  return value >>> 0;
}

function dailyFor(day) {
  return ["easy", "medium", "hard"].map((tier) => {
    const pool = DAILY_POOL[tier];
    const pick = pool[hash(day + ":" + tier) % pool.length];
    return { ...pick, tier, points: TIER_POINTS[tier] };
  });
}

function counts(wallet, day) {
  const rows = db.prepare("SELECT key, count FROM quest_activity WHERE wallet = ? AND day = ?").all(wallet, day);
  const map = new Map();
  for (const row of rows) map.set(row.key, Number(row.count) || 0);
  return map;
}

function bump(wallet, day, key, amount) {
  db.prepare(`
    INSERT INTO quest_activity (wallet, day, key, count) VALUES (?, ?, ?, ?)
    ON CONFLICT (wallet, day, key) DO UPDATE SET count = count + excluded.count
  `).run(wallet, day, key, amount);
}

function dayTotal(wallet, day) {
  const row = db.prepare("SELECT COALESCE(SUM(count), 0) AS total FROM quest_activity WHERE wallet = ? AND day = ?").get(wallet, day);
  return Number(row?.total) || 0;
}

/** Count something the server saw. */
export function track(address, keys) {
  const wallet = String(address || "").toLowerCase();
  if (!wallet) return;
  try {
    const day = today();
    if (dayTotal(wallet, day) >= DAY_CAP) return;
    for (const key of keys) {
      bump(wallet, day, key, 1);
      bump(wallet, ALL, key, 1);
    }
  } catch {
    /* counting must never break a chat */
  }
}

const eventStamps = new Map();

/** Count something the page reported. Whitelisted, and each event counts once per day. */
export function recordEvent(address, event) {
  const wallet = String(address || "").toLowerCase();
  const key = String(event || "");
  if (!wallet || !CLIENT_EVENTS.has(key)) {
    const error = new Error("Unknown event.");
    error.status = 400;
    throw error;
  }
  const now = Date.now();
  const recent = (eventStamps.get(wallet) || []).filter((stamp) => now - stamp < 60_000);
  if (recent.length >= 60) {
    const error = new Error("Too many events.");
    error.status = 429;
    throw error;
  }
  recent.push(now);
  eventStamps.set(wallet, recent);
  if (eventStamps.size > 2000) eventStamps.clear();
  const day = today(now);
  if (counts(wallet, day).get(key)) return false;
  track(wallet, [key]);
  return true;
}

function activeDays(wallet) {
  return db
    .prepare("SELECT DISTINCT day FROM quest_activity WHERE wallet = ? AND day != ? ORDER BY day DESC LIMIT 400")
    .all(wallet, ALL)
    .map((row) => row.day);
}

function streakOf(days, now = Date.now()) {
  if (!days.length) return 0;
  const set = new Set(days);
  let cursor = Date.parse(today(now) + "T00:00:00Z");
  if (!set.has(today(now))) cursor -= 86400000;
  let streak = 0;
  while (set.has(new Date(cursor).toISOString().slice(0, 10))) {
    streak += 1;
    cursor -= 86400000;
  }
  return streak;
}

function claimedSet(wallet) {
  const rows = db.prepare("SELECT quest, day FROM quest_claims WHERE wallet = ?").all(wallet);
  return new Set(rows.map((row) => row.quest + "|" + row.day));
}

function progressOf(goal, lookup) {
  if (goal.all) {
    const met = goal.all.filter((part) => (lookup(part.key) || 0) >= part.target).length;
    return { progress: met, target: goal.all.length };
  }
  const value = lookup(goal.key) || 0;
  return { progress: Math.min(value, goal.target), target: goal.target };
}

function build(wallet, now = Date.now()) {
  const day = today(now);
  const todayCounts = counts(wallet, day);
  const lifetime = counts(wallet, ALL);
  const claims = claimedSet(wallet);
  const streak = streakOf(activeDays(wallet), now);
  const sweeps = Number(db.prepare("SELECT COUNT(*) AS n FROM quest_claims WHERE wallet = ? AND quest = 'daily-all'").get(wallet)?.n) || 0;

  const daily = dailyFor(day).map((item) => {
    const { progress, target } = progressOf(item.goal, (key) => todayCounts.get(key));
    return {
      id: item.id,
      tier: item.tier,
      title: item.title,
      desc: item.desc,
      points: item.points,
      progress,
      target,
      done: progress >= target,
      claimed: claims.has("daily:" + item.id + "|" + day),
    };
  });
  const allClaimed = daily.every((item) => item.claimed);
  const bonus = {
    id: "daily-all",
    title: "Clean sweep",
    desc: "Claim all three of today's challenges.",
    points: DAILY_BONUS_POINTS,
    progress: daily.filter((item) => item.claimed).length,
    target: daily.length,
    done: allClaimed,
    claimed: claims.has("daily-all|" + day),
  };

  const achievements = ACHIEVEMENTS.map((item) => {
    let progress;
    let target;
    if (item.goal.special === "streak") {
      target = item.goal.target;
      progress = Math.min(streak, target);
    } else if (item.goal.special === "sweeps") {
      target = item.goal.target;
      progress = Math.min(sweeps, target);
    } else {
      ({ progress, target } = progressOf(item.goal, (key) => lifetime.get(key)));
    }
    return {
      id: item.id,
      group: item.group,
      title: item.title,
      desc: item.desc,
      points: item.points,
      progress,
      target,
      done: progress >= target,
      claimed: claims.has("ach:" + item.id + "|" + ALL),
    };
  });

  const totals = db.prepare("SELECT COALESCE(SUM(points), 0) AS points, COALESCE(SUM(tokens), 0) AS tokens FROM quest_claims WHERE wallet = ?").get(wallet);
  const perCredit = tokensPerCredit();
  return {
    day,
    resetsAt: new Date(nextMidnight(now)).toISOString(),
    streak,
    points: Number(totals.points) || 0,
    creditsEarned: (Number(totals.tokens) || 0) / perCredit,
    pointsPerCredit: Math.round(perCredit / TOKENS_PER_POINT),
    daily,
    bonus,
    achievements,
  };
}

export function questState(address) {
  return build(String(address || "").toLowerCase());
}

/** Pay out one finished challenge or achievement, once. */
export function claimQuest(address, kind, id) {
  const wallet = String(address || "").toLowerCase();
  const state = build(wallet);
  let item;
  let quest;
  let day;
  if (kind === "daily" && id === "daily-all") {
    item = state.bonus;
    quest = "daily-all";
    day = state.day;
  } else if (kind === "daily") {
    item = state.daily.find((row) => row.id === id);
    quest = "daily:" + id;
    day = state.day;
  } else if (kind === "achievement") {
    item = state.achievements.find((row) => row.id === id);
    quest = "ach:" + id;
    day = ALL;
  }
  if (!item) {
    const error = new Error("Unknown challenge.");
    error.status = 404;
    throw error;
  }
  if (item.claimed) {
    const error = new Error("Already claimed.");
    error.status = 409;
    throw error;
  }
  if (!item.done) {
    const error = new Error("Not finished yet.");
    error.status = 400;
    throw error;
  }
  const tokens = item.points * TOKENS_PER_POINT;
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("INSERT INTO quest_claims (wallet, quest, day, points, tokens, claimed_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(wallet, quest, day, item.points, tokens, new Date().toISOString());
    grantBonus(wallet, tokens);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    if (String(error.message).includes("UNIQUE")) {
      const dup = new Error("Already claimed.");
      dup.status = 409;
      throw dup;
    }
    throw error;
  }
  return { awarded: { points: item.points, credits: tokens / tokensPerCredit(), title: item.title } };
}
