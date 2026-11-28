import { randomBytes } from "node:crypto";
import { database } from "./credits.mjs";

const db = database();
db.exec(`
  CREATE TABLE IF NOT EXISTS day_notes (
    id TEXT PRIMARY KEY,
    wallet TEXT NOT NULL,
    day TEXT NOT NULL,
    text TEXT NOT NULL,
    part TEXT NOT NULL,
    done INTEGER NOT NULL DEFAULT 0,
    project_id TEXT NOT NULL DEFAULT '',
    project_label TEXT NOT NULL DEFAULT '',
    conversation_id TEXT NOT NULL DEFAULT '',
    conversation_title TEXT NOT NULL DEFAULT '',
    miles_remind INTEGER NOT NULL DEFAULT 0,
    remind_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS day_notes_wallet_day ON day_notes (wallet, day);
  CREATE INDEX IF NOT EXISTS day_notes_remind ON day_notes (wallet, miles_remind, remind_at, done);
`);

const PARTS = new Set(["morning", "afternoon", "evening", "night"]);

function now() {
  return new Date().toISOString();
}

function id() {
  return randomBytes(12).toString("hex");
}

function dayKey(value) {
  const text = String(value || "").slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  return new Date().toISOString().slice(0, 10);
}

function cleanPart(value) {
  const part = String(value || "").toLowerCase();
  return PARTS.has(part) ? part : "afternoon";
}

function shown(row) {
  if (!row) return null;
  return {
    id: row.id,
    day: row.day,
    text: row.text,
    part: row.part,
    done: Boolean(row.done),
    projectId: row.projectId || "",
    projectLabel: row.projectLabel || "",
    conversationId: row.conversationId || "",
    conversationTitle: row.conversationTitle || "",
    milesRemind: Boolean(row.milesRemind),
    remindAt: row.remindAt || null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

const SELECT = `
  SELECT id, day, text, part, done,
    project_id AS projectId, project_label AS projectLabel,
    conversation_id AS conversationId, conversation_title AS conversationTitle,
    miles_remind AS milesRemind, remind_at AS remindAt,
    created_at AS createdAt, updated_at AS updatedAt
  FROM day_notes
`;

export function listNotes(wallet, day) {
  const key = dayKey(day);
  return db
    .prepare(`${SELECT} WHERE wallet = ? AND day = ? ORDER BY done ASC, created_at ASC`)
    .all(wallet, key)
    .map(shown);
}

export function dueMilesNotes(wallet, at = now()) {
  const stamp = String(at || now());
  const today = dayKey(stamp);
  return db
    .prepare(
      `${SELECT}
       WHERE wallet = ?
         AND done = 0
         AND miles_remind = 1
         AND day = ?
         AND (remind_at IS NULL OR remind_at = '' OR remind_at <= ?)
       ORDER BY remind_at ASC, created_at ASC
       LIMIT 20`,
    )
    .all(wallet, today, stamp)
    .map(shown);
}

export function createNote(wallet, body = {}) {
  const text = String(body.text || "").trim().slice(0, 280);
  if (!text) {
    const error = new Error("Note text is required.");
    error.status = 400;
    throw error;
  }
  const noteId = id();
  const stamp = now();
  const day = dayKey(body.day);
  const part = cleanPart(body.part);
  const projectId = String(body.projectId || "").slice(0, 80);
  const projectLabel = String(body.projectLabel || "").slice(0, 80);
  const conversationId = String(body.conversationId || "").slice(0, 80);
  const conversationTitle = String(body.conversationTitle || "").slice(0, 80);
  const milesRemind = body.milesRemind ? 1 : 0;
  const remindAt = body.remindAt ? String(body.remindAt).slice(0, 40) : null;
  db.prepare(`
    INSERT INTO day_notes (
      id, wallet, day, text, part, done,
      project_id, project_label, conversation_id, conversation_title,
      miles_remind, remind_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    noteId,
    wallet,
    day,
    text,
    part,
    projectId,
    projectLabel,
    conversationId,
    conversationTitle,
    milesRemind,
    remindAt,
    stamp,
    stamp,
  );
  return shown(db.prepare(`${SELECT} WHERE id = ?`).get(noteId));
}

export function updateNote(wallet, noteId, body = {}) {
  const row = db.prepare(`${SELECT} WHERE id = ? AND wallet = ?`).get(noteId, wallet);
  if (!row) return null;
  const text = body.text != null ? String(body.text || "").trim().slice(0, 280) : row.text;
  if (!text) {
    const error = new Error("Note text is required.");
    error.status = 400;
    throw error;
  }
  const part = body.part != null ? cleanPart(body.part) : row.part;
  const done = body.done != null ? (body.done ? 1 : 0) : row.done ? 1 : 0;
  const projectId = body.projectId != null ? String(body.projectId || "").slice(0, 80) : row.projectId || "";
  const projectLabel = body.projectLabel != null ? String(body.projectLabel || "").slice(0, 80) : row.projectLabel || "";
  const conversationId =
    body.conversationId != null ? String(body.conversationId || "").slice(0, 80) : row.conversationId || "";
  const conversationTitle =
    body.conversationTitle != null ? String(body.conversationTitle || "").slice(0, 80) : row.conversationTitle || "";
  const milesRemind = body.milesRemind != null ? (body.milesRemind ? 1 : 0) : row.milesRemind ? 1 : 0;
  let remindAt = row.remindAt || null;
  if (body.remindAt !== undefined) remindAt = body.remindAt ? String(body.remindAt).slice(0, 40) : null;
  const stamp = now();
  db.prepare(`
    UPDATE day_notes SET
      text = ?, part = ?, done = ?,
      project_id = ?, project_label = ?, conversation_id = ?, conversation_title = ?,
      miles_remind = ?, remind_at = ?, updated_at = ?
    WHERE id = ? AND wallet = ?
  `).run(
    text,
    part,
    done,
    projectId,
    projectLabel,
    conversationId,
    conversationTitle,
    milesRemind,
    remindAt,
    stamp,
    noteId,
    wallet,
  );
  return shown(db.prepare(`${SELECT} WHERE id = ?`).get(noteId));
}

export function deleteNote(wallet, noteId) {
  const row = db.prepare("SELECT id FROM day_notes WHERE id = ? AND wallet = ?").get(noteId, wallet);
  if (!row) return false;
  db.prepare("DELETE FROM day_notes WHERE id = ?").run(noteId);
  return true;
}

export function replaceDayNotes(wallet, day, notes) {
  const key = dayKey(day);
  const list = Array.isArray(notes) ? notes : [];
  const wipe = db.prepare("DELETE FROM day_notes WHERE wallet = ? AND day = ?");
  const insert = db.prepare(`
    INSERT INTO day_notes (
      id, wallet, day, text, part, done,
      project_id, project_label, conversation_id, conversation_title,
      miles_remind, remind_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const stamp = now();
  wipe.run(wallet, key);
  for (const item of list.slice(0, 40)) {
    const text = String(item?.text || "").trim().slice(0, 280);
    if (!text) continue;
    insert.run(
      String(item.id || id()).slice(0, 40),
      wallet,
      key,
      text,
      cleanPart(item.part),
      item.done ? 1 : 0,
      String(item.projectId || "").slice(0, 80),
      String(item.projectLabel || "").slice(0, 80),
      String(item.conversationId || "").slice(0, 80),
      String(item.conversationTitle || "").slice(0, 80),
      item.milesRemind ? 1 : 0,
      item.remindAt ? String(item.remindAt).slice(0, 40) : null,
      String(item.createdAt || stamp).slice(0, 40),
      stamp,
    );
  }
  return listNotes(wallet, key);
}
