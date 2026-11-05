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

// Levels come from lifetime points. They decide how hard today's trials are and how much they pay.
export const LEVELS = [
  { name: "Seed", at: 0 },
  { name: "Sprout", at: 150 },
  { name: "Sapling", at: 400 },
  { name: "Palm", at: 900 },
  { name: "Grove", at: 1800 },
  { name: "Canopy", at: 3200 },
];
// Counting goals grow with level. Rewards grow too, but more slowly, so a higher level is a harder grind.
const GOAL_MULT = [1, 1.3, 1.6, 2, 2.4, 3];
const REWARD_MULT = [1, 1.1, 1.2, 1.35, 1.5, 1.75];
const EPIC_FROM_LEVEL = 3;
const TIER_POINTS = { easy: 30, medium: 50, hard: 70, epic: 110 };
const DAILY_BONUS_POINTS = 100;

function levelIndex(points) {
  let index = 0;
  for (let i = 0; i < LEVELS.length; i += 1) if (points >= LEVELS[i].at) index = i;
  return index;
}

const ALL_VIEWS = ["ops", "help", "reasoning", "notes", "billing", "settings"];
const viewsGoal = (names) => ({ all: names.map((name) => ({ key: "view:" + name, target: 1 })) });

// Every entry is built for the player's level: counting goals scale, and some entries only appear in a level band.
// The first entry that fits is not special. The day picks one of the entries that fit.
const DAILY_POOL = {
  easy: [
    { id: "warm-up", max: 5, make: (n) => ({ title: "Warm up", desc: `Send ${n(3)} messages.`, goal: { key: "turn", target: n(3) } }) },
    { id: "open-two", max: 1, make: () => ({ title: "Find your way", desc: "Open the Ops and Help tabs.", goal: viewsGoal(["ops", "help"]) }) },
    { id: "back-to-class", max: 3, make: () => ({ title: "Back to class", desc: "Finish any Episode.", goal: { key: "episode_any", target: 1 } }) },
    { id: "tour-three", min: 2, make: () => ({ title: "Tour the harness", desc: "Open Ops, Reasoning, Notes, and Billing.", goal: viewsGoal(["ops", "reasoning", "notes", "billing"]) }) },
    { id: "new-chats", max: 5, make: (n) => ({ title: "Fresh starts", desc: `Begin ${n(2)} new chats.`, goal: { key: "chat_new", target: n(2) } }) },
  ],
  medium: [
    { id: "just-asking", make: (n) => ({ title: "Just asking", desc: `Send ${n(3)} messages in Ask mode.`, goal: { key: "turn:ask", target: n(3) } }) },
    { id: "plan-first", make: (n) => ({ title: "Plan first", desc: `Send ${n(3)} messages in Plan mode.`, goal: { key: "turn:plan", target: n(3) } }) },
    { id: "sharpen", make: (n) => ({ title: "Sharpen the ask", desc: `Use Auto-Prompt ${n(2)} times.`, goal: { key: "autoprompt", target: n(2) } }) },
    { id: "look-it-up", make: (n) => ({ title: "Look it up", desc: `Let Hamrin run ${n(3)} web lookups.`, goal: { key: "web", target: n(3) } }) },
    { id: "agent-day", make: (n) => ({ title: "Agent at work", desc: `Send ${n(5)} messages in Agent mode.`, goal: { key: "turn:agent", target: n(5) } }) },
  ],
  hard: [
    { id: "marathon", make: (n) => ({ title: "Marathon", desc: `Send ${n(10)} messages.`, goal: { key: "turn", target: n(10) } }) },
    {
      id: "all-modes",
      make: (n, level) => {
        const each = [2, 2, 3, 3, 4, 5][level];
        return {
          title: "Every mode",
          desc: `Send ${each} messages each in Agent, Ask, and Plan mode.`,
          goal: { all: [{ key: "turn:agent", target: each }, { key: "turn:ask", target: each }, { key: "turn:plan", target: each }] },
        };
      },
    },
    {
      id: "research",
      make: (n) => ({
        title: "Deep research",
        desc: `Run ${n(6)} web lookups and ${n(2)} Auto-Prompts.`,
        goal: { all: [{ key: "web", target: n(6) }, { key: "autoprompt", target: n(2) }] },
      }),
    },
    {
      id: "everything",
      make: (n) => ({
        title: "Use everything",
        desc: `Send ${n(6)} messages, run ${n(2)} web lookups, use Auto-Prompt, and begin ${n(2)} chats.`,
        goal: {
          all: [
            { key: "turn", target: n(6) },
            { key: "web", target: n(2) },
            { key: "autoprompt", target: 1 },
            { key: "chat_new", target: n(2) },
          ],
        },
      }),
    },
  ],
  epic: [
    {
      id: "open-all",
      make: (n, level) => ({
        title: "Left no stone",
        desc: `Open every tab, send ${n(8)} messages, and finish an Episode.`,
        goal: { all: [...ALL_VIEWS.map((name) => ({ key: "view:" + name, target: 1 })), { key: "turn", target: n(8) }, { key: "episode_any", target: 1 }] },
      }),
    },
    {
      id: "double-class",
      make: (n, level, day) => {
        const first = EPISODES[hash(day + ":a") % EPISODES.length];
        let second = EPISODES[hash(day + ":b") % EPISODES.length];
        if (second.id === first.id) second = EPISODES[(EPISODES.indexOf(first) + 1) % EPISODES.length];
        return {
          title: "Double feature",
          desc: `Finish Episode ${EPISODES.indexOf(first) + 1} and Episode ${EPISODES.indexOf(second) + 1}, then send ${n(6)} messages.`,
          goal: { all: [{ key: "episode:" + first.id, target: 1 }, { key: "episode:" + second.id, target: 1 }, { key: "turn", target: n(6) }] },
        };
      },
    },
    {
      id: "power-user",
      make: (n, level) => {
        const each = [2, 2, 3, 3, 4, 5][level];
        return {
          title: "Power user",
          desc: `Send ${each} messages in every mode, run ${n(6)} web lookups, and use Auto-Prompt ${n(3)} times.`,
          goal: {
            all: [
              { key: "turn:agent", target: each },
              { key: "turn:ask", target: each },
              { key: "turn:plan", target: each },
              { key: "web", target: n(6) },
              { key: "autoprompt", target: n(3) },
            ],
          },
        };
      },
    },
  ],
};
const ACHIEVEMENTS = [
  { id: "first-words", group: "Chat", title: "First words", desc: "Send your first message to Hamrin.", points: 25, goal: { key: "turn", target: 1 } },
  { id: "chatterbox", group: "Chat", title: "Chatterbox", desc: "Send 25 messages.", points: 100, goal: { key: "turn", target: 25 } },
  { id: "centurion", group: "Chat", title: "Centurion", desc: "Send 100 messages.", points: 300, goal: { key: "turn", target: 100 } },
  { id: "legend", group: "Chat", title: "Living legend", desc: "Send 500 messages.", points: 600, goal: { key: "turn", target: 500 } },
  {
    id: "versatile",
    group: "Chat",
    title: "Versatile",
    desc: "Send 25 messages in each of Agent, Ask, and Plan mode.",
    points: 300,
    goal: { all: [{ key: "turn:agent", target: 25 }, { key: "turn:ask", target: 25 }, { key: "turn:plan", target: 25 }] },
  },
  { id: "ask-away", group: "Chat", title: "Ask away", desc: "Send 3 messages in Ask mode.", points: 50, goal: { key: "turn:ask", target: 3 } },
  { id: "planner", group: "Chat", title: "Planner", desc: "Send 3 messages in Plan mode.", points: 50, goal: { key: "turn:plan", target: 3 } },
  { id: "agent-smith", group: "Chat", title: "Agent at large", desc: "Send 10 messages in Agent mode.", points: 50, goal: { key: "turn:agent", target: 10 } },
  { id: "collector", group: "Chat", title: "Collector", desc: "Begin 5 chats.", points: 60, goal: { key: "chat_new", target: 5 } },
  { id: "prompt-smith", group: "Tools", title: "Prompt smith", desc: "Use Auto-Prompt 5 times.", points: 75, goal: { key: "autoprompt", target: 5 } },
  { id: "scout", group: "Tools", title: "Scout", desc: "Let Hamrin look up 5 web pages or searches.", points: 75, goal: { key: "web", target: 5 } },
  { id: "prompt-master", group: "Tools", title: "Prompt master", desc: "Use Auto-Prompt 25 times.", points: 200, goal: { key: "autoprompt", target: 25 } },
  { id: "cartographer", group: "Tools", title: "Cartographer", desc: "Let Hamrin look up 25 web pages or searches.", points: 200, goal: { key: "web", target: 25 } },
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
  { id: "streak-60", group: "Streaks", title: "Evergreen", desc: "Be active 60 days in a row.", points: 1500, goal: { special: "streak", target: 60 } },
  { id: "daily-30", group: "Streaks", title: "Thirty sweeps", desc: "Finish all of the daily challenges on 30 days.", points: 800, goal: { special: "sweeps", target: 30 } },
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

function dailyFor(day, level) {
  const scale = (base) => Math.max(1, Math.round(base * GOAL_MULT[level]));
  const tiers = level >= EPIC_FROM_LEVEL ? ["easy", "medium", "hard", "epic"] : ["easy", "medium", "hard"];
  return tiers.map((tier) => {
    const fits = DAILY_POOL[tier].filter((entry) => level >= (entry.min ?? 0) && level <= (entry.max ?? 99));
    const pick = fits[hash(day + ":" + tier) % fits.length];
    return { id: pick.id, tier, points: Math.round(TIER_POINTS[tier] * REWARD_MULT[level]), ...pick.make(scale, level, day) };
  });
}

// Level is read from points earned before today, so the day's trials do not change when you claim one.
function trialLevel(wallet, day) {
  const row = db.prepare("SELECT COALESCE(SUM(points), 0) AS points FROM quest_claims WHERE wallet = ? AND claimed_at < ?").get(wallet, day + "T00:00:00.000Z");
  return levelIndex(Number(row?.points) || 0);
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

  const level = trialLevel(wallet, day);
  const daily = dailyFor(day, level).map((item) => {
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
    points: Math.round(DAILY_BONUS_POINTS * REWARD_MULT[level]),
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
    trials: { level, name: LEVELS[level].name, goalMult: GOAL_MULT[level], rewardMult: REWARD_MULT[level], epic: level >= EPIC_FROM_LEVEL, nextEpicAt: level >= EPIC_FROM_LEVEL ? null : LEVELS[EPIC_FROM_LEVEL].at },
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
