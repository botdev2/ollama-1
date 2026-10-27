import { spawn } from "node:child_process";
import { timingSafeEqual, randomBytes } from "node:crypto";
import http from "node:http";
import { appendTurn, deleteConversation, ensureConversation, getConversation, listConversations, MAX_CONVERSATIONS, priorMessages } from "./chatStore.mjs";
import { buildSystemPrompt, extractThink, finalizeAnswer, trimMessages } from "./harness.mjs";

const PORT = Number(process.env.PORT || 3000);
const MAX_USERS = Number(process.env.MAX_USERS || 5);
const NAME = process.env.INSTANCE_NAME || "Ollama #1";
const GATE = process.env.GATE_TOKEN || "";
const OLLAMA = (process.env.OLLAMA_BASE || "http://127.0.0.1:11434").replace(/\/$/, "");
const OLLAMA_API_KEY = process.env.OLLAMA_API_KEY || "";
const CLOUD = "https://ollama.com";
const GLM_MODEL = "glm-5.2";
const SESSION_MS = 15 * 60 * 1000;
const GLM_ORIGINS = new Set([
  "https://chat.useroot.sh",
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "http://localhost:5174",
  "http://127.0.0.1:5174",
]);

const sessions = new Map();
let signinProc = null;
let accountCache = { at: 0, body: null };
let glmBusy = 0;

function json(res, code, body) {
  const payload = JSON.stringify(body);
  res.writeHead(code, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function glmCors(req, res) {
  const origin = req.headers.origin || "";
  if (!GLM_ORIGINS.has(origin)) return false;
  res.setHeader("access-control-allow-origin", origin);
  res.setHeader("vary", "Origin");
  res.setHeader("access-control-allow-headers", "content-type, x-wallet");
  res.setHeader("access-control-allow-methods", "GET, POST, DELETE, OPTIONS");
  return true;
}

function walletHeader(req) {
  const value = String(req.headers["x-wallet"] || "");
  return /^0x[a-fA-F0-9]{40}$/.test(value) ? value : "";
}

function glmMessages(body) {
  if (!Array.isArray(body?.messages) || body.messages.length === 0) return null;
  const messages = [];
  for (const item of body.messages.slice(-32)) {
    const role = item?.role === "assistant" ? "assistant" : item?.role === "user" ? "user" : "";
    const content = String(item?.content || "").trim().slice(0, 12000);
    if (!role || !content) continue;
    messages.push({ role, content });
  }
  return messages.length ? messages : null;
}

async function askGlm(messages) {
  const response = await fetch(CLOUD + "/api/chat", {
    method: "POST",
    headers: {
      authorization: "Bearer " + OLLAMA_API_KEY,
      "content-type": "application/json",
    },
    body: JSON.stringify({ model: GLM_MODEL, messages, stream: false }),
  });
  const text = await response.text();
  let payload = {};
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = {};
  }
  if (!response.ok) {
    const error = new Error(payload.error || "GLM 5.2 cloud did not answer.");
    error.status = response.status;
    throw error;
  }
  const answer = String(payload.message?.content || "").trim();
  if (!answer) {
    const error = new Error("GLM 5.2 cloud returned an empty answer.");
    error.status = 502;
    throw error;
  }
  return answer;
}

function authorized(req) {
  if (!GATE) return false;
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  const left = Buffer.from(token);
  const right = Buffer.from(GATE);
  if (left.length !== right.length || left.length === 0) return false;
  return timingSafeEqual(left, right);
}

function prune() {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (!session.busy && now - session.seen > SESSION_MS) sessions.delete(id);
  }
}

function isCloudModel(model) {
  if (typeof model !== "string") return false;
  const name = model.trim();
  if (!/^[\w./:+-]{1,120}$/.test(name)) return false;
  return name.includes(":cloud") || name.endsWith("-cloud");
}

async function readBody(req, limit = 2_000_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) {
      const error = new Error("body too large");
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    const error = new Error("invalid json");
    error.status = 400;
    throw error;
  }
}

async function ollamaMe() {
  const now = Date.now();
  if (accountCache.body && now - accountCache.at < 15000) return accountCache.body;
  try {
    const response = await fetch(OLLAMA + "/api/me", { method: "POST" });
    const text = await response.text();
    let body = {};
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = { raw: text.slice(0, 300) };
    }
    const status = {
      reachable: true,
      status: response.status,
      signedIn: Boolean(body.name || body.username),
      user: body.name || body.username || "",
      signInUrl: body.signin_url || body.signInUrl || "",
    };
    accountCache = { at: now, body: status };
    return status;
  } catch (error) {
    const status = { reachable: false, signedIn: false, user: "", error: error.message };
    accountCache = { at: now, body: status };
    return status;
  }
}

