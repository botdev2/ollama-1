export const CONTEXT_WINDOW = 8192;
const MIN_RESERVE = 1024;
const MAX_RESERVE = 4096;
const MIN_RECENT = 4;
const TRIM_NOTICE =
  "[Older turns were trimmed to stay within the model context window. Rely on the latest request above. Ask again if a trimmed detail still matters.]";

export function estimateTokens(text) {
  const value = String(text || "");
  if (!value) return 0;
  return Math.max(1, Math.ceil(value.length / 4));
}

export function stripThink(raw) {
  let text = String(raw || "").replace(/\r\n/g, "\n");
  text = text.replace(/<think>[\s\S]*?<\/think>/gi, "");
  text = text.replace(/<think>[\s\S]*$/gi, "");
  text = text.replace(/<\/think>/gi, "");
  text = text.replace(/```thinking[\s\S]*?```/gi, "");
  return text.trim();
}

export function extractThink(raw) {
  const match = String(raw || "").match(/<think>([\s\S]*?)<\/think>/i);
  return match ? match[1].trim() : "";
}

export function finalizeAnswer(raw) {
  let text = stripThink(raw);
  text = text.replace(/\[(COMPLETE|CONTINUE)\]/gi, "");
  text = text.replace(/\s*\[(?:COMP(?:LETE?)?|CONT(?:INUE?)?)\]?\.?\s*$/i, "");
  text = text.replace(/\n{3,}/g, "\n\n").trim();
  const parts = text.split(/\n\s*\n/);
  if (parts.length >= 2 && /(\.\.\.|…)\s*$/.test(parts[0].trim())) {
    const rest = parts.slice(1).join("\n\n").trim();
    if (rest) text = rest;
  }
  return text.trim();
}

function modeBlock(mode) {
  if (mode === "ask") {
    return [
      "Active chat mode: Ask.",
      "ASK MODE (read-only):",
      "- Answer questions from the project text included below and from general knowledge.",
      "- Do not propose file writes, shell commands, commits, or deploys as if they already ran.",
      "- Explain what you found. Do not claim you edited files.",
    ].join("\n");
  }
  if (mode === "plan") {
    return [
      "Active chat mode: Plan.",
      "PLAN MODE (read-only planning):",
      "- Produce a concrete implementation plan. Do not implement it.",
      "- Write a short analysis: goal, risks, and files involved.",
      "- Include a numbered list of actionable steps. Keep each step one clear action.",
      "- End by asking whether the user wants to switch to Agent mode to execute the plan.",
    ].join("\n");
  }
  return [
    "Active chat mode: Agent.",
    "AGENT MODE:",
    "- You may propose edits, commands, and git steps.",
    "- This web harness does not run tools. Put proposed file changes in markdown so the user can apply them.",
    "- Never claim a file was edited, created, or deleted.",
  ].join("\n");
}

export function buildSystemPrompt({ mode, project, brain, files, autoprompt }) {
  const lines = [
    "You are /root, a coding agent in the spirit of Cursor and Codex.",
    "You answer through GLM 5.2 cloud for the signed-in wallet on the web harness.",
    "Be precise, pragmatic, and concise.",
    "Earlier assistant messages are not proof that work happened.",
    modeBlock(mode),
    "For simple questions, answer directly when no repository evidence is needed.",
    "Response style:",
    "- Lead with a one-line summary of what you are doing or found.",
    "Chat markdown (the UI renders these — use them in final answers):",
    "- Headings: # Title, ## Section, ### Subsection",
    "- Emphasis: **bold**, *italic*, `inline code`",
    "- Bullet lists: - item",
    "- Numbered lists: 1. first  2. second",
    "- Code blocks: ``` optional-lang then code then ```",
    "- Links: [label](https://example.com)",
    "Avoid HTML. Prefer tight, skimmable answers.",
    "- Before your answer, think inside a <think>...</think> block.",
    "- Structure thinking as a numbered plan, one step per line.",
    "- Keep the final answer outside the <think> block.",
    "- Never end with only \"Done.\"",
  ];
  if (brain?.["loop.workflow"]) {
    lines.push("One-Prompt pipeline is on. Work from a short checklist inside thinking, then answer.");
  } else {
    lines.push("Simple agent loop is on. One model call. Answer after the thinking block.");
  }
  if (brain?.["guard.force_final"]) {
    lines.push("End the turn with a substantive final answer.");
  }
  if (autoprompt || brain?.["autoprompt.rewrite"]) {
    lines.push("Auto-Prompt is on. Restate the user's ask as a one-paragraph brief inside thinking before you answer.");
  }
  if (project?.label) {
    lines.push("Project: " + project.label + (project.remote ? " (" + project.remote + ")" : "") + ".");
  }
  if (brain?.["context.expand"] && files) {
    lines.push("Project files in this window:\n" + String(files).slice(0, 6000));
  }
  return lines.join("\n");
}

export function trimMessages(system, history) {
  const reserve = Math.min(MAX_RESERVE, Math.max(MIN_RESERVE, Math.floor(CONTEXT_WINDOW / 6)));
  const budget = Math.max(MIN_RESERVE, CONTEXT_WINDOW - reserve);
  const systemTokens = estimateTokens(system);
  let remaining = budget - systemTokens;
  const kept = [];
  const recentFloor = Math.min(MIN_RECENT, history.length);
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const message = history[i];
    const cost = estimateTokens(message.content) + 4;
    const mustKeep = history.length - i <= recentFloor;
    if (!mustKeep && cost > remaining) continue;
    remaining -= cost;
    kept.push(message);
    if (remaining <= 0 && kept.length >= recentFloor) break;
  }
  kept.reverse();
  const trimmed = kept.length < history.length;
  const messages = [{ role: "system", content: system }];
  if (trimmed) messages.push({ role: "system", content: TRIM_NOTICE });
  messages.push(...kept);
  const used = messages.reduce((sum, item) => sum + estimateTokens(item.content), 0);
  return {
    messages,
    trimmed,
    usage: {
      total: used,
      window: CONTEXT_WINDOW,
      percent: Math.min(100, Math.round((used / CONTEXT_WINDOW) * 100)),
    },
  };
}
