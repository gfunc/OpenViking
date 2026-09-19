/**
 * Kimi Code transcript access for the OpenViking memory plugin.
 *
 * Kimi Code does not pass a transcript path in hook payloads. Transcripts are
 * resolved through ~/.kimi-code/session_index.jsonl (one JSON object per line:
 * { sessionId, sessionDir, workDir }); each session directory holds one
 * wire.jsonl per agent: <sessionDir>/agents/main/wire.jsonl for the main
 * agent and <sessionDir>/agents/agent-<n>/wire.jsonl for subagents.
 *
 * wire.jsonl is a JSON-lines event log. Only `context.append_message`
 * records carry conversation turns:
 *   { type: "context.append_message", message: { role, content, toolCalls,
 *     origin: { kind, ... } }, time }
 *
 * Capture rules (verified against real session files):
 *   - user turns are ONLY records with message.origin.kind === "user".
 *     Injected reminders have origin.kind "injection" (also "system_trigger",
 *     "skill_activation", "task", "compaction_summary", ...) and MUST be
 *     excluded, otherwise we feed our own injections back into OV.
 *   - the assistant side comes in one of two shapes (never both in one file):
 *     append_message records with role "assistant" (subagent / older wires),
 *     or context.append_loop_event records ("content.part" text parts and
 *     "tool.call" events, current main-agent wires). "think" parts are
 *     dropped; tool calls are serialized as "[tool-call <name>] <arguments>"
 *     so the memory extractor sees what the agent did.
 *   - role "tool" records are tool results; dropped (extraction signal lives
 *     in the assistant's prose summary, mirroring the claude/codex plugins).
 *
 * This module is pure (no I/O beyond what the caller passes in) so tests can
 * exercise it against fixture strings.
 */

import { join } from "node:path";

/**
 * Parse session_index.jsonl content into entries.
 * Malformed lines are skipped.
 */
export function parseSessionIndex(content) {
  const entries = [];
  for (const line of String(content || "").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const entry = JSON.parse(trimmed);
      if (entry && typeof entry.sessionId === "string" && typeof entry.sessionDir === "string") {
        entries.push(entry);
      }
    } catch { /* skip malformed line */ }
  }
  return entries;
}

/**
 * Find the sessionDir for a hook session_id. Matches exact ids first, then
 * tolerates a missing/extra "session_" prefix (the payload's id format is not
 * documented; verified installs use "session_<uuid>").
 * Returns the sessionDir string or null.
 */
export function lookupSessionDir(entries, sessionId) {
  const wanted = String(sessionId || "").trim();
  if (!wanted) return null;
  for (const entry of entries) {
    if (entry.sessionId === wanted) return entry.sessionDir;
  }
  const bare = wanted.replace(/^session_/, "");
  for (const entry of entries) {
    if (entry.sessionId.replace(/^session_/, "") === bare) return entry.sessionDir;
  }
  return null;
}

/**
 * Extract conversation records from wire.jsonl content. Two protocol shapes
 * exist in the wild (never mixed within one file):
 *   - append_message style: turns arrive as `context.append_message` records
 *     (user + assistant + tool roles).
 *   - loop-event style (current main-agent wires): the assistant side arrives
 *     only as `context.append_loop_event` records (`content.part`,
 *     `tool.call`), while the user side still arrives as append_message.
 * Malformed lines and unrelated event types are skipped.
 */
export function parseWireTranscript(content) {
  const records = [];
  for (const line of String(content || "").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const record = JSON.parse(trimmed);
      if (record?.type === "context.append_message" && record.message && typeof record.message === "object") {
        records.push(record);
      } else if (record?.type === "context.append_loop_event") {
        const eventType = record.event?.type;
        if (eventType === "content.part" || eventType === "tool.call") {
          records.push(record);
        }
      }
    } catch { /* skip malformed line */ }
  }
  return records;
}

function textFromContent(content) {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
      parts.push(block.text);
    }
    // "think" blocks (reasoning traces) and everything else are dropped.
  }
  return parts.join("\n\n").trim();
}

