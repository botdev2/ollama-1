import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const file = process.env.CHAT_DB || "/root/.ollama/root-chat.sqlite";
fs.mkdirSync(path.dirname(file), { recursive: true });

const db = new DatabaseSync(file);
db.exec(`
  CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY,
    wallet TEXT NOT NULL,
    project_id TEXT NOT NULL,
    title TEXT NOT NULL,
    mode TEXT NOT NULL,
    model TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS conversations_wallet ON conversations (wallet, updated_at);
  CREATE TABLE IF NOT EXISTS turns (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT NOT NULL,
    role TEXT NOT NULL,
    text TEXT NOT NULL,
    think TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS turns_conversation ON turns (conversation_id, id);
`);

function now() {
  return new Date().toISOString();
}

function id() {
  return randomBytes(12).toString("hex");
}

export function listConversations(wallet) {
  return db.prepare(`
    SELECT id, project_id AS projectId, title, mode, model, updated_at AS updatedAt
    FROM conversations
    WHERE wallet = ?
    ORDER BY updated_at DESC
    LIMIT 200
  `).all(wallet);
}

export function getConversation(wallet, conversationId) {
  const row = db.prepare(`
    SELECT id, project_id AS projectId, title, mode, model, updated_at AS updatedAt
    FROM conversations WHERE id = ? AND wallet = ?
  `).get(conversationId, wallet);
  if (!row) return null;
  const turns = db.prepare(`
    SELECT role, text, think FROM turns WHERE conversation_id = ? ORDER BY id ASC
  `).all(conversationId);
  return { ...row, turns };
}

export function ensureConversation(wallet, { conversationId, projectId, title, mode, model }) {
  if (conversationId) {
    const existing = db.prepare("SELECT id FROM conversations WHERE id = ? AND wallet = ?").get(conversationId, wallet);
    if (!existing) return null;
    db.prepare("UPDATE conversations SET mode = ?, model = ?, updated_at = ? WHERE id = ?").run(mode, model, now(), conversationId);
    return conversationId;
  }
  const created = id();
  db.prepare(`
    INSERT INTO conversations (id, wallet, project_id, title, mode, model, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(created, wallet, projectId || "project", (title || "New Agent").slice(0, 80), mode, model, now());
  return created;
}

export function appendTurn(conversationId, role, text, think = "") {
  db.prepare(`
    INSERT INTO turns (conversation_id, role, text, think, created_at) VALUES (?, ?, ?, ?, ?)
  `).run(conversationId, role, text, think || "", now());
  db.prepare("UPDATE conversations SET updated_at = ? WHERE id = ?").run(now(), conversationId);
  const count = db.prepare("SELECT COUNT(*) AS n FROM turns WHERE conversation_id = ?").get(conversationId).n;
  if (count > 400) {
    db.prepare(`
      DELETE FROM turns WHERE conversation_id = ? AND id IN (
        SELECT id FROM turns WHERE conversation_id = ? ORDER BY id ASC LIMIT ?
      )
    `).run(conversationId, conversationId, count - 400);
  }
}

export function priorMessages(conversationId) {
  return db.prepare(`
    SELECT role, text FROM turns WHERE conversation_id = ? ORDER BY id ASC
  `).all(conversationId).map((row) => ({ role: row.role, content: row.text }));
}

export function deleteConversation(wallet, conversationId) {
  const row = db.prepare("SELECT id FROM conversations WHERE id = ? AND wallet = ?").get(conversationId, wallet);
  if (!row) return false;
  db.prepare("DELETE FROM turns WHERE conversation_id = ?").run(conversationId);
  db.prepare("DELETE FROM conversations WHERE id = ?").run(conversationId);
  return true;
}
