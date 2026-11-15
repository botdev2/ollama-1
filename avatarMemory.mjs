import { database } from "./credits.mjs";

const SAID_MS = 6 * 60 * 60 * 1000;
const SEEN_MS = 45 * 60 * 1000;
const ADVICE_MS = 4 * 60 * 60 * 1000;
const MAX_ROWS = 36;
const DEDUPE_MS = 20 * 60 * 1000;

const db = database();
db.exec(`
  CREATE TABLE IF NOT EXISTS avatar_memory (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    wallet TEXT NOT NULL,
    kind TEXT NOT NULL,
    text TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS avatar_memory_wallet ON avatar_memory (wallet, expires_at);
`);

function nowIso() {
  return new Date().toISOString();
}

function prune(wallet) {
  db.prepare("DELETE FROM avatar_memory WHERE expires_at < ?").run(nowIso());
  const key = String(wallet || "").toLowerCase();
  if (!key) return;
  const n = Number(db.prepare("SELECT COUNT(*) AS n FROM avatar_memory WHERE wallet = ?").get(key)?.n) || 0;
  if (n <= MAX_ROWS) return;
  db.prepare(`
    DELETE FROM avatar_memory WHERE id IN (
      SELECT id FROM avatar_memory WHERE wallet = ? ORDER BY created_at ASC LIMIT ?
    )
  `).run(key, n - MAX_ROWS);
}

export function remember(wallet, kind, text, ttlMs = SAID_MS) {
  const key = String(wallet || "").toLowerCase();
  const note = String(text || "").replace(/\s+/g, " ").trim().slice(0, 400);
  const type = String(kind || "said").slice(0, 24);
  if (!key || !note) return false;
  prune(key);
  const recent = db.prepare(`
    SELECT text FROM avatar_memory
    WHERE wallet = ? AND kind = ? AND created_at > ?
    ORDER BY id DESC LIMIT 1
  `).get(key, type, new Date(Date.now() - DEDUPE_MS).toISOString());
  if (recent?.text === note) return false;
  db.prepare(`
    INSERT INTO avatar_memory (wallet, kind, text, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(key, type, note, nowIso(), new Date(Date.now() + ttlMs).toISOString());
  prune(key);
  return true;
}

export function recall(wallet) {
  const key = String(wallet || "").toLowerCase();
  prune(key);
  if (!key) return [];
  return db.prepare(`
    SELECT kind, text, created_at AS at
    FROM avatar_memory
    WHERE wallet = ? AND expires_at > ?
    ORDER BY id DESC
    LIMIT 24
  `).all(key, nowIso());
}

export function memoryPrompt(wallet) {
  const rows = recall(wallet);
  if (!rows.length) return "";
  const lines = rows
    .slice()
    .reverse()
    .map((row) => `- (${row.kind}) ${row.text}`);
  return [
    "Short-term memory about this person. Use it. Never mention that you keep notes or a database.",
    ...lines,
  ].join("\n");
}

export function spokenBit(text) {
  const raw = String(text || "").replace(/\s+/g, " ").trim();
  const marker = "The person is on the ";
  const at = raw.lastIndexOf(marker);
  if (at < 0) return raw;
  const rest = raw.slice(at);
  const dot = rest.indexOf(". ");
  return (dot >= 0 ? rest.slice(dot + 2) : raw).trim();
}

export function noteSeen(wallet, view, project) {
  const screen = String(view || "home").slice(0, 40);
  const repo = String(project || "").slice(0, 80);
  return remember(wallet, "seen", repo ? `On ${screen}, repository ${repo}` : `On ${screen}`, SEEN_MS);
}

export function noteSaid(wallet, text) {
  return remember(wallet, "said", spokenBit(text), SAID_MS);
}

export function noteAdvice(wallet, text) {
  return remember(wallet, "advice", text, ADVICE_MS);
}

export function noteWork(wallet, chat) {
  const lines = String(chat || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const last = [...lines].reverse().find((line) => /^You:/i.test(line)) || lines[lines.length - 1] || "";
  const note = last.replace(/^You:\s*/i, "").replace(/^Agent:\s*/i, "").slice(0, 280);
  if (!note) return false;
  return remember(wallet, "work", note, SAID_MS);
}

export function clipWorkspace(body) {
  return {
    chat: String(body?.chat || "").slice(0, 2500),
    files: String(body?.files || "").slice(0, 3500),
    title: String(body?.workTitle || "").slice(0, 80),
    mode: String(body?.workMode || "").slice(0, 16),
  };
}

export function companionSystem({ view, projectLabel, wallet, chat, files, title, mode }) {
  const screen = String(view || "home").slice(0, 40);
  const repo = String(projectLabel || "").slice(0, 80);
  const work = title ? `${title}${mode ? " · " + mode : ""}` : mode;
  return [
    "You are the companion avatar in the corner of /root.",
    "You can see the open Hamrin conversation and the repository files in this prompt. Use them.",
    "You do not have a camera and you do not need one. Never say you cannot see the chat, files, terminal, or screen.",
    "If asked whether you can see, say you can see the open chat and repo.",
    "Reply in one or two short spoken sentences. No markdown, no lists, no tools. Stay in character.",
    "Never mention memory, notes, or a database.",
    `They are on the ${screen} screen` + (repo ? `, repository ${repo}.` : "."),
    work ? "Open agent chat: " + work + "." : "",
    chat ? "Conversation:\n" + chat : "",
    files ? "Repository:\n" + files : "",
    memoryPrompt(wallet),
  ]
    .filter(Boolean)
    .join("\n");
}