function beginSignIn() {
  if (signinProc && !signinProc.exited && signinProc.url) return Promise.resolve(signinProc.url);
  if (signinProc && !signinProc.exited) {
    try {
      signinProc.child.kill();
    } catch {
      /* already gone */
    }
  }
  return new Promise((resolve) => {
    const child = spawn("ollama", ["signin"], { env: process.env });
    const state = { child, url: "", buf: "", exited: false };
    signinProc = state;
    const take = (chunk) => {
      state.buf += chunk.toString();
      const match = state.buf.match(/https:\/\/\S+/);
      if (match && !state.url) {
        state.url = match[0].replace(/[),.;]+$/, "");
        resolve(state.url);
      }
    };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    child.on("exit", () => {
      state.exited = true;
    });
    setTimeout(() => resolve(state.url || ""), 12000);
  });
}

function publicState(account) {
  prune();
  return {
    instance: NAME,
    maxUsers: MAX_USERS,
    activeUsers: sessions.size,
    busy: [...sessions.values()].filter((session) => session.busy).length,
    signedIn: Boolean(account?.signedIn),
    user: account?.user || "",
    ollama: account?.reachable ? "up" : "down",
  };
}

const page = `<!doctype html>
<html lang="en">
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${NAME}</title>
<style>
  body { margin: 0; font: 15px/1.45 "Segoe UI", sans-serif; background: #121110; color: #f5f2ec; }
  main { max-width: 640px; margin: 0 auto; padding: 32px 20px 64px; }
  h1 { font-weight: 560; font-size: 28px; margin: 0 0 8px; }
  p, li { color: #b8b0a6; }
  label { display: block; margin: 18px 0 6px; color: #8a837a; font-size: 12px; }
  input { width: 100%; box-sizing: border-box; height: 40px; border-radius: 10px; border: 1px solid #3a3835; background: #1a1918; color: inherit; padding: 0 12px; }
  button { height: 38px; margin: 12px 8px 0 0; border-radius: 10px; border: 1px solid #3a3835; background: #f5f2ec; color: #121110; padding: 0 14px; cursor: pointer; }
  button.ghost { background: transparent; color: #f5f2ec; }
  pre { white-space: pre-wrap; background: #1e1d1b; border-radius: 12px; padding: 12px; }
  a { color: #f5f2ec; }
</style>
<main>
  <h1>${NAME}</h1>
  <p>Processing server for Ollama <code>:cloud</code> models. Sign in with your Ollama user, then this instance serves up to ${MAX_USERS} people at a time.</p>
  <label>Gate token</label>
  <input id="token" type="password" autocomplete="off" />
  <div>
    <button id="save" type="button">Save token</button>
    <button id="status" class="ghost" type="button">Refresh</button>
    <button id="signin" class="ghost" type="button">Sign in</button>
    <button id="slot" class="ghost" type="button">Take a slot</button>
  </div>
  <pre id="out">Token stays in this browser.</pre>
</main>
<script>
  const out = document.getElementById("out");
  const tokenEl = document.getElementById("token");
  tokenEl.value = sessionStorage.getItem("gate") || "";
  const show = (value) => { out.textContent = typeof value === "string" ? value : JSON.stringify(value, null, 2); };
  const headers = () => ({ authorization: "Bearer " + tokenEl.value.trim(), "content-type": "application/json" });
  document.getElementById("save").onclick = () => { sessionStorage.setItem("gate", tokenEl.value.trim()); show("Saved in this tab."); };
  document.getElementById("status").onclick = async () => {
    const res = await fetch("/v1/status", { headers: headers() });
    show(await res.json());
  };
  document.getElementById("signin").onclick = async () => {
    const res = await fetch("/v1/signin", { method: "POST", headers: headers() });
    const body = await res.json();
    show(body);
    if (body.url) window.open(body.url, "_blank", "noopener");
  };
  document.getElementById("slot").onclick = async () => {
    const res = await fetch("/v1/sessions", { method: "POST", headers: headers() });
    const body = await res.json();
    show(body);
    if (body.id) sessionStorage.setItem("slot", body.id);
  };
</script>
`;