function toolCallLines(toolCalls) {
  if (!Array.isArray(toolCalls)) return { lines: [], names: [] };
  const lines = [];
  const names = [];
  for (const call of toolCalls) {
    if (!call || typeof call !== "object") continue;
    const name = typeof call.name === "string" ? call.name : "";
    if (name) names.push(name);
    let argsText = "";
    const args = call.arguments ?? call.args ?? call.input;
    if (typeof args === "string") argsText = args.trim();
    else if (args != null) {
      try { argsText = JSON.stringify(args); } catch { argsText = String(args); }
    }
    lines.push(`[tool-call${name ? ` ${name}` : ""}]${argsText ? ` ${argsText}` : ""}`);
  }
  return { lines, names };
}

/**
 * Turn shape pushed to OpenViking: { role, text, toolNames, time }.
 * `text` has tool calls inlined; caller sanitizes before sending.
 *
 * In loop-event style wires, assistant output is grouped into one turn per
 * `stepUuid` (a model step), kept in file order so user prompts interleave
 * chronologically. `think` parts are dropped; `tool.call` events are
 * serialized the same way as append_message toolCalls.
 */
export function extractTurns(records) {
  const turns = [];
  let group = null; // { stepUuid, chunks, names, time }

  const flushGroup = () => {
    if (!group) return;
    const { chunks, names, time, stepUuid } = group;
    group = null;
    const text = chunks.join("\n").trim();
    if (text) {
      turns.push({ role: "assistant", text, toolNames: names, time, stepUuid });
    }
  };

  for (const record of records || []) {
    if (record.type === "context.append_loop_event") {
      const event = record.event || {};
      if (typeof event.stepUuid !== "string" || !event.stepUuid) continue;
      if (group && group.stepUuid !== event.stepUuid) flushGroup();
      if (!group) {
        group = {
          stepUuid: event.stepUuid,
          chunks: [],
          names: [],
          time: typeof record.time === "number" ? record.time : null,
        };
      }
      if (event.type === "content.part") {
        const part = event.part || {};
        if (part.type === "text" && typeof part.text === "string" && part.text.trim()) {
          group.chunks.push(part.text.trim());
        }
        // "think" parts (reasoning traces) are dropped.
      } else if (event.type === "tool.call") {
        const name = typeof event.name === "string" ? event.name : "";
        if (name) group.names.push(name);
        let argsText = "";
        const args = event.args ?? event.arguments ?? event.input;
        if (typeof args === "string") argsText = args.trim();
        else if (args != null) {
          try { argsText = JSON.stringify(args); } catch { argsText = String(args); }
        }
        group.chunks.push(`[tool-call${name ? ` ${name}` : ""}]${argsText ? ` ${argsText}` : ""}`);
      }
      continue;
    }

    // context.append_message — flush any open assistant group so the
    // emitted turns keep the file's chronological order.
    flushGroup();
    const message = record.message || {};
    const role = message.role;
    const originKind = message.origin?.kind;

    if (role === "user") {
      if (originKind !== "user") continue; // injection / system_trigger / task / ...
    } else if (role === "assistant") {
      // Assistant records carry no origin; accept regardless.
    } else {
      continue; // "tool" results and anything else
    }

    const chunks = [];
    const text = textFromContent(message.content);
    if (text) chunks.push(text);
    const { lines, names } = toolCallLines(message.toolCalls);
    if (lines.length > 0) chunks.push(lines.join("\n"));

    const merged = chunks.join("\n").trim();
    if (!merged) continue;
    turns.push({
      role,
      text: merged,
      toolNames: names,
      time: typeof record.time === "number" ? record.time : null,
    });
  }
  flushGroup();
  return turns;
}

/**
 * Convenience: wire.jsonl content -> capture turns.
 */
export function turnsFromWireContent(content) {
  return extractTurns(parseWireTranscript(content));
}

/**
 * Resolve the main agent's wire.jsonl path for a session id, given the
 * session_index.jsonl content. Returns a path or null.
 */
export function mainWirePath(indexContent, sessionId) {
  const sessionDir = lookupSessionDir(parseSessionIndex(indexContent), sessionId);
  if (!sessionDir) return null;
  return join(sessionDir, "agents", "main", "wire.jsonl");
}
