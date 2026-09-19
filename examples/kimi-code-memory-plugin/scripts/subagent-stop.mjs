#!/usr/bin/env node

/**
 * SubagentStop Hook for Kimi Code.
 *
 * Fires when a subagent finishes. In-subagent hooks never reach the parent
 * plugin, so this is the only place we can capture subagent turns. Kimi gives
 * us no transcript path: we resolve <sessionDir>/agents/<agent>/wire.jsonl —
 *   1. state.agent_dir stashed by subagent-start.mjs, when present;
 *   2. the stop payload's agent id when it looks like "agent-<n>";
 *   3. otherwise the most recently modified non-main agent wire.jsonl
 *      (best effort — subagents are short-lived, so the newest is almost
 *      always the one that just finished).
 *
 * Turns are pushed to the isolated kc-<session_id>__subagent-<agent> OV
 * session and committed immediately so the subagent's context is archived
 * before the parent continues. Detached write path; silent exit 0 always.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { isPluginEnabled, loadConfig } from "./config.mjs";
import { createLogger } from "./debug-log.mjs";
import { lookupSessionDir, parseSessionIndex, turnsFromWireContent } from "./lib/kimi-transcript.mjs";
import {
  commitSession,
  deriveOvSessionId,
  isBypassed,
  isRetryableFailure,
  makeFetchJSON,
} from "./lib/ov-session.mjs";
import { readJsonState, removeState } from "./lib/state.mjs";
import { stripInjectedBlocks } from "./lib/sanitize.mjs";
import { maybeDetach, readHookStdin } from "./shared/async-writer.mjs";
import { sendSessionMessages } from "./shared/batch-send.mjs";

const SUBAGENT_STATE_PREFIX = "kc-subagent-";

main().catch(() => process.exit(0));

async function main() {
  try {
    if (isPluginEnabled()) await run();
  } catch { /* fail-open */ }
  process.exit(0);
}

async function run() {
  const cfg = loadConfig();
  const { log, logError } = createLogger("subagent-stop");
  const fetchJSON = makeFetchJSON(cfg, "captureTimeoutMs");

  if (!cfg.autoCapture) {
    log("skip", { reason: "autoCapture disabled" });
    return;
  }

  if (await maybeDetach(cfg, () => {})) return;

  let input = {};
  try {
    input = JSON.parse((await readHookStdin()) || "{}");
  } catch { /* best effort */ }

  const sessionId = typeof input.session_id === "string" ? input.session_id.trim() : "";
  const cwd = typeof input.cwd === "string" ? input.cwd : process.cwd();
  const agentId = firstNonEmpty(
    input.agent_id,
    input.agentId,
    input.agent_name,
    input.agentName,
    input.agent_type,
    input.agentType,
  ) || "";

  if (!sessionId) {
    log("skip", { reason: "no session_id" });
    return;
  }
  if (isBypassed(cfg, { sessionId, cwd })) {
    log("skip", { reason: "bypass_session_pattern" });
    return;
  }

  // Prefer state from SubagentStart; fall back to live derivation.
  const state = agentId ? readJsonState(subagentStateName(agentId)) : null;
  const resolvedAgent = state?.agent_id || agentId || guessLatestAgentDir(cfg, sessionId) || "unknown";
  const ovSessionId = state?.ov_session_id
    || deriveOvSessionId(sessionId, `subagent:${resolvedAgent}`);

  const wirePath = resolveSubagentWirePath(cfg, sessionId, {
    agentDir: state?.agent_dir,
    agentId: resolvedAgent,
  });
  if (!wirePath || !existsSync(wirePath)) {
    log("skip", { stage: "transcript_resolve", reason: "subagent wire.jsonl not found", resolvedAgent });
    cleanupState(agentId);
    return;
  }

  let wireContent;
  try {
    wireContent = await readFile(wirePath, "utf-8");
  } catch (err) {
    logError("transcript_read", err);
    return;
  }

  const turns = turnsFromWireContent(wireContent)
    .map((turn) => ({ ...turn, text: stripInjectedBlocks(turn.text).trim() }))
    .filter((turn) => turn.text)
    .map((turn) => ({ ...turn, text: truncate(turn.text, cfg.captureMaxLength) }));
  log("transcript_parse", { resolvedAgent, ovSessionId, totalTurns: turns.length });

  if (turns.length === 0) {
    cleanupState(agentId);
    return;
  }

  const peerId = cfg.peerId || state?.peer_id || "";
  const payloads = turns.map((turn) => {
    const body = { role: turn.role, content: turn.text };
    if (peerId) body.peer_id = peerId;
    return body;
  });

  const health = await fetchJSON("/health");
  let result;
  if (health.ok) {
    // Subagents are short-lived, so threshold tracking adds little value —
    // push and commit immediately (mirrors the claude plugin).
    const sent = await sendSessionMessages(fetchJSON, ovSessionId, payloads, {});
    log("push_turns", { ovSessionId, sent: sent.sent, queued: sent.queued, failed: sent.failed });
    if (sent.sent + sent.queued > 0) {
      const commitRes = await commitSession(fetchJSON, ovSessionId);
      log("commit", {
        ovSessionId,
        ok: commitRes.ok,
        queued: Boolean(commitRes.pendingQueued),
        trace_id: commitRes.traceId || commitRes.result?.trace_id || undefined,
      });
    }
    result = { durable: sent.sent + sent.queued, enqueueFailed: sent.enqueueFailed };
  } else if (isRetryableFailure(health)) {
    logError("health_check", "server unreachable; enqueuing subagent capture");
    const { enqueue } = await import("../shared/pending-queue.mjs");
    let queued = 0;
    let enqueueFailed = 0;
    for (const payload of payloads) {
      const res = await enqueue("addMessage", ovSessionId, payload);
      if (res.ok) queued++;
      else enqueueFailed++;
    }
    if (queued > 0) {
      const res = await enqueue("commitSession", ovSessionId, {});
      if (!res.ok) enqueueFailed++;
    }
    result = { durable: queued, enqueueFailed };
  } else {
    logError("health_check", `non-retryable status ${health.status || "unknown"}`);
    return;
  }

  if (result.enqueueFailed > 0) {
    logError("pending_enqueue", "some turns failed to enqueue; state file retained");
    return;
  }
  cleanupState(agentId);
}