async function handleWalletChat(req, res, url) {
  const path = url.pathname;
  const chatPath = path === "/v1/conversations" || path.startsWith("/v1/conversations/") || path === "/v1/chat/turn";
  if (!chatPath) return false;
  const allowed = glmCors(req, res);
  if (!allowed) {
    json(res, 403, { error: "This chat is only available from the Root harness." });
    return true;
  }
  const wallet = walletHeader(req).toLowerCase();
  if (!wallet) {
    json(res, 401, { error: "Connect a wallet first." });
    return true;
  }
  if (req.method === "GET" && path === "/v1/conversations") {
    const listed = listConversations(wallet);
    json(res, 200, {
      conversations: listed.conversations,
      dropped: listed.dropped,
      maxConversations: listed.maxConversations,
      contextWindow: 8192,
    });
    return true;
  }
  if (req.method === "GET" && path.startsWith("/v1/conversations/")) {
    const conversation = getConversation(wallet, decodeURIComponent(path.slice("/v1/conversations/".length)));
    if (!conversation) {
      json(res, 404, { error: "That conversation is not on this wallet." });
      return true;
    }
    json(res, 200, { conversation });
    return true;
  }
  if (req.method === "DELETE" && path.startsWith("/v1/conversations/")) {
    const removed = deleteConversation(wallet, decodeURIComponent(path.slice("/v1/conversations/".length)));
    json(res, removed ? 200 : 404, removed ? { ok: true } : { error: "That conversation is not on this wallet." });
    return true;
  }
  if (req.method === "POST" && path === "/v1/chat/turn") {
    if (!OLLAMA_API_KEY) {
      json(res, 503, { error: "GLM 5.2 cloud is not configured." });
      return true;
    }
    if (glmBusy >= MAX_USERS) {
      json(res, 429, { error: NAME + " is already serving " + MAX_USERS + " users." });
      return true;
    }
    const body = await readBody(req);
    const text = String(body.text || "").trim().slice(0, 12000);
    if (!text) {
      json(res, 400, { error: "text is required." });
      return true;
    }
    const mode = body.mode === "ask" || body.mode === "plan" ? body.mode : "agent";
    const title = String(body.title || text).trim().slice(0, 80);
    const ensured = ensureConversation(wallet, {
      conversationId: String(body.conversationId || ""),
      projectId: String(body.projectId || "project").slice(0, 80),
      title,
      mode,
      model: "glm-5.2:cloud",
    });
    const conversationId = ensured?.id || "";
    const dropped = ensured?.dropped || [];
    if (!conversationId) {
      json(res, 404, { error: "That conversation is not on this wallet." });
      return true;
    }
    const system = buildSystemPrompt({
      mode,
      project: { label: String(body.projectLabel || ""), remote: String(body.projectRemote || "") },
      brain: body.brain && typeof body.brain === "object" ? body.brain : {},
      files: String(body.files || ""),
      autoprompt: body.autoprompt === true,
    });
    const history = priorMessages(conversationId).map((item) => ({
      role: item.role === "assistant" ? "assistant" : "user",
      content: finalizeAnswer(item.content),
    })).filter((item) => item.content);
    history.push({ role: "user", content: text });
    const packed = trimMessages(system, history);
    glmBusy += 1;
    try {
      const raw = await askGlm(packed.messages.filter((item) => item.role !== "system").length ? packed.messages : [{ role: "user", content: text }]);
      const think = extractThink(raw);
      const answer = finalizeAnswer(raw);
      appendTurn(conversationId, "user", text, "");
      appendTurn(conversationId, "assistant", answer, think);
      const conversation = getConversation(wallet, conversationId);
      json(res, 200, {
        conversation,
        think,
        text: answer,
        usage: packed.usage,
        trimmed: packed.trimmed,
        dropped,
        maxConversations: MAX_CONVERSATIONS,
      });
    } finally {
      glmBusy -= 1;
    }
    return true;
  }
  json(res, 404, { error: "not found" });
  return true;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", "http://127.0.0.1");
  try {
    if (req.method === "GET" && url.pathname === "/health") {
      json(res, 200, { ok: true, instance: NAME });
      return;
    }
    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(page);
      return;
    }
    if (url.pathname === "/v1/glm" || url.pathname === "/v1/conversations" || url.pathname.startsWith("/v1/conversations/") || url.pathname === "/v1/chat/turn") {
      if (req.method === "OPTIONS") {
        const allowed = glmCors(req, res);
        res.writeHead(allowed ? 204 : 403);
        res.end();
        return;
      }
    }
    if (await handleWalletChat(req, res, url)) return;
    if (!authorized(req)) {
      json(res, 401, { error: "Sign in with the gate token." });
      return;
    }

    if (req.method === "GET" && url.pathname === "/v1/status") {
      json(res, 200, publicState(await ollamaMe()));
      return;
    }

    if (req.method === "GET" && url.pathname === "/v1/account") {
      accountCache.at = 0;
      json(res, 200, await ollamaMe());
      return;
    }

    if (req.method === "POST" && url.pathname === "/v1/signin") {
      accountCache.at = 0;
      const account = await ollamaMe();
      if (account.signedIn) {
        json(res, 200, { signedIn: true, user: account.user, instance: NAME });
        return;
      }
      const urlFromCli = await beginSignIn();
      const again = await ollamaMe();
      const link = urlFromCli || again.signInUrl || "";
      json(res, link ? 200 : 502, {
        signedIn: false,
        url: link,
        hint: link ? "Open this URL and approve Ollama #1 with your Ollama user." : "Ollama did not return a sign-in URL yet.",
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/v1/sessions") {
      prune();
      if (sessions.size >= MAX_USERS) {
        json(res, 429, { error: NAME + " is already serving " + MAX_USERS + " users.", activeUsers: sessions.size, maxUsers: MAX_USERS });
        return;
      }
      const id = randomBytes(16).toString("hex");
      sessions.set(id, { seen: Date.now(), busy: false });
      json(res, 201, { id, instance: NAME, activeUsers: sessions.size, maxUsers: MAX_USERS });
      return;
    }

    if (req.method === "DELETE" && url.pathname.startsWith("/v1/sessions/")) {
      sessions.delete(url.pathname.slice("/v1/sessions/".length));
      json(res, 200, { activeUsers: sessions.size, maxUsers: MAX_USERS });
      return;
    }

    if (req.method === "GET" && url.pathname === "/v1/models") {
      let live = [];
      try {
        const response = await fetch(OLLAMA + "/api/tags");
        const body = await response.json();
        live = (body.models || []).map((item) => item.name).filter(isCloudModel);
      } catch {
        live = [];
      }
      json(res, 200, {
        instance: NAME,
        models: live,
        note: "Only :cloud models are accepted.",
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/v1/chat") {
      const body = await readBody(req);
      const sessionId = req.headers["x-session"] || body.session;
      prune();
      const session = sessions.get(sessionId);
      if (!session) {
        json(res, 401, { error: "Take a slot first. This instance serves " + MAX_USERS + " users." });
        return;
      }
      if (!isCloudModel(body.model)) {
        json(res, 400, { error: "Ollama #1 only runs :cloud models." });
        return;
      }
      if (!Array.isArray(body.messages) || body.messages.length === 0) {
        json(res, 400, { error: "messages is required." });
        return;
      }
      const account = await ollamaMe();
      if (!account.signedIn) {
        json(res, 409, { error: "Sign in with your Ollama user before sending cloud prompts.", url: account.signInUrl || "" });
        return;
      }
      if (session.busy) {
        json(res, 429, { error: "This slot already has a prompt running." });
        return;
      }
      session.busy = true;
      session.seen = Date.now();
      try {
        const upstream = await fetch(OLLAMA + "/api/chat", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: body.model.trim(),
            messages: body.messages,
            stream: Boolean(body.stream),
            options: body.options && typeof body.options === "object" ? body.options : undefined,
          }),
        });
        if (body.stream) {
          res.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") || "application/x-ndjson" });
          const reader = upstream.body.getReader();
          while (true) {
            const step = await reader.read();
            if (step.done) break;
            res.write(step.value);
          }
          res.end();
          return;
        }
        const text = await upstream.text();
        res.writeHead(upstream.status, { "content-type": "application/json; charset=utf-8" });
        res.end(text);
      } finally {
        session.busy = false;
        session.seen = Date.now();
      }
      return;
    }

    json(res, 404, { error: "not found" });
  } catch (error) {
    json(res, error.status || 500, { error: error.message || "processing failed" });
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(NAME + " processing server on " + PORT + ", cap " + MAX_USERS);
});