function subagentStateName(agentId) {
  const safe = String(agentId || "").replace(/[^a-zA-Z0-9_-]/g, "_");
  return `${SUBAGENT_STATE_PREFIX}${safe}.json`;
}

function cleanupState(agentId) {
  if (agentId) removeState(subagentStateName(agentId));
}

function firstNonEmpty(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return "";
}

function truncate(text, maxChars) {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 20)).trimEnd()}\n[truncated]`;
}

function sessionDirFor(cfg, sessionId) {
  try {
    const indexPath = join(cfg.kimiHome, "session_index.jsonl");
    if (!existsSync(indexPath)) return null;
    return lookupSessionDir(parseSessionIndex(readFileSync(indexPath, "utf-8")), sessionId);
  } catch {
    return null;
  }
}

/**
 * Best-effort subagent wire resolution — see the header comment.
 */
function resolveSubagentWirePath(cfg, sessionId, { agentDir, agentId }) {
  const sessionDir = sessionDirFor(cfg, sessionId);
  if (!sessionDir) return null;
  const agentsDir = join(sessionDir, "agents");
  if (agentDir) return join(agentsDir, agentDir, "wire.jsonl");
  const fromId = String(agentId || "").match(/^(?:agent[-_])?(\d+)$/i);
  if (fromId) {
    const candidate = join(agentsDir, `agent-${fromId[1]}`, "wire.jsonl");
    if (existsSync(candidate)) return candidate;
  }
  return join(agentsDir, "agent-0", "wire.jsonl");
}

/**
 * Fallback used when neither state nor the payload identifies the subagent:
 * the most recently modified non-main agent wire.jsonl.
 */
function guessLatestAgentDir(cfg, sessionId) {
  const sessionDir = sessionDirFor(cfg, sessionId);
  if (!sessionDir) return null;
  const agentsDir = join(sessionDir, "agents");
  try {
    if (!existsSync(agentsDir)) return null;
    let best = null;
    let bestMtime = -1;
    for (const entry of readdirSync(agentsDir)) {
      if (entry === "main" || !entry.startsWith("agent-")) continue;
      const wire = join(agentsDir, entry, "wire.jsonl");
      if (!existsSync(wire)) continue;
      const mtime = statSync(wire).mtimeMs;
      if (mtime > bestMtime) {
        bestMtime = mtime;
        best = entry;
      }
    }
    return best;
  } catch {
    return null;
  }
}
